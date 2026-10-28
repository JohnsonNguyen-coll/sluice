// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV2TestBase} from "./AgentWalletV2.Base.t.sol";
import {AgentWalletV2}         from "../AgentWalletV2.sol";
import {MockSwapAdapter}       from "./mocks/MockSwapAdapter.sol";

/// @notice Tests: payout preference, slippage revert, SwapAdapterNotSet.
contract AgentWalletV2SwapTest is AgentWalletV2TestBase {

    function setUp() public override {
        super.setUp();
        // Install swap adapter
        vm.prank(OWNER);
        wallet.setSwapAdapter(address(swapAdapter));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 17. Payout preference: provider prefers tokenB; settle tokenA voucher;
    //     MockSwapAdapter 1:1 rate (adjusted for decimal diff); assert payout
    //     received in tokenB, fee paid in tokenA.
    // ═══════════════════════════════════════════════════════════════════════

    function test_swap_payoutInPreferredToken() public {
        // Deposit tokenA (6 dec) into wallet
        uint256 depositA = 1_000e6;
        _deposit(address(tokenA), depositA);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        // Provider prefers tokenB as payout
        vm.prank(PROVIDER);
        wallet.setPayoutToken(PROVIDER, address(tokenB));

        // Fund adapter with tokenB reserves (need to handle 6→18 dec conversion)
        // MockSwapAdapter default rate is 1:1 (1e18/1e18) which works for equal decimals.
        // For 6-dec→18-dec we need rate = 1e12 numerator, 1 denominator so that
        // amountOut = amountIn * 1e12 / 1 = amountIn scaled to 18 dec.
        swapAdapter.setRate(1e12, 1);

        uint256 cumulative = 100e6;  // 100 tokenA (6 dec)
        uint256 feeAmt     = (cumulative * FEE_BPS) / 10_000;
        uint256 payout6    = cumulative - feeAmt;        // in 6-dec units
        uint256 payoutB    = payout6 * 1e12;             // expected tokenB (18-dec)

        tokenB.mint(address(this), payoutB + 1e18);
        tokenB.approve(address(swapAdapter), type(uint256).max);
        swapAdapter.fund(address(tokenB), payoutB + 1e18);

        uint256 providerBefore = tokenB.balanceOf(PROVIDER);
        uint256 feeRecipBefore = tokenA.balanceOf(FEE_RECIPIENT);

        _settle(PROVIDER, address(tokenA), cumulative, 1);

        // Provider receives tokenB
        assertEq(tokenB.balanceOf(PROVIDER) - providerBefore, payoutB);
        // Fee paid in tokenA
        assertEq(tokenA.balanceOf(FEE_RECIPIENT) - feeRecipBefore, feeAmt);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 18. Slippage revert: forceFailBelow > computed output → revert
    // ═══════════════════════════════════════════════════════════════════════

    function test_swap_slippage_reverts() public {
        uint256 depositA = 1_000e6;
        _deposit(address(tokenA), depositA);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(PROVIDER);
        wallet.setPayoutToken(PROVIDER, address(tokenB));

        // 1:1 rate for same-decimal scenario (use same token as stand-in via rate)
        // Actually use 6-dec tokenA → 6-dec tokenA would be odd; let's do tokenA→tokenB
        // but set rate 1:1 (amountOut = amountIn * 1e18 / 1e18 = amountIn = 100e6).
        swapAdapter.setRate(1e18, 1e18);
        // Force fail below a value larger than what the swap would produce
        swapAdapter.setForceFailBelow(200e6); // computed output is 100e6 < 200e6 → fail

        tokenB.mint(address(this), 1_000e6);
        tokenB.approve(address(swapAdapter), type(uint256).max);
        swapAdapter.fund(address(tokenB), 1_000e6);

        uint256 cumulative = 100e6;
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), cumulative, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        // Provide minOut=0 — the forceFailBelow inside the adapter causes the revert.
        // Use bytes4 selector match (args vary); wrap in expectRevert with partial bytes.
        vm.expectRevert(abi.encodeWithSelector(MockSwapAdapter.SlippageExceeded.selector, uint256(99700000), uint256(200000000)));
        wallet.settle(v, sig, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 19. SwapAdapterNotSet: provider has payout preference but adapter == 0
    // ═══════════════════════════════════════════════════════════════════════

    function test_swap_adapterNotSet_reverts() public {
        // Remove the swap adapter
        vm.prank(OWNER);
        wallet.setSwapAdapter(address(0));

        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        // Provider wants tokenB payout
        vm.prank(PROVIDER);
        wallet.setPayoutToken(PROVIDER, address(tokenB));

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.SwapAdapterNotSet.selector);
        wallet.settle(v, sig, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Bonus: minOut slippage check (caller-supplied minOut exceeds output)
    // ═══════════════════════════════════════════════════════════════════════

    function test_swap_callerMinOutSlippage_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(PROVIDER);
        wallet.setPayoutToken(PROVIDER, address(tokenB));

        // 1:1 rate → output = 100e6
        swapAdapter.setRate(1e18, 1e18);
        tokenB.mint(address(this), 500e6);
        tokenB.approve(address(swapAdapter), type(uint256).max);
        swapAdapter.fund(address(tokenB), 500e6);

        uint256 cumulative = 100e6;
        uint256 fee        = (cumulative * FEE_BPS) / 10_000;
        uint256 payout     = cumulative - fee;   // ~99_700_000 (< 200e6)

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), cumulative, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        // minOut larger than swap output: amountOut = payout, minOut = payout + 1e6
        vm.expectRevert(abi.encodeWithSelector(
            MockSwapAdapter.SlippageExceeded.selector,
            payout,
            payout + 1e6
        ));
        wallet.settle(v, sig, payout + 1e6);
    }
}
