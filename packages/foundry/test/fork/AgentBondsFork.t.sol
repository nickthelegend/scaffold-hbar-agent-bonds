// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Test } from "forge-std/Test.sol";
import { AgentBonds } from "../../contracts/AgentBonds.sol";
import { AggregatorV3Interface } from "../../contracts/interfaces/AggregatorV3Interface.sol";

/// @notice Runs against live Hedera testnet state: `yarn foundry:test:testnet --match-path "test/fork/*"`.
/// Proves USD-quoted payments are priced with the real Chainlink HBAR/USD feed.
contract AgentBondsForkTest is Test {
    AggregatorV3Interface internal constant FEED = AggregatorV3Interface(0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a);

    function setUp() public {
        if (block.chainid != 296) vm.skip(true);
    }

    function test_quotedPayment_usesLiveChainlinkPrice() public {
        AgentBonds bonds = new AgentBonds(FEED, 1 days);
        address agent = makeAddr("agent");
        address client = makeAddr("client");
        vm.deal(agent, 1_000e8);
        vm.deal(client, 1_000e8);
        vm.prank(agent);
        bonds.register{ value: 500e8 }("fork-agent", address(0), 1 hours, 0);

        (bool ok, uint256 usd) = bonds.quoteUsd(100e8);
        assertTrue(ok, "live feed should be fresh within a day");
        assertGt(usd, 1e6, "100 HBAR should be worth more than $1");

        // A quote $0.000001 below the live value is rejected; the exact value is accepted.
        vm.prank(client);
        vm.expectRevert(abi.encodeWithSelector(AgentBonds.OverQuote.selector, usd, usd - 1));
        bonds.pay{ value: 100e8 }(agent, bytes32(0), usd - 1);
        vm.prank(client);
        uint256 id = bonds.pay{ value: 100e8 }(agent, bytes32(0), usd);
        assertEq(bonds.getPayment(id).usdValue, usd);
    }
}
