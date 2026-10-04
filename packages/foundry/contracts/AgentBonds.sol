// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";

/**
 * @title AgentBonds
 * @notice Slashable HBAR bonds for AI agents. Clients pay agents directly and instantly, and every payment is fully
 *         covered by the agent's bond for a dispute window. If the agent does bad, the client claws the payment
 *         back from the bond.
 *
 * Lifecycle of a payment:
 *  1. `pay`: the client sends HBAR. The agent receives it immediately (minus a small release fee) and an equal
 *     amount of its bond is locked until `disputeUntil`.
 *  2. During the window the agent posts a work receipt (its hash; the text lives on the agent's HCS topic) and the
 *     client can `dispute`.
 *       - Satisfaction guarantee (agent has no arbiter): the dispute claws the full amount back from the bond at once.
 *       - Arbitrated: the agent's arbiter decides a refund between 0% and 100%; if it misses its deadline the
 *         client is refunded in full.
 *  3. Undisputed payments are released by the Hedera Schedule Service just after `disputeUntil`: the contract schedules
 *     its own `release` call, so no keeper is needed. `release` is also permissionless as a fallback.
 *
 * Solvency: bonds are only ever paid out to clients (clawbacks) or back to their agent (withdrawals), and the
 * contract always holds at least `totalBonded`. Release fees fund the scheduled transactions on top of that.
 *
 * @dev Units: on Hedera, `msg.value` and `address.balance` inside the EVM are tinybars (8 decimals).
 *      USD amounts are 6-decimal fixed point.
 */
