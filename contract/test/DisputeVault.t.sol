// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test}               from "forge-std/Test.sol";
import {DisputeVault}       from "../src/DisputeVault.sol";
import {ProviderRegistry}   from "../src/ProviderRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {MockERC20}          from "./mocks/MockERC20.sol";

/// @notice A minimal wallet stub used for dispute tests.
///         Receives refunds and exposes owner().
contract MinimalWallet {
    address public owner;
    address public vaultAddress;
    uint256 public refundCount;
    mapping(address => uint256) public refundReceived;

    constructor(address owner_, address vault_) {
        owner       = owner_;
        vaultAddress = vault_;
    }

    function receiveRefund(address token, uint256 amount) external {
        require(msg.sender == vaultAddress, "only vault");
        refundReceived[token] += amount;
        refundCount++;
    }
}

contract DisputeVaultTest is Test {

    // ─── Errors ──────────────────────────────────────────────────────────────
    error NotTrustedWallet();
    error SettlementNotFound();
    error NotInHeldState();
    error DisputeWindowExpired();
    error DisputeAmountTooLarge();
    error DisputeAlreadyOpen();
    error NotWalletOwner();
    error NotProvider();
    error NotArbiter();
    error ProviderAlreadyResponded();
    error ArbiterDeadlineNotExpired();
    error SplitExceedsDisputed();
    error AlreadyResolved();
    error ReleaseWindowNotElapsed();
    error NotInDisputedState();
    error ZeroAddress();

    // ─── Constants ───────────────────────────────────────────────────────────
    uint32  internal constant WINDOW   = 300;   // 5-minute dispute window
    uint256 internal constant AMOUNT   = 1000e6;
    uint256 internal constant BOND     = 10e6;

    // ─── Actors ──────────────────────────────────────────────────────────────
    address internal ADMIN    = makeAddr("admin");
    address internal ARBITER  = makeAddr("arbiter");
    address internal OWNER    = makeAddr("walletOwner");
    address internal PAYOUT   = makeAddr("providerPayout");

    address internal PROVIDER;  // set in setUp via makeAddr

    // ─── Contracts ───────────────────────────────────────────────────────────
    DisputeVault       internal vault;
    ProviderRegistry   internal provRegistry;
    ReputationRegistry internal repRegistry;
    MockERC20          internal token;
    MinimalWallet      internal wallet;

    // ─── State helpers ───────────────────────────────────────────────────────
    bytes32 internal _sId;   // last settlement id

    function setUp() public {
        PROVIDER = makeAddr("provider");

        token = new MockERC20("Mock USDC", "mUSDC", 6);

        vm.prank(ADMIN);
        provRegistry = new ProviderRegistry();

        vm.prank(ADMIN);
        repRegistry = new ReputationRegistry();

        vm.prank(ADMIN);
        vault = new DisputeVault(ARBITER, address(provRegistry), address(repRegistry));

        // Grant vault as trusted caller in reputation registry
        vm.prank(ADMIN);
        repRegistry.setTrustedCaller(address(vault), true);

        // Create wallet stub AFTER vault is deployed
        wallet = new MinimalWallet(OWNER, address(vault));

        // Register wallet as trusted
        vm.prank(ADMIN);
        vault.setTrustedWallet(address(wallet), true);

        // Register provider with 5-min window
        vm.prank(PROVIDER);
        provRegistry.register(PAYOUT, keccak256("meta"), WINDOW, ARBITER);

        // Mint tokens to wallet stub (simulates wallet holding funds)
        token.mint(address(wallet), 100_000e6);

        // Set dispute bond
        vm.prank(ADMIN);
        vault.setDisputeBond(address(token), BOND);
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    /// @dev Simulate a settlement: transfer funds from wallet to vault, then call receiveSettlement.
    function _receiveSettlement(uint256 amount, uint32 window) internal returns (bytes32 sid) {
        sid = keccak256(abi.encode(address(wallet), PROVIDER, address(token), 1, block.number));
        // Transfer tokens to vault (as the wallet would)
        vm.prank(address(wallet));
        token.transfer(address(vault), amount);
        // Call receiveSettlement as the trusted wallet
        vm.prank(address(wallet));
        vault.receiveSettlement(sid, address(wallet), PROVIDER, address(token), amount, window);
        _sId = sid;
    }

    function _openDispute(bytes32 sid, uint256 disputeAmount) internal {
        // Approve bond from OWNER
        token.mint(OWNER, BOND);
        vm.prank(OWNER);
        token.approve(address(vault), BOND);
        vm.prank(OWNER);
        vault.openDispute(sid, disputeAmount, 0, bytes32(0));
    }

    // ─── 18. receiveSettlement() ──────────────────────────────────────────────

    function test_ReceiveSettlement_HappyPath() public {
        uint256 releaseAfterExpected = block.timestamp + WINDOW;
        bytes32 sid = keccak256(abi.encode(address(wallet), PROVIDER, address(token), 1, block.number));

        vm.prank(address(wallet));
        token.transfer(address(vault), AMOUNT);

        vm.prank(address(wallet));
        vm.expectEmit(true, true, true, true, address(vault));
        emit DisputeVault.SettlementReceived(sid, address(wallet), PROVIDER, address(token), AMOUNT, releaseAfterExpected);
        vault.receiveSettlement(sid, address(wallet), PROVIDER, address(token), AMOUNT, WINDOW);

        DisputeVault.Settlement memory s = vault.getSettlement(sid);
        assertEq(s.wallet,       address(wallet), "wallet");
        assertEq(s.provider,     PROVIDER,        "provider");
        assertEq(s.token,        address(token),  "token");
        assertEq(s.amount,       AMOUNT,          "amount");
        assertEq(s.releaseAfter, releaseAfterExpected, "releaseAfter");
        assertEq(uint8(s.state), uint8(DisputeVault.SettlementState.HELD), "state HELD");
    }

    function test_ReceiveSettlement_OnlyTrustedWallet() public {
        bytes32 sid = keccak256(abi.encode("x"));
        vm.prank(makeAddr("untrusted"));
        vm.expectRevert(NotTrustedWallet.selector);
        vault.receiveSettlement(sid, address(wallet), PROVIDER, address(token), AMOUNT, WINDOW);
    }

    function test_ReceiveSettlement_DuplicateIdReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        // second call with same sid
        vm.prank(address(wallet));
        token.transfer(address(vault), AMOUNT);
        vm.prank(address(wallet));
        vm.expectRevert(DisputeAlreadyOpen.selector);
        vault.receiveSettlement(sid, address(wallet), PROVIDER, address(token), AMOUNT, WINDOW);
    }

    // ─── 19. release() ───────────────────────────────────────────────────────

    function test_Release_HappyPath() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);

        vm.warp(block.timestamp + WINDOW + 1);

        uint256 payoutBefore = token.balanceOf(PAYOUT);
        vm.expectEmit(true, true, false, true, address(vault));
        emit DisputeVault.SettlementReleased(sid, PROVIDER, AMOUNT);
        vault.release(sid);

        assertEq(token.balanceOf(PAYOUT), payoutBefore + AMOUNT, "payout received");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.RELEASED), "RELEASED");
    }

    function test_Release_TooEarlyReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        vm.expectRevert(ReleaseWindowNotElapsed.selector);
        vault.release(sid);
    }

    function test_Release_NotInHeldStateReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(NotInHeldState.selector);
        vault.release(sid);
    }

    function test_Release_SettlementNotFound() public {
        vm.expectRevert(SettlementNotFound.selector);
        vault.release(keccak256("notexist"));
    }

    // ─── 20. openDispute() ───────────────────────────────────────────────────

    function test_OpenDispute_HappyPath() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);

        token.mint(OWNER, BOND);
        vm.prank(OWNER);
        token.approve(address(vault), BOND);

        vm.prank(OWNER);
        vm.expectEmit(true, true, false, true, address(vault));
        emit DisputeVault.DisputeOpened(sid, address(wallet), AMOUNT, 0, bytes32(0));
        vault.openDispute(sid, AMOUNT, 0, bytes32(0));

        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.DISPUTED), "DISPUTED");
        DisputeVault.Dispute memory d = vault.getDispute(sid);
        assertEq(d.amount,   AMOUNT, "dispute amount");
        assertEq(d.bond,     BOND,   "bond");
        assertEq(d.openedBy, OWNER,  "openedBy");
    }

    function test_OpenDispute_NotWalletOwnerReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        vm.prank(makeAddr("notOwner"));
        vm.expectRevert(NotWalletOwner.selector);
        vault.openDispute(sid, AMOUNT, 0, bytes32(0));
    }

    function test_OpenDispute_AfterWindowReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.prank(OWNER);
        vm.expectRevert(DisputeWindowExpired.selector);
        vault.openDispute(sid, AMOUNT, 0, bytes32(0));
    }

    function test_OpenDispute_AmountTooLargeReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        vm.prank(OWNER);
        vm.expectRevert(DisputeAmountTooLarge.selector);
        vault.openDispute(sid, AMOUNT + 1, 0, bytes32(0));
    }

    function test_OpenDispute_AlreadyOpenReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        token.mint(OWNER, BOND);
        vm.prank(OWNER);
        token.approve(address(vault), BOND);
        vm.prank(OWNER);
        vm.expectRevert(NotInHeldState.selector);
        vault.openDispute(sid, AMOUNT, 0, bytes32(0));
    }

    // ─── 21. acceptDispute() ─────────────────────────────────────────────────

    function test_AcceptDispute_HappyPath() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT / 2); // dispute half

        uint256 walletBefore = token.balanceOf(address(wallet));
        uint256 payoutBefore = token.balanceOf(PAYOUT);
        uint256 ownerBefore  = token.balanceOf(OWNER); // bond goes back to OWNER

        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, true, address(vault));
        emit DisputeVault.DisputeAccepted(sid, AMOUNT / 2);
        vault.acceptDispute(sid);

        // Refund goes to wallet
        assertEq(token.balanceOf(address(wallet)), walletBefore + AMOUNT / 2, "wallet refund");
        // Remainder to provider payout
        assertEq(token.balanceOf(PAYOUT),          payoutBefore + AMOUNT / 2, "provider remainder");
        // Bond returned to OWNER
        assertEq(token.balanceOf(OWNER),           ownerBefore  + BOND,      "bond returned");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.REFUNDED), "REFUNDED");
    }

    function test_AcceptDispute_NonProviderReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        vm.prank(makeAddr("notProvider"));
        vm.expectRevert(NotProvider.selector);
        vault.acceptDispute(sid);
    }

    function test_AcceptDispute_AlreadyResolvedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        vm.prank(PROVIDER);
        vault.acceptDispute(sid);

        vm.prank(PROVIDER);
        vm.expectRevert(NotInDisputedState.selector);
        vault.acceptDispute(sid);
    }

    // ─── 22. respondToDispute() ───────────────────────────────────────────────

    function test_RespondToDispute_HappyPath() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        bytes32 evHash = keccak256("evidence");
        vm.prank(PROVIDER);
        vm.expectEmit(true, false, false, true, address(vault));
        emit DisputeVault.ProviderResponded(sid, evHash);
        vault.respondToDispute(sid, evHash);

        DisputeVault.Dispute memory d = vault.getDispute(sid);
        assertTrue(d.providerResponded, "providerResponded");
        assertEq(d.providerEvidenceHash, evHash, "evidenceHash");
        assertTrue(d.arbiterDeadline > block.timestamp, "arbiterDeadline set");
    }

    function test_RespondToDispute_AlreadyRespondedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        vm.prank(PROVIDER);
        vm.expectRevert(ProviderAlreadyResponded.selector);
        vault.respondToDispute(sid, bytes32(0));
    }

    function test_RespondToDispute_AlreadyResolvedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        vm.prank(PROVIDER);
        vault.acceptDispute(sid);

        vm.prank(PROVIDER);
        vm.expectRevert(NotInDisputedState.selector);
        vault.respondToDispute(sid, bytes32(0));
    }

    // ─── 23. autoRefund() ────────────────────────────────────────────────────

    function test_AutoRefund_HappyPath() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        // Warp past response deadline (3 days)
        vm.warp(block.timestamp + 3 days + 1);

        uint256 walletBefore = token.balanceOf(address(wallet));
        uint256 ownerBefore  = token.balanceOf(OWNER);

        vm.expectEmit(true, false, false, true, address(vault));
        emit DisputeVault.AutoRefunded(sid, AMOUNT);
        vault.autoRefund(sid);

        assertEq(token.balanceOf(address(wallet)), walletBefore + AMOUNT, "wallet refunded");
        assertEq(token.balanceOf(OWNER),           ownerBefore  + BOND,  "bond returned");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.REFUNDED), "REFUNDED");
    }

    function test_AutoRefund_TooEarlyReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        vm.expectRevert(ArbiterDeadlineNotExpired.selector);
        vault.autoRefund(sid);
    }

    function test_AutoRefund_ProviderRespondedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);

        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        vm.warp(block.timestamp + 3 days + 1);
        vm.expectRevert(ProviderAlreadyResponded.selector);
        vault.autoRefund(sid);
    }

    // ─── 24. arbiterDecide() ─────────────────────────────────────────────────

    function test_ArbiterDecide_FullRefund() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        uint256 walletBefore = token.balanceOf(address(wallet));
        vm.prank(ARBITER);
        vault.arbiterDecide(sid, AMOUNT, 0, true);

        assertEq(token.balanceOf(address(wallet)), walletBefore + AMOUNT, "wallet full refund");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.REFUNDED), "REFUNDED");
    }

    function test_ArbiterDecide_FullRelease() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        uint256 payoutBefore = token.balanceOf(PAYOUT);
        vm.prank(ARBITER);
        vault.arbiterDecide(sid, 0, AMOUNT, false);

        assertEq(token.balanceOf(PAYOUT), payoutBefore + AMOUNT, "provider full release");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.RELEASED), "RELEASED");
    }

    function test_ArbiterDecide_PartialSplit() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        uint256 refund  = AMOUNT * 60 / 100;
        uint256 release = AMOUNT * 40 / 100;

        uint256 walletBefore = token.balanceOf(address(wallet));
        uint256 payoutBefore = token.balanceOf(PAYOUT);
        uint256 ownerBefore  = token.balanceOf(OWNER);

        vm.prank(ARBITER);
        vault.arbiterDecide(sid, refund, release, true);

        assertEq(token.balanceOf(address(wallet)), walletBefore + refund,  "wallet split");
        assertEq(token.balanceOf(PAYOUT),          payoutBefore + release, "provider split");
        assertEq(token.balanceOf(OWNER),           ownerBefore  + BOND,   "bond returned");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.SPLIT), "SPLIT");
    }

    function test_ArbiterDecide_SplitExceedsDisputedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT / 2);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        vm.prank(ARBITER);
        vm.expectRevert(SplitExceedsDisputed.selector);
        vault.arbiterDecide(sid, AMOUNT / 2 + 1, 0, true);
    }

    function test_ArbiterDecide_NonArbiterReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        vm.prank(makeAddr("notArbiter"));
        vm.expectRevert(NotArbiter.selector);
        vault.arbiterDecide(sid, AMOUNT, 0, true);
    }

    function test_ArbiterDecide_AlreadyResolvedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.acceptDispute(sid);

        vm.prank(ARBITER);
        vm.expectRevert(NotInDisputedState.selector);
        vault.arbiterDecide(sid, AMOUNT, 0, true);
    }

    // Bond forfeited to admin
    function test_ArbiterDecide_BondForfeitedToAdmin() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        uint256 adminBefore = token.balanceOf(ADMIN);
        vm.prank(ARBITER);
        vault.arbiterDecide(sid, 0, AMOUNT, false); // returnBond=false

        assertEq(token.balanceOf(ADMIN), adminBefore + BOND, "bond forfeited to admin");
    }

    // ─── 25. arbiterTimeout() ────────────────────────────────────────────────

    function test_ArbiterTimeout_HappyPath() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        // Warp past arbiter deadline (openedAt + responseDeadline + arbiterDeadline)
        uint256 arbiterDeadline = vault.getDispute(sid).arbiterDeadline;
        vm.warp(arbiterDeadline + 1);

        uint256 walletBefore = token.balanceOf(address(wallet));
        uint256 ownerBefore  = token.balanceOf(OWNER);

        vm.expectEmit(true, false, false, true, address(vault));
        emit DisputeVault.ArbiterTimedOut(sid, AMOUNT);
        vault.arbiterTimeout(sid);

        assertEq(token.balanceOf(address(wallet)), walletBefore + AMOUNT, "wallet refunded");
        assertEq(token.balanceOf(OWNER),           ownerBefore  + BOND,  "bond returned");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.REFUNDED), "REFUNDED");
    }

    function test_ArbiterTimeout_TooEarlyReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        vm.expectRevert(ArbiterDeadlineNotExpired.selector);
        vault.arbiterTimeout(sid);
    }

    function test_ArbiterTimeout_ProviderNotRespondedReverts() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        // Do NOT call respondToDispute
        vm.warp(block.timestamp + 3 days + 3 days + 1);
        vm.expectRevert(ArbiterDeadlineNotExpired.selector);
        vault.arbiterTimeout(sid);
    }

    // ─── Dispute hardening regressions ──────────────────────────────────────

    function test_ResponseBoundary_LastSecondAllowed() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.warp(vault.getDispute(sid).responseDeadline - 1);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));
        assertTrue(vault.getDispute(sid).providerResponded);
    }

    function test_ResponseBoundary_ExactDeadlineRefundWins() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.warp(vault.getDispute(sid).responseDeadline);
        vm.prank(PROVIDER);
        vm.expectRevert(DisputeVault.ResponseDeadlineExpired.selector);
        vault.respondToDispute(sid, bytes32(0));
        vm.prank(ARBITER);
        vm.expectRevert(DisputeVault.ProviderNotResponded.selector);
        vault.arbiterDecide(sid, 0, AMOUNT, false);
        vault.autoRefund(sid);
        assertTrue(vault.getDispute(sid).resolved);
    }

    function test_ArbiterCannotDecideBeforeProviderResponds() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(ARBITER);
        vm.expectRevert(DisputeVault.ProviderNotResponded.selector);
        vault.arbiterDecide(sid, 0, AMOUNT, false);
    }

    function test_ArbiterBoundary_LastSecondAllowed() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));
        vm.warp(vault.getDispute(sid).arbiterDeadline - 1);
        vm.prank(ARBITER);
        vault.arbiterDecide(sid, AMOUNT, 0, true);
        assertTrue(vault.getDispute(sid).resolved);
    }

    function test_ArbiterBoundary_ExactDeadlineTimeoutWins() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));
        vm.warp(vault.getDispute(sid).arbiterDeadline);
        vm.prank(ARBITER);
        vm.expectRevert(DisputeVault.ArbiterDeadlineExpired.selector);
        vault.arbiterDecide(sid, 0, AMOUNT, false);
        vault.arbiterTimeout(sid);
        assertTrue(vault.getDispute(sid).resolved);
    }

    function test_ProviderPreferenceChangeOnlyAffectsFutureSettlements() public {
        bytes32 first = _receiveSettlement(AMOUNT, WINDOW);
        address replacement = makeAddr("replacement");
        vm.startPrank(PROVIDER);
        provRegistry.updateArbiter(replacement);
        provRegistry.updatePayoutAddress(replacement);
        vm.stopPrank();
        _openDispute(first, AMOUNT);
        assertEq(vault.getSettlement(first).arbiter, ARBITER);
        assertEq(vault.getSettlement(first).payoutAddress, PAYOUT);
        vm.roll(block.number + 1);
        bytes32 second = _receiveSettlement(AMOUNT, WINDOW);
        assertEq(vault.getSettlement(second).arbiter, replacement);
        assertEq(vault.getSettlement(second).payoutAddress, replacement);
    }

    function test_DefaultArbiterRotationDoesNotChangeExistingSettlement() public {
        vm.prank(PROVIDER);
        provRegistry.updateArbiter(address(0));
        bytes32 first = _receiveSettlement(AMOUNT, WINDOW);
        address replacement = makeAddr("defaultReplacement");
        vm.prank(ADMIN);
        vault.transferDefaultArbiter(replacement);
        vm.prank(replacement);
        vault.acceptDefaultArbiter();
        _openDispute(first, AMOUNT);
        vm.prank(PROVIDER);
        vault.respondToDispute(first, bytes32(0));
        vm.prank(replacement);
        vm.expectRevert(NotArbiter.selector);
        vault.arbiterDecide(first, 0, AMOUNT, false);
        vm.prank(ARBITER);
        vault.arbiterDecide(first, AMOUNT, 0, true);
        vm.roll(block.number + 1);
        bytes32 second = _receiveSettlement(AMOUNT, WINDOW);
        assertEq(vault.getSettlement(second).arbiter, replacement);
    }

    function test_UndisputedReleaseMustWaitAndCannotRepeatOrRunAfterResolution() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT / 2);
        vm.expectRevert(ReleaseWindowNotElapsed.selector);
        vault.releaseUndisputed(sid);
        vm.warp(vault.getSettlement(sid).releaseAfter);
        vm.prank(makeAddr("anyone"));
        vault.releaseUndisputed(sid);
        assertEq(token.balanceOf(PAYOUT), AMOUNT / 2);
        assertEq(token.balanceOf(address(vault)), AMOUNT / 2 + BOND);
        vm.expectRevert(DisputeVault.NoUndisputedFunds.selector);
        vault.releaseUndisputed(sid);
        vm.prank(PROVIDER);
        vault.acceptDispute(sid);
        vm.expectRevert(NotInDisputedState.selector);
        vault.releaseUndisputed(sid);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function test_FullDisputeHasNoUndisputedRelease() public {
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(sid, AMOUNT);
        vm.warp(vault.getSettlement(sid).releaseAfter);
        vm.expectRevert(DisputeVault.NoUndisputedFunds.selector);
        vault.releaseUndisputed(sid);
        assertEq(token.balanceOf(address(vault)), AMOUNT + BOND);
    }

    function testFuzz_PartialReleaseConservesFundsAcrossEveryResolution(uint256 disputed, uint8 path) public {
        disputed = bound(disputed, 2, AMOUNT - 1);
        path = uint8(bound(path, 0, 3));
        bytes32 sid = _receiveSettlement(AMOUNT, WINDOW);
        uint256 walletBefore = token.balanceOf(address(wallet));
        _openDispute(sid, disputed);
        address replacement = makeAddr("changedPayout");
        vm.prank(PROVIDER);
        provRegistry.updatePayoutAddress(replacement);
        vm.warp(vault.getSettlement(sid).releaseAfter);
        vault.releaseUndisputed(sid);
        assertEq(token.balanceOf(address(vault)), disputed + BOND);
        uint256 refund = disputed;
        if (path == 0) {
            vm.prank(PROVIDER);
            vault.acceptDispute(sid);
        } else if (path == 1) {
            vm.warp(vault.getDispute(sid).responseDeadline);
            vault.autoRefund(sid);
        } else {
            vm.prank(PROVIDER);
            vault.respondToDispute(sid, bytes32(0));
            if (path == 2) {
                refund = disputed / 2;
                vm.prank(ARBITER);
                vault.arbiterDecide(sid, refund, disputed - refund, true);
            } else {
                vm.warp(vault.getDispute(sid).arbiterDeadline);
                vault.arbiterTimeout(sid);
            }
        }
        assertEq(token.balanceOf(address(wallet)), walletBefore + refund);
        assertEq(token.balanceOf(PAYOUT), AMOUNT - refund);
        assertEq(token.balanceOf(replacement), 0);
        assertEq(token.balanceOf(OWNER), BOND);
        assertEq(token.balanceOf(address(vault)), 0);
        assertEq(vault.getSettlement(sid).undisputedReleased, AMOUNT - disputed);
        assertTrue(vault.getDispute(sid).resolved);
        vm.prank(PROVIDER);
        vm.expectRevert(NotInDisputedState.selector);
        vault.acceptDispute(sid);
    }

    function test_PartialReleaseThenProviderWinsCannotSpendAnotherSettlementsFunds() public {
        bytes32 first = _receiveSettlement(AMOUNT, WINDOW);
        _openDispute(first, AMOUNT / 2);
        vm.roll(block.number + 1);
        bytes32 second = _receiveSettlement(AMOUNT, WINDOW);
        vm.warp(vault.getSettlement(first).releaseAfter);
        vault.releaseUndisputed(first);
        vm.prank(PROVIDER);
        vault.respondToDispute(first, bytes32(0));
        uint256 treasuryBefore = token.balanceOf(ADMIN);
        vm.prank(ARBITER);
        vault.arbiterDecide(first, 0, AMOUNT / 2, false);
        assertEq(token.balanceOf(PAYOUT), AMOUNT);
        assertEq(token.balanceOf(ADMIN), treasuryBefore + BOND);
        assertEq(token.balanceOf(address(vault)), AMOUNT);
        assertEq(uint8(vault.getSettlement(second).state), uint8(DisputeVault.SettlementState.HELD));
        vault.release(second);
        assertEq(token.balanceOf(PAYOUT), AMOUNT * 2);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    // ─── 26. Invariant test placeholder ──────────────────────────────────────
    // See AgentWalletV3.Invariant.t.sol for the full invariant test
}

