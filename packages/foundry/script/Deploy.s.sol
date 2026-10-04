//SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ScaffoldETHDeploy } from "./DeployHelpers.s.sol";
import { AgentBonds } from "../contracts/AgentBonds.sol";
import { AggregatorV3Interface } from "../contracts/interfaces/AggregatorV3Interface.sol";

/**
 * @notice Deploys AgentBonds wired to Chainlink's HBAR/USD feed.
 * @dev Example: yarn foundry:deploy --network hedera_testnet
 *      Override the feed with HBAR_USD_FEED=0x... (mainnet HBAR/USD: 0xAF685FB45C12b92b5054ccb9313e135525F9b5d5).
 */
contract DeployScript is ScaffoldETHDeploy {
    /// Chainlink HBAR/USD on Hedera testnet (chain 296).
    address internal constant TESTNET_HBAR_USD_FEED = 0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a;
    /// The testnet feed updates on deviation; its longest observed gap between rounds was ~2h08m.
    uint256 internal constant MAX_PRICE_AGE = 3 hours;

    function run() external ScaffoldEthDeployerRunner {
        address feed = vm.envOr("HBAR_USD_FEED", TESTNET_HBAR_USD_FEED);
        AgentBonds bonds = new AgentBonds(AggregatorV3Interface(feed), MAX_PRICE_AGE);
        deployments.push(Deployment({ name: "AgentBonds", addr: address(bonds) }));
    }
}
