// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {AgentWalletV3TestBase} from "./AgentWalletV3.t.sol";
import {AgentWalletV3} from "../src/AgentWalletV3.sol";
import {AgentWalletFactoryV3} from "../src/AgentWalletFactoryV3.sol";
import {DisputeVault} from "../src/DisputeVault.sol";
import {NegotiationWalletFactory} from "../src/NegotiationWalletFactory.sol";
import {NegotiationDisputeVault} from "../src/NegotiationDisputeVault.sol";

contract NegotiationDisputeVaultTest is AgentWalletV3TestBase {
    NegotiationDisputeVault internal nv;

    function setUp() public override {
        super.setUp();
        vm.prank(ADMIN);
        nv = new NegotiationDisputeVault(ARBITER, address(provRegistry), address(repRegistry));
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(ADMIN);
        factory = AgentWalletFactoryV3(
            address(
                new NegotiationWalletFactory(
                    FEE_RECIPIENT, FEE_BPS, tokens, address(nv), address(provRegistry), address(repRegistry)
                )
            )
        );
        wallet = AgentWalletV3(factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, bytes32("negotiation")));
        vault = DisputeVault(address(nv));
        vm.startPrank(ADMIN);
        nv.setTrustedFactory(address(factory), true);
        nv.setMaxDisputeAmount(address(token), 1000e6);
        repRegistry.setTrustedFactory(address(factory), true);
        repRegistry.setTrustedCaller(address(nv), true);
        vm.stopPrank();
        vm.startPrank(OWNER);
        token.approve(address(wallet), type(uint256).max);
        wallet.deposit(address(token), DEPOSIT);
        wallet.setProviderBudget(PROVIDER, address(token), 10000e6, 1000e6);
        vm.stopPrank();
        _consent();
    }

    function _consent() internal {
        bytes32 hash = nv.arbitrationTermsHash(PROVIDER, address(token));
        vm.prank(OWNER);
        nv.acceptArbitrationTerms(address(wallet), PROVIDER, address(token), hash);
    }

    function sendSettlement(uint256 cumulative, uint256 nonce) external {
        _settle(PROVIDER, cumulative, nonce, bytes32(0));
    }

    function _case() internal returns (bytes32 id) {
        _settle(PROVIDER, 100e6, 1, bytes32(0));
        id = keccak256(abi.encode(address(wallet), PROVIDER, address(token), uint256(1), block.number));
        vm.prank(OWNER);
        nv.openDispute(id, 50e6, 1, keccak256("claim"));
    }

    function _respond(bytes32 id) internal {
        vm.prank(PROVIDER);
        nv.respondToDispute(id, keccak256("response"));
    }

    function _escalate(bytes32 id) internal {
        _respond(id);
        vm.warp(nv.getDispute(id).responseDeadline);
        vm.prank(OWNER);
        nv.escalateDispute(id);
    }

    function test_FixedThirtyMinuteNegotiationAndOneDayArbitration() public {
        bytes32 id = _case();
        NegotiationDisputeVault.Dispute memory d = nv.getDispute(id);
        assertEq(d.responseDeadline, d.openedAt + 30 minutes);
        assertEq(d.arbiterDeadline, d.responseDeadline + 1 days);
    }

    function test_TermsChangeCannotSilentlyApplyToPendingVoucher() public {
        vm.prank(ADMIN);
        nv.setDisputeBond(address(token), 10e6);
        uint256 beforeBalance = token.balanceOf(address(wallet));
        vm.expectRevert(NegotiationDisputeVault.TermsNotAccepted.selector);
        this.sendSettlement(100e6, 1);
        assertEq(token.balanceOf(address(wallet)), beforeBalance);
        assertEq(wallet.nonces(PROVIDER, address(token)), 0);
    }

    function test_OnlyCurrentOwnerCanConsentAndExactTermsRequired() public {
        bytes32 hash = nv.arbitrationTermsHash(PROVIDER, address(token));
        vm.prank(PROVIDER);
        vm.expectRevert(NegotiationDisputeVault.NotWalletOwner.selector);
        nv.acceptArbitrationTerms(address(wallet), PROVIDER, address(token), hash);
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.TermsNotAccepted.selector);
        nv.acceptArbitrationTerms(address(wallet), PROVIDER, address(token), bytes32(0));
    }

    function test_ProviderCannotPickItselfAsArbiter() public {
        vm.prank(PROVIDER);
        provRegistry.updateArbiter(PROVIDER);
        vm.expectRevert(NegotiationDisputeVault.ArbiterNotApproved.selector);
        nv.arbitrationTermsHash(PROVIDER, address(token));
    }

    function test_UnapprovedDefaultArbiterIsRejected() public {
        vm.prank(ADMIN);
        vm.expectRevert(NegotiationDisputeVault.ArbiterNotApproved.selector);
        nv.transferDefaultArbiter(PROVIDER);
    }

    function test_ArbiterCannotActBeforeLastResortEscalation() public {
        bytes32 id = _case();
        _respond(id);
        vm.prank(ARBITER);
        vm.expectRevert(NegotiationDisputeVault.NotEscalated.selector);
        nv.resolveAfterEscalation(id, 0, 50e6, false, keccak256("decision"));
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.NegotiationNotElapsed.selector);
        nv.escalateDispute(id);
    }

    function test_TwoPartiesCanAgreeImmediatelyWithoutArbiter() public {
        bytes32 id = _case();
        vm.prank(OWNER);
        nv.proposeResolution(id, 20e6, true, keccak256("proposal"));
        (bytes32 hash,,,,,,) = nv.proposals(id);
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.NotDisputeParty.selector);
        nv.acceptResolution(id, hash);
        uint256 beforeBalance = token.balanceOf(address(wallet));
        vm.prank(PROVIDER);
        nv.acceptResolution(id, hash);
        assertEq(token.balanceOf(address(wallet)), beforeBalance + 20e6);
        assertTrue(nv.getDispute(id).resolved);
    }

    function test_StaleProposalAndThirdPartyAcceptanceAreRejected() public {
        bytes32 id = _case();
        vm.prank(OWNER);
        nv.proposeResolution(id, 20e6, true, keccak256("first"));
        (bytes32 old,,,,,,) = nv.proposals(id);
        vm.prank(PROVIDER);
        nv.proposeResolution(id, 10e6, true, keccak256("second"));
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.InvalidProposal.selector);
        nv.acceptResolution(id, old);
        (bytes32 latest,,,,,,) = nv.proposals(id);
        vm.prank(ARBITER);
        vm.expectRevert(NegotiationDisputeVault.NotDisputeParty.selector);
        nv.acceptResolution(id, latest);
    }

    function test_ProviderProposalCountsAsResponse() public {
        bytes32 id = _case();
        vm.prank(PROVIDER);
        nv.proposeResolution(id, 20e6, true, keccak256("proposal"));
        vm.warp(nv.getDispute(id).responseDeadline);
        vm.expectRevert(NegotiationDisputeVault.ProviderAlreadyResponded.selector);
        nv.autoRefund(id);
    }

    function test_NoNegotiationAfterExactDeadline() public {
        bytes32 id = _case();
        vm.warp(nv.getDispute(id).responseDeadline);
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.NegotiationExpired.selector);
        nv.proposeResolution(id, 20e6, true, keccak256("late"));
    }

    function test_ProviderSilenceRefundsAfterThirtyMinutes() public {
        bytes32 id = _case();
        uint256 balance = token.balanceOf(address(wallet));
        vm.warp(nv.getDispute(id).responseDeadline);
        nv.autoRefund(id);
        assertEq(token.balanceOf(address(wallet)), balance + 50e6);
    }

    function test_EscalationDoesNotResetTwentyFourHourDeadline() public {
        bytes32 id = _case();
        _respond(id);
        uint256 deadline = nv.getDispute(id).arbiterDeadline;
        vm.warp(deadline - 1);
        vm.prank(PROVIDER);
        nv.escalateDispute(id);
        assertEq(nv.getDispute(id).arbiterDeadline, deadline);
        vm.warp(deadline);
        nv.arbiterTimeout(id);
        assertTrue(nv.getDispute(id).resolved);
    }

    function test_FixedTimeoutPreventsFundsBeingStuckWithoutEscalation() public {
        bytes32 id = _case();
        _respond(id);
        vm.warp(nv.getDispute(id).arbiterDeadline);
        nv.arbiterTimeout(id);
        assertTrue(nv.getDispute(id).resolved);
    }

    function test_OnlyApprovedSnapshottedArbiterCanResolveAndNeedsReason() public {
        bytes32 id = _case();
        _escalate(id);
        vm.prank(PROVIDER);
        vm.expectRevert(NegotiationDisputeVault.NotArbiter.selector);
        nv.resolveAfterEscalation(id, 20e6, 30e6, true, keccak256("reason"));
        vm.prank(ARBITER);
        vm.expectRevert(NegotiationDisputeVault.RationaleRequired.selector);
        nv.resolveAfterEscalation(id, 20e6, 30e6, true, bytes32(0));
        vm.prank(ARBITER);
        nv.resolveAfterEscalation(id, 20e6, 30e6, true, keccak256("reason"));
        assertEq(nv.decisionRationale(id), keccak256("reason"));
    }

    function test_DisputedAmountCannotExceedAcceptedCap() public {
        vm.prank(ADMIN);
        nv.setMaxDisputeAmount(address(token), 10e6);
        _consent();
        _settle(PROVIDER, 100e6, 1, bytes32(0));
        bytes32 id = keccak256(abi.encode(address(wallet), PROVIDER, address(token), uint256(1), block.number));
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.DisputeAmountTooLarge.selector);
        nv.openDispute(id, 11e6, 1, bytes32(0));
    }

    function test_BondAndCapAreSnapshottedNotChangedMidSettlement() public {
        vm.prank(ADMIN);
        nv.setDisputeBond(address(token), 10e6);
        _consent();
        _settle(PROVIDER, 100e6, 1, bytes32(0));
        bytes32 id = keccak256(abi.encode(address(wallet), PROVIDER, address(token), uint256(1), block.number));
        vm.startPrank(ADMIN);
        nv.setDisputeBond(address(token), 999e6);
        nv.setMaxDisputeAmount(address(token), 1);
        vm.stopPrank();
        vm.startPrank(OWNER);
        token.approve(address(nv), 10e6);
        nv.openDispute(id, 50e6, 1, bytes32(0));
        vm.stopPrank();
        assertEq(nv.getDispute(id).bond, 10e6);
    }

    function testFuzz_MutualSplitConservesPrincipalAndCannotResolveTwice(uint96 raw) public {
        bytes32 id = _case();
        uint256 refund = bound(uint256(raw), 0, 50e6);
        uint256 beforeWallet = token.balanceOf(address(wallet));
        uint256 beforeProvider = token.balanceOf(PROVIDER_PAYOUT);
        vm.prank(OWNER);
        nv.proposeResolution(id, refund, true, keccak256("mutual"));
        (bytes32 hash,,,,,,) = nv.proposals(id);
        vm.prank(PROVIDER);
        nv.acceptResolution(id, hash);
        assertEq(token.balanceOf(address(wallet)) - beforeWallet, refund);
        assertEq(token.balanceOf(PROVIDER_PAYOUT) - beforeProvider, 100e6 - _fee(100e6) - refund);
        vm.prank(PROVIDER);
        vm.expectRevert();
        nv.acceptResolution(id, hash);
    }

    function sendToUnregistered() external {
        _settle(PROVIDER2, 100e6, 1, bytes32(0));
    }

    function test_RawVoucherCannotBypassConsentThroughInstantPayout() public {
        vm.expectRevert(bytes4(keccak256("ArbitrationHoldRequired()")));
        this.sendToUnregistered();
    }

    function test_ZeroHoldProviderCannotAcceptMisleadingArbitrationTerms() public {
        vm.prank(PROVIDER);
        provRegistry.requestDisputeWindowChange(0);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.prank(PROVIDER);
        provRegistry.applyDisputeWindowChange();
        bytes32 hash = nv.arbitrationTermsHash(PROVIDER, address(token));
        vm.prank(OWNER);
        vm.expectRevert(NegotiationDisputeVault.TermsNotAccepted.selector);
        nv.acceptArbitrationTerms(address(wallet), PROVIDER, address(token), hash);
        vm.expectRevert(bytes4(keccak256("ArbitrationHoldRequired()")));
        this.sendSettlement(100e6, 1);
    }
}
