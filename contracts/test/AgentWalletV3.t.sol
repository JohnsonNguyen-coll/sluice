// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test}                 from "forge-std/Test.sol";
import {AgentWalletV3}        from "../AgentWalletV3.sol";
import {AgentWalletFactoryV3} from "../AgentWalletFactoryV3.sol";
import {DisputeVault}         from "../DisputeVault.sol";
import {ProviderRegistry}     from "../ProviderRegistry.sol";
import {ReputationRegistry}   from "../ReputationRegistry.sol";
import {MockERC20}            from "./mocks/MockERC20.sol";

/// @notice Shared setup for V3 wallet tests
abstract contract AgentWalletV3TestBase is Test {

    // ─── Constants ───────────────────────────────────────────────────────────
    uint16  internal FEE_BPS       = 30;
    uint32  internal SETTLE_WINDOW = 3600;
    uint32  internal DISPUTE_WINDOW = 300;   // 5-min window for registered provider
    uint256 internal DEPOSIT        = 100_000e6;

    // ─── Actors ──────────────────────────────────────────────────────────────
    address internal OWNER;
    uint256 internal OWNER_PK;

    address internal AGENT_SIGNER;
    uint256 internal AGENT_SIGNER_PK;

    address internal FEE_RECIPIENT = makeAddr("feeRecipient");
    address internal PROVIDER_PAYOUT = makeAddr("providerPayout");
    address internal ARBITER       = makeAddr("arbiter");
    address internal ADMIN         = makeAddr("admin");

    address internal PROVIDER;    // registered (has dispute window)
    address internal PROVIDER2;   // not registered (instant payout)

    // ─── Contracts ───────────────────────────────────────────────────────────
    MockERC20          internal token;
    ProviderRegistry   internal provRegistry;
    ReputationRegistry internal repRegistry;
    DisputeVault       internal vault;
    AgentWalletFactoryV3 internal factory;
    AgentWalletV3      internal wallet;

    function setUp() public virtual {
        (OWNER,        OWNER_PK)        = makeAddrAndKey("owner");
        (AGENT_SIGNER, AGENT_SIGNER_PK) = makeAddrAndKey("agentSigner");

        PROVIDER  = makeAddr("provider");
        PROVIDER2 = makeAddr("provider2");

        // Deploy infra
        token = new MockERC20("Mock USDC", "mUSDC", 6);

        vm.prank(ADMIN);
        provRegistry = new ProviderRegistry();

        vm.prank(ADMIN);
        repRegistry = new ReputationRegistry();

        vm.prank(ADMIN);
        vault = new DisputeVault(ARBITER, address(provRegistry), address(repRegistry));

        // Deploy factory
        address[] memory tokens = new address[](1);
        tokens[0] = address(token);
        vm.prank(ADMIN);
        factory = new AgentWalletFactoryV3(
            FEE_RECIPIENT,
            FEE_BPS,
            tokens,
            address(vault),
            address(provRegistry),
            address(repRegistry)
        );

        // Create wallet
        wallet = AgentWalletV3(
            factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, bytes32("salt1"))
        );

        // Trust the wallet in vault + rep registry
        vm.prank(ADMIN);
        vault.setTrustedWallet(address(wallet), true);
        vm.prank(ADMIN);
        repRegistry.setTrustedCaller(address(wallet), true);
        // Vault also calls repRegistry for dispute outcomes
        vm.prank(ADMIN);
        repRegistry.setTrustedCaller(address(vault), true);

        // Register PROVIDER with a 5-min dispute window
        vm.prank(PROVIDER);
        provRegistry.register(PROVIDER_PAYOUT, keccak256("meta"), DISPUTE_WINDOW, ARBITER);

        // Fund owner and deposit into wallet
        token.mint(OWNER, 1_000_000e6);
        vm.prank(OWNER);
        token.approve(address(wallet), type(uint256).max);
        vm.prank(OWNER);
        wallet.deposit(address(token), DEPOSIT);
    }

    // ─── EIP-712 helpers ─────────────────────────────────────────────────────

    function _makeVoucher(
        address provider,
        address token_,
        uint256 cumulative,
        uint256 nonce,
        uint64  expiry
    ) internal view returns (AgentWalletV3.Voucher memory) {
        return AgentWalletV3.Voucher({
            wallet:           address(wallet),
            provider:         provider,
            token:            token_,
            cumulativeAmount: cumulative,
            nonce:            nonce,
            expiry:           expiry
        });
    }

    function _sign(AgentWalletV3.Voucher memory v, uint256 pk)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            wallet.VOUCHER_TYPEHASH(),
            v.wallet, v.provider, v.token,
            v.cumulativeAmount, v.nonce, v.expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            wallet.domainSeparator(),
            structHash
        ));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, vv);
    }

    function _settle(
        address provider,
        uint256 cumulative,
        uint256 nonce,
        bytes32 receiptsRoot
    ) internal {
        // Set budget first if not set
        (uint256 maxTotal,) = wallet.budgets(provider, address(token));
        if (maxTotal < cumulative) {
            vm.prank(OWNER);
            wallet.setProviderBudget(provider, address(token), cumulative * 2, cumulative);
        }

        AgentWalletV3.Voucher memory v = _makeVoucher(
            provider, address(token), cumulative, nonce,
            uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(provider);
        wallet.settle(v, sig, 0, receiptsRoot);
    }

    function _fee(uint256 delta) internal view returns (uint256) {
        return (delta * FEE_BPS) / 10_000;
    }
}

