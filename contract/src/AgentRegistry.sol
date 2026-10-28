// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgentRegistry
/// @notice ERC-8004-aligned identity registry for AI agents on the Sluice AgentPay protocol.
///
/// @dev Design choices (see docs/DECISIONS.md D21):
///      - Uses ERC-721 + URIStorage, following the ERC-8004 identity model.
///        This payment-wallet binding is an extension, not the full ERC-8004 ABI.
///      - `agentURI` resolves to an off-chain JSON registration file matching the ERC-8004 schema.
///      - Registration is permissioned: caller must prove wallet ownership via a trusted-factory check.
///      - Ownership of the NFT = ownership of the agent identity (transferable, 2-step rotate).
///      - The canonical Arc Testnet ERC-8004 registry lives at 0x8004A818BFB912233c491871b3d84c89A494BD9e;
///        Sluice deploys its own instance so wallets can be linked to its trusted factories.
///
/// @dev ERC-8004 alignment (partial):
///      - tokenId == agentId (incrementing uint256).
///      - tokenURI == agentURI (URI to off-chain registration file).
///      - setAgentURI (alias for _setTokenURI) callable by token owner or approved operators.
///      - Registration file schema: { type, name, description, image, services, x402Support,
///        active, registrations, supportedTrust } as specified in ERC-8004.
contract AgentRegistry is ERC721URIStorage, ReentrancyGuard {

    // ─── Structs ────────────────────────────────────────────────────────────

    struct AgentEntry {
        address wallet;     // AgentWallet address linked to this identity
        address owner;      // current owner (mirrors ERC-721 ownerOf)
        address signer;     // current agentSigner on the linked wallet (cached, updated on rotate)
        uint256 registeredAt;
    }

    // ─── Errors ─────────────────────────────────────────────────────────────

    error NotWalletOwner();
    error WalletNotFromFactory();
    error WalletAlreadyRegistered();
    error AgentNotFound();
    error NotAgentOwner();
    error ZeroAddress();
    error NotPendingOwner();

    // ─── Events ─────────────────────────────────────────────────────────────

    event AgentRegistered(uint256 indexed agentId, address indexed wallet, address indexed owner, string agentURI);
    event AgentURIUpdated(uint256 indexed agentId, string newURI);
    event AgentMetadataUpdated(uint256 indexed agentId, bytes32 metadataHash);
    event AgentSignerCached(uint256 indexed agentId, address newSigner);
    event OwnerRotateStarted(uint256 indexed agentId, address indexed pending);
    event OwnerRotated(uint256 indexed agentId, address indexed oldOwner, address indexed newOwner);
    event TrustedFactorySet(address indexed factory, bool trusted);
    event AdminTransferStarted(address indexed admin, address indexed pendingAdmin);
    event AdminTransferred(address indexed oldAdmin, address indexed newAdmin);

    // ─── State ──────────────────────────────────────────────────────────────

    uint256 private _nextId = 1;

    /// @notice Trusted factory addresses whose wallets may be registered.
    mapping(address => bool) public trustedFactory;

    /// @notice agentId => AgentEntry
    mapping(uint256 => AgentEntry) public agents;

    /// @notice wallet => agentId  (0 = not registered)
    mapping(address => uint256) public walletToAgent;
    mapping(uint256 => bytes32) public metadataHash;

    /// @notice Pending owner for 2-step rotation (agentId => pendingOwner)
    mapping(uint256 => address) public pendingOwner;

    /// @notice Registry admin (can add/remove trusted factories)
    address public admin;
    address public pendingAdmin;

    // ─── Constructor ────────────────────────────────────────────────────────

    /// @param initialFactories Initial set of trusted factory addresses
    constructor(address[] memory initialFactories) ERC721("Sluice Agent Identity", "SLUICE-AGENT") {
        admin = msg.sender;
        for (uint256 i; i < initialFactories.length; ++i) {
            if (initialFactories[i] == address(0)) revert ZeroAddress();
            trustedFactory[initialFactories[i]] = true;
            emit TrustedFactorySet(initialFactories[i], true);
        }
    }

    // ─── Admin ──────────────────────────────────────────────────────────────

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAgentOwner(); // reuse; admin-specific error not needed
        _;
    }

    /// @notice Add or remove a trusted factory.
    function setTrustedFactory(address factory, bool trusted) external onlyAdmin {
        if (factory == address(0)) revert ZeroAddress();
        trustedFactory[factory] = trusted;
        emit TrustedFactorySet(factory, trusted);
    }

    /// @notice 2-step admin transfer.
    function transferAdmin(address newAdmin) external onlyAdmin {
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotPendingOwner();
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    // ─── Registration ───────────────────────────────────────────────────────

    /// @notice Register an agent identity linked to an AgentWallet.
    /// @dev Caller must be the wallet owner. Wallet must have been deployed by a trusted factory.
    ///      The agentURI MUST resolve to an ERC-8004-compliant registration file.
    /// @param wallet  The AgentWallet address to link.
    /// @param agentURI_  URI to the off-chain ERC-8004 registration JSON.
    /// @return agentId  The newly minted token ID.
    function register(address wallet, string calldata agentURI_) external nonReentrant returns (uint256 agentId) {
        return _register(wallet, agentURI_, bytes32(0));
    }

    /// @notice Hash-only registration. No personal metadata is stored on-chain.
    /// @dev Named separately to avoid ambiguous string-literal overloads in existing integrations.
    function registerWithMetadataHash(address wallet, bytes32 hash) external nonReentrant returns (uint256 agentId) {
        return _register(wallet, "", hash);
    }

    function _register(address wallet, string memory agentURI_, bytes32 hash) internal returns (uint256 agentId) {
        if (wallet == address(0)) revert ZeroAddress();

        // Verify wallet is from a trusted factory
        if (!_isFromTrustedFactory(wallet)) revert WalletNotFromFactory();

        // Verify caller is the wallet owner
        if (!_isWalletOwner(wallet, msg.sender)) revert NotWalletOwner();

        // One registration per wallet
        if (walletToAgent[wallet] != 0) revert WalletAlreadyRegistered();

        agentId = _nextId++;
        // Cache signer from wallet
        address signer = _walletSigner(wallet);

        agents[agentId] = AgentEntry({
            wallet: wallet,
            owner: msg.sender,
            signer: signer,
            registeredAt: block.timestamp
        });
        walletToAgent[wallet] = agentId;
        metadataHash[agentId] = hash;

        // Commit the wallet link before the receiver callback. The callback may
        // transfer the NFT; _update keeps the cached owner synchronized.
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI_);
        emit AgentRegistered(agentId, wallet, msg.sender, agentURI_);
        emit AgentMetadataUpdated(agentId, hash);
    }

    function updateMetadata(uint256 agentId, bytes32 hash) external {
        if (!_isApprovedOrOwner(msg.sender, agentId)) revert NotAgentOwner();
        metadataHash[agentId] = hash;
        emit AgentMetadataUpdated(agentId, hash);
    }

    /// @notice Update the off-chain registration file URI (ERC-8004: setAgentURI).
    /// @dev Only callable by current token owner or an approved operator.
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        if (!_isApprovedOrOwner(msg.sender, agentId)) revert NotAgentOwner();
        _setTokenURI(agentId, newURI);
        agents[agentId].owner = ownerOf(agentId);
        emit AgentURIUpdated(agentId, newURI);
    }

    /// @notice Refresh the cached agentSigner from the on-chain wallet state.
    /// @dev Anyone can call — it just caches the current wallet.agentSigner().
    function syncSigner(uint256 agentId) external {
        AgentEntry storage e = agents[agentId];
        if (e.wallet == address(0)) revert AgentNotFound();
        address newSigner = _walletSigner(e.wallet);
        if (newSigner != e.signer) {
            e.signer = newSigner;
            emit AgentSignerCached(agentId, newSigner);
        }
    }

    // ─── 2-step owner rotation ───────────────────────────────────────────────

    /// @notice Step 1: nominate a new owner for the identity (transfers the NFT on acceptance).
    function requestOwnerRotation(uint256 agentId, address newOwner) external {
        if (ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner[agentId] = newOwner;
        emit OwnerRotateStarted(agentId, newOwner);
    }

    /// @notice Step 2: new owner accepts, NFT transferred.
    function acceptOwnerRotation(uint256 agentId) external {
        if (pendingOwner[agentId] != msg.sender) revert NotPendingOwner();
        address old = ownerOf(agentId);
        _transfer(old, msg.sender, agentId);
        agents[agentId].owner = msg.sender;
        pendingOwner[agentId] = address(0);
        emit OwnerRotated(agentId, old, msg.sender);
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    /// @notice ERC-8004: agentURI is the tokenURI.
    function agentURI(uint256 agentId) external view returns (string memory) {
        return tokenURI(agentId);
    }

    /// @notice Convenience: is this wallet registered in this registry?
    function isRegistered(address wallet) external view returns (bool) {
        return walletToAgent[wallet] != 0;
    }

    /// @notice Get full agent entry by wallet address.
    function getAgentByWallet(address wallet) external view returns (AgentEntry memory) {
        uint256 id = walletToAgent[wallet];
        if (id == 0) revert AgentNotFound();
        return agents[id];
    }

    /// @notice Get full agent entry by agentId.
    function getAgent(uint256 agentId) external view returns (AgentEntry memory) {
        if (agents[agentId].wallet == address(0)) revert AgentNotFound();
        return agents[agentId];
    }

    // ─── Internal helpers ────────────────────────────────────────────────────

    /// @dev Covers both the two-step rotation and standard ERC-721 transfers.
    ///      A previous owner's pending nomination must not survive a transfer.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        agents[tokenId].owner = to;
        delete pendingOwner[tokenId];
    }

    function _isApprovedOrOwner(address spender, uint256 agentId) internal view returns (bool) {
        address owner_ = ownerOf(agentId);
        return (spender == owner_ || isApprovedForAll(owner_, spender) || getApproved(agentId) == spender);
    }

    /// @dev A wallet's self-reported factory is only a lookup hint. The factory's
    ///      deployment record is the authority; otherwise anyone can spoof it.
    function _isFromTrustedFactory(address wallet) internal view returns (bool) {
        (bool ok, bytes memory data) = wallet.staticcall(abi.encodeWithSignature("factory()"));
        if (ok && data.length == 32) {
            address f = abi.decode(data, (address));
            if (!trustedFactory[f]) return false;
            (bool verified, bytes memory result) = f.staticcall(
                abi.encodeWithSignature("isFactoryWallet(address)", wallet)
            );
            return verified && result.length == 32 && abi.decode(result, (uint256)) == 1;
        }
        // Legacy wallets without factory() remain usable but cannot register here.
        return false;
    }

    /// @dev Read wallet.owner() via staticcall (works for V1/V2/V3 which all expose owner()).
    function _isWalletOwner(address wallet, address caller) internal view returns (bool) {
        (bool ok, bytes memory data) = wallet.staticcall(abi.encodeWithSignature("owner()"));
        if (!ok || data.length < 32) return false;
        return abi.decode(data, (address)) == caller;
    }

    /// @dev Read wallet.agentSigner() via staticcall.
    function _walletSigner(address wallet) internal view returns (address) {
        (bool ok, bytes memory data) = wallet.staticcall(abi.encodeWithSignature("agentSigner()"));
        if (!ok || data.length < 32) return address(0);
        return abi.decode(data, (address));
    }
}
