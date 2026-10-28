// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ReputationRegistry} from "../ReputationRegistry.sol";

contract ReputationRegistryTest is Test {

    // ─── Errors ──────────────────────────────────────────────────────────────
    error NotTrustedCaller();
    error InvalidScore();
    error NoSettlementHistory();
    error ZeroAddress();
    error NotAdmin();

    // ─── Actors ──────────────────────────────────────────────────────────────
    address internal ADMIN    = makeAddr("admin");
    address internal CALLER   = makeAddr("trustedCaller");
    address internal WALLET   = makeAddr("wallet");
    address internal PROVIDER = makeAddr("provider");
    address internal RANDO    = makeAddr("rando");

    // ─── State ───────────────────────────────────────────────────────────────
    ReputationRegistry internal rep;

    function setUp() public {
        vm.prank(ADMIN);
        rep = new ReputationRegistry();

        // Grant CALLER as trusted
        vm.prank(ADMIN);
        rep.setTrustedCaller(CALLER, true);
    }

    // ─── 14. setTrustedCaller() ───────────────────────────────────────────────

    function test_SetTrustedCaller_AdminHappyPath() public {
        address newCaller = makeAddr("newCaller");
        vm.prank(ADMIN);
        vm.expectEmit(true, false, false, true, address(rep));
        emit ReputationRegistry.TrustedCallerSet(newCaller, true);
        rep.setTrustedCaller(newCaller, true);
        assertTrue(rep.trustedCaller(newCaller));
    }

    function test_SetTrustedCaller_RemoveCaller() public {
        vm.prank(ADMIN);
        rep.setTrustedCaller(CALLER, false);
        assertFalse(rep.trustedCaller(CALLER));
    }

    function test_SetTrustedCaller_NonAdminReverts() public {
        vm.prank(RANDO);
        vm.expectRevert(NotAdmin.selector);
        rep.setTrustedCaller(CALLER, true);
    }

    function test_SetTrustedCaller_ZeroAddressReverts() public {
        vm.prank(ADMIN);
        vm.expectRevert(ZeroAddress.selector);
        rep.setTrustedCaller(address(0), true);
    }

    // ─── 15. recordSettlement() ───────────────────────────────────────────────

    function test_RecordSettlement_OnlyTrustedCaller() public {
        vm.prank(RANDO);
        vm.expectRevert(NotTrustedCaller.selector);
        rep.recordSettlement(WALLET, PROVIDER, 1000e6);
    }

    function test_RecordSettlement_UpdatesStats() public {
        vm.prank(CALLER);
        vm.expectEmit(true, false, false, true, address(rep));
        emit ReputationRegistry.ProviderStatsUpdated(PROVIDER, 1000e6, 1);
        vm.expectEmit(true, false, false, true, address(rep));
        emit ReputationRegistry.AgentStatsUpdated(WALLET, 1000e6, 1);
        rep.recordSettlement(WALLET, PROVIDER, 1000e6);

        ReputationRegistry.ProviderStats memory ps = rep.getProviderStats(PROVIDER);
        assertEq(ps.totalVolumeUsdE6, 1000e6, "providerVolume");
        assertEq(ps.settledCount,     1,       "settledCount");
        assertTrue(ps.firstSeen > 0,           "firstSeen");
        assertEq(ps.uniqueAgents,     1,       "uniqueAgents (first)");

        ReputationRegistry.AgentStats memory as_ = rep.getAgentStats(WALLET);
        assertEq(as_.totalVolumeUsdE6, 1000e6, "agentVolume");
        assertEq(as_.settledCount,     1,       "agentSettledCount");
        assertEq(as_.uniqueProviders,  1,       "uniqueProviders (first)");
    }

    function test_RecordSettlement_AccumulatesOnSecondCall() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 500e6);
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 300e6);

        ReputationRegistry.ProviderStats memory ps = rep.getProviderStats(PROVIDER);
        assertEq(ps.totalVolumeUsdE6, 800e6, "accumulated volume");
        assertEq(ps.settledCount,     2,     "count accumulated");
    }

    function test_RecordSettlement_DoesNotDoubleIncrementUniqueness() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 500e6);
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 500e6);

        // Uniqueness counts should remain at 1, not 2
        assertEq(rep.getProviderStats(PROVIDER).uniqueAgents,   1, "uniqueAgents no double");
        assertEq(rep.getAgentStats(WALLET).uniqueProviders, 1, "uniqueProviders no double");
    }

    function test_RecordSettlement_AccumulatesPairFees() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 1000e6, 1000e6);
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 500e6, 500e6);
        assertEq(rep.pairFeesPaidUsdE6(WALLET, PROVIDER), 1500e6);
    }

    function test_RecordSettlement_SetsFirstSeenOnce() public {
        uint256 t1 = 1_000_000;
        vm.warp(t1);
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 100e6);
        uint256 firstSeen = rep.getProviderStats(PROVIDER).firstSeen;
        assertEq(firstSeen, t1, "firstSeen set at t1");

        // second call should NOT overwrite firstSeen
        vm.warp(t1 + 1000);
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 100e6);
        assertEq(rep.getProviderStats(PROVIDER).firstSeen, t1, "firstSeen unchanged");
    }

    // ─── 16. recordDisputeOutcome() ───────────────────────────────────────────

    function test_RecordDisputeOutcome_OnlyTrusted() public {
        vm.prank(RANDO);
        vm.expectRevert(NotTrustedCaller.selector);
        rep.recordDisputeOutcome(WALLET, PROVIDER, 0);
    }

    function test_RecordDisputeOutcome_ProviderWon() public {
        uint8 outcome = rep.OUTCOME_PROVIDER_WON(); // read before prank to avoid consuming it
        vm.prank(CALLER);
        rep.recordDisputeOpened(WALLET, PROVIDER);
        vm.prank(CALLER);
        rep.recordDisputeOutcome(WALLET, PROVIDER, outcome);

        ReputationRegistry.ProviderStats memory ps = rep.getProviderStats(PROVIDER);
        assertEq(ps.disputesWon,      1, "provider won");
        assertEq(ps.disputesReceived, 1, "received");

        ReputationRegistry.AgentStats memory as_ = rep.getAgentStats(WALLET);
        assertEq(as_.disputesLost, 1, "agent lost");
        assertEq(as_.disputesWon,  0, "agent won=0");
    }

    function test_RecordDisputeOutcome_AgentWon() public {
        uint8 outcome = rep.OUTCOME_AGENT_WON();
        vm.prank(CALLER);
        rep.recordDisputeOpened(WALLET, PROVIDER);
        vm.prank(CALLER);
        rep.recordDisputeOutcome(WALLET, PROVIDER, outcome);

        ReputationRegistry.ProviderStats memory ps = rep.getProviderStats(PROVIDER);
        assertEq(ps.disputesLost,     1, "provider lost");
        assertEq(ps.disputesReceived, 1, "received");

        ReputationRegistry.AgentStats memory as_ = rep.getAgentStats(WALLET);
        assertEq(as_.disputesWon,  1, "agent won");
        assertEq(as_.disputesLost, 0, "agent lost=0");
    }

    function test_RecordDisputeOutcome_AutoRefund() public {
        uint8 outcome = rep.OUTCOME_AUTO_REFUND();
        vm.prank(CALLER);
        rep.recordDisputeOpened(WALLET, PROVIDER);
        vm.prank(CALLER);
        rep.recordDisputeOutcome(WALLET, PROVIDER, outcome);

        ReputationRegistry.ProviderStats memory ps = rep.getProviderStats(PROVIDER);
        assertEq(ps.disputesAutoRefunded, 1, "autoRefunded");
        assertEq(ps.disputesLost,         1, "provider lost on auto");
        assertEq(ps.disputesReceived,     1, "received");

        ReputationRegistry.AgentStats memory as_ = rep.getAgentStats(WALLET);
        assertEq(as_.disputesWon, 1, "agent won on auto");
    }

    function test_RecordDisputeOutcome_Split() public {
        uint8 outcome = rep.OUTCOME_SPLIT();
        vm.prank(CALLER);
        rep.recordDisputeOpened(WALLET, PROVIDER);
        vm.prank(CALLER);
        rep.recordDisputeOutcome(WALLET, PROVIDER, outcome);

        ReputationRegistry.ProviderStats memory ps = rep.getProviderStats(PROVIDER);
        assertEq(ps.disputesLost,     1, "provider partial loss");
        assertEq(ps.disputesReceived, 1, "received");

        ReputationRegistry.AgentStats memory as_ = rep.getAgentStats(WALLET);
        assertEq(as_.disputesWon, 1, "agent partial win");
    }

    // ─── 17. giveFeedback() ───────────────────────────────────────────────────

    function test_GiveFeedback_CallerMustBeWallet() public {
        // RANDO calls with wallet=WALLET but msg.sender != WALLET
        vm.prank(RANDO);
        vm.expectRevert(NoSettlementHistory.selector);
        rep.giveFeedback(WALLET, PROVIDER, 4, bytes32(0), bytes32(0));
    }

    function test_GiveFeedback_RequiresSettlementHistory() public {
        // No settlement yet
        vm.prank(WALLET);
        vm.expectRevert(NoSettlementHistory.selector);
        rep.giveFeedback(WALLET, PROVIDER, 4, bytes32(0), bytes32(0));
    }

    function test_GiveFeedback_ScoreZeroReverts() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 100e6);

        vm.prank(WALLET);
        vm.expectRevert(InvalidScore.selector);
        rep.giveFeedback(WALLET, PROVIDER, 0, bytes32(0), bytes32(0));
    }

    function test_GiveFeedback_ScoreSixReverts() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 100e6);

        vm.prank(WALLET);
        vm.expectRevert(InvalidScore.selector);
        rep.giveFeedback(WALLET, PROVIDER, 6, bytes32(0), bytes32(0));
    }

    function test_GiveFeedback_HappyPath() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 100e6, 100e6);

        bytes32 tag      = keccak256("fast");
        bytes32 evidence = keccak256("evidence");

        vm.prank(WALLET);
        vm.expectEmit(true, true, false, true, address(rep));
        emit ReputationRegistry.FeedbackGiven(WALLET, PROVIDER, 5, tag);
        rep.giveFeedback(WALLET, PROVIDER, 5, tag, evidence);

        ReputationRegistry.Feedback memory f = rep.getFeedback(WALLET, PROVIDER);
        assertEq(f.score,         5,        "score");
        assertEq(f.tagHash,       tag,      "tagHash");
        assertEq(f.evidenceHash,  evidence, "evidenceHash");
        assertEq(f.feesPaidUsdE6, 100e6,    "weight");
        assertTrue(f.updatedAt > 0,         "updatedAt");
    }

    function test_GiveFeedback_OverwritesExisting() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 100e6);

        vm.prank(WALLET);
        rep.giveFeedback(WALLET, PROVIDER, 3, bytes32(0), bytes32(0));
        vm.prank(WALLET);
        rep.giveFeedback(WALLET, PROVIDER, 5, bytes32(0), bytes32(0));

        assertEq(rep.getFeedback(WALLET, PROVIDER).score, 5, "overwritten");
    }

    function test_GiveFeedback_WeightCappedAtMax() public {
        uint256 cap = rep.MAX_PAIR_WEIGHT_USD_E6();
        // Record a huge settlement
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, cap + 1_000e6, cap + 1_000e6);

        vm.prank(WALLET);
        rep.giveFeedback(WALLET, PROVIDER, 5, bytes32(0), bytes32(0));

        assertEq(
            rep.getFeedback(WALLET, PROVIDER).feesPaidUsdE6,
            cap,
            "weight capped at MAX"
        );
    }

    function test_GiveFeedback_AllScoresValid() public {
        for (uint8 s = 1; s <= 5; s++) {
            vm.prank(CALLER);
            rep.recordSettlement(WALLET, makeAddr(string(abi.encode(s))), 10e6);

            address provider = makeAddr(string(abi.encode(s)));
            vm.prank(WALLET);
            rep.giveFeedback(WALLET, provider, s, bytes32(0), bytes32(0));
            assertEq(rep.getFeedback(WALLET, provider).score, s);
        }
    }

    // ─── hasHistory view ──────────────────────────────────────────────────────

    function test_HasHistory_FalseBeforeSettlement() public view {
        assertFalse(rep.hasHistory(WALLET, PROVIDER));
    }

    function test_HasHistory_TrueAfterSettlement() public {
        vm.prank(CALLER);
        rep.recordSettlement(WALLET, PROVIDER, 1e6);
        assertTrue(rep.hasHistory(WALLET, PROVIDER));
    }
}
