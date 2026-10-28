// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ProviderRegistry} from "../ProviderRegistry.sol";

contract ProviderRegistryTest is Test {

    // ─── Errors ──────────────────────────────────────────────────────────────
    error AlreadyRegistered();
    error NotRegistered();
    error NotProvider();
    error ZeroAddress();
    error DisputeWindowTooLong();
    error ChangeWindowNotElapsed();
    error NoPendingChange();

    // ─── Constants ───────────────────────────────────────────────────────────
    uint32 internal constant MAX_WINDOW = 7 days;

    // ─── Actors ──────────────────────────────────────────────────────────────
    address internal PAYOUT   = makeAddr("payout");
    address internal ARBITER  = makeAddr("arbiter");
    address internal PROVIDER = makeAddr("provider");
    address internal RANDO    = makeAddr("rando");

    // ─── State ───────────────────────────────────────────────────────────────
    ProviderRegistry internal registry;

    function setUp() public {
        registry = new ProviderRegistry();
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _register(address provider, uint32 window) internal {
        bytes32 hash = keccak256("meta");
        vm.prank(provider);
        registry.register(PAYOUT, hash, window, ARBITER);
    }

    // ─── 9. register() ───────────────────────────────────────────────────────

    function test_Register_HappyPath() public {
        bytes32 hash = keccak256("meta");
        vm.prank(PROVIDER);
        vm.expectEmit(true, true, false, true, address(registry));
        emit ProviderRegistry.ProviderRegistered(PROVIDER, PAYOUT, hash);
        registry.register(PAYOUT, hash, 3600, ARBITER);

        ProviderRegistry.ProviderEntry memory e = registry.getProvider(PROVIDER);
        assertEq(e.payoutAddress,    PAYOUT,   "payout");
        assertEq(e.metadataHash,     hash,     "metadataHash");
        assertEq(e.disputeWindow,    3600,     "window");
        assertEq(e.preferredArbiter, ARBITER,  "arbiter");
        assertTrue(e.active,                   "active");
        assertTrue(e.registeredAt > 0,         "registeredAt");
    }

    function test_Register_Reverts_AlreadyRegistered() public {
        _register(PROVIDER, 3600);
        vm.prank(PROVIDER);
        vm.expectRevert(AlreadyRegistered.selector);
        registry.register(PAYOUT, bytes32(0), 3600, ARBITER);
    }

    function test_Register_Reverts_ZeroPayoutAddress() public {
        vm.prank(PROVIDER);
        vm.expectRevert(ZeroAddress.selector);
        registry.register(address(0), bytes32(0), 0, address(0));
    }

    function test_Register_Reverts_DisputeWindowTooLong() public {
        vm.prank(PROVIDER);
        vm.expectRevert(DisputeWindowTooLong.selector);
        registry.register(PAYOUT, bytes32(0), MAX_WINDOW + 1, address(0));
    }

    function test_Register_MaxWindowAllowed() public {
        vm.prank(PROVIDER);
        registry.register(PAYOUT, bytes32(0), MAX_WINDOW, address(0));
        assertEq(registry.disputeWindowOf(PROVIDER), MAX_WINDOW);
    }

    // ─── 10. updateMetadata / updatePayoutAddress / updateArbiter ────────────

    function test_UpdateMetadata_HappyPath() public {
        _register(PROVIDER, 0);
        bytes32 newHash = keccak256("newmeta");
        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit ProviderRegistry.ProviderMetadataUpdated(PROVIDER, newHash);
        registry.updateMetadata(newHash);
        assertEq(registry.getProvider(PROVIDER).metadataHash, newHash);
    }

    function test_UpdateMetadata_NonProviderReverts() public {
        // Not registered at all
        vm.prank(RANDO);
        vm.expectRevert(NotProvider.selector);
        registry.updateMetadata(bytes32(0));
    }

    function test_UpdatePayoutAddress_HappyPath() public {
        _register(PROVIDER, 0);
        address newPayout = makeAddr("newPayout");
        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit ProviderRegistry.ProviderPayoutUpdated(PROVIDER, newPayout);
        registry.updatePayoutAddress(newPayout);
        assertEq(registry.getProvider(PROVIDER).payoutAddress, newPayout);
    }

    function test_UpdatePayoutAddress_NonProviderReverts() public {
        vm.prank(RANDO);
        vm.expectRevert(NotProvider.selector);
        registry.updatePayoutAddress(PAYOUT);
    }

    function test_UpdatePayoutAddress_ZeroReverts() public {
        _register(PROVIDER, 0);
        vm.prank(PROVIDER);
        vm.expectRevert(ZeroAddress.selector);
        registry.updatePayoutAddress(address(0));
    }

    function test_UpdateArbiter_HappyPath() public {
        _register(PROVIDER, 0);
        address newArb = makeAddr("newArb");
        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit ProviderRegistry.ProviderArbiterUpdated(PROVIDER, newArb);
        registry.updateArbiter(newArb);
        assertEq(registry.getProvider(PROVIDER).preferredArbiter, newArb);
    }

    function test_UpdateArbiter_NonProviderReverts() public {
        vm.prank(RANDO);
        vm.expectRevert(NotProvider.selector);
        registry.updateArbiter(address(0));
    }

    // ─── 11. requestDisputeWindowChange + applyDisputeWindowChange ───────────

    function test_DisputeWindowChange_FullFlow() public {
        uint32 initialWindow = 3600;
        _register(PROVIDER, initialWindow);

        vm.prank(PROVIDER);
        uint256 expectedEffectiveAfter = block.timestamp + initialWindow;
        vm.expectEmit(true, false, false, true, address(registry));
        emit ProviderRegistry.DisputeWindowChangeRequested(PROVIDER, 7200, expectedEffectiveAfter);
        registry.requestDisputeWindowChange(7200);

        (uint32 newWin, uint256 reqAt, uint256 effAfter) = registry.pendingWindowChanges(PROVIDER);
        assertEq(newWin,   7200,                   "newWindow");
        assertEq(effAfter, expectedEffectiveAfter, "effectiveAfter");
        assertTrue(reqAt > 0,                      "requestedAt set");

        // Too early
        vm.prank(PROVIDER);
        vm.expectRevert(ChangeWindowNotElapsed.selector);
        registry.applyDisputeWindowChange();

        // Warp past effectiveAfter
        vm.warp(expectedEffectiveAfter + 1);

        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit ProviderRegistry.DisputeWindowChanged(PROVIDER, initialWindow, 7200);
        registry.applyDisputeWindowChange();

        assertEq(registry.disputeWindowOf(PROVIDER), 7200, "new window applied");

        // Pending change cleared
        (,uint256 reqAt2,) = registry.pendingWindowChanges(PROVIDER);
        assertEq(reqAt2, 0, "pending cleared");
    }

    function test_ApplyDisputeWindowChange_NoPendingReverts() public {
        _register(PROVIDER, 3600);
        vm.prank(PROVIDER);
        vm.expectRevert(NoPendingChange.selector);
        registry.applyDisputeWindowChange();
    }

    function test_RequestWindowChange_TooLongReverts() public {
        _register(PROVIDER, 0);
        vm.prank(PROVIDER);
        vm.expectRevert(DisputeWindowTooLong.selector);
        registry.requestDisputeWindowChange(MAX_WINDOW + 1);
    }

    function test_RequestWindowChange_InstantProvider() public {
        // Window=0 provider: effectiveAfter == block.timestamp (immediate)
        _register(PROVIDER, 0);
        uint256 ts = block.timestamp;
        vm.prank(PROVIDER);
        registry.requestDisputeWindowChange(3600);
        (,, uint256 effAfter) = registry.pendingWindowChanges(PROVIDER);
        assertEq(effAfter, ts, "immediate when current window is 0");
    }

    // ─── 12. deactivate() + reactivate() ─────────────────────────────────────

    function test_Deactivate_HappyPath() public {
        _register(PROVIDER, 0);
        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, false, address(registry));
        emit ProviderRegistry.ProviderDeactivated(PROVIDER);
        registry.deactivate();
        assertFalse(registry.isActive(PROVIDER));
    }

    function test_Deactivate_NonProviderReverts() public {
        vm.prank(RANDO);
        vm.expectRevert(NotProvider.selector);
        registry.deactivate();
    }

    function test_Reactivate_HappyPath() public {
        _register(PROVIDER, 0);
        vm.prank(PROVIDER);
        registry.deactivate();
        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, false, address(registry));
        emit ProviderRegistry.ProviderReactivated(PROVIDER);
        registry.reactivate();
        assertTrue(registry.isActive(PROVIDER));
    }

    function test_Reactivate_NotRegisteredReverts() public {
        vm.prank(RANDO);
        vm.expectRevert(NotRegistered.selector);
        registry.reactivate();
    }

    // ─── 13. view helpers ────────────────────────────────────────────────────

    function test_GetProvider_RevertNotRegistered() public {
        vm.expectRevert(NotRegistered.selector);
        registry.getProvider(RANDO);
    }

    function test_DisputeWindowOf_ReturnsZeroForUnregistered() public view {
        assertEq(registry.disputeWindowOf(RANDO), 0);
    }

    function test_PayoutAddressOf_FallsBackToProviderIfUnregistered() public view {
        assertEq(registry.payoutAddressOf(RANDO), RANDO);
    }

    function test_PayoutAddressOf_ReturnsStoredValue() public {
        _register(PROVIDER, 0);
        assertEq(registry.payoutAddressOf(PROVIDER), PAYOUT);
    }

    function test_PreferredArbiterOf_ReturnsZeroForUnregistered() public view {
        assertEq(registry.preferredArbiterOf(RANDO), address(0));
    }

    function test_PreferredArbiterOf_ReturnsStoredValue() public {
        _register(PROVIDER, 0);
        assertEq(registry.preferredArbiterOf(PROVIDER), ARBITER);
    }

    function test_IsRegistered_ReturnsTrueAfterRegister() public {
        assertFalse(registry.isRegistered(PROVIDER));
        _register(PROVIDER, 0);
        assertTrue(registry.isRegistered(PROVIDER));
    }

    // ─── Fuzz: window boundary ────────────────────────────────────────────────

    function testFuzz_Register_WindowBoundary(uint32 window) public {
        window = uint32(bound(window, 0, MAX_WINDOW));
        vm.prank(PROVIDER);
        registry.register(PAYOUT, bytes32(0), window, address(0));
        assertEq(registry.disputeWindowOf(PROVIDER), window);
    }
}
