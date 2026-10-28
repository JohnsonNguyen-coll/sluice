// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ProviderRegistry
/// @notice On-chain registry for Sluice API providers.
///
/// @dev Providers self-register with a metadata hash (points to an off-chain ERC-8004-compatible
///      JSON file), preferred payout address, dispute window, and preferred arbiter address.
///      Domain verification is off-chain: the provider serves a signed message at
///      /.well-known/agentpay.json; the SDK/dashboard verify it without any on-chain oracle.
///
/// @dev ERC-8004 alignment: a provider entry mirrors the ERC-8004 "services" concept — the
///      metadata hash resolves to a JSON matching the ERC-8004 registration file schema.
///      The registry does NOT use ERC-721 for providers because provider identities are
///      tied to on-chain addresses (not transferable) — see DECISIONS.md D22.
contract ProviderRegistry {

    // ─── Constants ──────────────────────────────────────────────────────────

    /// @notice Maximum dispute window a provider may set (7 days).
    uint32 public constant MAX_DISPUTE_WINDOW = 7 days;

    // ─── Structs ────────────────────────────────────────────────────────────

    struct ProviderEntry {
        address payoutAddress;    // where settled funds are sent
        bytes32 metadataHash;     // keccak256 or CIDv1 of off-chain JSON
        uint32  disputeWindow;    // seconds; 0 = instant payout
        address preferredArbiter; // address(0) = use protocol default
        uint256 registeredAt;
        bool    active;
    }

    struct DisputeWindowChange {
        uint32  newWindow;
        uint256 requestedAt;
        uint256 effectiveAfter;  // requestedAt + current disputeWindow
    }

    // ─── Errors ─────────────────────────────────────────────────────────────

    error AlreadyRegistered();
    error NotRegistered();
    error NotProvider();
    error ZeroAddress();
    error DisputeWindowTooLong();
    error ChangeWindowNotElapsed();
    error NoPendingChange();

    // ─── Events ─────────────────────────────────────────────────────────────

    event ProviderRegistered(address indexed provider, address indexed payoutAddress, bytes32 metadataHash);
    event ProviderMetadataUpdated(address indexed provider, bytes32 newHash);
    event ProviderPayoutUpdated(address indexed provider, address newPayout);
    event ProviderArbiterUpdated(address indexed provider, address arbiter);
    event DisputeWindowChangeRequested(address indexed provider, uint32 newWindow, uint256 effectiveAfter);
    event DisputeWindowChanged(address indexed provider, uint32 oldWindow, uint32 newWindow);
    event ProviderDeactivated(address indexed provider);
    event ProviderReactivated(address indexed provider);

    // ─── State ──────────────────────────────────────────────────────────────

    /// @notice provider address => ProviderEntry
    mapping(address => ProviderEntry) public providers;

    /// @notice Pending dispute window changes (provider => pending change)
    mapping(address => DisputeWindowChange) public pendingWindowChanges;

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyProvider() {
        if (!providers[msg.sender].active) revert NotProvider();
        _;
    }

    // ─── Registration ───────────────────────────────────────────────────────

    /// @notice Register as a provider. msg.sender becomes the provider address.
    /// @param payoutAddress  Where settled funds go. Can differ from msg.sender.
    /// @param metadataHash   Hash of the off-chain ERC-8004-compatible JSON metadata.
    /// @param disputeWindow  Seconds before settled funds release. 0 = instant. Max 7 days.
    /// @param preferredArbiter Preferred dispute arbiter. address(0) = protocol default.
    function register(
        address payoutAddress,
        bytes32 metadataHash,
        uint32  disputeWindow,
        address preferredArbiter
    ) external {
        if (providers[msg.sender].registeredAt != 0) revert AlreadyRegistered();
        if (payoutAddress == address(0)) revert ZeroAddress();
        if (disputeWindow > MAX_DISPUTE_WINDOW) revert DisputeWindowTooLong();

        providers[msg.sender] = ProviderEntry({
            payoutAddress:    payoutAddress,
            metadataHash:     metadataHash,
            disputeWindow:    disputeWindow,
            preferredArbiter: preferredArbiter,
            registeredAt:     block.timestamp,
            active:           true
        });

        emit ProviderRegistered(msg.sender, payoutAddress, metadataHash);
    }

    // ─── Updates ─────────────────────────────────────────────────────────────

    /// @notice Update the off-chain metadata hash.
    function updateMetadata(bytes32 newHash) external onlyProvider {
        providers[msg.sender].metadataHash = newHash;
        emit ProviderMetadataUpdated(msg.sender, newHash);
    }

    /// @notice Update the payout address (immediate, not time-locked — only affects future settlements).
    function updatePayoutAddress(address newPayout) external onlyProvider {
        if (newPayout == address(0)) revert ZeroAddress();
        providers[msg.sender].payoutAddress = newPayout;
        emit ProviderPayoutUpdated(msg.sender, newPayout);
    }

    /// @notice Update the preferred arbiter.
    function updateArbiter(address arbiter) external onlyProvider {
        providers[msg.sender].preferredArbiter = arbiter;
        emit ProviderArbiterUpdated(msg.sender, arbiter);
    }

    /// @notice Step 1: request a dispute window change.
    /// @dev   Change takes effect after the CURRENT dispute window has elapsed from the request,
    ///        so providers cannot shorten their window to escape pending disputes.
    function requestDisputeWindowChange(uint32 newWindow) external onlyProvider {
        if (newWindow > MAX_DISPUTE_WINDOW) revert DisputeWindowTooLong();
        uint32 current = providers[msg.sender].disputeWindow;
        uint256 effectiveAfter = block.timestamp + current;
        pendingWindowChanges[msg.sender] = DisputeWindowChange({
            newWindow:      newWindow,
            requestedAt:    block.timestamp,
            effectiveAfter: effectiveAfter
        });
        emit DisputeWindowChangeRequested(msg.sender, newWindow, effectiveAfter);
    }

    /// @notice Step 2: apply the pending dispute window change after the delay.
    function applyDisputeWindowChange() external onlyProvider {
        DisputeWindowChange storage c = pendingWindowChanges[msg.sender];
        if (c.requestedAt == 0) revert NoPendingChange();
        if (block.timestamp < c.effectiveAfter) revert ChangeWindowNotElapsed();
        uint32 old = providers[msg.sender].disputeWindow;
        uint32 newWin = c.newWindow; // cache before delete
        providers[msg.sender].disputeWindow = newWin;
        delete pendingWindowChanges[msg.sender];
        emit DisputeWindowChanged(msg.sender, old, newWin);
    }

    function deactivate() external onlyProvider {
        providers[msg.sender].active = false;
        emit ProviderDeactivated(msg.sender);
    }

    function reactivate() external {
        if (providers[msg.sender].registeredAt == 0) revert NotRegistered();
        providers[msg.sender].active = true;
        emit ProviderReactivated(msg.sender);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function isRegistered(address provider) external view returns (bool) {
        return providers[provider].registeredAt != 0;
    }

    function isActive(address provider) external view returns (bool) {
        return providers[provider].active;
    }

    function getProvider(address provider) external view returns (ProviderEntry memory) {
        if (providers[provider].registeredAt == 0) revert NotRegistered();
        return providers[provider];
    }

    /// @notice Get the dispute window for a provider (0 if not registered).
    function disputeWindowOf(address provider) external view returns (uint32) {
        return providers[provider].disputeWindow;
    }

    /// @notice Get the payout address (falls back to provider address if not registered).
    function payoutAddressOf(address provider) external view returns (address) {
        address p = providers[provider].payoutAddress;
        return p != address(0) ? p : provider;
    }

    /// @notice Get the preferred arbiter (address(0) if none set or not registered).
    function preferredArbiterOf(address provider) external view returns (address) {
        return providers[provider].preferredArbiter;
    }
}
