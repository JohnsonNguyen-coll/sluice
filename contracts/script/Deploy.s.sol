// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {AgentWalletFactory} from "../AgentWalletFactory.sol";

/// @notice Deploy AgentWalletFactory. All configuration comes from environment variables.
///
/// Required env vars:
///   USDC_ADDRESS       — USDC ERC-20 token address on the target chain
///   FEE_RECIPIENT      — Initial protocol fee recipient
///   FEE_BPS            — Fee in basis points (0-500)
///
/// Optional:
///   DEPLOYER_PK        — Private key for broadcast (not needed for dry runs)
///
/// Usage (dry run):
///   forge script contracts/script/Deploy.s.sol --rpc-url $RPC_URL
///
/// Usage (broadcast):
///   forge script contracts/script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --verify
contract DeployScript is Script {
    function run() external returns (AgentWalletFactory factory) {
        address usdc         = vm.envAddress("USDC_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint16  feeBps       = uint16(vm.envUint("FEE_BPS"));

        require(usdc         != address(0), "Deploy: USDC_ADDRESS not set");
        require(feeRecipient != address(0), "Deploy: FEE_RECIPIENT not set");
        require(feeBps       <= 500,        "Deploy: FEE_BPS exceeds 500");

        vm.startBroadcast();
        factory = new AgentWalletFactory(usdc, feeRecipient, feeBps);
        vm.stopBroadcast();

        console2.log("AgentWalletFactory deployed at:", address(factory));
        console2.log("  usdc:         ", usdc);
        console2.log("  feeRecipient: ", feeRecipient);
        console2.log("  feeBps:       ", feeBps);
        console2.log("  owner:        ", factory.owner());
    }
}
