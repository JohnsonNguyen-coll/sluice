// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReputationRegistry} from "../ReputationRegistry.sol";

contract ReputationWalletStub {
    address public owner;
    constructor(address owner_) { owner = owner_; }
    function setOwner(address owner_) external { owner = owner_; }
}

contract ReputationRegistrySecurityTest is Test {
    ReputationRegistry rep;
    ReputationWalletStub wallet;
    address owner = makeAddr("owner");
    address provider = makeAddr("provider");

    function setUp() public {
        rep = new ReputationRegistry();
        rep.setTrustedCaller(address(this), true);
        wallet = new ReputationWalletStub(owner);
    }

    function testFuzz_WeightUsesFeesAndCaps(uint128 volume, uint128 fees) public {
        fees = uint128(bound(fees, 0, volume));
        rep.recordSettlement(address(wallet), provider, volume, fees);
        vm.prank(owner);
        rep.giveFeedback(address(wallet), provider, 5, bytes32(0), bytes32(0));
        assertEq(rep.getProviderStats(provider).totalVolumeUsdE6, volume);
        assertEq(rep.pairFeesPaidUsdE6(address(wallet), provider), fees);
        uint256 cap = rep.MAX_PAIR_WEIGHT_USD_E6();
        assertEq(rep.getFeedback(address(wallet), provider).feesPaidUsdE6, fees > cap ? cap : fees);
    }

    function test_LegacySettlementDoesNotInventFeeWeight() public {
        rep.recordSettlement(address(wallet), provider, 1000e6);
        assertEq(rep.pairFeesPaidUsdE6(address(wallet), provider), 0);
        assertTrue(rep.hasHistory(address(wallet), provider));
    }

    function test_OpenedDisputeCountedBeforeResolutionAndNotDoubleCounted() public {
        rep.recordDisputeOpened(address(wallet), provider);
        assertEq(rep.getAgentStats(address(wallet)).disputesOpened, 1);
        assertEq(rep.getProviderStats(provider).disputesReceived, 1);
        assertEq(rep.getAgentStats(address(wallet)).disputesWon, 0);
        rep.recordDisputeOutcome(address(wallet), provider, 2);
        assertEq(rep.getAgentStats(address(wallet)).disputesOpened, 1);
        assertEq(rep.getProviderStats(provider).disputesReceived, 1);
        assertEq(rep.getAgentStats(address(wallet)).disputesAutoRefunded, 1);
    }

    function test_UntrustedCallerCannotRecordOpenedDispute() public {
        vm.prank(owner);
        vm.expectRevert(ReputationRegistry.NotTrustedCaller.selector);
        rep.recordDisputeOpened(address(wallet), provider);
    }

    function test_RejectFeesExceedingVolume() public {
        vm.expectRevert(ReputationRegistry.InvalidFees.selector);
        rep.recordSettlement(address(wallet), provider, 10, 11);
    }

    function testFuzz_InvalidOutcomeRejected(uint8 outcome) public {
        vm.assume(outcome > 3);
        vm.expectRevert(ReputationRegistry.InvalidOutcome.selector);
        rep.recordDisputeOutcome(address(wallet), provider, outcome);
    }

    function test_SameOwnerFeedbackHasZeroWeight() public {
        rep.recordSettlement(address(wallet), owner, 1000e6, 3e6);
        vm.prank(owner);
        rep.giveFeedback(address(wallet), owner, 5, bytes32(0), bytes32(0));
        assertTrue(rep.sameOwnerPair(address(wallet), owner));
        assertEq(rep.getFeedback(address(wallet), owner).feesPaidUsdE6, 0);
        wallet.setOwner(provider);
        vm.prank(provider);
        rep.giveFeedback(address(wallet), owner, 5, bytes32(0), bytes32(0));
        assertTrue(rep.sameOwnerPair(address(wallet), owner));
        assertEq(rep.getFeedback(address(wallet), owner).feesPaidUsdE6, 0, "rotation cannot erase self-dealing history");
    }

    function test_OwnershipChangeRemovesScoreWeightAndOldOwnerAccess() public {
        rep.recordSettlement(address(wallet), provider, 1000e6, 3e6);
        vm.prank(owner);
        rep.giveFeedback(address(wallet), provider, 5, bytes32(0), bytes32(0));
        assertEq(rep.getFeedback(address(wallet), provider).feesPaidUsdE6, 3e6);
        wallet.setOwner(provider);
        assertEq(rep.getFeedback(address(wallet), provider).feesPaidUsdE6, 0);
        vm.prank(owner);
        vm.expectRevert(ReputationRegistry.NoSettlementHistory.selector);
        rep.giveFeedback(address(wallet), provider, 5, bytes32(0), bytes32(0));
    }
}
