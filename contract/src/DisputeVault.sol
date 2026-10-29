// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard}  from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20}        from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20}           from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ProviderRegistry} from "./ProviderRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";

/// @title DisputeVault
/// @notice Holds settled provider payouts during the dispute window.
///         Supports: instant release (window==0), dispute open, provider accept, arbiter resolve,
///         auto-refund on provider silence, and arbiter-timeout safe default.
///
/// @dev Funds flow:
///      1. AgentWalletV3.settle() calls vault.receive(settlementId, wallet, provider, token, amount).
///         Vault holds the amount; provider does NOT receive immediately.
///      2. After disputeWindow elapses, anyone calls vault.release(settlementId) -> funds to provider payout address.
///      3. Within the window, the agent wallet owner calls vault.openDispute(...).
///      4. Resolution: provider acceptDispute / provider respondToDispute (arbiter decides) /
///         auto-refund on silence / arbiter timeout -> safe refund.
///      5. Refunds go back into the AgentWallet (token balance) via wallet.receiveRefund(token, amount).
///
/// @dev Security properties:
///      - Arbiter can only split the DISPUTED portion — cannot touch undisputed funds or other settlements.
///      - A paused wallet can still have disputes resolved; refunds go into the wallet's token balance.
///      - Token removed from allowlist mid-dispute: refund still processes (held funds are not gated by allowlist).
///      - Bond is locked at dispute open; returned if agent wins fully or partially.
///      - Double-release and double-refund prevented by state machine.
///      - Settlement-time arbiter and payout snapshots survive provider/admin changes.
///      - After the hold, undisputed funds may release once while principal/bond stay locked.
contract DisputeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Constants ──────────────────────────────────────────────────────────

    uint256 public constant MAX_DISPUTE_WINDOW  = 7 days;
    uint256 public constant RESPONSE_DEADLINE   = 3 days;  // provider must respond within this
    uint256 public constant ARBITER_DEADLINE    = 3 days;  // arbiter must decide within this

    // ─── Settlement state machine ────────────────────────────────────────────
    //
    //   HELD -> RELEASED          (no dispute, window elapsed)
    //   HELD -> DISPUTED          (dispute opened within window)
    //   DISPUTED -> REFUNDED      (provider accepts OR auto-refund OR arbiter decides full-refund)
    //   DISPUTED -> RELEASED      (arbiter decides full-release)
    //   DISPUTED -> SPLIT         (arbiter decides partial; held amount redistributed)
    //   SPLIT -> (terminal)
    //   RELEASED -> (terminal)
    //   REFUNDED -> (terminal)

    enum SettlementState { HELD, RELEASED, DISPUTED, SPLIT, REFUNDED }

    // ─── Structs ────────────────────────────────────────────────────────────

    struct Settlement {
        address wallet;         // AgentWallet that made the payment
        address provider;       // provider address
        address token;          // ERC-20 token
        uint256 amount;         // gross payout held (net of protocol fee, as transferred by wallet)
        uint256 heldAt;         // timestamp of settlement
        uint256 releaseAfter;   // heldAt + disputeWindow
        SettlementState state;
        address payoutAddress;  // snapshotted when the payment enters the vault
        address arbiter;        // provider preference/default at settlement time
        uint256 undisputedReleased; // paid before final resolution; never paid twice
    }

    struct Dispute {
        address openedBy;       // wallet owner who opened
        uint256 amount;         // disputed amount (<= settlement.amount)
        uint256 bond;           // bond locked in the dispute token
        uint8   reasonCode;     // provider-defined reason codes
        bytes32 evidenceHash;   // hash of off-chain evidence (agent side)
        uint256 openedAt;
        uint256 responseDeadline;
        bytes32 providerEvidenceHash;
        uint256 arbiterDeadline;
        bool    providerResponded;
        bool    resolved;
    }

    // ─── Errors ─────────────────────────────────────────────────────────────

    error NotTrustedWallet();
    error SettlementNotFound();
    error NotInHeldState();
    error DisputeWindowExpired();
    error DisputeAmountTooLarge();
    error DisputeAlreadyOpen();
    error NotWalletOwner();
    error NotProvider();
    error NotArbiter();
    error ProviderAlreadyResponded();
    error ResponseDeadlineExpired();
    error ProviderNotResponded();
    error ArbiterDeadlineExpired();
    error NoUndisputedFunds();
    error ArbiterDeadlineNotExpired();
    error SplitExceedsDisputed();
    error AlreadyResolved();
    error ReleaseWindowNotElapsed();
    error NotInDisputedState();
    error ZeroAddress();
    error NotAdmin();
    error BondNotSet();
    error InsufficientBond();

    // ─── Events ─────────────────────────────────────────────────────────────

    event SettlementReceived(bytes32 indexed settlementId, address indexed wallet, address indexed provider, address token, uint256 amount, uint256 releaseAfter);
    event SettlementReleased(bytes32 indexed settlementId, address indexed provider, uint256 amount);
    event UndisputedReleased(bytes32 indexed settlementId, address indexed provider, uint256 amount);
    event DisputeOpened(bytes32 indexed settlementId, address indexed wallet, uint256 amount, uint8 reasonCode, bytes32 evidenceHash);
    event ProviderResponded(bytes32 indexed settlementId, bytes32 evidenceHash);
    event DisputeAccepted(bytes32 indexed settlementId, uint256 refundAmount);
    event ArbiterDecided(bytes32 indexed settlementId, uint256 refundToWallet, uint256 releaseToProvider, bool bondReturnedToAgent);
    event AutoRefunded(bytes32 indexed settlementId, uint256 amount);
    event ArbiterTimedOut(bytes32 indexed settlementId, uint256 refundAmount);
    event DefaultArbiterChanged(address indexed oldArbiter, address indexed newArbiter);
    event DisputeBondSet(address indexed token, uint256 bond);
    event TrustedWalletSet(address indexed wallet, bool trusted);

    // ─── State ──────────────────────────────────────────────────────────────

    address public admin;
    address public pendingAdmin;
    address public defaultArbiter;
    address public pendingDefaultArbiter;

    ProviderRegistry   public immutable providerRegistry;
    ReputationRegistry public immutable reputationRegistry;

    /// @notice Trusted wallets (AgentWalletV3 instances verified by factory)
    mapping(address => bool) public trustedWallet;

    /// @notice settlementId => Settlement
    mapping(bytes32 => Settlement) public settlements;

    /// @notice settlementId => Dispute
    mapping(bytes32 => Dispute) public disputes;

    /// @notice Configurable dispute bond per token (set by admin)
    mapping(address => uint256) public disputeBond;

    // ─── Constructor ────────────────────────────────────────────────────────

    constructor(
        address defaultArbiter_,
        address providerRegistry_,
        address reputationRegistry_
    ) {
        if (defaultArbiter_ == address(0)) revert ZeroAddress();
        admin = msg.sender;
        defaultArbiter = defaultArbiter_;
        providerRegistry = ProviderRegistry(providerRegistry_);
        reputationRegistry = ReputationRegistry(reputationRegistry_);
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    function transferAdmin(address newAdmin) external onlyAdmin { pendingAdmin = newAdmin; }
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
    }

    /// @notice 2-step default arbiter change.
    function transferDefaultArbiter(address newArbiter) external onlyAdmin {
        if (newArbiter == address(0)) revert ZeroAddress();
        pendingDefaultArbiter = newArbiter;
    }
    function acceptDefaultArbiter() external {
        if (msg.sender != pendingDefaultArbiter) revert NotAdmin();
        address old = defaultArbiter;
        defaultArbiter = pendingDefaultArbiter;
        pendingDefaultArbiter = address(0);
        emit DefaultArbiterChanged(old, defaultArbiter);
    }

    /// @notice Set the dispute bond for a token (0 = no bond required).
    function setDisputeBond(address token, uint256 amount) external onlyAdmin {
        disputeBond[token] = amount;
        emit DisputeBondSet(token, amount);
    }

    function setTrustedWallet(address wallet, bool trusted) external onlyAdmin {
        trustedWallet[wallet] = trusted;
        emit TrustedWalletSet(wallet, trusted);
    }

    // ─── Core: receive settlement ────────────────────────────────────────────

    /// @notice Called by AgentWalletV3 when settling with a provider that has disputeWindow > 0.
    ///         Tokens are already transferred to this vault by the wallet before this call.
    /// @param settlementId Unique ID (keccak256 of wallet+provider+token+nonce+block).
    /// @param wallet_      The AgentWallet address.
    /// @param provider_    The provider address.
    /// @param token_       The ERC-20 token.
    /// @param amount_      The amount held.
    /// @param window_      The provider's current dispute window in seconds.
    function receiveSettlement(
        bytes32 settlementId,
        address wallet_,
        address provider_,
        address token_,
        uint256 amount_,
        uint32  window_
    ) external {
        if (!trustedWallet[msg.sender]) revert NotTrustedWallet();
        if (settlements[settlementId].heldAt != 0) revert DisputeAlreadyOpen(); // re-use error; means duplicate id

        settlements[settlementId] = Settlement({
            wallet:       wallet_,
            provider:     provider_,
            token:        token_,
            amount:       amount_,
            heldAt:       block.timestamp,
            releaseAfter: block.timestamp + window_,
            state:        SettlementState.HELD,
            payoutAddress: providerRegistry.payoutAddressOf(provider_),
            arbiter:      _arbiterFor(provider_),
            undisputedReleased: 0
        });

        emit SettlementReceived(settlementId, wallet_, provider_, token_, amount_, block.timestamp + window_);
    }

    // ─── Release (undisputed) ────────────────────────────────────────────────

    /// @notice Release funds to the provider after the dispute window has elapsed without a dispute.
    /// @dev Callable by anyone.
    function release(bytes32 settlementId) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        if (s.heldAt == 0) revert SettlementNotFound();
        if (s.state != SettlementState.HELD) revert NotInHeldState();
        if (block.timestamp < s.releaseAfter) revert ReleaseWindowNotElapsed();

        s.state = SettlementState.RELEASED;

        address payoutAddr = s.payoutAddress;
        IERC20(s.token).safeTransfer(payoutAddr, s.amount);

        emit SettlementReleased(settlementId, s.provider, s.amount);
    }

    /// @notice Pay the undisputed remainder after the original hold expires.
    /// @dev Anyone may trigger this once; the disputed principal and bond stay locked.
    function releaseUndisputed(bytes32 settlementId) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        Dispute storage d = disputes[settlementId];
        _requireDisputed(s, d);
        if (block.timestamp < s.releaseAfter) revert ReleaseWindowNotElapsed();
        uint256 amount = s.amount - d.amount - s.undisputedReleased;
        if (amount == 0) revert NoUndisputedFunds();
        s.undisputedReleased += amount;
        IERC20(s.token).safeTransfer(s.payoutAddress, amount);
        emit UndisputedReleased(settlementId, s.provider, amount);
    }

    // ─── Dispute open ────────────────────────────────────────────────────────

    /// @notice Open a dispute on a held settlement.
    /// @dev Caller must be the wallet owner. A bond is locked if configured.
    function openDispute(
        bytes32 settlementId,
        uint256 disputeAmount,
        uint8   reasonCode,
        bytes32 evidenceHash
    ) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        if (s.heldAt == 0) revert SettlementNotFound();
        if (s.state != SettlementState.HELD) revert NotInHeldState();
        if (block.timestamp >= s.releaseAfter) revert DisputeWindowExpired();
        if (disputes[settlementId].openedAt != 0) revert DisputeAlreadyOpen();
        if (disputeAmount == 0 || disputeAmount > s.amount) revert DisputeAmountTooLarge();

        // Caller must be the wallet owner
        if (!_isWalletOwner(s.wallet, msg.sender)) revert NotWalletOwner();

        // Lock bond (pulled from caller)
        uint256 bond = disputeBond[s.token];
        if (bond > 0) {
            IERC20(s.token).safeTransferFrom(msg.sender, address(this), bond);
        }

        s.state = SettlementState.DISPUTED;

        disputes[settlementId] = Dispute({
            openedBy:             msg.sender,
            amount:               disputeAmount,
            bond:                 bond,
            reasonCode:           reasonCode,
            evidenceHash:         evidenceHash,
            openedAt:             block.timestamp,
            responseDeadline:     block.timestamp + RESPONSE_DEADLINE,
            providerEvidenceHash: bytes32(0),
            arbiterDeadline:      0,
            providerResponded:    false,
            resolved:             false
        });

        reputationRegistry.recordDisputeOpened(s.wallet, s.provider);
        emit DisputeOpened(settlementId, s.wallet, disputeAmount, reasonCode, evidenceHash);
    }

    // ─── Provider: accept dispute ─────────────────────────────────────────────

    /// @notice Provider concedes: refund disputeAmount to wallet, release remainder to provider.
    function acceptDispute(bytes32 settlementId) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        Dispute    storage d = disputes[settlementId];
        _requireDisputed(s, d);
        if (msg.sender != s.provider) revert NotProvider();
        if (d.resolved) revert AlreadyResolved();

        d.resolved = true;
        s.state    = SettlementState.REFUNDED;

        uint256 refund    = d.amount;
        uint256 remainder = s.amount - refund - s.undisputedReleased;

        // Refund bond back to agent
        if (d.bond > 0) IERC20(s.token).safeTransfer(d.openedBy, d.bond);

        // Refund disputed amount to wallet
        _refundToWallet(s.wallet, s.token, refund);

        // Release remainder (undisputed) to provider payout address
        if (remainder > 0) {
            address payoutAddr = s.payoutAddress;
            IERC20(s.token).safeTransfer(payoutAddr, remainder);
        }

        // Record outcome
        reputationRegistry.recordDisputeOutcome(s.wallet, s.provider, 1); // OUTCOME_AGENT_WON

        emit DisputeAccepted(settlementId, refund);
    }

    // ─── Provider: respond ───────────────────────────────────────────────────

    /// @notice Provider submits counter-evidence strictly before responseDeadline.
    function respondToDispute(bytes32 settlementId, bytes32 evidenceHash) external {
        Settlement storage s = settlements[settlementId];
        Dispute    storage d = disputes[settlementId];
        _requireDisputed(s, d);
        if (msg.sender != s.provider) revert NotProvider();
        if (d.providerResponded) revert ProviderAlreadyResponded();
        if (d.resolved) revert AlreadyResolved();

        if (block.timestamp >= d.responseDeadline) revert ResponseDeadlineExpired();

        d.providerResponded    = true;
        d.providerEvidenceHash = evidenceHash;
        d.arbiterDeadline      = block.timestamp + ARBITER_DEADLINE;

        emit ProviderResponded(settlementId, evidenceHash);
    }

    // ─── Auto-refund (provider silent) ──────────────────────────────────────

    /// @notice Anyone can trigger auto-refund after the response deadline if provider did not respond.
    function autoRefund(bytes32 settlementId) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        Dispute    storage d = disputes[settlementId];
        _requireDisputed(s, d);
        if (d.resolved) revert AlreadyResolved();
        if (d.providerResponded) revert ProviderAlreadyResponded(); // must use arbiter path
        if (block.timestamp < d.responseDeadline) revert ArbiterDeadlineNotExpired();

        d.resolved = true;
        s.state    = SettlementState.REFUNDED;

        uint256 refund    = d.amount;
        uint256 remainder = s.amount - refund - s.undisputedReleased;

        // Bond returned to agent on auto-refund (provider's fault)
        if (d.bond > 0) IERC20(s.token).safeTransfer(d.openedBy, d.bond);

        _refundToWallet(s.wallet, s.token, refund);

        if (remainder > 0) {
            address payoutAddr = s.payoutAddress;
            IERC20(s.token).safeTransfer(payoutAddr, remainder);
        }

        reputationRegistry.recordDisputeOutcome(s.wallet, s.provider, 2); // OUTCOME_AUTO_REFUND

        emit AutoRefunded(settlementId, refund);
    }

    // ─── Arbiter decision ────────────────────────────────────────────────────

    /// @notice Arbiter resolves: splits disputed amount between wallet and provider.
    /// @dev Only the settlement's snapshotted arbiter, after response and before arbiterDeadline.
    /// @param refundToWallet   Amount returned to agent wallet (must be <= d.amount).
    /// @param releaseToProvider Amount released to provider payout (must be <= d.amount - refundToWallet).
    ///                          Remainder (if any) due to integer split: goes to provider (safe default).
    /// @param returnBondToAgent True = bond returned to agent; false = bond forfeited to protocol (admin).
    function arbiterDecide(
        bytes32 settlementId,
        uint256 refundToWallet,
        uint256 releaseToProvider,
        bool    returnBondToAgent
    ) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        Dispute    storage d = disputes[settlementId];
        _requireDisputed(s, d);
        if (d.resolved) revert AlreadyResolved();

        // Must be the designated arbiter
        address arbiter = s.arbiter;
        if (msg.sender != arbiter) revert NotArbiter();

        // Arbitration only exists after a timely response and before its deadline.
        // Silence and expired arbitration have exclusive refund paths.
        if (!d.providerResponded) revert ProviderNotResponded();
        if (block.timestamp >= d.arbiterDeadline) revert ArbiterDeadlineExpired();

        // The arbiter can only split the DISPUTED amount
        if (refundToWallet + releaseToProvider > d.amount) revert SplitExceedsDisputed();

        d.resolved = true;

        // Determine settlement terminal state
        if (refundToWallet == d.amount) {
            s.state = SettlementState.REFUNDED;
        } else if (refundToWallet == 0) {
            s.state = SettlementState.RELEASED;
        } else {
            s.state = SettlementState.SPLIT;
        }

        // Bond handling
        if (d.bond > 0) {
            if (returnBondToAgent) {
                IERC20(s.token).safeTransfer(d.openedBy, d.bond);
            } else {
                // Bond forfeited to admin (protocol treasury)
                IERC20(s.token).safeTransfer(admin, d.bond);
            }
        }

        // Refund to wallet
        if (refundToWallet > 0) _refundToWallet(s.wallet, s.token, refundToWallet);

        // Remainder of disputed amount that is not refunded goes to provider
        uint256 toProvider = d.amount - refundToWallet;
        // Plus undisputed portion
        toProvider += (s.amount - d.amount - s.undisputedReleased);

        if (toProvider > 0) {
            address payoutAddr = s.payoutAddress;
            IERC20(s.token).safeTransfer(payoutAddr, toProvider);
        }

        // Reputation: determine effective outcome
        uint8 outcome;
        if (refundToWallet == d.amount) {
            outcome = 1; // OUTCOME_AGENT_WON
        } else if (refundToWallet == 0) {
            outcome = 0; // OUTCOME_PROVIDER_WON
        } else {
            outcome = 3; // OUTCOME_SPLIT
        }
        reputationRegistry.recordDisputeOutcome(s.wallet, s.provider, outcome);

        emit ArbiterDecided(settlementId, refundToWallet, toProvider, returnBondToAgent);
    }

    // ─── Arbiter timeout (safe default) ─────────────────────────────────────

    /// @notice If the arbiter misses its deadline after provider responded, anyone can trigger
    ///         a safe refund of the disputed amount to the wallet.
    function arbiterTimeout(bytes32 settlementId) external nonReentrant {
        Settlement storage s = settlements[settlementId];
        Dispute    storage d = disputes[settlementId];
        _requireDisputed(s, d);
        if (d.resolved) revert AlreadyResolved();
        if (!d.providerResponded) revert ArbiterDeadlineNotExpired(); // wrong path; use autoRefund
        if (block.timestamp < d.arbiterDeadline) revert ArbiterDeadlineNotExpired();

        d.resolved = true;
        s.state    = SettlementState.REFUNDED;

        uint256 refund    = d.amount;
        uint256 remainder = s.amount - refund - s.undisputedReleased;

        // Bond returned on arbiter timeout (neither party's fault)
        if (d.bond > 0) IERC20(s.token).safeTransfer(d.openedBy, d.bond);

        _refundToWallet(s.wallet, s.token, refund);

        if (remainder > 0) {
            address payoutAddr = s.payoutAddress;
            IERC20(s.token).safeTransfer(payoutAddr, remainder);
        }

        reputationRegistry.recordDisputeOutcome(s.wallet, s.provider, 1); // OUTCOME_AGENT_WON

        emit ArbiterTimedOut(settlementId, refund);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getSettlement(bytes32 id) external view returns (Settlement memory) {
        return settlements[id];
    }

    function getDispute(bytes32 id) external view returns (Dispute memory) {
        return disputes[id];
    }

    function isReleased(bytes32 id) external view returns (bool) {
        SettlementState st = settlements[id].state;
        return st == SettlementState.RELEASED || st == SettlementState.SPLIT || st == SettlementState.REFUNDED;
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    function _requireDisputed(Settlement storage s, Dispute storage d) internal view {
        if (s.heldAt == 0) revert SettlementNotFound();
        if (s.state != SettlementState.DISPUTED) revert NotInDisputedState();
        if (d.openedAt == 0) revert SettlementNotFound();
    }

    function _refundToWallet(address wallet, address token, uint256 amount) internal {
        // Transfer tokens to wallet contract; then notify it via receiveRefund
        IERC20(token).safeTransfer(wallet, amount);
        // Best-effort call to wallet.receiveRefund — wallet may not be V3 (paused/etc)
        // We do NOT revert if this call fails (funds are already at the wallet address)
        (bool ok,) = wallet.call(
            abi.encodeWithSignature("receiveRefund(address,uint256)", token, amount)
        );
        // If wallet rejects, the tokens still land at the wallet address — they're recoverable
        // as a plain token balance. See DECISIONS.md D25.
        if (!ok) {
            // Funds safe at wallet; no action needed. Emit nothing here — wallet events cover it.
        }
    }

    function _arbiterFor(address provider) internal view returns (address) {
        address preferred = providerRegistry.preferredArbiterOf(provider);
        return preferred != address(0) ? preferred : defaultArbiter;
    }

    function _isWalletOwner(address wallet, address caller) internal view returns (bool) {
        (bool ok, bytes memory data) = wallet.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return false;
        return abi.decode(data, (address)) == caller;
    }
}
