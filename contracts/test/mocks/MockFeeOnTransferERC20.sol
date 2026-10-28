// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev ERC-20 that silently takes a 1% fee on every transfer, used to test
///      FeeOnTransferToken rejection in AgentWalletV2.deposit.
contract MockFeeOnTransferERC20 is ERC20 {
    uint8 private _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) { return _decimals; }

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    /// @dev Override _update so that every transfer burns 1% (fee).
    ///      Mint (from == address(0)) and burn (to == address(0)) are unchanged.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100; // 1%
            super._update(from, address(0), fee);  // burn fee
            super._update(from, to, value - fee);  // transfer net
        } else {
            super._update(from, to, value);
        }
    }
}
