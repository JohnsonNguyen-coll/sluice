// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapAdapter} from "../../src/ISwapAdapter.sol";

/// @title MockSwapAdapter
/// @notice Test-only swap adapter.  Uses a configurable fixed rate (rateNumerator/rateDenominator)
///         to convert tokenIn → tokenOut.  Simulates slippage by accepting a forceFailBelow
///         threshold — swaps that would produce < forceFailBelow are reverted.
///
/// @dev The adapter holds tokenOut reserves that must be pre-funded by the test harness.
///      It pulls tokenIn from msg.sender (the wallet) using transferFrom and transfers tokenOut
///      to the recipient.  No real AMM math — pure deterministic for reproducible tests.
contract MockSwapAdapter is ISwapAdapter {
    using SafeERC20 for IERC20;

    error SlippageExceeded(uint256 amountOut, uint256 minOut);
    error InsufficientReserves(uint256 available, uint256 needed);

    /// @notice Rate: amountOut = amountIn * rateNumerator / rateDenominator.
    ///         Default: 1:1 (rateNumerator = rateDenominator = 1e18).
    uint256 public rateNumerator   = 1e18;
    uint256 public rateDenominator = 1e18;

    /// @notice If set to a positive value, swaps producing < this amount revert.
    uint256 public forceFailBelow;

    function setRate(uint256 num, uint256 denom) external {
        require(denom > 0, "MockSwapAdapter: denom zero");
        rateNumerator   = num;
        rateDenominator = denom;
    }

    function setForceFailBelow(uint256 threshold) external {
        forceFailBelow = threshold;
    }

    /// @inheritdoc ISwapAdapter
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes calldata /*data*/
    ) external override returns (uint256 amountOut) {
        // Pull tokenIn from caller
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);

        // Compute output
        amountOut = (amountIn * rateNumerator) / rateDenominator;

        // Slippage guard
        if (amountOut < minOut) revert SlippageExceeded(amountOut, minOut);
        if (forceFailBelow > 0 && amountOut < forceFailBelow) revert SlippageExceeded(amountOut, forceFailBelow);

        // Reserve check
        uint256 reserves = IERC20(tokenOut).balanceOf(address(this));
        if (reserves < amountOut) revert InsufficientReserves(reserves, amountOut);

        // Send output
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
    }

    /// @notice Fund the adapter's tokenOut reserves (called by test harness).
    function fund(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }
}
