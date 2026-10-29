// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

library CallReceipts {
    struct Receipt {
        bytes32 voucherHash;
        bytes32 requestHash;
        bytes32 responseHash;
        uint16 status;
        uint64 timestamp;
        address token;
        uint256 nonce;
        uint256 amount;
    }
    struct Context {
        address paymentToken;
        uint256 firstNonce;
        uint256 lastNonce;
        uint256 grossAmount;
        bytes32 root;
    }
    bytes32 internal constant TYPEHASH = keccak256("Receipt(bytes32 voucherHash,bytes32 requestHash,bytes32 responseHash,uint16 status,uint64 timestamp,address token,uint256 nonce,uint256 amount)");
    function digest(Receipt memory receipt, address wallet) internal view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256("AgentPayReceipt"), keccak256("1"), block.chainid, wallet
        ));
        bytes32 message = keccak256(abi.encode(TYPEHASH, receipt));
        return keccak256(abi.encodePacked("\x19\x01", domain, message));
    }
    function leaf(Receipt memory receipt, address wallet) internal view returns (bytes32) {
        return keccak256(abi.encode(digest(receipt, wallet)));
    }
}
