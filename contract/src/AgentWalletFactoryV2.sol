// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV2} from "./AgentWalletV2.sol";

/// @title AgentWalletFactoryV2
/// @notice CREATE2 deployer for AgentWalletV2 instances with a factory-level token allowlist.
///
/// @dev V2 extends V1 factory with:
///      - Token allowlist: only tokens on the allowlist can be deposited into or settled from V2 wallets.
///      - Wallets embed the factory address so they can check the allowlist at runtime.
///      - All V1 ownership / fee-governance patterns preserved (2-step ownership, 2-step fee recipient,
///        feeBps snapshotted per wallet, max 500 bps).
///
///      Token allowlist design: the factory is the single source of truth.  Wallets call back into
///      `isAllowedToken(token)` at deposit and settle time.  Removing a token from the allowlist
///      prevents NEW deposits and settlements but does NOT freeze funds already held — the owner
///      can still withdraw existing balances of de-listed tokens via `emergencyWithdraw`.
contract AgentWalletFactoryV2 {

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

    event OwnershipTransferStarted(address indexed current, address indexed pending);
    event OwnershipTransferred(address indexed previous, address indexed next);
    event FeeRecipientTransferStarted(address indexed current, address indexed pending);
    event FeeRecipientChanged(address indexed oldRecipient, address indexed newRecipient);
    event FeeBpsChanged(uint16 oldBps, uint16 newBps);
    event TokenAllowed(address indexed token);
    event TokenRemoved(address indexed token);
    event WalletCreated(
        address indexed walletOwner,
        address indexed wallet,
        address agentSigner,
        uint32  settleWindow,
        uint16  feeBps,
        bytes32 userSalt
    );

    // ─── State ───────────────────────────────────────────────────────────────

    address public owner;
    address public pendingOwner;
    address public feeRecipient;
    address public pendingFeeRecipient;
    uint16  public feeBps;

    /// @notice Token allowlist. Only allowlisted tokens may be deposited or settled.
    mapping(address => bool) public isAllowedToken;

    mapping(address => address[]) private _ownerWallets;
    mapping(address => bool)      public  isFactoryWallet;

    // ─── Constructor ────────────────────────────────────────────────────────

    /// @notice Deploys the V2 factory.
    /// @param feeRecipient_ Initial protocol fee recipient.
    /// @param feeBps_       Initial fee in basis points (max 500).
    /// @param initialTokens Initial set of allowed tokens (e.g. [USDC, USDT]).
    constructor(
        address feeRecipient_,
        uint16  feeBps_,
        address[] memory initialTokens
    ) {
        if (feeRecipient_ == address(0)) revert ZeroAddress();
        if (feeBps_ > 500) revert InvalidFee();

        feeRecipient = feeRecipient_;
        feeBps       = feeBps_;
        owner        = msg.sender;

        emit OwnershipTransferred(address(0), msg.sender);

        for (uint256 i; i < initialTokens.length; ++i) {
            address t = initialTokens[i];
            if (t == address(0)) revert ZeroAddress();
            isAllowedToken[t] = true;
            emit TokenAllowed(t);
        }
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Ownership (2-step) ─────────────────────────────────────────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert OnlyPendingOwner();
        address old = owner;
        owner        = msg.sender;
        pendingOwner = address(0);
        emit OwnershipTransferred(old, msg.sender);
    }

    // ─── Fee recipient (2-step) ──────────────────────────────────────────────

    function transferFeeRecipient(address newRecipient) external onlyOwner {
        if (newRecipient == address(0)) revert ZeroAddress();
        pendingFeeRecipient = newRecipient;
        emit FeeRecipientTransferStarted(feeRecipient, newRecipient);
    }

    function acceptFeeRecipient() external {
        if (msg.sender != pendingFeeRecipient) revert OnlyPendingRecipient();
        address old         = feeRecipient;
        feeRecipient        = msg.sender;
        pendingFeeRecipient = address(0);
        emit FeeRecipientChanged(old, msg.sender);
    }

    // ─── Fee config ─────────────────────────────────────────────────────────

    function setFeeBps(uint16 newBps) external onlyOwner {
        if (newBps > 500) revert InvalidFee();
        emit FeeBpsChanged(feeBps, newBps);
        feeBps = newBps;
    }

    // ─── Token allowlist ────────────────────────────────────────────────────

    /// @notice Adds a token to the allowlist. Only the factory owner may call.
    /// @param token ERC-20 token address to allow.
    function addToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (isAllowedToken[token]) revert TokenAlreadyAllowed();
        isAllowedToken[token] = true;
        emit TokenAllowed(token);
    }

    /// @notice Removes a token from the allowlist.
    /// @dev Existing wallet balances of this token are unaffected; the owner can still
    ///      call `AgentWalletV2.emergencyWithdraw` to recover them.
    ///      Vouchers with this token submitted after removal will revert at settle time.
    /// @param token ERC-20 token address to remove.
    function removeToken(address token) external onlyOwner {
        if (!isAllowedToken[token]) revert TokenNotAllowed();
        isAllowedToken[token] = false;
        emit TokenRemoved(token);
    }

    // ─── Wallet creation ────────────────────────────────────────────────────

    /// @notice Deploys a new AgentWalletV2 at a deterministic CREATE2 address.
    /// @param owner_       Wallet owner.
    /// @param agentSigner  Initial trusted voucher signer.
    /// @param settleWindow Safety window in seconds (min 600).
    /// @param userSalt     Caller-supplied salt for address uniqueness.
    /// @return wallet Address of the deployed wallet.
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
            new AgentWalletV2{salt: salt}(
                owner_,
                agentSigner,
                address(this),   // factory — wallet calls back for allowlist + fee config
                feeRecipient,
                feeBps,
                settleWindow
            )
        );

        _ownerWallets[owner_].push(wallet);
        isFactoryWallet[wallet] = true;

        emit WalletCreated(owner_, wallet, agentSigner, settleWindow, feeBps, userSalt);
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    function walletsOf(address owner_) external view returns (address[] memory) {
        return _ownerWallets[owner_];
    }

    /// @notice Predicts the CREATE2 address for a V2 wallet before deployment.
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
                type(AgentWalletV2).creationCode,
                abi.encode(owner_, agentSigner, address(this), feeRecipient, feeBps_, settleWindow)
            )
        );
        return address(uint160(uint256(keccak256(
            abi.encodePacked(bytes1(0xff), address(this), salt, initCodeHash)
        ))));
    }

    // ─── Internal ────────────────────────────────────────────────────────────

    function _computeSalt(address owner_, address agentSigner, bytes32 userSalt) private pure returns (bytes32) {
        return keccak256(abi.encode(owner_, agentSigner, userSalt));
    }
}
