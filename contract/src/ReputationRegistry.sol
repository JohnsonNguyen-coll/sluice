// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReputationRegistry
/// @notice Stores raw, verifiable reputation data for agents and providers.
///
/// @dev Design principles (DECISIONS.md D23):
///      1. OBJECTIVE counters are written ONLY by the protocol (trusted callers = DisputeVault + V3 wallets).
///         No external party can inflate their own stats.
///      2. SUBJECTIVE feedback is written by agent wallets that have a proven settlement history
///         with the provider. Weight is proportional to total fees paid (capped per pair to resist wash trading).
///      3. SCORE COMPUTATION is intentionally off-chain (pure SDK function `computeReputation(rawData)`).
///         This means the formula can evolve without a contract upgrade, and on-chain storage stays minimal.
///      4. Same-owner pairs (agent owner == provider owner via registry lookup) are flagged and excluded
///         from the off-chain score.
///
/// @dev Payment-specific extension, NOT the standard ERC-8004 reputation ABI.
///      Indexers must use the AgentPay ABI; see DECISIONS.md D23.
contract ReputationRegistry {

    // ─── Constants ──────────────────────────────────────────────────────────

    /// @notice Maximum fee weight any single agent/provider pair contributes to reputation score.
    ///         Prevents wash-trading attacks (D23).
    uint256 public constant MAX_PAIR_WEIGHT_USD_E6 = 10_000 * 1e6; // $10,000 cap

    // ─── Structs ────────────────────────────────────────────────────────────

    struct ProviderStats {
        uint256 totalVolumeUsdE6;      // gross settled volume in USD micro-units
        uint256 settledCount;          // total settlement calls
        uint256 firstSeen;             // timestamp of first settlement
        uint256 disputesReceived;      // total disputes opened against this provider
        uint256 disputesWon;           // disputes decided in provider's favour
        uint256 disputesLost;          // disputes decided against provider (refunded)
        uint256 disputesAutoRefunded;  // disputes that triggered auto-refund (provider silent)
        uint256 uniqueAgents;          // approximate: incremented on first settlement with each agent
    }

    struct AgentStats {
        uint256 totalVolumeUsdE6;
        uint256 settledCount;
        uint256 firstSeen;
        uint256 disputesOpened;
        uint256 disputesWon;
        uint256 disputesLost;
        uint256 uniqueProviders;
        uint256 disputesAutoRefunded;
    }

    struct Feedback {
        uint8   score;           // 1–5
        bytes32 tagHash;         // keccak256 of a tag string (off-chain: "fast", "accurate", etc.)
        bytes32 evidenceHash;    // hash of supporting off-chain evidence (can be 0x0)
        uint256 feesPaidUsdE6;   // weight: total fees paid by this agent to this provider
        uint256 updatedAt;
    }

    // ─── Errors ─────────────────────────────────────────────────────────────

    error NotTrustedCaller();
    error InvalidScore();
    error NoSettlementHistory();
    error ZeroAddress();
    error NotAdmin();
    error InvalidFees();
    error InvalidOutcome();

    // ─── Events ─────────────────────────────────────────────────────────────

    event ProviderStatsUpdated(address indexed provider, uint256 volumeUsdE6, uint256 settledCount);
    event AgentStatsUpdated(address indexed wallet, uint256 volumeUsdE6, uint256 settledCount);
    event DisputeOutcomeRecorded(address indexed provider, address indexed wallet, uint8 outcome);
    event DisputeOpenedRecorded(address indexed provider, address indexed wallet);
    event FeedbackGiven(address indexed wallet, address indexed provider, uint8 score, bytes32 tagHash);
    event TrustedCallerSet(address indexed caller, bool trusted);

    // ─── State ──────────────────────────────────────────────────────────────

    address public admin;
    address public pendingAdmin;

    /// @notice Trusted callers that may write objective stats (DisputeVault, AgentWalletV3).
    mapping(address => bool) public trustedCaller;

    /// @notice provider address => objective stats
    mapping(address => ProviderStats) public providerStats;

    /// @notice wallet address => objective stats
    mapping(address => AgentStats) public agentStats;

    /// @notice wallet => provider => subjective feedback
    mapping(address => mapping(address => Feedback)) public feedback;

    /// @notice wallet => provider => total fees paid in USD E6 (for weight computation)
    mapping(address => mapping(address => uint256)) public pairFeesPaidUsdE6;
    mapping(address => mapping(address => bool)) public sameOwnerPair;

    /// @notice Approximate uniqueness tracking: wallet => provider => first settlement seen
    mapping(address => mapping(address => bool)) private _seenPair; // [wallet][provider]
    mapping(address => mapping(address => bool)) private _seenAgentProvider; // [provider][wallet]

    // ─── Constructor ────────────────────────────────────────────────────────

    constructor() {
        admin = msg.sender;
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyTrusted() {
        if (!trustedCaller[msg.sender]) revert NotTrustedCaller();
        _;
    }

    function setTrustedCaller(address caller, bool trusted) external onlyAdmin {
        if (caller == address(0)) revert ZeroAddress();
        trustedCaller[caller] = trusted;
        emit TrustedCallerSet(caller, trusted);
    }

    function transferAdmin(address newAdmin) external onlyAdmin { pendingAdmin = newAdmin; }
    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ─── Trusted-caller writes (objective) ──────────────────────────────────

    /// @notice Record a settlement. Called by AgentWalletV3 after every successful settle().
    /// @param wallet     Agent wallet address.
    /// @param provider   Provider address.
    /// @param deltaUsdE6 USD-equivalent value of this settlement (owner-set rate).
    function recordSettlement(
        address wallet,
        address provider,
        uint256 deltaUsdE6
    ) external onlyTrusted {
        // Legacy callers do not supply verifiable fees, so they get no score weight.
        _recordSettlement(wallet, provider, deltaUsdE6, 0);
    }

    function recordSettlement(
        address wallet,
        address provider,
        uint256 deltaUsdE6,
        uint256 feesUsdE6
    ) external onlyTrusted {
        if (feesUsdE6 > deltaUsdE6) revert InvalidFees();
        _recordSettlement(wallet, provider, deltaUsdE6, feesUsdE6);
    }

    function _recordSettlement(address wallet, address provider, uint256 deltaUsdE6, uint256 feesUsdE6) internal {
        if (wallet == address(0) || provider == address(0)) revert ZeroAddress();
        ProviderStats storage ps = providerStats[provider];
        AgentStats    storage as_ = agentStats[wallet];

        if (ps.firstSeen == 0) ps.firstSeen = block.timestamp;
        if (as_.firstSeen == 0) as_.firstSeen = block.timestamp;

        ps.totalVolumeUsdE6 += deltaUsdE6;
        ps.settledCount     += 1;
        as_.totalVolumeUsdE6 += deltaUsdE6;
        as_.settledCount     += 1;

        // Approximate unique-counterparty count
        if (!_seenAgentProvider[provider][wallet]) {
            _seenAgentProvider[provider][wallet] = true;
            ps.uniqueAgents += 1;
        }
        if (!_seenPair[wallet][provider]) {
            _seenPair[wallet][provider] = true;
            as_.uniqueProviders += 1;
        }

        // Accumulate fees-paid weight for subjective feedback
        pairFeesPaidUsdE6[wallet][provider] += feesUsdE6;
        sameOwnerPair[wallet][provider] = sameOwnerPair[wallet][provider] || _sameOwner(wallet, provider);

        emit ProviderStatsUpdated(provider, ps.totalVolumeUsdE6, ps.settledCount);
        emit AgentStatsUpdated(wallet, as_.totalVolumeUsdE6, as_.settledCount);
    }

    // Outcome constants — use these values when calling recordDisputeOutcome
    // 0 = provider won, 1 = agent won, 2 = auto-refund, 3 = split
    uint8 public constant OUTCOME_PROVIDER_WON  = 0;
    uint8 public constant OUTCOME_AGENT_WON     = 1;
    uint8 public constant OUTCOME_AUTO_REFUND   = 2;
    uint8 public constant OUTCOME_SPLIT         = 3;

    /// @notice Count a dispute when it opens, including those still unresolved.
    function recordDisputeOpened(address wallet, address provider) external onlyTrusted {
        providerStats[provider].disputesReceived += 1;
        agentStats[wallet].disputesOpened += 1;
        emit DisputeOpenedRecorded(provider, wallet);
    }

    /// @notice Record a dispute outcome. Called by DisputeVault.
    /// @param outcome  0=provider won, 1=agent won, 2=auto-refund, 3=split
    function recordDisputeOutcome(
        address wallet,
        address provider,
        uint8   outcome
    ) external onlyTrusted {
        if (outcome > OUTCOME_SPLIT) revert InvalidOutcome();
        ProviderStats storage ps = providerStats[provider];
        AgentStats    storage as_ = agentStats[wallet];

        if (outcome == OUTCOME_PROVIDER_WON) {
            ps.disputesWon  += 1;
            as_.disputesLost += 1;
        } else if (outcome == OUTCOME_AGENT_WON) {
            ps.disputesLost += 1;
            as_.disputesWon += 1;
        } else if (outcome == OUTCOME_AUTO_REFUND) {
            ps.disputesAutoRefunded += 1;
            ps.disputesLost         += 1;
            as_.disputesWon         += 1;
            as_.disputesAutoRefunded += 1;
        } else {
            // split — count as partial for both
            ps.disputesLost += 1;
            as_.disputesWon += 1;
        }

        emit DisputeOutcomeRecorded(provider, wallet, outcome);
    }

    // ─── Subjective feedback ─────────────────────────────────────────────────

    /// @notice Leave or update a 1–5 star review for a provider.
    /// @dev    The wallet MUST have at least one settlement with this provider.
    ///         Caller is the wallet itself or its current on-chain owner.
    ///         Weight is `min(pairFeesPaidUsdE6, MAX_PAIR_WEIGHT_USD_E6)`.
    ///         One active feedback per (wallet, provider); updating overwrites the old entry.
    /// @param wallet The settled wallet; only that wallet or its current on-chain owner may submit.
    /// @param provider Provider address.
    /// @param score    1–5.
    /// @param tagHash  keccak256 of a free-text tag (e.g. "fast", "accurate").
    /// @param evidenceHash Hash of supporting evidence stored off-chain (can be bytes32(0)).
    function giveFeedback(
        address wallet,
        address provider,
        uint8   score,
        bytes32 tagHash,
        bytes32 evidenceHash
    ) external {
        if (msg.sender != wallet && msg.sender != _ownerOf(wallet)) revert NoSettlementHistory();

        if (score < 1 || score > 5) revert InvalidScore();
        if (!_seenPair[wallet][provider]) revert NoSettlementHistory();

        uint256 weight = pairFeesPaidUsdE6[wallet][provider];
        if (weight > MAX_PAIR_WEIGHT_USD_E6) weight = MAX_PAIR_WEIGHT_USD_E6;
        bool selfOwned = sameOwnerPair[wallet][provider] || _sameOwner(wallet, provider);
        sameOwnerPair[wallet][provider] = selfOwned;
        if (selfOwned) weight = 0;

        feedback[wallet][provider] = Feedback({
            score:         score,
            tagHash:       tagHash,
            evidenceHash:  evidenceHash,
            feesPaidUsdE6: weight,
            updatedAt:     block.timestamp
        });

        emit FeedbackGiven(wallet, provider, score, tagHash);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function getProviderStats(address provider) external view returns (ProviderStats memory) {
        return providerStats[provider];
    }

    function getAgentStats(address wallet) external view returns (AgentStats memory) {
        return agentStats[wallet];
    }

    function getFeedback(address wallet, address provider) external view returns (Feedback memory) {
        Feedback memory entry = feedback[wallet][provider];
        // Recheck current ownership too: ownership can change after feedback.
        if (sameOwnerPair[wallet][provider] || _sameOwner(wallet, provider)) entry.feesPaidUsdE6 = 0;
        return entry;
    }

    function _ownerOf(address account) internal view returns (address) {
        (bool ok, bytes memory data) = account.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length != 32) return address(0);
        uint256 raw = abi.decode(data, (uint256));
        if (raw > type(uint160).max) return address(0);
        return address(uint160(raw));
    }

    function _sameOwner(address wallet, address provider) internal view returns (bool) {
        address walletOwner = _ownerOf(wallet);
        if (walletOwner == address(0)) return wallet == provider;
        address providerOwner = _ownerOf(provider);
        return walletOwner == (providerOwner == address(0) ? provider : providerOwner);
    }

    /// @notice Has this wallet ever settled with this provider?
    function hasHistory(address wallet, address provider) external view returns (bool) {
        return _seenPair[wallet][provider];
    }
}
