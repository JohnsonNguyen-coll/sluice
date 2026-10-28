// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentWalletV2TestBase} from "./AgentWalletV2.Base.t.sol";
import {AgentWalletV2}         from "../src/AgentWalletV2.sol";
import {AgentWalletFactoryV2}  from "../src/AgentWalletFactoryV2.sol";
import {MockERC20}             from "./mocks/MockERC20.sol";

/// @notice Tests: Factory constructor, token allowlist, createWallet, feeBps governance.
contract AgentWalletV2FactoryTest is AgentWalletV2TestBase {

    // ═══════════════════════════════════════════════════════════════════════
    // 1. Constructor state
    // ═══════════════════════════════════════════════════════════════════════

    function test_factory_constructorState() public view {
        assertEq(factory.feeRecipient(), FEE_RECIPIENT);
        assertEq(factory.feeBps(), FEE_BPS);
        assertEq(factory.owner(), address(this));
    }

    function test_factory_initialTokensAllowlisted() public view {
        assertTrue(factory.isAllowedToken(address(tokenA)));
        assertTrue(factory.isAllowedToken(address(tokenB)));
    }

    function test_factory_constructor_zeroFeeRecipient_reverts() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(AgentWalletFactoryV2.ZeroAddress.selector);
        new AgentWalletFactoryV2(address(0), 30, empty);
    }

    function test_factory_constructor_feeTooHigh_reverts() public {
        address[] memory empty = new address[](0);
        vm.expectRevert(AgentWalletFactoryV2.InvalidFee.selector);
        new AgentWalletFactoryV2(FEE_RECIPIENT, 501, empty);
    }

    function test_factory_constructor_zeroTokenInList_reverts() public {
        address[] memory toks = new address[](1);
        toks[0] = address(0);
        vm.expectRevert(AgentWalletFactoryV2.ZeroAddress.selector);
        new AgentWalletFactoryV2(FEE_RECIPIENT, 30, toks);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 2. addToken / removeToken
    // ═══════════════════════════════════════════════════════════════════════

    function test_factory_addToken_happyPath() public {
        MockERC20 newTok = new MockERC20("New", "NEW", 18);
        assertFalse(factory.isAllowedToken(address(newTok)));

        vm.expectEmit(true, false, false, false, address(factory));
        emit AgentWalletFactoryV2.TokenAllowed(address(newTok));
        factory.addToken(address(newTok));

        assertTrue(factory.isAllowedToken(address(newTok)));
    }

    function test_factory_addToken_zeroAddress_reverts() public {
        vm.expectRevert(AgentWalletFactoryV2.ZeroAddress.selector);
        factory.addToken(address(0));
    }

    function test_factory_addToken_alreadyAllowed_reverts() public {
        vm.expectRevert(AgentWalletFactoryV2.TokenAlreadyAllowed.selector);
        factory.addToken(address(tokenA));
    }

    function test_factory_addToken_onlyOwner_reverts() public {
        MockERC20 newTok = new MockERC20("New", "NEW", 18);
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletFactoryV2.OnlyOwner.selector);
        factory.addToken(address(newTok));
    }

    function test_factory_removeToken_happyPath() public {
        assertTrue(factory.isAllowedToken(address(tokenA)));

        vm.expectEmit(true, false, false, false, address(factory));
        emit AgentWalletFactoryV2.TokenRemoved(address(tokenA));
        factory.removeToken(address(tokenA));

        assertFalse(factory.isAllowedToken(address(tokenA)));
    }

    function test_factory_removeToken_notAllowed_reverts() public {
        MockERC20 unknown = new MockERC20("X", "X", 18);
        vm.expectRevert(AgentWalletFactoryV2.TokenNotAllowed.selector);
        factory.removeToken(address(unknown));
    }

    function test_factory_removeToken_onlyOwner_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletFactoryV2.OnlyOwner.selector);
        factory.removeToken(address(tokenA));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 3. createWallet: predicted address, isFactoryWallet, walletsOf
    // ═══════════════════════════════════════════════════════════════════════

    function test_factory_createWallet_registersWallet() public view {
        assertTrue(factory.isFactoryWallet(address(wallet)));
        address[] memory ws = factory.walletsOf(OWNER);
        assertEq(ws.length, 1);
        assertEq(ws[0], address(wallet));
    }

    function test_factory_createWallet_predictedAddress() public {
        bytes32 salt = bytes32("salt2");
        address predicted = factory.predictWalletAddress(
            OWNER, AGENT_SIGNER, SETTLE_WINDOW, FEE_BPS, salt
        );
        address deployed = factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, salt);
        assertEq(predicted, deployed);
    }

    function test_factory_createWallet_differentSalts_differentAddresses() public {
        address w1 = factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, bytes32("aa"));
        address w2 = factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, bytes32("bb"));
        assertTrue(w1 != w2);
    }

    function test_factory_createWallet_zeroOwner_reverts() public {
        vm.expectRevert(AgentWalletFactoryV2.ZeroAddress.selector);
        factory.createWallet(address(0), AGENT_SIGNER, SETTLE_WINDOW, bytes32("x"));
    }

    function test_factory_createWallet_zeroSigner_reverts() public {
        vm.expectRevert(AgentWalletFactoryV2.ZeroAddress.selector);
        factory.createWallet(OWNER, address(0), SETTLE_WINDOW, bytes32("x"));
    }

    function test_factory_createWallet_settleWindowTooSmall_reverts() public {
        vm.expectRevert(AgentWalletFactoryV2.InvalidSettleWindow.selector);
        factory.createWallet(OWNER, AGENT_SIGNER, 599, bytes32("x"));
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 4. feeBps governance: setFeeBps affects new wallets only
    // ═══════════════════════════════════════════════════════════════════════

    function test_factory_setFeeBps_affectsNewWallets() public {
        factory.setFeeBps(200);
        AgentWalletV2 newWallet = AgentWalletV2(
            factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, bytes32("fee-test"))
        );
        assertEq(newWallet.feeBps(), 200);
        // Existing wallet retains original feeBps
        assertEq(wallet.feeBps(), FEE_BPS);
    }

    function test_factory_setFeeBps_tooHigh_reverts() public {
        vm.expectRevert(AgentWalletFactoryV2.InvalidFee.selector);
        factory.setFeeBps(501);
    }

    function test_factory_setFeeBps_onlyOwner_reverts() public {
        vm.prank(OWNER);
        vm.expectRevert(AgentWalletFactoryV2.OnlyOwner.selector);
        factory.setFeeBps(100);
    }

    function test_factory_setFeeBps_maxAllowed() public {
        factory.setFeeBps(500);
        assertEq(factory.feeBps(), 500);
    }
}
