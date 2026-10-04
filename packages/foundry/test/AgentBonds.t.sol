// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { AgentBonds } from "../contracts/AgentBonds.sol";
import { MockAggregator } from "./mocks/MockAggregator.sol";
import { MockHederaScheduleService } from "./mocks/MockHederaScheduleService.sol";

contract AgentBondsTest is Test {
    address internal constant HSS_ADDRESS = address(0x16b);
    int256 internal constant PRICE = 10_000_000; // $0.10 per HBAR, 8 feed decimals
    uint256 internal constant HBAR = 1e8; // tinybars
    uint256 internal constant USD = 1e6;
    uint32 internal constant WINDOW = 1 hours;

    MockAggregator internal feed;
    MockHederaScheduleService internal hss;
    AgentBonds internal bonds;

    address internal agent = makeAddr("agent");
    address internal client = makeAddr("client");
    address internal arbiter = makeAddr("arbiter");
    address internal stranger = makeAddr("stranger");
    uint256 internal fee;

    function setUp() public {
        vm.warp(1_790_000_000);
        feed = new MockAggregator(PRICE);
        vm.etch(HSS_ADDRESS, address(new MockHederaScheduleService()).code);
        hss = MockHederaScheduleService(HSS_ADDRESS);
        bonds = new AgentBonds(feed, 3 hours);
        fee = bonds.RELEASE_FEE();

        vm.deal(agent, 1_000 * HBAR);
        vm.deal(client, 1_000 * HBAR);
        vm.prank(agent);
        bonds.register{ value: 100 * HBAR }("research-agent", address(0), WINDOW, 4242);
    }

    function _pay(uint256 amount) internal returns (uint256 id) {
        vm.prank(client);
        return bonds.pay{ value: amount }(agent, keccak256("write a market report"), 0);
    }

    function _status(uint256 id) internal view returns (AgentBonds.Status) {
        return bonds.getPayment(id).status;
    }

    /*//////////////////////////////////////////////////////////////
                              REGISTRATION
    //////////////////////////////////////////////////////////////*/

    function test_register_postsBondAndLists() public view {
        AgentBonds.Agent memory a = bonds.getAgent(agent);
        assertTrue(a.registered);
        assertEq(a.bond, 100 * HBAR);
        assertEq(a.receiptTopic, 4242);
        assertEq(bonds.totalBonded(), 100 * HBAR);
        assertEq(bonds.agentList()[0], agent);
        assertEq(bonds.names(agent), "research-agent");
    }

    function test_register_rejectsBadConfig() public {
        vm.startPrank(stranger);
        vm.expectRevert(AgentBonds.InvalidWindow.selector);
        bonds.register("x", address(0), 59, 0);
        vm.expectRevert(AgentBonds.InvalidArbiter.selector);
        bonds.register("x", stranger, WINDOW, 0);
        vm.stopPrank();

        vm.prank(agent);
        vm.expectRevert(AgentBonds.AlreadyRegistered.selector);
        bonds.register("again", address(0), WINDOW, 0);
    }

    function test_postBond_requiresRegistration() public {
        vm.deal(stranger, HBAR);
        vm.prank(stranger);
        vm.expectRevert(AgentBonds.NotRegistered.selector);
        bonds.postBond{ value: HBAR }();
    }

    /*//////////////////////////////////////////////////////////////
                                PAYMENTS
    //////////////////////////////////////////////////////////////*/

    function test_pay_paysAgentInstantlyAndLocksBond() public {
        uint256 before = agent.balance;
        uint256 id = _pay(20 * HBAR);

        assertEq(agent.balance - before, 20 * HBAR - fee, "agent is paid instantly, minus the release fee");
        assertEq(bonds.getAgent(agent).locked, 20 * HBAR);
        assertEq(bonds.freeBond(agent), 80 * HBAR);
        AgentBonds.Payment memory p = bonds.getPayment(id);
        assertEq(uint8(p.status), uint8(AgentBonds.Status.Open));
        assertEq(p.usdValue, 2 * USD);
        assertEq(p.disputeUntil, block.timestamp + WINDOW);
    }

    function test_pay_mustBeFullyCoveredByFreeBond() public {
        _pay(80 * HBAR);
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.NotCovered.selector, 20 * HBAR));
        bonds.pay{ value: 21 * HBAR }(agent, bytes32(0), 0);
    }

    function test_pay_rejectsDustAndUnknownAgents() public {
        vm.startPrank(client);
        vm.expectRevert(AgentBonds.PaymentTooSmall.selector);
        bonds.pay{ value: fee }(agent, bytes32(0), 0);
        vm.expectRevert(AgentBonds.NotRegistered.selector);
        bonds.pay{ value: HBAR }(stranger, bytes32(0), 0);
        vm.stopPrank();
    }

    function test_pay_enforcesUsdQuote() public {
        vm.startPrank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.OverQuote.selector, 2 * USD, USD));
        bonds.pay{ value: 20 * HBAR }(agent, bytes32(0), USD); // $2 against a $1 quote
        bonds.pay{ value: 10 * HBAR }(agent, bytes32(0), USD); // exactly $1
        vm.stopPrank();
    }

    function test_pay_quoteFailsSafeOnStalePrice() public {
        feed.set(PRICE, block.timestamp - 4 hours);
        vm.prank(client);
        vm.expectRevert(AgentBonds.PriceUnavailable.selector);
        bonds.pay{ value: 10 * HBAR }(agent, bytes32(0), USD);

        // Without a quote the payment still works; it just records no USD value.
        uint256 id = _pay(10 * HBAR);
        assertEq(bonds.getPayment(id).usdValue, 0);
    }

    /*//////////////////////////////////////////////////////////////
                         RELEASE (SCHEDULE SERVICE)
    //////////////////////////////////////////////////////////////*/

    function test_release_isScheduledAndFiredByTheNetwork() public {
        uint256 id = _pay(20 * HBAR);
        assertEq(hss.count(), 1);
        (address to, uint256 at, uint256 gasLimit,) = hss.scheduled(0);
        assertEq(to, address(bonds));
        assertEq(at, block.timestamp + WINDOW + bonds.SCHEDULE_DELAY(), "fires after the window, not at its edge");
        assertEq(gasLimit, bonds.SCHEDULE_GAS_LIMIT());

        vm.warp(at);
        (bool ok,) = hss.fire(0);

        assertTrue(ok);
        assertEq(uint8(_status(id)), uint8(AgentBonds.Status.Released));
        assertEq(bonds.getAgent(agent).locked, 0);
        assertEq(bonds.freeBond(agent), 100 * HBAR);
    }

    /// Hedera's block.timestamp is the start of the ~2s block, so an execution at second T can observe T-2.
    /// The scheduled release must still pass its time check when it lands in a block that started 2s earlier.
    function test_release_scheduledTimeToleratesBlockTimestampLag() public {
        uint256 id = _pay(20 * HBAR);
        (, uint256 at,,) = hss.scheduled(0);
        vm.warp(at - 2); // the block the scheduled call lands in started two seconds before its expiry
        bonds.release(id);
        assertEq(uint8(_status(id)), uint8(AgentBonds.Status.Released));
    }

    function test_release_revertsBeforeWindowCloses() public {
        uint256 id = _pay(20 * HBAR);
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.TooEarly.selector, block.timestamp + WINDOW));
        bonds.release(id);
    }

    function test_release_isPermissionlessWhenScheduleServiceIsMissing() public {
        vm.etch(HSS_ADDRESS, "");
        uint256 id = _pay(20 * HBAR);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        bonds.release(id);
        assertEq(uint8(_status(id)), uint8(AgentBonds.Status.Released));
    }

    /*//////////////////////////////////////////////////////////////
                         DISPUTES AND CLAWBACK
    //////////////////////////////////////////////////////////////*/

    function test_dispute_satisfactionGuaranteeClawsBackInFull() public {
        uint256 id = _pay(20 * HBAR);
        uint256 clientBefore = client.balance;
        address schedule = bonds.getPayment(id).schedule;

        vm.prank(client);
        bonds.dispute(id, keccak256("report was copied from a blog"));

        assertEq(client.balance - clientBefore, 20 * HBAR, "full payment refunded from the bond");
        AgentBonds.Agent memory a = bonds.getAgent(agent);
        assertEq(a.bond, 80 * HBAR);
        assertEq(a.locked, 0);
        assertEq(a.clawbacks, 1);
        assertEq(bonds.totalBonded(), 80 * HBAR);
        assertEq(uint8(_status(id)), uint8(AgentBonds.Status.Refunded));
        assertTrue(hss.deleted(schedule), "the pending release schedule is deleted");
    }

    function test_dispute_onlyClientInsideWindowOnce() public {
        uint256 id = _pay(20 * HBAR);
        vm.prank(stranger);
        vm.expectRevert(AgentBonds.NotClient.selector);
        bonds.dispute(id, bytes32(0));

        vm.prank(client);
        bonds.dispute(id, bytes32(0));
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.WrongStatus.selector, AgentBonds.Status.Refunded));
        bonds.dispute(id, bytes32(0));

        uint256 late = _pay(10 * HBAR);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(client);
        vm.expectRevert(AgentBonds.WindowClosed.selector);
        bonds.dispute(late, bytes32(0));
    }

    function _arbitratedAgent() internal returns (address arbitrated) {
        arbitrated = makeAddr("arbitrated");
        vm.deal(arbitrated, 100 * HBAR);
        vm.prank(arbitrated);
        bonds.register{ value: 50 * HBAR }("arbitrated-agent", arbiter, WINDOW, 0);
    }

    function test_arbiter_partialRefund() public {
        address arbitrated = _arbitratedAgent();
        vm.prank(client);
        uint256 id = bonds.pay{ value: 20 * HBAR }(arbitrated, bytes32(0), 0);
        vm.prank(client);
        bonds.dispute(id, keccak256("half the report is missing"));
        assertEq(uint8(_status(id)), uint8(AgentBonds.Status.Disputed));

        vm.prank(stranger);
        vm.expectRevert(AgentBonds.NotArbiter.selector);
        bonds.resolve(id, 5_000);

        uint256 clientBefore = client.balance;
        vm.prank(arbiter);
        bonds.resolve(id, 5_000);

        assertEq(client.balance - clientBefore, 10 * HBAR);
        assertEq(bonds.getAgent(arbitrated).bond, 40 * HBAR);
        assertEq(bonds.getAgent(arbitrated).locked, 0);
        assertEq(bonds.getPayment(id).refunded, 10 * HBAR);
    }

    function test_arbiter_canRuleForTheAgent() public {
        address arbitrated = _arbitratedAgent();
        vm.prank(client);
        uint256 id = bonds.pay{ value: 20 * HBAR }(arbitrated, bytes32(0), 0);
        vm.prank(client);
        bonds.dispute(id, bytes32(0));
        vm.prank(arbiter);
        bonds.resolve(id, 0);
        assertEq(uint8(_status(id)), uint8(AgentBonds.Status.Released));
        assertEq(bonds.getAgent(arbitrated).bond, 50 * HBAR);
    }

    function test_arbiter_missedDeadlineRefundsClient() public {
        address arbitrated = _arbitratedAgent();
        vm.prank(client);
        uint256 id = bonds.pay{ value: 20 * HBAR }(arbitrated, bytes32(0), 0);
        vm.prank(client);
        bonds.dispute(id, bytes32(0));

        vm.expectRevert();
        bonds.resolveExpired(id);

        vm.warp(block.timestamp + bonds.ARBITRATION_PERIOD());
        uint256 clientBefore = client.balance;
        vm.prank(stranger);
        bonds.resolveExpired(id);
        assertEq(client.balance - clientBefore, 20 * HBAR);
    }

    function test_receipt_onlyAgent() public {
        uint256 id = _pay(20 * HBAR);
        vm.prank(stranger);
        vm.expectRevert(AgentBonds.NotAgent.selector);
        bonds.submitReceipt(id, keccak256("receipt"));
        vm.prank(agent);
        bonds.submitReceipt(id, keccak256("receipt"));
        assertEq(bonds.getPayment(id).receiptHash, keccak256("receipt"));
    }

    /*//////////////////////////////////////////////////////////////
                              WITHDRAWALS
    //////////////////////////////////////////////////////////////*/

    function test_withdrawal_waitsOneWindowAndOnlyUsesFreeBond() public {
        _pay(30 * HBAR);
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.InsufficientFreeBond.selector, 70 * HBAR));
        bonds.requestWithdrawal(71 * HBAR);

        bonds.requestWithdrawal(70 * HBAR);
        assertEq(bonds.freeBond(agent), 0, "pending withdrawals can't cover new payments");
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.TooEarly.selector, block.timestamp + WINDOW));
        bonds.withdrawBond();

        vm.warp(block.timestamp + WINDOW);
        uint256 before = agent.balance;
        bonds.withdrawBond();
        vm.stopPrank();

        assertEq(agent.balance - before, 70 * HBAR);
        assertEq(bonds.getAgent(agent).bond, 30 * HBAR);
        assertEq(bonds.totalBonded(), 30 * HBAR);
    }

    function test_withdrawal_canBeCancelled() public {
        vm.startPrank(agent);
        bonds.requestWithdrawal(50 * HBAR);
        bonds.cancelWithdrawal();
        vm.stopPrank();
        assertEq(bonds.freeBond(agent), 100 * HBAR);
    }

    /*//////////////////////////////////////////////////////////////
                                  FUZZ
    //////////////////////////////////////////////////////////////*/

    /// Whatever mix of payments, disputes and releases happens, the contract can always cover every bond, and every
    /// clawback is paid in full.
    function testFuzz_alwaysSolventAndFullyCovered(uint64[6] memory amounts, bool[6] memory disputes) public {
        for (uint256 i; i < amounts.length; i++) {
            uint256 free = bonds.freeBond(agent);
            if (free <= fee) break;
            uint256 amount = bound(amounts[i], fee + 1, free);
            uint256 id = _pay(amount);
            if (disputes[i]) {
                uint256 before = client.balance;
                vm.prank(client);
                bonds.dispute(id, bytes32(0));
                assertEq(client.balance - before, amount, "clawback covers the whole payment");
            }
            assertGe(address(bonds).balance, bonds.totalBonded(), "solvent");
            AgentBonds.Agent memory a = bonds.getAgent(agent);
            assertLe(uint256(a.locked) + a.pendingWithdrawal, a.bond, "locks never exceed the bond");
        }
    }
}