// ─── Invariant handler ───────────────────────────────────────────────────────

contract DisputeVaultInvariantHandler is Test {
    DisputeVault       public vault;
    ProviderRegistry   public provRegistry;
    ReputationRegistry public repRegistry;
    MockERC20          public token;
    MinimalWallet      public wallet;

    address public OWNER    = makeAddr("inv_owner");
    address public PROVIDER = makeAddr("inv_provider");
    address public PAYOUT   = makeAddr("inv_payout");
    address public ARBITER  = makeAddr("inv_arbiter");
    address public ADMIN    = makeAddr("inv_admin");

    uint256 public ghost_heldPlusDisputed;

    bytes32[] public allSettlementIds;
    mapping(bytes32 => bool) public idExists;
    uint256 public nonce;

    constructor() {
        token = new MockERC20("Mock USDC", "mUSDC", 6);

        vm.prank(ADMIN);
        provRegistry = new ProviderRegistry();

        vm.prank(ADMIN);
        repRegistry = new ReputationRegistry();

        vm.prank(ADMIN);
        vault = new DisputeVault(ARBITER, address(provRegistry), address(repRegistry));

        vm.prank(ADMIN);
        repRegistry.setTrustedCaller(address(vault), true);

        wallet = new MinimalWallet(OWNER, address(vault));

        vm.prank(ADMIN);
        vault.setTrustedWallet(address(wallet), true);

        vm.prank(PROVIDER);
        provRegistry.register(PAYOUT, keccak256("meta"), 300, ARBITER);

        token.mint(address(wallet), 1_000_000e6);
    }

    function settleNew(uint256 amount) external {
        amount = bound(amount, 1e6, 10_000e6);
        nonce++;
        bytes32 sid = keccak256(abi.encode(nonce));
        if (idExists[sid]) return;

        // Transfer tokens to vault
        if (token.balanceOf(address(wallet)) < amount) return;
        vm.prank(address(wallet));
        token.transfer(address(vault), amount);

        vm.prank(address(wallet));
        vault.receiveSettlement(sid, address(wallet), PROVIDER, address(token), amount, 300);

        idExists[sid] = true;
        allSettlementIds.push(sid);
        ghost_heldPlusDisputed += amount;
    }

    function releaseSid(uint256 idx) external {
        if (allSettlementIds.length == 0) return;
        idx = idx % allSettlementIds.length;
        bytes32 sid = allSettlementIds[idx];
        DisputeVault.Settlement memory s = vault.getSettlement(sid);
        if (s.state != DisputeVault.SettlementState.HELD) return;
        if (block.timestamp < s.releaseAfter) {
            vm.warp(s.releaseAfter + 1);
        }
        vault.release(sid);
        ghost_heldPlusDisputed -= s.amount;
    }
}

contract DisputeVaultInvariantTest is Test {
    DisputeVaultInvariantHandler internal handler;

    function setUp() public {
        handler = new DisputeVaultInvariantHandler();
        targetContract(address(handler));
    }

    /// @notice Vault's token balance >= sum of all HELD+DISPUTED settlement amounts
    function invariant_VaultBalanceGeSumHeldDisputed() public view {
        uint256 vaultBal = handler.token().balanceOf(address(handler.vault()));
        // Ghost tracks held+disputed; should never exceed actual balance
        assertGe(vaultBal, handler.ghost_heldPlusDisputed(), "vault balance invariant violated");
    }
}
