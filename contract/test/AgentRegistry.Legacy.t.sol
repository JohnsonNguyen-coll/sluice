// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {AgentWalletFactory} from "../src/AgentWalletFactory.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
contract UnrecordedLegacyWallet { address public owner; constructor(address owner_){owner=owner_;} }
contract AgentRegistryLegacyTest is Test {
    AgentRegistry registry; AgentWalletFactory factory; address owner=makeAddr("legacyOwner");
    function setUp() public {
        factory=new AgentWalletFactory(address(new MockERC20("USD","USD",6)),address(this),30);
        address[] memory factories=new address[](1);factories[0]=address(factory);registry=new AgentRegistry(factories);
    }
    function test_V1WalletRegistersUsingAuthoritativeFactoryRecord() public {
        address wallet=factory.createWallet(owner,makeAddr("signer"),600,bytes32(0));
        vm.prank(owner);uint256 id=registry.registerWithMetadataHash(wallet,keccak256("metadata"));
        assertEq(registry.ownerOf(id),owner);
    }
    function test_UnrecordedLegacyWalletCannotRegister() public {
        address wallet=address(new UnrecordedLegacyWallet(owner));
        vm.prank(owner);vm.expectRevert(AgentRegistry.WalletNotFromFactory.selector);
        registry.registerWithMetadataHash(wallet,bytes32(0));
    }
    function test_RevokedLegacyFactoryCannotAuthorizeNewIdentity() public {
        address wallet=factory.createWallet(owner,makeAddr("signer"),600,bytes32(0));
        registry.setTrustedFactory(address(factory),false);
        vm.prank(owner);vm.expectRevert(AgentRegistry.WalletNotFromFactory.selector);
        registry.registerWithMetadataHash(wallet,bytes32(0));
    }
}
