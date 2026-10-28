// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV2TestBase}       from "./AgentWalletV2.Base.t.sol";
import {AgentWalletV2}               from "../AgentWalletV2.sol";
import {AgentWalletFactoryV2}        from "../AgentWalletFactoryV2.sol";
import {MockERC20}                   from "./mocks/MockERC20.sol";
import {MockFeeOnTransferERC20}      from "./mocks/MockFeeOnTransferERC20.sol";
import {IERC20}                      from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Tests: deposit, budget, settle (single/cumulative/batch), multi-token, fuzz.
contract AgentWalletV2WalletTest is AgentWalletV2TestBase {

    // ═══════════════════════════════════════════════════════════════════════
    // 5. deposit: happy path — two tokens, accounting updated
    // ═══════════════════════════════════════════════════════════════════════

    function test_deposit_tokenA_happyPath() public {
        uint256 amt = 500e6;
        vm.expectEmit(true, true, false, true, address(wallet));
        emit AgentWalletV2.Deposited(OWNER, address(tokenA), amt);
        _deposit(address(tokenA), amt);

        assertEq(tokenA.balanceOf(address(wallet)), amt);
        assertEq(wallet.totalDeposited(address(tokenA)), amt);
    }

    function test_deposit_tokenB_happyPath() public {
        uint256 amt = 1_000e18;
        _deposit(address(tokenB), amt);
        assertEq(tokenB.balanceOf(address(wallet)), amt);
        assertEq(wallet.totalDeposited(address(tokenB)), amt);
    }

    function test_deposit_twoTokens_independentAccounting() public {
        _deposit(address(tokenA), 100e6);
        _deposit(address(tokenB), 200e18);
        assertEq(wallet.totalDeposited(address(tokenA)), 100e6);
        assertEq(wallet.totalDeposited(address(tokenB)), 200e18);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 6. deposit reverts
    // ═══════════════════════════════════════════════════════════════════════

    function test_deposit_zeroAmount_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.ZeroAmount.selector);
        wallet.deposit(address(tokenA), 0);
    }

    function test_deposit_tokenNotAllowed_reverts() public {
        MockERC20 unknown = new MockERC20("X", "X", 18);
        unknown.mint(OWNER, 1e18);
        vm.startPrank(OWNER);
        unknown.approve(address(wallet), type(uint256).max);
        vm.expectRevert(AgentWalletV2.TokenNotAllowed.selector);
        wallet.deposit(address(unknown), 1e18);
        vm.stopPrank();
    }

    function test_deposit_feeOnTransferToken_reverts() public {
        // Add a fee-on-transfer token to the factory allowlist first
        MockFeeOnTransferERC20 fotToken = new MockFeeOnTransferERC20("FOT", "FOT", 6);
        factory.addToken(address(fotToken));
        fotToken.mint(OWNER, 1_000e6);

        vm.startPrank(OWNER);
        fotToken.approve(address(wallet), type(uint256).max);
        vm.expectRevert(AgentWalletV2.FeeOnTransferToken.selector);
        wallet.deposit(address(fotToken), 100e6);
        vm.stopPrank();
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 7. Token removed after deposit: balance unaffected, new deposit reverts,
    //    emergencyWithdraw available
    // ═══════════════════════════════════════════════════════════════════════

    function test_delistedToken_existingBalanceUnaffected() public {
        _deposit(address(tokenA), 100e6);
        factory.removeToken(address(tokenA));
        // Balance still in wallet
        assertEq(tokenA.balanceOf(address(wallet)), 100e6);
    }

    function test_delistedToken_newDeposit_reverts() public {
        _deposit(address(tokenA), 100e6);
        factory.removeToken(address(tokenA));
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.TokenNotAllowed.selector);
        wallet.deposit(address(tokenA), 50e6);
    }

    function test_delistedToken_emergencyWithdraw_succeeds() public {
        _deposit(address(tokenA), 100e6);
        factory.removeToken(address(tokenA));

        uint256 ownerBefore = tokenA.balanceOf(OWNER);
        vm.expectEmit(true, true, false, true, address(wallet));
        emit AgentWalletV2.EmergencyWithdrawn(OWNER, address(tokenA), 100e6);
        vm.prank(OWNER);
        wallet.emergencyWithdraw(address(tokenA), 100e6);

        assertEq(tokenA.balanceOf(OWNER), ownerBefore + 100e6);
    }

    function test_emergencyWithdraw_stillListed_reverts() public {
        _deposit(address(tokenA), 100e6);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.TokenNotAllowed.selector);
        wallet.emergencyWithdraw(address(tokenA), 100e6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 8. setProviderBudget: happy path
    // ═══════════════════════════════════════════════════════════════════════

    function test_setBudget_happyPath() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 50e6);

        (uint256 maxTotal, uint256 perCallCap) = wallet.budgets(PROVIDER, address(tokenA));
        assertEq(maxTotal, 500e6);
        assertEq(perCallCap, 50e6);
        assertEq(wallet.encumbered(address(tokenA)), 500e6);
        assertEq(wallet.freeBalance(address(tokenA)), 500e6);
    }

    function test_setBudget_encumberedIncreasesOnIncrease() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 300e6, 0);
        assertEq(wallet.encumbered(address(tokenA)), 300e6);
        _setBudget(PROVIDER, address(tokenA), 600e6, 0);
        assertEq(wallet.encumbered(address(tokenA)), 600e6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 9. setProviderBudget reverts
    // ═══════════════════════════════════════════════════════════════════════

    function test_setBudget_insufficientFreeBalance_reverts() public {
        _deposit(address(tokenA), 100e6);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.InsufficientFreeBalance.selector);
        wallet.setProviderBudget(PROVIDER, address(tokenA), 200e6, 0);
    }

    function test_setBudget_useDecreaseRequest_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.UseDecreaseRequest.selector);
        wallet.setProviderBudget(PROVIDER, address(tokenA), 400e6, 0);
    }

    function test_setBudget_tokenNotAllowed_reverts() public {
        MockERC20 unknown = new MockERC20("X", "X", 18);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.TokenNotAllowed.selector);
        wallet.setProviderBudget(PROVIDER, address(unknown), 100e6, 0);
    }

    function test_setBudget_zeroProvider_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.ZeroAddress.selector);
        wallet.setProviderBudget(address(0), address(tokenA), 100e6, 0);
    }

    function test_setBudget_onlyOwner_reverts() public {
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.OnlyOwner.selector);
        wallet.setProviderBudget(PROVIDER, address(tokenA), 100e6, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 10. settle: happy path — correct delta, fee (feeBps=30), payout, state
    // ═══════════════════════════════════════════════════════════════════════

    function test_settle_happyPath_feeBps30() public {
        uint256 depositAmt = 1_000e6;
        uint256 cumulative = 100e6;
        _deposit(address(tokenA), depositAmt);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        uint256 providerBefore    = tokenA.balanceOf(PROVIDER);
        uint256 feeRecipBefore    = tokenA.balanceOf(FEE_RECIPIENT);

        // delta = 100e6, fee = 100e6 * 30 / 10000 = 30_000 (0.3 %)
        uint256 expectedFee    = (cumulative * FEE_BPS) / 10_000;
        uint256 expectedPayout = cumulative - expectedFee;

        vm.expectEmit(true, true, false, true, address(wallet));
        emit AgentWalletV2.Settled(
            PROVIDER,
            address(tokenA),
            cumulative,
            expectedFee,
            1,
            cumulative,
            address(tokenA),
            expectedPayout
        );
        _settle(PROVIDER, address(tokenA), cumulative, 1);

        assertEq(wallet.settled(PROVIDER, address(tokenA)), cumulative);
        assertEq(wallet.nonces(PROVIDER, address(tokenA)), 1);
        assertEq(wallet.encumbered(address(tokenA)), 500e6 - cumulative);
        assertEq(tokenA.balanceOf(PROVIDER),     providerBefore + expectedPayout);
        assertEq(tokenA.balanceOf(FEE_RECIPIENT), feeRecipBefore + expectedFee);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 11. settle: cumulative vouchers (nonce 1, 2, 3)
    // ═══════════════════════════════════════════════════════════════════════

    function test_settle_cumulativeVouchers() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 300e6, 0);

        // Voucher 1: cumulative = 100e6, delta = 100e6
        _settle(PROVIDER, address(tokenA), 100e6, 1);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 100e6);
        assertEq(wallet.nonces(PROVIDER,  address(tokenA)), 1);

        // Voucher 2: cumulative = 180e6, delta = 80e6
        _settle(PROVIDER, address(tokenA), 180e6, 2);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 180e6);
        assertEq(wallet.nonces(PROVIDER,  address(tokenA)), 2);

        // Voucher 3: cumulative = 250e6, delta = 70e6
        _settle(PROVIDER, address(tokenA), 250e6, 3);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 250e6);
        assertEq(wallet.nonces(PROVIDER,  address(tokenA)), 3);

        // Total payout + fees = 250e6
        uint256 fee    = (250e6 * uint256(FEE_BPS)) / 10_000;
        uint256 payout = 250e6 - fee;
        assertEq(tokenA.balanceOf(FEE_RECIPIENT), fee);
        assertEq(tokenA.balanceOf(PROVIDER),      payout);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 12. settle reverts
    // ═══════════════════════════════════════════════════════════════════════

    function test_settle_walletPaused_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        vm.prank(OWNER);
        wallet.pause();

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.WalletPaused.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_voucherExpired_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp - 1)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.VoucherExpired.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_invalidSignature_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        // sign with wrong key
        (, uint256 wrongPk) = makeAddrAndKey("wrongSigner");
        bytes memory sig = _sign(v, wrongPk);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.InvalidSignature.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_invalidNonce_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        _settle(PROVIDER, address(tokenA), 100e6, 1);

        // Replay nonce 1
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 200e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.InvalidNonce.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_budgetExceeded_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 100e6, 0);

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 150e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.BudgetExceeded.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_perCallCapExceeded_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 50e6);  // perCallCap = 50e6

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.PerCallCapExceeded.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_unauthorizedProvider_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        // PROVIDER2 tries to submit PROVIDER's voucher
        vm.prank(PROVIDER2);
        vm.expectRevert(AgentWalletV2.UnauthorizedProvider.selector);
        wallet.settle(v, sig, 0);
    }

    function test_settle_tokenNotAllowed_midFlight_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        // De-list the token after budget is set
        factory.removeToken(address(tokenA));

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.TokenNotAllowed.selector);
        wallet.settle(v, sig, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 13. settleBatch: two vouchers, two providers
    // ═══════════════════════════════════════════════════════════════════════

    function test_settleBatch_twoProviders() public {
        _deposit(address(tokenA), 2_000e6);
        _setBudget(PROVIDER,  address(tokenA), 800e6, 0);
        _setBudget(PROVIDER2, address(tokenA), 800e6, 0);

        AgentWalletV2.Voucher[] memory vouchers = new AgentWalletV2.Voucher[](2);
        bytes[]   memory sigs    = new bytes[](2);
        uint256[] memory minOuts = new uint256[](2);

        vouchers[0] = _makeVoucher(PROVIDER,  address(tokenA), 200e6, 1, uint64(block.timestamp + 1 hours));
        vouchers[1] = _makeVoucher(PROVIDER2, address(tokenA), 300e6, 1, uint64(block.timestamp + 1 hours));
        sigs[0]     = _sign(vouchers[0], AGENT_SIGNER_PK);
        sigs[1]     = _sign(vouchers[1], AGENT_SIGNER_PK);

        // Both providers settle in same tx
        // PROVIDER calls settleBatch — but PROVIDER2's voucher is also in there.
        // We need a relayer or both provider == caller; use PROVIDER as relayer for PROVIDER2.
        // Actually: the test must submit each as the provider. Use PROVIDER's settle for PROVIDER
        // and PROVIDER2's settle for PROVIDER2 — but settleBatch is a single call.
        // The cleanest approach: submit via PROVIDER as relayer for PROVIDER.
        // For PROVIDER2, set PROVIDER as relayer.
        vm.prank(PROVIDER2);
        wallet.setRelayer(PROVIDER2, PROVIDER);

        vm.prank(PROVIDER);
        wallet.settleBatch(vouchers, sigs, minOuts);

        assertEq(wallet.settled(PROVIDER,  address(tokenA)), 200e6);
        assertEq(wallet.settled(PROVIDER2, address(tokenA)), 300e6);
        assertEq(wallet.nonces(PROVIDER,   address(tokenA)), 1);
        assertEq(wallet.nonces(PROVIDER2,  address(tokenA)), 1);

        uint256 totalDelta = 200e6 + 300e6;
        uint256 totalFee   = (totalDelta * FEE_BPS) / 10_000;
        assertEq(tokenA.balanceOf(FEE_RECIPIENT), totalFee);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 14. Two tokens: independent per-token accounting
    // ═══════════════════════════════════════════════════════════════════════

    function test_multiToken_independentAccounting() public {
        _deposit(address(tokenA), 1_000e6);
        _deposit(address(tokenB), 1_000e18);
        _setBudget(PROVIDER, address(tokenA), 300e6,  0);
        _setBudget(PROVIDER, address(tokenB), 400e18, 0);

        _settle(PROVIDER, address(tokenA), 200e6,  1);
        _settle(PROVIDER, address(tokenB), 300e18, 1);

        assertEq(wallet.settled(PROVIDER, address(tokenA)), 200e6);
        assertEq(wallet.settled(PROVIDER, address(tokenB)), 300e18);
        assertEq(wallet.nonces(PROVIDER,  address(tokenA)), 1);
        assertEq(wallet.nonces(PROVIDER,  address(tokenB)), 1);

        // Encumbered per-token
        assertEq(wallet.encumbered(address(tokenA)), 300e6  - 200e6);
        assertEq(wallet.encumbered(address(tokenB)), 400e18 - 300e18);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 15. Fuzz: decimals mixing — delta == payout + fee exactly
    // ═══════════════════════════════════════════════════════════════════════

    function testFuzz_settle_deltaEqualPayoutPlusFee_6dec(uint256 cumA) public {
        cumA = bound(cumA, 1e3, 500e6); // 0.001 USDC to 500 USDC
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 600e6, 0);

        uint256 provBefore = tokenA.balanceOf(PROVIDER);
        uint256 feeBefore  = tokenA.balanceOf(FEE_RECIPIENT);

        _settle(PROVIDER, address(tokenA), cumA, 1);

        uint256 provGain = tokenA.balanceOf(PROVIDER)     - provBefore;
        uint256 feeGain  = tokenA.balanceOf(FEE_RECIPIENT) - feeBefore;
        assertEq(provGain + feeGain, cumA, "delta must equal payout+fee");
    }

    function testFuzz_settle_deltaEqualPayoutPlusFee_18dec(uint256 cumB) public {
        cumB = bound(cumB, 1e12, 500e18); // avoid dust below fee threshold
        _deposit(address(tokenB), 1_000e18);
        _setBudget(PROVIDER, address(tokenB), 600e18, 0);

        uint256 provBefore = tokenB.balanceOf(PROVIDER);
        uint256 feeBefore  = tokenB.balanceOf(FEE_RECIPIENT);

        _settle(PROVIDER, address(tokenB), cumB, 1);

        uint256 provGain = tokenB.balanceOf(PROVIDER)     - provBefore;
        uint256 feeGain  = tokenB.balanceOf(FEE_RECIPIENT) - feeBefore;
        assertEq(provGain + feeGain, cumB, "delta must equal payout+fee");
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 16. Per-token invariant: balance >= encumbered
    // ═══════════════════════════════════════════════════════════════════════

    function test_invariant_balanceGteEncumbered_afterSettle() public {
        _deposit(address(tokenA), 1_000e6);
        _deposit(address(tokenB), 1_000e18);
        _setBudget(PROVIDER, address(tokenA), 600e6, 0);
        _setBudget(PROVIDER, address(tokenB), 700e18, 0);

        _settle(PROVIDER, address(tokenA), 200e6,  1);
        _settle(PROVIDER, address(tokenB), 300e18, 1);

        // balance >= encumbered must hold after each settle
        assertTrue(
            tokenA.balanceOf(address(wallet)) >= wallet.encumbered(address(tokenA)),
            "tokenA: balance < encumbered"
        );
        assertTrue(
            tokenB.balanceOf(address(wallet)) >= wallet.encumbered(address(tokenB)),
            "tokenB: balance < encumbered"
        );
    }
}