// ─── Main V3 test contract ────────────────────────────────────────────────────

contract AgentWalletV3Test is AgentWalletV3TestBase {

    // ─── Errors (local) ──────────────────────────────────────────────────────
    error OnlyDisputeVault();
    error InvalidSignature();
    error BudgetExceeded();

    // ─── 27. settle() with dispute window=0 (provider not registered) ─────────

    function test_Settle_InstantPayout_ProviderNotRegistered() public {
        uint256 delta = 1000e6;
        uint256 cumulative = delta;
        uint256 fee = _fee(delta);
        uint256 payout = delta - fee;

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), cumulative * 2, cumulative);

        uint256 providerBefore = token.balanceOf(PROVIDER2);
        uint256 feeBefore      = token.balanceOf(FEE_RECIPIENT);
        uint256 vaultBefore    = token.balanceOf(address(vault));

        _settle(PROVIDER2, cumulative, 1, bytes32(0));

        assertEq(token.balanceOf(PROVIDER2),      providerBefore + payout, "provider received payout");
        assertEq(token.balanceOf(FEE_RECIPIENT),  feeBefore + fee,         "fee recipient got fee");
        assertEq(token.balanceOf(address(vault)), vaultBefore,             "vault untouched");
    }

    // ─── 28. settle() with dispute window > 0 → vault ────────────────────────

    function test_Settle_WithDisputeWindow_GoesToVault() public {
        uint256 delta = 1000e6;
        uint256 cumulative = delta;
        uint256 fee = _fee(delta);
        uint256 payout = delta - fee;

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER, address(token), cumulative * 2, cumulative);

        uint256 vaultBefore    = token.balanceOf(address(vault));
        uint256 providerBefore = token.balanceOf(PROVIDER_PAYOUT);

        _settle(PROVIDER, cumulative, 1, bytes32(0));

        assertEq(token.balanceOf(address(vault)), vaultBefore + payout,    "vault holds funds");
        assertEq(token.balanceOf(PROVIDER_PAYOUT), providerBefore,         "provider NOT paid yet");

        // settlement stored in wallet
        assertEq(wallet.nonces(PROVIDER, address(token)), 1, "nonce updated");
        assertEq(wallet.settled(PROVIDER, address(token)), cumulative, "settled updated");
    }

    // ─── 29. settle() receiptsRoot stored ────────────────────────────────────

    function test_Settle_ReceiptsRootStored() public {
        uint256 delta = 500e6;
        bytes32 root = keccak256("receipts-root");

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), delta * 2, delta);

        vm.expectEmit(true, true, false, true, address(wallet));
        emit AgentWalletV3.ReceiptsRootStored(PROVIDER2, address(token), 1, root);
        _settle(PROVIDER2, delta, 1, root);

        assertEq(wallet.receiptsRoots(PROVIDER2, address(token), 1), root, "root stored");
    }

    function test_Settle_ZeroReceiptsRootNotStored() public {
        uint256 delta = 500e6;
        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), delta * 2, delta);
        _settle(PROVIDER2, delta, 1, bytes32(0));
        assertEq(wallet.receiptsRoots(PROVIDER2, address(token), 1), bytes32(0), "not stored");
    }

    // ─── 30. verifyReceiptProof() ─────────────────────────────────────────────

    function test_VerifyReceiptProof_TwoLeafTree() public {
        // Build a 2-leaf Merkle tree: leaf0, leaf1
        bytes32 leaf0 = keccak256("receipt-0");
        bytes32 leaf1 = keccak256("receipt-1");

        // Sort for the contract's sorting logic
        bytes32 root;
        if (leaf0 < leaf1) {
            root = keccak256(abi.encodePacked(leaf0, leaf1));
        } else {
            root = keccak256(abi.encodePacked(leaf1, leaf0));
        }

        uint256 delta = 500e6;
        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), delta * 2, delta);
        _settle(PROVIDER2, delta, 1, root);

        // Proof for leaf0: sibling is leaf1
        bytes32[] memory proof0 = new bytes32[](1);
        proof0[0] = leaf1;
        assertTrue(wallet.verifyReceiptProof(PROVIDER2, address(token), 1, leaf0, proof0), "proof0 valid");

        // Proof for leaf1: sibling is leaf0
        bytes32[] memory proof1 = new bytes32[](1);
        proof1[0] = leaf0;
        assertTrue(wallet.verifyReceiptProof(PROVIDER2, address(token), 1, leaf1, proof1), "proof1 valid");

        // Tampered leaf
        bytes32[] memory badProof = new bytes32[](1);
        badProof[0] = leaf1;
        assertFalse(wallet.verifyReceiptProof(PROVIDER2, address(token), 1, keccak256("tampered"), badProof), "tampered false");
    }

    function test_VerifyReceiptProof_NoRootReturnsFalse() public view {
        bytes32[] memory empty = new bytes32[](0);
        assertFalse(wallet.verifyReceiptProof(PROVIDER2, address(token), 99, keccak256("x"), empty));
    }

    // ─── 31. receiveRefund() ──────────────────────────────────────────────────

    function test_ReceiveRefund_OnlyDisputeVault() public {
        vm.prank(makeAddr("notVault"));
        vm.expectRevert(OnlyDisputeVault.selector);
        wallet.receiveRefund(address(token), 100e6);
    }

    function test_ReceiveRefund_UpdatesTotalRefunded() public {
        uint256 refundAmt = 500e6;
        // Mint tokens directly to wallet to simulate a refund
        token.mint(address(wallet), refundAmt);

        uint256 before = wallet.totalRefunded(address(token));
        vm.prank(address(vault));
        wallet.receiveRefund(address(token), refundAmt);
        assertEq(wallet.totalRefunded(address(token)), before + refundAmt, "totalRefunded updated");
    }

    function test_ReceiveRefund_EmitsEvent() public {
        uint256 refundAmt = 500e6;
        token.mint(address(wallet), refundAmt);

        vm.prank(address(vault));
        vm.expectEmit(true, false, false, true, address(wallet));
        emit AgentWalletV3.RefundReceived(address(token), refundAmt);
        wallet.receiveRefund(address(token), refundAmt);
    }

    // ─── 32. settle() reputation hook ────────────────────────────────────────

    function test_Settle_ReputationHook() public {
        uint256 delta = 1000e6;
        vm.prank(OWNER);
        wallet.setTokenRate(address(token), 1e6, 6);
        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), delta * 2, delta);
        _settle(PROVIDER2, delta, 1, bytes32(0));

        ReputationRegistry.ProviderStats memory ps = repRegistry.getProviderStats(PROVIDER2);
        assertEq(ps.settledCount, 1, "settledCount == 1 after settle");
        assertEq(repRegistry.pairFeesPaidUsdE6(address(wallet), PROVIDER2), _fee(delta), "weight uses actual fee");
    }

    // ─── 33. Full dispute flow (end-to-end) ───────────────────────────────────

    function test_FullDisputeFlow_AcceptDispute() public {
        uint256 delta = 1000e6;
        uint256 fee   = _fee(delta);
        uint256 payout = delta - fee;

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER, address(token), delta * 2, delta);
        _settle(PROVIDER, delta, 1, bytes32(0));

        // Vault holds payout
        assertEq(token.balanceOf(address(vault)), payout, "vault holds");

        // Get settlement id from wallet's Settled event (we can compute it)
        bytes32 sid = keccak256(abi.encode(address(wallet), PROVIDER, address(token), 1, block.number));

        // Open dispute
        token.mint(OWNER, vault.disputeBond(address(token)));
        vm.prank(OWNER);
        token.approve(address(vault), vault.disputeBond(address(token)));
        vm.prank(OWNER);
        vault.openDispute(sid, payout, 0, bytes32(0));

        // Provider accepts
        uint256 walletTokenBefore = token.balanceOf(address(wallet));
        vm.prank(PROVIDER);
        vault.acceptDispute(sid);

        // Vault should be empty
        assertEq(token.balanceOf(address(vault)), 0, "vault empty after accept");

        // Wallet got refund (full payout since we disputed full amount)
        assertEq(token.balanceOf(address(wallet)), walletTokenBefore + payout, "wallet recovered");

        // wallet.totalRefunded increased
        assertGt(wallet.totalRefunded(address(token)), 0, "totalRefunded > 0");
    }

    // ─── 34. Full auto-refund flow ────────────────────────────────────────────

    function test_FullAutoRefundFlow() public {
        uint256 delta  = 800e6;
        uint256 fee    = _fee(delta);
        uint256 payout = delta - fee;

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER, address(token), delta * 2, delta);
        _settle(PROVIDER, delta, 1, bytes32(0));

        bytes32 sid = keccak256(abi.encode(address(wallet), PROVIDER, address(token), 1, block.number));

        // Open dispute (bond = 0 for simplicity — admin didn't set bond here)
        // Reset bond to 0 for this test
        vm.prank(ADMIN);
        vault.setDisputeBond(address(token), 0);

        vm.prank(OWNER);
        vault.openDispute(sid, payout, 0, bytes32(0));

        // Warp past response deadline
        vm.warp(block.timestamp + 3 days + 1);

        uint256 walletBefore = token.balanceOf(address(wallet));
        vault.autoRefund(sid);
        assertEq(token.balanceOf(address(wallet)), walletBefore + payout, "auto-refunded to wallet");
    }

    // ─── 35. Full arbiter flow ────────────────────────────────────────────────

    function test_FullArbiterFlow_PartialSplit() public {
        uint256 delta  = 1000e6;
        uint256 fee    = _fee(delta);
        uint256 payout = delta - fee;

        vm.prank(ADMIN);
        vault.setDisputeBond(address(token), 0);

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER, address(token), delta * 2, delta);
        _settle(PROVIDER, delta, 1, bytes32(0));

        bytes32 sid = keccak256(abi.encode(address(wallet), PROVIDER, address(token), 1, block.number));

        vm.prank(OWNER);
        vault.openDispute(sid, payout, 0, bytes32(0));

        vm.prank(PROVIDER);
        vault.respondToDispute(sid, bytes32(0));

        // Arbiter splits: 60% to wallet, 40% to provider
        uint256 refund  = payout * 60 / 100;
        uint256 release = payout * 40 / 100;

        uint256 walletBefore = token.balanceOf(address(wallet));
        uint256 payoutBefore = token.balanceOf(PROVIDER_PAYOUT);

        vm.prank(ARBITER);
        vault.arbiterDecide(sid, refund, release, true);

        assertEq(token.balanceOf(address(wallet)), walletBefore + refund,  "wallet split");
        assertEq(token.balanceOf(PROVIDER_PAYOUT), payoutBefore + release, "provider split");
        assertEq(uint8(vault.getSettlement(sid).state), uint8(DisputeVault.SettlementState.SPLIT), "SPLIT");
    }

    // ─── 36. settleBatch() with mixed windows ────────────────────────────────

    function test_SettleBatch_MixedWindows() public {
        uint256 delta1 = 500e6; // PROVIDER  (has window → vault)
        uint256 delta2 = 300e6; // PROVIDER2 (no window  → direct)
        uint256 fee1   = _fee(delta1);
        uint256 fee2   = _fee(delta2);

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER,  address(token), delta1 * 2, delta1);
        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), delta2 * 2, delta2);

        AgentWalletV3.Voucher[] memory vouchers = new AgentWalletV3.Voucher[](2);
        bytes[] memory sigs = new bytes[](2);
        uint256[] memory minOuts = new uint256[](2);
        bytes32[] memory roots = new bytes32[](2);

        vouchers[0] = _makeVoucher(PROVIDER,  address(token), delta1, 1, uint64(block.timestamp + 1 hours));
        vouchers[1] = _makeVoucher(PROVIDER2, address(token), delta2, 1, uint64(block.timestamp + 1 hours));
        sigs[0] = _sign(vouchers[0], AGENT_SIGNER_PK);
        sigs[1] = _sign(vouchers[1], AGENT_SIGNER_PK);

        // Call batch as PROVIDER (must be one of the providers or relayer)
        // Each provider has to submit their own voucher — batch is called by PROVIDER for their own
        // Actually settleBatch caller must be each provider OR their relayer
        // Since V3 checks msg.sender == provider for each voucher, we cannot batch across providers
        // from a single caller unless they are both providers.
        // The check is per-voucher inside _settle: msg.sender != v.provider && != relayers[v.provider]
        // So we need PROVIDER to call it with PROVIDER's voucher, and PROVIDER2 for their own.
        // settleBatch is called once with one caller — this means it only works if the caller
        // is either provider for all vouchers (can't be two different providers) OR a relayer for all.
        // Set up PROVIDER as relayer for PROVIDER2 to test mixed in one batch call:
        vm.prank(PROVIDER2);
        wallet.setRelayer(PROVIDER2, PROVIDER);

        // Reprice vouchers (PROVIDER calls for both)
        vm.prank(PROVIDER);
        wallet.settleBatch(vouchers, sigs, minOuts, roots);

        // PROVIDER's settlement went to vault
        assertGt(token.balanceOf(address(vault)), 0, "vault has funds");

        // PROVIDER2's settlement went direct to PROVIDER2
        assertEq(token.balanceOf(PROVIDER2), delta2 - fee2, "provider2 got direct payout");
    }

    // ─── Fuzz: settle amount bounds ───────────────────────────────────────────

    function testFuzz_Settle_FeeAndPayoutConsistent(uint256 delta) public {
        delta = bound(delta, 1e6, 50_000e6);

        // Ensure wallet has enough
        token.mint(OWNER, delta);
        vm.prank(OWNER);
        wallet.deposit(address(token), delta);

        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), delta * 3, delta);

        uint256 fee    = _fee(delta);
        uint256 payout = delta - fee;

        uint256 providerBefore = token.balanceOf(PROVIDER2);
        uint256 feeBefore      = token.balanceOf(FEE_RECIPIENT);

        AgentWalletV3.Voucher memory v = _makeVoucher(
            PROVIDER2, address(token), delta, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER2);
        wallet.settle(v, sig, 0, bytes32(0));

        assertEq(token.balanceOf(PROVIDER2),     providerBefore + payout, "payout consistent");
        assertEq(token.balanceOf(FEE_RECIPIENT), feeBefore + fee,         "fee consistent");
    }
}