contract AgentBonds is ReentrancyGuard {
    enum Status {
        None,
        Open,
        Disputed,
        Released,
        Refunded
    }

    struct Agent {
        bool registered;
        uint32 disputeWindow;
        uint64 receiptTopic;
        address arbiter;
        uint128 bond;
        uint128 locked;
        uint128 pendingWithdrawal;
        uint40 withdrawableAt;
        uint32 payments;
        uint32 disputes;
        uint32 clawbacks;
    }

    struct Payment {
        address client;
        address agent;
        uint64 amount;
        uint128 usdValue;
        uint40 paidAt;
        uint40 disputeUntil;
        uint40 arbitrationDeadline;
        Status status;
        uint64 refunded;
        bytes32 jobHash;
        bytes32 receiptHash;
        bytes32 disputeHash;
        address schedule;
    }

    IHederaScheduleService internal constant HSS = IHederaScheduleService(address(0x16b));
    int64 internal constant HSS_SUCCESS = 22;
    uint256 public constant SCHEDULE_GAS_LIMIT = 250_000;
    /// @notice How long after `disputeUntil` the scheduled release fires. On Hedera, `block.timestamp` is the start
    ///         of the ~2s block a transaction lands in, so a call executed at second T can observe T-2 and fail a
    ///         `>= T` check. Firing a few seconds late guarantees the window has closed from the EVM's view.
    uint256 public constant SCHEDULE_DELAY = 10;
    /// @notice Kept from each payment to pay for the scheduled `release` (0.05 HBAR).
    uint256 public constant RELEASE_FEE = 5_000_000;
    uint256 public constant MIN_DISPUTE_WINDOW = 60;
    uint256 public constant MAX_DISPUTE_WINDOW = 30 days;
    /// @notice How long an arbiter has to decide before the client is refunded by default.
    uint256 public constant ARBITRATION_PERIOD = 3 days;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant USD_DECIMALS = 6;
    uint256 internal constant TINYBARS_PER_HBAR = 1e8;

    AggregatorV3Interface public immutable hbarUsdFeed;
    uint8 public immutable feedDecimals;
    uint256 public immutable maxPriceAge;

    uint256 public totalBonded;
    uint256 public nextPaymentId = 1;
    mapping(address agent => Agent) internal agents;
    mapping(address agent => string) public names;
    mapping(uint256 id => Payment) internal payments;
    address[] internal _agentList;

    event AgentRegistered(
        address indexed agent, string name, address arbiter, uint32 disputeWindow, uint64 receiptTopic
    );
    event BondPosted(address indexed agent, uint256 amount, uint256 bond);
    event WithdrawalRequested(address indexed agent, uint256 amount, uint256 withdrawableAt);
    event WithdrawalCancelled(address indexed agent, uint256 amount);
    event BondWithdrawn(address indexed agent, uint256 amount);
    event Paid(
        uint256 indexed id,
        address indexed client,
        address indexed agent,
        uint256 amount,
        uint256 usdValue,
        bytes32 jobHash,
        uint256 disputeUntil
    );
    event ReceiptSubmitted(uint256 indexed id, bytes32 receiptHash);
    event Disputed(uint256 indexed id, bytes32 reasonHash, uint256 arbitrationDeadline);
    event ClawedBack(uint256 indexed id, address indexed client, uint256 refund, uint256 remainingBond);
    event Released(uint256 indexed id);
    event ReleaseScheduled(uint256 indexed id, address schedule, uint256 at);
    event ScheduleFailed(uint256 indexed id, int64 responseCode);

    error NotRegistered();
    error AlreadyRegistered();
    error InvalidWindow();
    error InvalidArbiter();
    error ZeroAmount();
    error PaymentTooSmall();
    error AmountTooLarge();
    error NotCovered(uint256 freeBond);
    error PriceUnavailable();
    error OverQuote(uint256 usdValue, uint256 maxUsd);
    error NotClient();
    error NotAgent();
    error NotArbiter();
    error WrongStatus(Status status);
    error WindowClosed();
    error TooEarly(uint256 at);
    error InvalidRefund();
    error InsufficientFreeBond(uint256 freeBond);
    error TransferFailed();

    constructor(AggregatorV3Interface hbarUsdFeed_, uint256 maxPriceAge_) {
        hbarUsdFeed = hbarUsdFeed_;
        feedDecimals = hbarUsdFeed_.decimals();
        maxPriceAge = maxPriceAge_;
    }

    /*//////////////////////////////////////////////////////////////
                                 AGENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Registers the caller as an agent and posts `msg.value` as its initial bond.
    /// @param arbiter Who decides disputes; address(0) offers a satisfaction guarantee (disputes refund instantly).
    /// @param disputeWindow Seconds each payment stays refundable from the bond.
    /// @param receiptTopic HCS topic (number, shard and realm 0) where the agent publishes work receipts.
    function register(string calldata name, address arbiter, uint32 disputeWindow, uint64 receiptTopic)
        external
        payable
        nonReentrant
    {
        Agent storage a = agents[msg.sender];
        if (a.registered) revert AlreadyRegistered();
        if (disputeWindow < MIN_DISPUTE_WINDOW || disputeWindow > MAX_DISPUTE_WINDOW) revert InvalidWindow();
        // An agent judging its own disputes could always refund 0%.
        if (arbiter == msg.sender) revert InvalidArbiter();
        a.registered = true;
        a.arbiter = arbiter;
        a.disputeWindow = disputeWindow;
        a.receiptTopic = receiptTopic;
        names[msg.sender] = name;
        _agentList.push(msg.sender);
        emit AgentRegistered(msg.sender, name, arbiter, disputeWindow, receiptTopic);
        if (msg.value > 0) _addBond(a, msg.value);
    }

    /// @notice Adds `msg.value` to the caller's bond.
    function postBond() external payable nonReentrant {
        Agent storage a = agents[msg.sender];
        if (!a.registered) revert NotRegistered();
        if (msg.value == 0) revert ZeroAmount();
        _addBond(a, msg.value);
    }

    /// @notice Starts withdrawing free bond. It stays covered (and claimable) for one dispute window first, so a
    ///         client who checked the bond before paying is never surprised.
    function requestWithdrawal(uint256 amount) external {
        Agent storage a = agents[msg.sender];
        if (!a.registered) revert NotRegistered();
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeBond(msg.sender);
        if (amount > free) revert InsufficientFreeBond(free);
        a.pendingWithdrawal += SafeCast.toUint128(amount);
        a.withdrawableAt = uint40(block.timestamp + a.disputeWindow);
        emit WithdrawalRequested(msg.sender, a.pendingWithdrawal, a.withdrawableAt);
    }

    function cancelWithdrawal() external {
        Agent storage a = agents[msg.sender];
        uint256 amount = a.pendingWithdrawal;
        a.pendingWithdrawal = 0;
        emit WithdrawalCancelled(msg.sender, amount);
    }

    /// @notice Pays out a requested withdrawal once its delay has passed.
    function withdrawBond() external nonReentrant {
        Agent storage a = agents[msg.sender];
        uint256 amount = a.pendingWithdrawal;
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < a.withdrawableAt) revert TooEarly(a.withdrawableAt);
        a.pendingWithdrawal = 0;
        a.bond -= SafeCast.toUint128(amount);
        totalBonded -= amount;
        emit BondWithdrawn(msg.sender, amount);
        _send(msg.sender, amount);
    }

    /// @notice The agent records the hash of a work receipt it published to its HCS topic.
    function submitReceipt(uint256 id, bytes32 receiptHash) external {
        Payment storage p = payments[id];
        if (p.agent != msg.sender) revert NotAgent();
        if (p.status != Status.Open && p.status != Status.Disputed) revert WrongStatus(p.status);
        p.receiptHash = receiptHash;
        emit ReceiptSubmitted(id, receiptHash);
    }

    /*//////////////////////////////////////////////////////////////
                                CLIENTS
    //////////////////////////////////////////////////////////////*/

    /// @notice Pays `agent` for a job. The agent receives `msg.value - RELEASE_FEE` immediately; the full amount
    ///         stays refundable from its bond until the dispute window closes.
    /// @param jobHash Hash of the job description agreed off-chain.
    /// @param maxUsd The USD price the client agreed to (6 decimals); 0 skips the check. With a cap set, the
    ///        payment reverts if the live Chainlink price makes it worth more, or if no fresh price is available.
    function pay(address agent, bytes32 jobHash, uint256 maxUsd) external payable nonReentrant returns (uint256 id) {
        Agent storage a = agents[agent];
        if (!a.registered) revert NotRegistered();
        if (msg.value <= RELEASE_FEE) revert PaymentTooSmall();
        if (msg.value > type(uint64).max) revert AmountTooLarge();
        uint256 free = freeBond(agent);
        if (msg.value > free) revert NotCovered(free);

        (bool priceOk, uint256 usd) = quoteUsd(msg.value);
        if (maxUsd > 0) {
            if (!priceOk) revert PriceUnavailable();
            if (usd > maxUsd) revert OverQuote(usd, maxUsd);
        }

        id = nextPaymentId++;
        Payment storage p = payments[id];
        p.client = msg.sender;
        p.agent = agent;
        // casting to uint64 is safe: larger values reverted with AmountTooLarge above
        // forge-lint: disable-next-line(unsafe-typecast)
        p.amount = uint64(msg.value);
        p.usdValue = priceOk ? SafeCast.toUint128(usd) : 0;
        p.paidAt = uint40(block.timestamp);
        p.disputeUntil = uint40(block.timestamp + a.disputeWindow);
        p.status = Status.Open;
        p.jobHash = jobHash;
        a.locked += SafeCast.toUint128(msg.value);
        a.payments += 1;
        emit Paid(id, msg.sender, agent, msg.value, p.usdValue, jobHash, p.disputeUntil);

        _scheduleRelease(id, p.disputeUntil + SCHEDULE_DELAY);
        _send(agent, msg.value - RELEASE_FEE);
    }

    /// @notice The client disputes a payment inside its window. Satisfaction-guarantee agents are clawed back at
    ///         once; otherwise the agent's arbiter has `ARBITRATION_PERIOD` to decide.
    /// @param reasonHash Hash of the client's explanation (e.g. published to the agent's HCS topic).
    function dispute(uint256 id, bytes32 reasonHash) external nonReentrant {
        Payment storage p = payments[id];
        if (p.client != msg.sender) revert NotClient();
        if (p.status != Status.Open) revert WrongStatus(p.status);
        if (block.timestamp >= p.disputeUntil) revert WindowClosed();

        Agent storage a = agents[p.agent];
        a.disputes += 1;
        p.disputeHash = reasonHash;
        _cancelSchedule(p);

        if (a.arbiter == address(0)) {
            emit Disputed(id, reasonHash, 0);
            _clawBack(id, p, a, p.amount);
        } else {
            p.status = Status.Disputed;
            // casting to uint40 is safe: timestamps fit in uint40 until the year 36812
            // forge-lint: disable-next-line(unsafe-typecast)
            p.arbitrationDeadline = uint40(block.timestamp + ARBITRATION_PERIOD);
            emit Disputed(id, reasonHash, p.arbitrationDeadline);
        }
    }

    /// @notice The agent's arbiter refunds `refundBps` of a disputed payment from the bond; the rest is released.
    function resolve(uint256 id, uint256 refundBps) external nonReentrant {
        Payment storage p = payments[id];
        if (p.status != Status.Disputed) revert WrongStatus(p.status);
        Agent storage a = agents[p.agent];
        if (msg.sender != a.arbiter) revert NotArbiter();
        if (refundBps > BPS) revert InvalidRefund();
        _clawBack(id, p, a, (uint256(p.amount) * refundBps) / BPS);
    }

    /// @notice If the arbiter misses its deadline, anyone can refund the client in full.
    function resolveExpired(uint256 id) external nonReentrant {
        Payment storage p = payments[id];
        if (p.status != Status.Disputed) revert WrongStatus(p.status);
        if (block.timestamp < p.arbitrationDeadline) revert TooEarly(p.arbitrationDeadline);
        _clawBack(id, p, agents[p.agent], p.amount);
    }

    /// @notice Releases an undisputed payment's locked bond once its window has closed.
    /// @dev Normally called by the Hedera Schedule Service; permissionless so a missed schedule never strands bond.
    function release(uint256 id) external {
        Payment storage p = payments[id];
        if (p.status != Status.Open) revert WrongStatus(p.status);
        if (block.timestamp < p.disputeUntil) revert TooEarly(p.disputeUntil);
        p.status = Status.Released;
        agents[p.agent].locked -= p.amount;
        emit Released(id);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Bond not locked by open payments and not on its way out: what new payments can be covered by.
    function freeBond(address agent) public view returns (uint256) {
        Agent storage a = agents[agent];
        uint256 committed = uint256(a.locked) + a.pendingWithdrawal;
        return a.bond > committed ? a.bond - committed : 0;
    }

    /// @notice USD value (6 decimals, rounded up) of `amount` tinybars, and whether the Chainlink answer is usable.
    /// @dev Never reverts: a reverting feed, a non-positive, absurdly large, future-dated or stale answer returns ok=false.
    function quoteUsd(uint256 amount) public view returns (bool ok, uint256 usd) {
        try hbarUsdFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || answer > int256(uint256(type(uint128).max))) return (false, 0);
            if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) {
                return (false, 0);
            }
            if (amount > type(uint64).max) return (false, 0);
            // casting to uint256 is safe because answer is within (0, type(uint128).max] here
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 price = uint256(answer);
            usd = Math.mulDiv(
                amount, price * 10 ** USD_DECIMALS, TINYBARS_PER_HBAR * 10 ** feedDecimals, Math.Rounding.Ceil
            );
            ok = true;
        } catch {
            return (false, 0);
        }
    }

    function getAgent(address agent) external view returns (Agent memory) {
        return agents[agent];
    }

    function getPayment(uint256 id) external view returns (Payment memory) {
        return payments[id];
    }

    function agentList() external view returns (address[] memory) {
        return _agentList;
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    function _addBond(Agent storage a, uint256 amount) internal {
        a.bond += SafeCast.toUint128(amount);
        totalBonded += amount;
        emit BondPosted(msg.sender, amount, a.bond);
    }

    /// @dev Refunds `refund` of the payment from the agent's bond and releases the rest of its lock.
    function _clawBack(uint256 id, Payment storage p, Agent storage a, uint256 refund) internal {
        p.status = refund > 0 ? Status.Refunded : Status.Released;
        // casting to uint64 is safe: refund <= p.amount, which is a uint64
        // forge-lint: disable-next-line(unsafe-typecast)
        p.refunded = uint64(refund);
        a.locked -= p.amount;
        if (refund == 0) {
            emit Released(id);
            return;
        }
        a.bond -= SafeCast.toUint128(refund);
        a.clawbacks += 1;
        totalBonded -= refund;
        emit ClawedBack(id, p.client, refund, a.bond);
        _send(p.client, refund);
    }

    function _send(address to, uint256 amount) internal {
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert TransferFailed();
    }

    /// @dev Best effort, via low-level calls so a missing or throttled Schedule Service never reverts a payment;
    ///      `release` stays permissionless after `at`.
    function _scheduleRelease(uint256 id, uint256 at) internal {
        (bool ok, bytes memory ret) = address(HSS)
            .staticcall(abi.encodeCall(IHederaScheduleService.hasScheduleCapacity, (at, SCHEDULE_GAS_LIMIT)));
        if (!ok || ret.length < 32 || !abi.decode(ret, (bool))) {
            emit ScheduleFailed(id, -1);
            return;
        }
        (ok, ret) = address(HSS)
            .call(
                abi.encodeCall(
                    IHederaScheduleService.scheduleCall,
                    (address(this), at, SCHEDULE_GAS_LIMIT, 0, abi.encodeCall(this.release, (id)))
                )
            );
        if (!ok || ret.length < 64) {
            emit ScheduleFailed(id, -1);
            return;
        }
        (int64 rc, address schedule) = abi.decode(ret, (int64, address));
        if (rc != HSS_SUCCESS || schedule == address(0)) {
            emit ScheduleFailed(id, rc);
            return;
        }
        payments[id].schedule = schedule;
        emit ReleaseScheduled(id, schedule, at);
    }

    /// @dev A disputed payment's scheduled release would only revert; delete it to save the fee (best effort).
    function _cancelSchedule(Payment storage p) internal {
        if (p.schedule == address(0)) return;
        (bool deleted,) = address(HSS).call(abi.encodeCall(IHederaScheduleService.deleteSchedule, (p.schedule)));
        if (deleted) p.schedule = address(0);
    }
}
