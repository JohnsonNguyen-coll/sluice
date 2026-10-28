// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWallet} from "./AgentWallet.sol";

/// @title AgentWalletFactory
/// @notice CREATE2 deployer for AgentWallet instances.
///
/// @dev Ownership uses a 2-step transfer (owner + pendingOwner) to protect against
///      accidental transfer to a wrong address. Fee recipient also uses a 2-step transfer.
///      feeBps changes affect NEW wallets only — existing wallets snapshot their fee at
///      creation time as an immutable.
///
///      CREATE2 salt is derived from (owner_, agentSigner_, userSalt) so callers can
///      precompute the wallet address off-chain before deployment.
///      Use predictWalletAddress() to compute the address before calling createWallet().
contract AgentWalletFactory {

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidFee();
    error InvalidSettleWindow();
    error OnlyOwner();
    error OnlyPendingOwner();
    error OnlyPendingRecipient();
    error SaltAlreadyUsed();

    // ─── Events ─────────────────────────────────────────────────────────────

    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeeRecipientTransferStarted(address indexed current, address indexed pending);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeeBpsChanged(uint16 oldBps, uint16 newBps);
    event WalletCreated(
        address indexed walletOwner,
        address indexed wallet,
        address agentSigner,
        uint32  settleWindow,
        uint16  feeBps,
        bytes32 salt
    );

    // ─── Immutables ─────────────────────────────────────────────────────────

    address public immutable usdc;

    // ─── Mutable state ──────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;

    address public feeRecipient;
    uint16  public feeBps;
    address public pendingFeeRecipient;

    mapping(address => address[]) private _ownerWallets;
    mapping(address => bool) public isFactoryWallet;

    // ─── Constructor ────────────────────────────────────────────────────────

    /// @notice Deploys the factory.
    /// @param usdc_         USDC token address used for all wallets.
    /// @param feeRecipient_ Initial protocol fee recipient.
    /// @param feeBps_       Initial protocol fee in basis points (max 500).
    constructor(address usdc_, address feeRecipient_, uint16 feeBps_) {
        if (usdc_ == address(0) || feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > 500) revert InvalidFee();

        usdc         = usdc_;
        feeRecipient = feeRecipient_;
        feeBps       = feeBps_;
        owner        = msg.sender;

        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Ownership (2-step) ─────────────────────────────────────────────────

    /// @notice Initiates a 2-step ownership transfer. Recipient must call acceptOwnership().
    /// @param newOwner Candidate new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Completes the ownership transfer. Must be called by the pending owner.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        address oldOwner = owner;
        owner        = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(oldOwner, msg.sender);
    }

    // ─── Fee recipient (2-step) ──────────────────────────────────────────────

    /// @notice Starts the 2-step fee recipient transfer.
    /// @param newRecipient Candidate new fee recipient.
    function transferFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingFeeRecipient = newRecipient;
        emit FeeRecipientTransferStarted(feeRecipient, newRecipient);
    }

    /// @notice Completes the fee recipient transfer. Must be called by the pending recipient.
    function acceptFeeRecipient() external {
        if (msg.sender != pendingFeeRecipient) revert OnlyPendingRecipient();
        address oldRecipient = feeRecipient;
        feeRecipient         = msg.sender;
        pendingFeeRecipient  = address(0);
        emit FeeRecipientChanged(oldRecipient, msg.sender);
    }

    // ─── Fee config ─────────────────────────────────────────────────────────

    /// @notice Updates the protocol fee for future wallet deployments only.
    /// @dev Existing wallets are unaffected (fee is snapshotted at creation).
    /// @param newBps New fee in basis points (max 500).
    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > 500) revert InvalidFee();
        uint16 oldBps = feeBps;
        feeBps = newBps;
        emit FeeBpsChanged(oldBps, newBps);
    }

    // ─── Wallet creation ────────────────────────────────────────────────────

    /// @notice Deploys a new AgentWallet at a deterministic CREATE2 address.
    /// @dev Caller chooses a userSalt (e.g. a counter) to allow multiple wallets per owner
    ///      with predictable addresses. Use predictWalletAddress() to compute the address first.
    /// @param owner_       Wallet owner address.
    /// @param agentSigner  Initial trusted voucher signer.
    /// @param settleWindow Settlement window in seconds (min 600).
    /// @param userSalt     Arbitrary caller-supplied entropy for address uniqueness.
    /// @return wallet Address of the newly deployed AgentWallet.
    function createWallet(
        address owner_,
        address agentSigner,
        uint32  settleWindow,
        bytes32 userSalt
    ) external returns (address wallet) {
        if (owner_ == address(0) || agentSigner == address(0)) revert ZeroAddress();
        if (settleWindow < 600) revert InvalidSettleWindow();

        bytes32 salt = _computeSalt(owner_, agentSigner, userSalt);

        wallet = address(
            new AgentWallet{salt: salt}(owner_, agentSigner, usdc, feeRecipient, feeBps, settleWindow)
        );

        _ownerWallets[owner_].push(wallet);
        isFactoryWallet[wallet] = true;

        emit WalletCreated(owner_, wallet, agentSigner, settleWindow, feeBps, userSalt);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns all wallets created for an owner.
    /// @param owner_ Wallet owner address.
    function walletsOf(address owner_) external view returns (address[] memory) {
        return _ownerWallets[owner_];
    }

    /// @notice Predicts the CREATE2 address for a wallet before deployment.
    /// @dev Use the same parameters you intend to pass to createWallet().
    function predictWalletAddress(
        address owner_,
        address agentSigner,
        uint32  settleWindow,
        uint16  feeBps_,
        bytes32 userSalt
    ) external view returns (address) {
        bytes32 salt = _computeSalt(owner_, agentSigner, userSalt);
        bytes32 initCodeHash = keccak256(
            abi.encodePacked(
                type(AgentWallet).creationCode,
                abi.encode(owner_, agentSigner, usdc, feeRecipient, feeBps_, settleWindow)
            )
        );
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)))));
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _computeSalt(address owner_, address agentSigner, bytes32 userSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner_, agentSigner, userSalt));
    }
}