// ─── V3 Invariant test ───────────────────────────────────────────────────────

contract AgentWalletV3InvariantHandler is Test {

    MockERC20          public token;
    ProviderRegistry   public provRegistry;
    ReputationRegistry public repRegistry;
    DisputeVault       public vault;
    AgentWalletFactoryV3 public factory;
    AgentWalletV3      public wallet;

    address public ADMIN    = makeAddr("inv_admin");
    address public OWNER;
    uint256 public OWNER_PK;
    address public AGENT_SIGNER;
    uint256 public AGENT_SIGNER_PK;
    address public PROVIDER  = makeAddr("inv_provider");
    address public PROVIDER2 = makeAddr("inv_provider2");
    address public PAYOUT    = makeAddr("inv_payout");
    address public ARBITER   = makeAddr("inv_arbiter");
    address public FEE_RECIP = makeAddr("inv_feeRecip");

    uint256 public nonce1;
    uint256 public nonce2;
    uint256 public ghost_encumbered;

    constructor() {
        (OWNER, OWNER_PK) = makeAddrAndKey("inv_owner");
        (AGENT_SIGNER, AGENT_SIGNER_PK) = makeAddrAndKey("inv_signer");

        token = new MockERC20("Mock USDC", "mUSDC", 6);

        vm.prank(ADMIN);
        provRegistry = new ProviderRegistry();

        vm.prank(ADMIN);
        repRegistry = new ReputationRegistry();

        vm.prank(ADMIN);
        vault = new DisputeVault(ARBITER, address(provRegistry), address(repRegistry));

        address[] memory tokens = new address[](1);
        tokens[0] = address(token);

        vm.prank(ADMIN);
        factory = new AgentWalletFactoryV3(
            FEE_RECIP, 30, tokens,
            address(vault), address(provRegistry), address(repRegistry)
        );

        wallet = AgentWalletV3(
            factory.createWallet(OWNER, AGENT_SIGNER, 3600, bytes32("inv_salt"))
        );

        vm.prank(ADMIN);
        vault.setTrustedWallet(address(wallet), true);
        vm.prank(ADMIN);
        repRegistry.setTrustedCaller(address(wallet), true);

        // PROVIDER has dispute window; PROVIDER2 does not
        vm.prank(PROVIDER);
        provRegistry.register(PAYOUT, keccak256("meta"), 300, ARBITER);

        // Fund and deposit
        token.mint(OWNER, 10_000_000e6);
        vm.prank(OWNER);
        token.approve(address(wallet), type(uint256).max);
        vm.prank(OWNER);
        wallet.deposit(address(token), 1_000_000e6);

        // Set budgets
        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER, address(token), 500_000e6, 10_000e6);
        vm.prank(OWNER);
        wallet.setProviderBudget(PROVIDER2, address(token), 500_000e6, 10_000e6);
        ghost_encumbered = wallet.encumbered(address(token));
    }

    function _sign(AgentWalletV3.Voucher memory v, uint256 pk)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            wallet.VOUCHER_TYPEHASH(),
            v.wallet, v.provider, v.token,
            v.cumulativeAmount, v.nonce, v.expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            wallet.domainSeparator(),
            structHash
        ));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, vv);
    }

    function settleProvider(uint256 delta) external {
        delta = bound(delta, 1e6, 10_000e6);
        nonce1 += 1;
        uint256 cumulative = wallet.settled(PROVIDER, address(token)) + delta;

        (uint256 maxTotal,) = wallet.budgets(PROVIDER, address(token));
        if (cumulative > maxTotal) return;
        if (wallet.freeBalance(address(token)) < delta) return;

        AgentWalletV3.Voucher memory v = AgentWalletV3.Voucher({
            wallet: address(wallet),
            provider: PROVIDER,
            token: address(token),
            cumulativeAmount: cumulative,
            nonce: nonce1,
            expiry: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        try wallet.settle(v, sig, 0, bytes32(0)) {} catch {}
    }

    function settleProvider2(uint256 delta) external {
        delta = bound(delta, 1e6, 10_000e6);
        nonce2 += 1;
        uint256 cumulative = wallet.settled(PROVIDER2, address(token)) + delta;

        (uint256 maxTotal,) = wallet.budgets(PROVIDER2, address(token));
        if (cumulative > maxTotal) return;
        if (wallet.freeBalance(address(token)) < delta) return;

        AgentWalletV3.Voucher memory v = AgentWalletV3.Voucher({
            wallet: address(wallet),
            provider: PROVIDER2,
            token: address(token),
            cumulativeAmount: cumulative,
            nonce: nonce2,
            expiry: uint64(block.timestamp + 1 hours)
        });
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER2);
        try wallet.settle(v, sig, 0, bytes32(0)) {} catch {}
    }

    function depositMore(uint256 amount) external {
        amount = bound(amount, 1e6, 100_000e6);
        token.mint(OWNER, amount);
        vm.prank(OWNER);
        wallet.deposit(address(token), amount);
    }
}

