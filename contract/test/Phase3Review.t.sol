// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV3TestBase} from "./AgentWalletV3.t.sol";
import {AgentWalletV3} from "../src/AgentWalletV3.sol";
import {DisputeVault} from "../src/DisputeVault.sol";

/// @notice Fixed findings are regressions. The root-only test documents that membership
/// is not authentication; signed receipt claims are tested in Phase3Receipts.t.sol.
contract Phase3ReviewTest is AgentWalletV3TestBase {
    function _held(bytes32 root) internal returns (bytes32 id) {
        _settle(PROVIDER, 100e6, 1, root);
        id = keccak256(abi.encode(address(wallet), PROVIDER, address(token), uint256(1), block.number));
    }

    function _open(bytes32 id) internal {
        vm.prank(OWNER);
        vault.openDispute(id, 50e6, 0, bytes32(0));
    }

    function test_Fix_ProviderCannotReplaceArbiterOfExistingDispute() public {
        bytes32 id = _held(bytes32(0));
        _open(id);
        address replacement = makeAddr("providerChosenArbiter");
        vm.prank(PROVIDER);
        provRegistry.updateArbiter(replacement);
        vm.prank(replacement);
        vm.expectRevert(DisputeVault.NotArbiter.selector);
        vault.arbiterDecide(id, 0, 50e6, false);
        assertFalse(vault.getDispute(id).resolved);
        vm.prank(PROVIDER);
        vault.respondToDispute(id, bytes32(0));
        vm.prank(ARBITER);
        vault.arbiterDecide(id, 50e6, 0, true);
        assertTrue(vault.getDispute(id).resolved);
    }

    function test_Fix_LateResponseCannotBlockAutoRefund() public {
        bytes32 id = _held(bytes32(0));
        _open(id);
        vm.warp(vault.getDispute(id).responseDeadline + 1);
        vm.prank(PROVIDER);
        vm.expectRevert(DisputeVault.ResponseDeadlineExpired.selector);
        vault.respondToDispute(id, keccak256("late response"));
        vault.autoRefund(id);
        assertTrue(vault.getDispute(id).resolved);
    }

    function test_Fix_PayoutChangeCannotRedirectHeldSettlement() public {
        bytes32 id = _held(bytes32(0));
        uint256 amount = vault.getSettlement(id).amount;
        address replacement = makeAddr("newPayout");
        vm.prank(PROVIDER);
        provRegistry.updatePayoutAddress(replacement);
        vm.warp(vault.getSettlement(id).releaseAfter);
        vault.release(id);
        assertEq(token.balanceOf(replacement), 0);
        assertEq(token.balanceOf(PROVIDER_PAYOUT), amount);
    }

    function test_Review_RootIsNotBoundToAgentVoucherSignature() public {
        // _settle signs only the voucher fields, never this independently supplied root.
        bytes32 inventedReceipt = keccak256("no provider signature or real call");
        _held(inventedReceipt);
        bytes32[] memory proof = new bytes32[](0);
        assertTrue(wallet.verifyReceiptProof(PROVIDER, address(token), 1, inventedReceipt, proof));
    }

    function test_Fix_UndisputedRemainderReleasesWhileDisputeStaysOpen() public {
        bytes32 id = _held(bytes32(0));
        _open(id);
        vm.warp(vault.getSettlement(id).releaseAfter);
        vault.releaseUndisputed(id);
        assertEq(token.balanceOf(PROVIDER_PAYOUT), vault.getSettlement(id).amount - 50e6);
        assertFalse(vault.getDispute(id).resolved);
        vm.expectRevert(DisputeVault.NoUndisputedFunds.selector);
        vault.releaseUndisputed(id);
    }

    function test_Fix_NewFactoryWalletSettlesThroughVerifiedFactory() public {
        vm.startPrank(ADMIN);
        vault.setTrustedFactory(address(factory), true);
        repRegistry.setTrustedFactory(address(factory), true);
        vm.stopPrank();
        wallet = AgentWalletV3(factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, keccak256("fresh")));
        vm.startPrank(OWNER);
        token.approve(address(wallet), 1000e6);
        wallet.deposit(address(token), 1000e6);
        wallet.setProviderBudget(PROVIDER, address(token), 200e6, 100e6);
        vm.stopPrank();
        AgentWalletV3.Voucher memory voucher = _makeVoucher(PROVIDER, address(token), 100e6, 1, uint64(block.timestamp + 1 hours));
        bytes memory signature = _sign(voucher, AGENT_SIGNER_PK);
        assertFalse(vault.trustedWallet(address(wallet)));
        assertFalse(repRegistry.trustedCaller(address(wallet)));
        assertTrue(vault.isTrustedWallet(address(wallet)));
        vm.prank(PROVIDER);
        wallet.settle(voucher, signature, 0, bytes32(0));
        assertEq(repRegistry.getProviderStats(PROVIDER).settledCount, 1);
    }
}
