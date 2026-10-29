// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library WalletProvenance {
    function verified(address wallet, mapping(address => bool) storage factories) internal view returns (bool) {
        (bool ok, bytes memory data) = wallet.staticcall(abi.encodeWithSignature("factory()"));
        if (!ok || data.length != 32) return false;
        uint256 raw = abi.decode(data, (uint256));
        if (raw > type(uint160).max) return false;
        address factory = address(uint160(raw));
        if (!factories[factory]) return false;
        (ok, data) = factory.staticcall(abi.encodeWithSignature("isFactoryWallet(address)", wallet));
        return ok && data.length == 32 && abi.decode(data, (uint256)) == 1;
    }
}
