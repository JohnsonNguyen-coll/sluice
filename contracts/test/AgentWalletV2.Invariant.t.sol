// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test}               from "forge-std/Test.sol";
import {AgentWalletV2}      from "../AgentWalletV2.sol";
import {AgentWalletFactoryV2} from "../AgentWalletFactoryV2.sol";
import {MockERC20}          from "./mocks/MockERC20.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/// @notice Stateful handler that drives the wallet through a sequence of
///         operations used by the invariant test.  Tracks ghost accounting
///         so the invariant checker can verify the conservation law.
contract AgentWalletV2Handler is Test {

    AgentWalletV2  internal wallet;
    AgentWalletFactoryV2 internal factory;
    MockERC20      internal tokenA;
    MockERC20      internal tokenB;

    address internal owner;
    address internal provider;

    uint256 internal signerPk;
    address internal signer;

    // Ghost state — nonces per token
    uint256 public nonceA;
    uint256 public nonceB;

    // Ghost cumulative totals (net payout = cumulative = settled[provider][token])
    uint256 public cumulA;
    uint256 public cumulB;

    // Budget caps (set once, kept simple)
    uint256 internal constant BUDGET_A = 500_000e6;
    uint256 internal constant BUDGET_B = 500_000e18;

    constructor(
        AgentWalletV2 wallet_,
        AgentWalletFactoryV2 factory_,
        MockERC20 tokenA_,
        MockERC20 tokenB_,
        address owner_,
        address provider_,
        uint256 signerPk_
    ) {
        wallet   = wallet_;
        factory  = factory_;
        tokenA   = tokenA_;
        tokenB   = tokenB_;
        owner    = owner_;
        provider = provider_;
        signerPk = signerPk_;
        (signer,) = (vm.addr(signerPk_), signerPk_);

        // Seed initial budgets (large enough not to be the limiting factor)
        tokenA_.mint(owner_, 1_000_000e6);
        tokenB_.mint(owner_, 1_000_000e18);
        vm.startPrank(owner_);
        tokenA_.approve(address(wallet_), type(uint256).max);
        tokenB_.approve(address(wallet_), type(uint256).max);
        wallet_.deposit(address(tokenA_), 600_000e6);
        wallet_.deposit(address(tokenB_), 600_000e18);
        wallet_.setProviderBudget(provider_, address(tokenA_), BUDGET_A, 0);
        wallet_.setProviderBudget(provider_, address(tokenB_), BUDGET_B, 0);
        vm.stopPrank();
    }

    // ─── Actions ────────────────────────────────────────────────────────────

    function deposit(uint256 amountA, uint256 amountB) public {
        amountA = bound(amountA, 1e6, 10_000e6);
        amountB = bound(amountB, 1e18, 10_000e18);
        tokenA.mint(owner, amountA);
        tokenB.mint(owner, amountB);
        vm.startPrank(owner);
        wallet.deposit(address(tokenA), amountA);
        wallet.deposit(address(tokenB), amountB);
        vm.stopPrank();
    }

    function settleVoucherA(uint256 deltaA) public {
        deltaA = bound(deltaA, 1, 1_000e6);
        uint256 budgetLeft = BUDGET_A > cumulA ? BUDGET_A - cumulA : 0;
        if (deltaA > budgetLeft) deltaA = budgetLeft;
        if (deltaA == 0) return;
        if (wallet.freeBalance(address(tokenA)) + wallet.encumbered(address(tokenA)) < deltaA + cumulA) return;

        cumulA  += deltaA;
        nonceA  += 1;
        _settleToken(address(tokenA), cumulA, nonceA);
    }

    function settleVoucherB(uint256 deltaB) public {
        deltaB = bound(deltaB, 1, 1_000e18);
        uint256 budgetLeft = BUDGET_B > cumulB ? BUDGET_B - cumulB : 0;
        if (deltaB > budgetLeft) deltaB = budgetLeft;
        if (deltaB == 0) return;
        if (wallet.freeBalance(address(tokenB)) + wallet.encumbered(address(tokenB)) < deltaB + cumulB) return;

        cumulB  += deltaB;
        nonceB  += 1;
        _settleToken(address(tokenB), cumulB, nonceB);
    }

    function withdrawA(uint256 amount) public {
        uint256 free = wallet.freeBalance(address(tokenA));
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(owner);
        wallet.withdraw(address(tokenA), amount);
    }

    function withdrawB(uint256 amount) public {
        uint256 free = wallet.freeBalance(address(tokenB));
        if (free == 0) return;
        amount = bound(amount, 1, free);
        vm.prank(owner);
        wallet.withdraw(address(tokenB), amount);
    }

    // ─── Internal ───────────────────────────────────────────────────────────

    function _settleToken(address token, uint256 cumulative, uint256 nonce) internal {
        AgentWalletV2.Voucher memory v = AgentWalletV2.Voucher({
            wallet:           address(wallet),
            provider:         provider,
            token:            token,
            cumulativeAmount: cumulative,
            nonce:            nonce,
            expiry:           uint64(block.timestamp + 1 days)
        });
        bytes32 structHash = keccak256(abi.encode(
            wallet.VOUCHER_TYPEHASH(),
            v.wallet, v.provider, v.token, v.cumulativeAmount, v.nonce, v.expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", wallet.domainSeparator(), structHash
        ));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        bytes memory sig = abi.encodePacked(r, s, vv);

        vm.prank(provider);
        try wallet.settle(v, sig, 0) { } catch { }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant contract
// ─────────────────────────────────────────────────────────────────────────────

contract AgentWalletV2InvariantTest is Test {

    AgentWalletV2          internal wallet;
    AgentWalletFactoryV2   internal factory;
    MockERC20              internal tokenA;
    MockERC20              internal tokenB;
    AgentWalletV2Handler   internal handler;

    address internal owner    = makeAddr("invOwner");
    address internal provider = makeAddr("invProvider");
    address internal feeRecip = makeAddr("invFeeRecip");

    uint256 internal signerPk;

    function setUp() public {
        uint256 pk;
        (, pk) = makeAddrAndKey("invSigner");
        signerPk = pk;
        address signer = vm.addr(pk);

        tokenA = new MockERC20("InvUSDC", "iUSDC", 6);
        tokenB = new MockERC20("InvDAI",  "iDAI",  18);

        address[] memory initial = new address[](2);
        initial[0] = address(tokenA);
        initial[1] = address(tokenB);
        factory = new AgentWalletFactoryV2(feeRecip, 30, initial);

        wallet = AgentWalletV2(
            factory.createWallet(owner, signer, 3600, bytes32("inv-salt"))
        );

        handler = new AgentWalletV2Handler(
            wallet, factory, tokenA, tokenB, owner, provider, signerPk
        );

        targetContract(address(handler));
    }

    // ─── Invariants ─────────────────────────────────────────────────────────

    /// @notice balance of wallet >= encumbered for tokenA at all times.
    function invariant_balanceGteEncumberedA() public view {
        assertTrue(
            tokenA.balanceOf(address(wallet)) >= wallet.encumbered(address(tokenA)),
            "tokenA: balance < encumbered"
        );
    }

    /// @notice balance of wallet >= encumbered for tokenB at all times.
    function invariant_balanceGteEncumberedB() public view {
        assertTrue(
            tokenB.balanceOf(address(wallet)) >= wallet.encumbered(address(tokenB)),
            "tokenB: balance < encumbered"
        );
    }

    /// @notice settled[provider][tokenA] never exceeds the budget cap.
    function invariant_settledWithinBudgetA() public view {
        (uint256 maxTotal, ) = wallet.budgets(provider, address(tokenA));
        assertTrue(
            wallet.settled(provider, address(tokenA)) <= maxTotal,
            "tokenA: settled > budget"
        );
    }

    /// @notice settled[provider][tokenB] never exceeds the budget cap.
    function invariant_settledWithinBudgetB() public view {
        (uint256 maxTotal, ) = wallet.budgets(provider, address(tokenB));
        assertTrue(
            wallet.settled(provider, address(tokenB)) <= maxTotal,
            "tokenB: settled > budget"
        );
    }

    /// @notice nonces for (provider, tokenA) on-chain == handler ghost nonce
    ///         (monotonically non-decreasing — we verify on-chain nonce == handler's).
    function invariant_nonceMonotonicA() public view {
        assertEq(
            wallet.nonces(provider, address(tokenA)),
            handler.nonceA(),
            "tokenA nonce diverged"
        );
    }

    /// @notice nonces for (provider, tokenB) on-chain == handler ghost nonce.
    function invariant_nonceMonotonicB() public view {
        assertEq(
            wallet.nonces(provider, address(tokenB)),
            handler.nonceB(),
            "tokenB nonce diverged"
        );
    }
}
