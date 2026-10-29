// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {AgentWalletV3TestBase} from "./AgentWalletV3.t.sol";
import {CallReceipts} from "../src/CallReceipts.sol";
import {DisputeVault} from "../src/DisputeVault.sol";

contract SpoofedFactoryWallet {
    address public factory;
    constructor(address factory_) { factory = factory_; }
}

contract Phase3ReceiptsTest is AgentWalletV3TestBase {
    function _receipt() internal view returns (CallReceipts.Receipt memory) {
        return CallReceipts.Receipt(keccak256("voucher"), keccak256("request"), keccak256("response"),
            500, uint64(block.timestamp), address(token), 1, 100e6);
    }
    function _signature(CallReceipts.Receipt memory receipt) internal returns (bytes memory) {
        (address signer, uint256 key) = makeAddrAndKey("provider");
        assertEq(signer, PROVIDER);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, CallReceipts.digest(receipt, address(wallet)));
        return abi.encodePacked(r, s, v);
    }
    function _receive(CallReceipts.Receipt memory receipt) internal returns (bytes32 id) {
        _settle(PROVIDER, 100e6, 1, CallReceipts.leaf(receipt, address(wallet)));
        return keccak256(abi.encode(address(wallet), PROVIDER, address(token), uint256(1), block.number));
    }
    function test_SignedReceiptCanOpenBoundedDispute() public {
        CallReceipts.Receipt memory receipt = _receipt();
        bytes memory signature = _signature(receipt);
        bytes32 id = _receive(receipt);
        vm.prank(OWNER);
        vault.openDisputeWithReceipt(id, receipt, signature, new bytes32[](0), 50e6, 1, bytes32(0));
        assertEq(vault.getDispute(id).amount, 50e6);
    }
    function test_ReceiptCannotClaimMoreThanItsNetPayout() public {
        CallReceipts.Receipt memory receipt = _receipt();
        bytes memory signature = _signature(receipt);
        bytes32 id = _receive(receipt);
        vm.prank(OWNER);
        vm.expectRevert(DisputeVault.DisputeAmountTooLarge.selector);
        vault.openDisputeWithReceipt(id, receipt, signature, new bytes32[](0), 100e6, 1, bytes32(0));
    }
    function test_ReceiptWrongSignatureOrProofCannotOpenDispute() public {
        CallReceipts.Receipt memory receipt = _receipt();
        bytes memory signature = _signature(receipt);
        bytes32 id = _receive(receipt);
        receipt.responseHash = keccak256("tampered");
        vm.prank(OWNER);
        vm.expectRevert(DisputeVault.InvalidReceipt.selector);
        vault.openDisputeWithReceipt(id, receipt, signature, new bytes32[](0), 50e6, 1, bytes32(0));
        signature = _signature(receipt);
        vm.prank(OWNER);
        vm.expectRevert(DisputeVault.InvalidReceipt.selector);
        vault.openDisputeWithReceipt(id, receipt, signature, new bytes32[](0), 50e6, 1, bytes32(0));
    }
    function test_ReceiptOutsideSettlementNonceRangeIsRejectedEvenIfCommitted() public {
        CallReceipts.Receipt memory receipt = _receipt(); receipt.nonce = 2;
        bytes memory signature = _signature(receipt);
        bytes32 id = _receive(receipt);
        vm.prank(OWNER);
        vm.expectRevert(DisputeVault.InvalidReceipt.selector);
        vault.openDisputeWithReceipt(id, receipt, signature, new bytes32[](0), 50e6, 1, bytes32(0));
    }
    function test_SpoofedFactoryClaimCannotGainVaultOrReputationAuthority() public {
        vm.startPrank(ADMIN);
        vault.setTrustedFactory(address(factory), true);
        repRegistry.setTrustedFactory(address(factory), true);
        vm.stopPrank();
        address forged = address(new SpoofedFactoryWallet(address(factory)));
        assertFalse(vault.isTrustedWallet(forged));
        vm.prank(forged);
        vm.expectRevert();
        repRegistry.recordSettlement(forged, PROVIDER, 1e6, 1);
        vm.prank(address(wallet));
        vm.expectRevert(DisputeVault.NotTrustedWallet.selector);
        vault.receiveSettlement(keccak256("forged"), forged, PROVIDER, address(token), 1, 1);
    }
    function test_ArbiterCannotForfeitBondWhenAgentWinsPartially() public {
        CallReceipts.Receipt memory receipt = _receipt();
        bytes32 id = _receive(receipt);
        vm.prank(ADMIN); vault.setDisputeBond(address(token), 10e6);
        vm.startPrank(OWNER); token.approve(address(vault), 10e6);
        vault.openDispute(id, 50e6, 0, bytes32(0)); vm.stopPrank();
        vm.prank(PROVIDER); vault.respondToDispute(id, bytes32(0));
        uint256 beforeBond = token.balanceOf(OWNER);
        vm.prank(ARBITER); vault.arbiterDecide(id, 1, 50e6 - 1, false);
        assertEq(token.balanceOf(OWNER), beforeBond + 10e6);
    }
}