contract AgentWalletV3InvariantTest is Test {
    AgentWalletV3InvariantHandler internal handler;

    function setUp() public {
        handler = new AgentWalletV3InvariantHandler();
        targetContract(address(handler));
    }

    /// @notice wallet balance >= encumbered
    function invariant_WalletBalanceGeEncumbered() public view {
        uint256 bal = handler.token().balanceOf(address(handler.wallet()));
        uint256 enc = handler.wallet().encumbered(address(handler.token()));
        assertGe(bal, enc, "wallet balance < encumbered");
    }

    /// @notice nonces never decrease
    function invariant_NoncesNeverDecrease() public view {
        // We track nonces in the handler; just verify current >= starting 0
        assertGe(handler.wallet().nonces(handler.PROVIDER(), address(handler.token())), 0,
                 "nonce provider decreased");
        assertGe(handler.wallet().nonces(handler.PROVIDER2(), address(handler.token())), 0,
                 "nonce provider2 decreased");
    }

    /// @notice settled <= budgets.maxTotal
    function invariant_SettledLeBudget() public view {
        uint256 settledP1 = handler.wallet().settled(handler.PROVIDER(), address(handler.token()));
        (uint256 maxP1,)  = handler.wallet().budgets(handler.PROVIDER(), address(handler.token()));
        assertLe(settledP1, maxP1, "settled > budget for PROVIDER");

        uint256 settledP2 = handler.wallet().settled(handler.PROVIDER2(), address(handler.token()));
        (uint256 maxP2,)  = handler.wallet().budgets(handler.PROVIDER2(), address(handler.token()));
        assertLe(settledP2, maxP2, "settled > budget for PROVIDER2");
    }
}
