// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV3} from "./AgentWalletV3.sol";

/// @title AgentWalletFactoryV3
/// @notice CREATE2 factory for AgentWalletV3 instances.
///         V3 adds: DisputeVault routing, ProviderRegistry reads, ReputationRegistry writes.
///
/// @dev Deliberately does NOT inherit V2 factory to keep the inheritance graph flat.
///      All state and logic is self-contained; V1/V2 factories remain unchanged.
contract AgentWalletFactoryV3 {

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidFee();
    error InvalidSettleWindow();
    error OnlyOwner();
    error OnlyPendingOwner();
    error OnlyPendingRecipient();
    error TokenAlreadyAllowed();
    error TokenNotAllowed();

    // ─── Events ─────────────────────────────────────────────────────────────

    event WalletCreated(address indexed owner, address indexed wallet, address agentSigner, uint32 settleWindow, uint16 feeBps);
    event OwnershipTransferStarted(address indexed current, address indexed pending);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeRecipientTransferStarted(address indexed current, address indexed pending);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeeBpsChanged(uint16 oldBps, uint16 newBps);
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);

    // ─── State ──────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;

    address public feeRecipient;
    address public pendingFeeRecipient;
    uint16  public feeBps;

    /// @notice Protocol registry addresses (immutable after construction)
    address public immutable disputeVault;
    address public immutable providerRegistry;
    address public immutable reputationRegistry;

    mapping(address => bool) public isAllowedToken;
    mapping(address => bool) public isFactoryWallet;
    mapping(address => address[]) private _ownerWallets;

    // ─── Constructor ────────────────────────────────────────────────────────

    /// @param feeRecipient_     Initial fee recipient.
    /// @param feeBps_           Initial fee in bps (max 500).
    /// @param initialTokens     Initial token allowlist.
    /// @param disputeVault_     DisputeVault address.
    /// @param providerRegistry_ ProviderRegistry address.
    /// @param reputationRegistry_ ReputationRegistry address.
    constructor(
        address feeRecipient_,
        uint16  feeBps_,
        address[] memory initialTokens,
        address disputeVault_,
        address providerRegistry_,
        address reputationRegistry_
    ) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > 500) revert InvalidFee();
        if (disputeVault_ == address(0)) revert ZeroAddress();
        if (providerRegistry_ == address(0)) revert ZeroAddress();
        if (reputationRegistry_ == address(0)) revert ZeroAddress();

        owner          = msg.sender;
        feeRecipient   = feeRecipient_;
        feeBps         = feeBps_;
        disputeVault   = disputeVault_;
        providerRegistry   = providerRegistry_;
        reputationRegistry = reputationRegistry_;

        for (uint256 i; i < initialTokens.length; ++i) {
            if (initialTokens[i] == address(0)) revert ZeroAddress();
            isAllowedToken[initialTokens[i]] = true;
            emit TokenAdded(initialTokens[i]);
        }
    }

    // ─── Ownership ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // ─── Fee governance ──────────────────────────────────────────────────────

    function transferFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingFeeRecipient = newRecipient;
        emit FeeRecipientTransferStarted(feeRecipient, newRecipient);
    }

    function acceptFeeRecipient() external {
        if (msg.sender != pendingFeeRecipient) revert OnlyPendingRecipient();
        emit FeeRecipientChanged(feeRecipient, pendingFeeRecipient);
        feeRecipient = pendingFeeRecipient;
        pendingFeeRecipient = address(0);
    }

    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > 500) revert InvalidFee();
        emit FeeBpsChanged(feeBps, newBps);
        feeBps = newBps;
    }

    // ─── Token allowlist ─────────────────────────────────────────────────────

    function addToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (isAllowedToken[token]) revert TokenAlreadyAllowed();
        isAllowedToken[token] = true;
        emit TokenAdded(token);
    }

    function removeToken(address token) external onlyOwner {
        if (!isAllowedToken[token]) revert TokenNotAllowed();
        isAllowedToken[token] = false;
        emit TokenRemoved(token);
    }

    // ─── Wallet creation ─────────────────────────────────────────────────────

    /// @notice Deploy an AgentWalletV3 at a deterministic address.
    /// @param owner_       Wallet owner (controls funds, budgets, signer).
    /// @param agentSigner_ Hot signing key (signs vouchers only).
    /// @param settleWindow Settle window in seconds (min 600).
    /// @param userSalt     Caller-supplied salt for deterministic address.
    function createWallet(
        address owner_,
        address agentSigner_,
        uint32  settleWindow,
        bytes32 userSalt
    ) external returns (address wallet) {
        if (owner_ == address(0) || agentSigner_ == address(0)) revert ZeroAddress();
        if (settleWindow < 600) revert InvalidSettleWindow();

        bytes32 salt = keccak256(abi.encode(owner_, agentSigner_, settleWindow, userSalt));

        wallet = address(new AgentWalletV3{salt: salt}(
            owner_,
            agentSigner_,
            feeRecipient,
            feeBps,
            settleWindow,
            address(this)
        ));

        isFactoryWallet[wallet] = true;
        _ownerWallets[owner_].push(wallet);

        emit WalletCreated(owner_, wallet, agentSigner_, settleWindow, feeBps);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function walletsOf(address owner_) external view returns (address[] memory) {
        return _ownerWallets[owner_];
    }

    function predictWalletAddress(
        address owner_,
        address agentSigner_,
        uint32  settleWindow,
        bytes32 userSalt
    ) external view returns (address) {
        bytes32 salt = keccak256(abi.encode(owner_, agentSigner_, settleWindow, userSalt));
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AgentWalletV3).creationCode,
                abi.encode(owner_, agentSigner_, feeRecipient, feeBps, settleWindow, address(this))
            )
        );
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
        ))));
    }
}
