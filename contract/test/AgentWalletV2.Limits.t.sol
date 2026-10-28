// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV2TestBase} from "./AgentWalletV2.Base.t.sol";
import {AgentWalletV2}         from "../src/AgentWalletV2.sol";

/// @notice Tests: daily limit, budget decrease, pause/unpause, signer rotation.
contract AgentWalletV2LimitsTest is AgentWalletV2TestBase {

    // ═══════════════════════════════════════════════════════════════════════
    // 20. setDailyLimit + setTokenRate: within limit passes; over limit reverts
    // ═══════════════════════════════════════════════════════════════════════

    function test_dailyLimit_withinLimit_passes() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 600e6, 0);

        vm.startPrank(OWNER);
        // $500 daily limit (500_000_000 USD micro-units)
        wallet.setDailyLimit(500_000_000);
        // tokenA: 1 full token (1e6 base units) = $1.00, decimals=6
        wallet.setTokenRate(address(tokenA), 1_000_000, 6);
        vm.stopPrank();

        // Settle 200e6 tokenA → 200 USD → within $500 limit
        _settle(PROVIDER, address(tokenA), 200e6, 1);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 200e6);
    }

    function test_dailyLimit_exceeds_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 600e6, 0);

        vm.startPrank(OWNER);
        wallet.setDailyLimit(100_000_000); // $100 limit
        wallet.setTokenRate(address(tokenA), 1_000_000, 6);
        vm.stopPrank();

        // Try to settle 200e6 tokenA → $200 > $100 limit
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 200e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.DailyLimitExceeded.selector);
        wallet.settle(v, sig, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 21. No rate configured → daily limit NOT enforced for that token
    // ═══════════════════════════════════════════════════════════════════════

    function test_dailyLimit_noRateConfigured_skipsCheck() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 600e6, 0);

        vm.prank(OWNER);
        wallet.setDailyLimit(1); // Impossibly tiny limit (1 USD micro-unit)
        // Intentionally do NOT call setTokenRate for tokenA

        // Even with a 1-unit daily limit, settle should pass because no rate is set
        _settle(PROVIDER, address(tokenA), 200e6, 1);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 200e6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 22. Cross-token daily limit: tokenA + tokenB both count toward same bucket
    // ═══════════════════════════════════════════════════════════════════════

    function test_dailyLimit_crossToken_shared() public {
        _deposit(address(tokenA), 1_000e6);
        _deposit(address(tokenB), 1_000e18);
        _setBudget(PROVIDER, address(tokenA), 600e6,  0);
        _setBudget(PROVIDER, address(tokenB), 600e18, 0);

        vm.startPrank(OWNER);
        // $300 daily limit
        wallet.setDailyLimit(300_000_000);
        // tokenA: $1 per token (6 dec)
        wallet.setTokenRate(address(tokenA), 1_000_000, 6);
        // tokenB: $1 per token (18 dec) → usdRateE6 = 1_000_000
        wallet.setTokenRate(address(tokenB), 1_000_000, 18);
        vm.stopPrank();

        // Settle $200 in tokenA → $200 consumed
        _settle(PROVIDER, address(tokenA), 200e6, 1);

        // Now try to settle $200 in tokenB → total would be $400 > $300 → reverts
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenB), 200e18, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.DailyLimitExceeded.selector);
        wallet.settle(v, sig, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 23. requestBudgetDecrease + executeBudgetDecrease: full flow
    // ═══════════════════════════════════════════════════════════════════════

    function test_budgetDecrease_fullFlow() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        // Request decrease to 200e6
        vm.prank(OWNER);
        wallet.requestBudgetDecrease(PROVIDER, address(tokenA), 200e6, 0);

        (uint256 newMax, , uint256 reqAt) = wallet.decreaseRequests(PROVIDER, address(tokenA));
        assertEq(newMax, 200e6);
        assertTrue(reqAt > 0);

        // Cannot execute before settle window elapses
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.DecreaseWindowNotElapsed.selector);
        wallet.executeBudgetDecrease(PROVIDER, address(tokenA));

        // Warp past settle window
        vm.warp(block.timestamp + SETTLE_WINDOW + 1);
        vm.prank(OWNER);
        wallet.executeBudgetDecrease(PROVIDER, address(tokenA));

        (uint256 maxTotal, ) = wallet.budgets(PROVIDER, address(tokenA));
        assertEq(maxTotal, 200e6);
        // Encumbered should be reduced accordingly: was 500e6, now 200e6
        assertEq(wallet.encumbered(address(tokenA)), 200e6);
    }

    function test_budgetDecrease_noPendingDecrease_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.NoPendingDecrease.selector);
        wallet.executeBudgetDecrease(PROVIDER, address(tokenA));
    }

    function test_budgetDecrease_notLessThanCurrent_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.InvalidDelta.selector);
        wallet.requestBudgetDecrease(PROVIDER, address(tokenA), 500e6, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 24. Provider can still settle up to old maxTotal during settle window
    // ═══════════════════════════════════════════════════════════════════════

    function test_budgetDecrease_settleStillWorksInWindow() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(OWNER);
        wallet.requestBudgetDecrease(PROVIDER, address(tokenA), 100e6, 0);

        // During the window the OLD budget (500e6) is still in effect
        // Settle 400e6 (which is > new requested max of 100e6)
        _settle(PROVIDER, address(tokenA), 400e6, 1);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 400e6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 25. pause + settle reverts; unpause + settle passes; cooldown persists
    // ═══════════════════════════════════════════════════════════════════════

    function test_pause_settleReverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);
        vm.prank(OWNER);
        wallet.pause();
        assertTrue(wallet.paused());

        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.WalletPaused.selector);
        wallet.settle(v, sig, 0);
    }

    function test_unpause_settlePasses() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(OWNER);
        wallet.pause();
        vm.prank(OWNER);
        wallet.unpause();
        assertFalse(wallet.paused());

        // Warp past the withdraw cooldown so that withdraw also works
        // (but settle should pass immediately)
        _settle(PROVIDER, address(tokenA), 100e6, 1);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 100e6);
    }

    function test_pause_withdrawCooldownSurvivesUnpause() public {
        _deposit(address(tokenA), 1_000e6);

        vm.prank(OWNER);
        wallet.pause();
        uint256 deadline = wallet.pauseWithdrawDeadline();
        assertTrue(deadline > block.timestamp);

        vm.prank(OWNER);
        wallet.unpause();
        // Deadline still set
        assertEq(wallet.pauseWithdrawDeadline(), deadline);

        // Withdraw should revert while cooldown is active
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletV2.WithdrawCooldown.selector);
        wallet.withdraw(address(tokenA), 100e6);

        // After warp past deadline, withdraw succeeds
        vm.warp(deadline + 1);
        vm.prank(OWNER);
        wallet.withdraw(address(tokenA), 100e6);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 26. rotateAgentSigner
    // ═══════════════════════════════════════════════════════════════════════

    function test_rotate_newSignerValidImmediately() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(OWNER);
        wallet.rotateAgentSigner(AGENT_SIGNER2);
        assertEq(wallet.agentSigner(), AGENT_SIGNER2);

        // New signer can sign valid voucher
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig2 = _sign(v, AGENT_SIGNER2_PK);
        vm.prank(PROVIDER);
        wallet.settle(v, sig2, 0);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 100e6);
    }

    function test_rotate_oldSignerStillValidDuringWindow() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(OWNER);
        wallet.rotateAgentSigner(AGENT_SIGNER2);

        // Old signer should still be valid during the settle window
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sigOld = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        wallet.settle(v, sigOld, 0);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 100e6);
    }

    function test_rotate_oldSignerExpiredAfterWindow_reverts() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        vm.prank(OWNER);
        wallet.rotateAgentSigner(AGENT_SIGNER2);

        // Warp past the settle window
        vm.warp(block.timestamp + SETTLE_WINDOW + 1);

        // Old signer's voucher should now be rejected
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sigOld = _sign(v, AGENT_SIGNER_PK);
        vm.prank(PROVIDER);
        vm.expectRevert(AgentWalletV2.InvalidSignature.selector);
        wallet.settle(v, sigOld, 0);
    }

    function test_rotate_multipleRotations_safe() public {
        _deposit(address(tokenA), 1_000e6);
        _setBudget(PROVIDER, address(tokenA), 500e6, 0);

        // First rotation: old → signer2
        vm.prank(OWNER);
        wallet.rotateAgentSigner(AGENT_SIGNER2);

        // Second rotation: signer2 → back to a new address
        (address signer3, uint256 pk3) = makeAddrAndKey("signer3");
        vm.prank(OWNER);
        wallet.rotateAgentSigner(signer3);
        assertEq(wallet.agentSigner(), signer3);

        // signer3 signs a valid voucher
        AgentWalletV2.Voucher memory v = _makeVoucher(
            PROVIDER, address(tokenA), 100e6, 1, uint64(block.timestamp + 1 hours)
        );
        bytes memory sig3 = keccak256(abi.encode(pk3)) == keccak256(abi.encode(pk3))
            ? _signWith(v, pk3)
            : bytes("");
        vm.prank(PROVIDER);
        wallet.settle(v, sig3, 0);
        assertEq(wallet.settled(PROVIDER, address(tokenA)), 100e6);
    }

    // ─── Internal helper for signing with an arbitrary key ──────────────────

    function _signWith(AgentWalletV2.Voucher memory v, uint256 pk)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            wallet.VOUCHER_TYPEHASH(),
            v.wallet, v.provider, v.token, v.cumulativeAmount, v.nonce, v.expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01", wallet.domainSeparator(), structHash
        ));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, vv);
    }
}
