// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../AgentRegistry.sol";
import {AgentWalletFactoryV2} from "../AgentWalletFactoryV2.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

contract IdentityWalletStub {
    address public owner;
    address public agentSigner;
    address public factory;
    constructor(address owner_, address factory_) {
        owner = owner_;
        agentSigner = owner_;
        factory = factory_;
    }
}

contract IdentityFactoryStub {
    mapping(address => bool) public isFactoryWallet;
    function create(address owner) external returns (address wallet) {
        wallet = address(new IdentityWalletStub(owner, address(this)));
        isFactoryWallet[wallet] = true;
    }
}

contract IdentityReceiver is IERC721Receiver {
    AgentRegistry public registry;
    address public wallet;
    address public recipient;
    bool public nestedSucceeded;
    constructor(AgentRegistry registry_, address recipient_) {
        registry = registry_;
        recipient = recipient_;
    }
    function register(address wallet_) external {
        wallet = wallet_;
        registry.register(wallet_, "ipfs://metadata-hash");
    }
    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        require(msg.sender == address(registry));
        try registry.register(wallet, "ipfs://duplicate") returns (uint256) {
            nestedSucceeded = true;
        } catch {}
        registry.transferFrom(address(this), recipient, id);
        return IERC721Receiver.onERC721Received.selector;
    }
}

contract AgentRegistrySecurityTest is Test {
    AgentRegistry registry;
    IdentityFactoryStub factory;
    address owner = makeAddr("owner");
    address recipient = makeAddr("recipient");

    function setUp() public {
        factory = new IdentityFactoryStub();
        address[] memory factories = new address[](1);
        factories[0] = address(factory);
        registry = new AgentRegistry(factories);
    }

    function test_SpoofedTrustedFactoryRejected() public {
        address forged = address(new IdentityWalletStub(owner, address(factory)));
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.WalletNotFromFactory.selector);
        registry.register(forged, "ipfs://fake");
    }

    function test_MetadataHashRegistrationAndOwnerUpdate() public {
        address wallet = factory.create(owner);
        bytes32 hash = keccak256("off-chain JSON");
        vm.prank(owner);
        uint256 id = registry.registerWithMetadataHash(wallet, hash);
        assertEq(registry.metadataHash(id), hash);
        assertEq(registry.tokenURI(id), "");
        vm.prank(recipient);
        vm.expectRevert(AgentRegistry.NotAgentOwner.selector);
        registry.updateMetadata(id, bytes32(0));
        vm.prank(owner);
        registry.updateMetadata(id, bytes32(0));
        assertEq(registry.metadataHash(id), bytes32(0));
    }

    function test_TrustedEOAIsNotFactoryProof() public {
        registry.setTrustedFactory(owner, true);
        address forged = address(new IdentityWalletStub(owner, owner));
        vm.prank(owner);
        vm.expectRevert(AgentRegistry.WalletNotFromFactory.selector);
        registry.register(forged, "ipfs://fake");
    }

    function test_RealV2FactoryWalletRegisters() public {
        AgentWalletFactoryV2 realFactory = new AgentWalletFactoryV2(owner, 30, new address[](0));
        registry.setTrustedFactory(address(realFactory), true);
        address wallet = realFactory.createWallet(owner, recipient, 600, bytes32(0));
        vm.prank(owner);
        uint256 id = registry.register(wallet, "ipfs://metadata-hash");
        assertEq(registry.getAgent(id).wallet, wallet);
    }

    function testFuzz_TransferClearsOldNominationAndSyncsOwner(address newOwner) public {
        vm.assume(newOwner != address(0) && newOwner != owner);
        address wallet = factory.create(owner);
        vm.startPrank(owner);
        uint256 id = registry.register(wallet, "ipfs://metadata-hash");
        registry.requestOwnerRotation(id, recipient);
        registry.transferFrom(owner, newOwner, id);
        vm.stopPrank();
        assertEq(registry.getAgent(id).owner, newOwner);
        assertEq(registry.pendingOwner(id), address(0));
        vm.prank(recipient);
        vm.expectRevert(AgentRegistry.NotPendingOwner.selector);
        registry.acceptOwnerRotation(id);
    }

    function test_MintCallbackCannotDuplicateWalletAndTransferKeepsOwner() public {
        IdentityReceiver receiver = new IdentityReceiver(registry, recipient);
        address wallet = factory.create(address(receiver));
        receiver.register(wallet);
        assertFalse(receiver.nestedSucceeded());
        assertEq(registry.walletToAgent(wallet), 1);
        assertEq(registry.ownerOf(1), recipient);
        assertEq(registry.getAgent(1).owner, recipient);
        assertEq(registry.balanceOf(address(receiver)), 0);
    }
}
