// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISwapAdapter
/// @notice Pluggable swap interface used by AgentWalletV2 when a provider's preferred payout
///         token differs from the voucher token.
/// @dev Implementations must:
///      - Pull `amountIn` of `tokenIn` from msg.sender (the wallet) via transferFrom, OR accept
///        them already transferred (depends on pattern; wallet uses safeTransfer then calls swap).
///      - Transfer at least `minOut` of `tokenOut` to `recipient`.
///      - Revert with `SlippageExceeded()` (or any revert) if `minOut` cannot be met.
///      - Be stateless (no per-user storage that could be drained).
interface ISwapAdapter {
    /// @notice Swap exactly `amountIn` of `tokenIn` for at least `minOut` of `tokenOut`.
    /// @param tokenIn   Input token address.
    /// @param tokenOut  Output token address.
    /// @param amountIn  Exact amount of tokenIn to spend (already held by this contract or
    ///                  approved for pull, depending on implementation).
    /// @param minOut    Minimum acceptable amount of tokenOut. Revert if not met.
    /// @param recipient Address that receives tokenOut.
    /// @return amountOut Actual amount of tokenOut sent to recipient.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minOut,
        address recipient,
        bytes   calldata data
    ) external returns (uint256 amountOut);
}
