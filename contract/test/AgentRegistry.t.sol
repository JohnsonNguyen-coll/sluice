// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

/// @notice Minimal mock wallet that exposes owner(), agentSigner(), factory()
contract MockWallet {
    address public owner;
    address public agentSigner;
    address public factory;

    constructor(address owner_, address signer_, address factory_) {
        owner      = owner_;
        agentSigner = signer_;
        factory    = factory_;
    }

    function setAgentSigner(address newSigner) external {
        agentSigner = newSigner;
    }
}

contract AgentRegistryTest is Test {

    // ─── Errors from AgentRegistry ───────────────────────────────────────────
    error NotWalletOwner();
    error WalletNotFromFactory();
    error WalletAlreadyRegistered();
    error AgentNotFound();
    error NotAgentOwner();
    error ZeroAddress();
    error NotPendingOwner();

    // ─── Actors ──────────────────────────────────────────────────────────────
    address internal ADMIN    = makeAddr("admin");
    address internal OWNER    = makeAddr("owner");
    address internal OWNER2   = makeAddr("owner2");
    address internal SIGNER   = makeAddr("signer");
    address internal FACTORY  = makeAddr("factory");
    address internal FACTORY2 = makeAddr("factory2");
    address internal RANDO    = makeAddr("rando");

    // ─── Contracts ───────────────────────────────────────────────────────────
    AgentRegistry internal registry;
    MockWallet    internal wallet;

    function setUp() public {
        vm.prank(ADMIN);
        address[] memory factories = new address[](1);
        factories[0] = FACTORY;
        registry = new AgentRegistry(factories);

        wallet = new MockWallet(OWNER, SIGNER, FACTORY);
        vm.mockCall(FACTORY, abi.encodeWithSignature("isFactoryWallet(address)", address(wallet)), abi.encode(true));
    }

    // ─── Helpers ─────────────────────────────────────────────────────────────

    function _register(address caller) internal returns (uint256) {
        vm.prank(caller);
        return registry.register(address(wallet), "ipfs://agent-uri");
    }

    // ─── 1. register() happy path ─────────────────────────────────────────────

    function test_Register_HappyPath() public {
        vm.prank(OWNER);
        vm.expectEmit(true, true, true, true, address(registry));
        emit AgentRegistry.AgentRegistered(1, address(wallet), OWNER, "ipfs://agent-uri");
        uint256 id = registry.register(address(wallet), "ipfs://agent-uri");

        assertEq(id, 1, "agentId should be 1");
        assertEq(registry.ownerOf(id), OWNER, "NFT owner should be OWNER");
        assertEq(registry.walletToAgent(address(wallet)), id, "walletToAgent should map to id");

        AgentRegistry.AgentEntry memory e = registry.getAgent(id);
        assertEq(e.wallet, address(wallet), "entry wallet");
        assertEq(e.owner,  OWNER,           "entry owner");
        assertEq(e.signer, SIGNER,          "entry signer");
        assertTrue(e.registeredAt > 0,      "registeredAt > 0");
    }

    function test_Register_IncrementingIds() public {
        MockWallet w2 = new MockWallet(OWNER2, SIGNER, FACTORY);
        vm.mockCall(FACTORY, abi.encodeWithSignature("isFactoryWallet(address)", address(w2)), abi.encode(true));
        vm.prank(OWNER);
        uint256 id1 = registry.register(address(wallet), "ipfs://a");
        vm.prank(OWNER2);
        uint256 id2 = registry.register(address(w2), "ipfs://b");
        assertEq(id1, 1);
        assertEq(id2, 2);
    }

    // ─── 2. register() reverts ────────────────────────────────────────────────

    function test_Register_Reverts_WalletNotFromFactory() public {
        MockWallet badWallet = new MockWallet(OWNER, SIGNER, FACTORY2); // not trusted
        vm.prank(OWNER);
        vm.expectRevert(WalletNotFromFactory.selector);
        registry.register(address(badWallet), "ipfs://x");
    }

    function test_Register_Reverts_NotWalletOwner() public {
        vm.prank(RANDO);
        vm.expectRevert(NotWalletOwner.selector);
        registry.register(address(wallet), "ipfs://x");
    }

    function test_Register_Reverts_WalletAlreadyRegistered() public {
        vm.prank(OWNER);
        registry.register(address(wallet), "ipfs://first");
        vm.prank(OWNER);
        vm.expectRevert(WalletAlreadyRegistered.selector);
        registry.register(address(wallet), "ipfs://second");
    }

    function test_Register_Reverts_ZeroAddress() public {
        vm.prank(OWNER);
        vm.expectRevert(ZeroAddress.selector);
        registry.register(address(0), "ipfs://x");
    }

    // ─── 3. setAgentURI() ─────────────────────────────────────────────────────

    function test_SetAgentURI_HappyPath() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://old");

        vm.prank(OWNER);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentRegistry.AgentURIUpdated(id, "ipfs://new");
        registry.setAgentURI(id, "ipfs://new");

        assertEq(registry.agentURI(id), "ipfs://new");
    }

    function test_SetAgentURI_NonOwnerReverts() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://old");

        vm.prank(RANDO);
        vm.expectRevert(NotAgentOwner.selector);
        registry.setAgentURI(id, "ipfs://new");
    }

    // ─── 4. syncSigner() ──────────────────────────────────────────────────────

    function test_SyncSigner_CachesNewSigner() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://a");

        // Change the wallet's agentSigner
        address newSigner = makeAddr("newSigner");
        wallet.setAgentSigner(newSigner);

        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentRegistry.AgentSignerCached(id, newSigner);
        registry.syncSigner(id);

        AgentRegistry.AgentEntry memory e = registry.getAgent(id);
        assertEq(e.signer, newSigner, "signer cached");
    }

    function test_SyncSigner_NoopIfUnchanged() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://a");

        // Call sync without changing signer — should NOT emit
        vm.recordLogs();
        registry.syncSigner(id);
        assertEq(vm.getRecordedLogs().length, 0, "no event if unchanged");
    }

    // ─── 5. requestOwnerRotation + acceptOwnerRotation ────────────────────────

    function test_OwnerRotation_FullFlow() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://a");

        // Step 1: request
        vm.prank(OWNER);
        vm.expectEmit(true, true, false, false, address(registry));
        emit AgentRegistry.OwnerRotateStarted(id, OWNER2);
        registry.requestOwnerRotation(id, OWNER2);

        assertEq(registry.pendingOwner(id), OWNER2);

        // Step 2: accept
        vm.prank(OWNER2);
        vm.expectEmit(true, true, true, false, address(registry));
        emit AgentRegistry.OwnerRotated(id, OWNER, OWNER2);
        registry.acceptOwnerRotation(id);

        assertEq(registry.ownerOf(id), OWNER2,  "NFT transferred");
        assertEq(registry.getAgent(id).owner, OWNER2, "agent entry owner updated");
        assertEq(registry.pendingOwner(id), address(0), "pendingOwner cleared");
    }

    function test_OwnerRotation_WrongPendingReverts() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://a");
        vm.prank(OWNER);
        registry.requestOwnerRotation(id, OWNER2);

        vm.prank(RANDO);
        vm.expectRevert(NotPendingOwner.selector);
        registry.acceptOwnerRotation(id);
    }

    function test_RequestRotation_NonOwnerReverts() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://a");

        vm.prank(RANDO);
        vm.expectRevert(NotAgentOwner.selector);
        registry.requestOwnerRotation(id, OWNER2);
    }

    function test_RequestRotation_ZeroAddressReverts() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://a");

        vm.prank(OWNER);
        vm.expectRevert(ZeroAddress.selector);
        registry.requestOwnerRotation(id, address(0));
    }

    // ─── 6. setTrustedFactory() ───────────────────────────────────────────────

    function test_SetTrustedFactory_AdminHappyPath() public {
        assertFalse(registry.trustedFactory(FACTORY2));
        vm.prank(ADMIN);
        registry.setTrustedFactory(FACTORY2, true);
        assertTrue(registry.trustedFactory(FACTORY2));
    }

    function test_SetTrustedFactory_NonAdminReverts() public {
        vm.prank(RANDO);
        vm.expectRevert(NotAgentOwner.selector); // onlyAdmin reuses NotAgentOwner
        registry.setTrustedFactory(FACTORY2, true);
    }

    function test_SetTrustedFactory_ZeroReverts() public {
        vm.prank(ADMIN);
        vm.expectRevert(ZeroAddress.selector);
        registry.setTrustedFactory(address(0), true);
    }

    // ─── 7. isRegistered() / getAgentByWallet() ──────────────────────────────

    function test_IsRegistered_ReturnsFalseBeforeRegister() public view {
        assertFalse(registry.isRegistered(address(wallet)));
    }

    function test_IsRegistered_ReturnsTrueAfterRegister() public {
        vm.prank(OWNER);
        registry.register(address(wallet), "ipfs://a");
        assertTrue(registry.isRegistered(address(wallet)));
    }

    function test_GetAgentByWallet_ReturnsEntry() public {
        vm.prank(OWNER);
        registry.register(address(wallet), "ipfs://a");
        AgentRegistry.AgentEntry memory e = registry.getAgentByWallet(address(wallet));
        assertEq(e.wallet, address(wallet));
        assertEq(e.owner, OWNER);
    }

    function test_GetAgentByWallet_RevertsMissing() public {
        vm.expectRevert(AgentNotFound.selector);
        registry.getAgentByWallet(address(wallet));
    }

    function test_GetAgent_RevertsMissing() public {
        vm.expectRevert(AgentNotFound.selector);
        registry.getAgent(999);
    }

    // ─── 8. agentURI() == tokenURI() ─────────────────────────────────────────

    function test_AgentURI_EqualsTokenURI() public {
        vm.prank(OWNER);
        uint256 id = registry.register(address(wallet), "ipfs://canonical");
        assertEq(registry.agentURI(id), registry.tokenURI(id));
    }
}
