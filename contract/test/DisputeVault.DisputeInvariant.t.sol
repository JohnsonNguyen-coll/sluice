// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {DisputeVault} from "../src/DisputeVault.sol";
import {ProviderRegistry} from "../src/ProviderRegistry.sol";
import {ReputationRegistry} from "../src/ReputationRegistry.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MinimalWallet} from "./DisputeVault.t.sol";

contract DisputeLifecycleHandler is Test {
    uint256 public constant BOND = 10e6;
    uint256 public constant SUPPLY = 2_000_000e6;
    address public OWNER = makeAddr("lifecycleOwner");
    address public PROVIDER = makeAddr("lifecycleProvider");
    address public PAYOUT = makeAddr("lifecyclePayout");
    address public OTHER_PAYOUT = makeAddr("lifecycleOtherPayout");
    address public ARBITER = makeAddr("lifecycleArbiter");
    address public OTHER_ARBITER = makeAddr("lifecycleOtherArbiter");
    MockERC20 public token;
    DisputeVault public vault;
    ProviderRegistry public registry;
    MinimalWallet public wallet;
    uint256 public locked;
    bytes32[] public ids;
    mapping(bytes32 => address) public expectedPayout;
    mapping(bytes32 => address) public expectedArbiter;

    constructor() {
        token = new MockERC20("USD", "USD", 6);
        registry = new ProviderRegistry();
        ReputationRegistry reputation = new ReputationRegistry();
        vault = new DisputeVault(ARBITER, address(registry), address(reputation));
        reputation.setTrustedCaller(address(vault), true);
        wallet = new MinimalWallet(OWNER, address(vault));
        vault.setTrustedWallet(address(wallet), true);
        vault.setDisputeBond(address(token), BOND);
        vm.prank(PROVIDER);
        registry.register(PAYOUT, bytes32(0), 600, ARBITER);
        token.mint(address(wallet), SUPPLY / 2);
        token.mint(OWNER, SUPPLY / 2);
        vm.prank(OWNER);
        token.approve(address(vault), type(uint256).max);
    }

    function settleNew(uint256 amount, bool disputeNow, uint256 disputed) external {
        amount = bound(amount, 2, 1000e6);
        if (token.balanceOf(address(wallet)) < amount) return;
        bytes32 id = keccak256(abi.encode(ids.length));
        expectedPayout[id] = registry.payoutAddressOf(PROVIDER);
        expectedArbiter[id] = registry.preferredArbiterOf(PROVIDER);
        vm.startPrank(address(wallet));
        token.transfer(address(vault), amount);
        vault.receiveSettlement(id, address(wallet), PROVIDER, address(token), amount, 600);
        vm.stopPrank();
        ids.push(id);
        locked += amount;
        if (disputeNow) {
            vm.prank(OWNER);
            vault.openDispute(id, bound(disputed, 1, amount), 0, bytes32(0));
            locked += BOND;
        }
    }

    function release(uint256 index) external {
        if (ids.length == 0) return;
        bytes32 id = ids[index % ids.length];
        DisputeVault.Settlement memory s = vault.getSettlement(id);
        if (block.timestamp < s.releaseAfter) return;
        if (s.state == DisputeVault.SettlementState.HELD) {
            vault.release(id);
            locked -= s.amount;
        } else if (s.state == DisputeVault.SettlementState.DISPUTED) {
            uint256 amount = s.amount - vault.getDispute(id).amount - s.undisputedReleased;
            if (amount == 0) return;
            vault.releaseUndisputed(id);
            locked -= amount;
        }
    }

    function respond(uint256 index) external {
        if (ids.length == 0) return;
        bytes32 id = ids[index % ids.length];
        DisputeVault.Dispute memory d = vault.getDispute(id);
        if (d.openedAt == 0 || d.resolved || d.providerResponded || block.timestamp >= d.responseDeadline) return;
        vm.prank(PROVIDER);
        vault.respondToDispute(id, bytes32(0));
    }

    function resolve(uint256 index, uint256 refund) external {
        if (ids.length == 0) return;
        bytes32 id = ids[index % ids.length];
        DisputeVault.Settlement memory s = vault.getSettlement(id);
        DisputeVault.Dispute memory d = vault.getDispute(id);
        if (s.state != DisputeVault.SettlementState.DISPUTED) return;
        if (!d.providerResponded) {
            if (block.timestamp >= d.responseDeadline) vault.autoRefund(id);
            else { vm.prank(PROVIDER); vault.acceptDispute(id); }
        } else if (block.timestamp >= d.arbiterDeadline) vault.arbiterTimeout(id);
        else {
            refund = bound(refund, 0, d.amount);
            vm.prank(s.arbiter);
            vault.arbiterDecide(id, refund, d.amount - refund, true);
        }
        locked -= s.amount - s.undisputedReleased + d.bond;
    }

    function changeProvider(bool alternate) external {
        vm.startPrank(PROVIDER);
        registry.updatePayoutAddress(alternate ? OTHER_PAYOUT : PAYOUT);
        registry.updateArbiter(alternate ? OTHER_ARBITER : ARBITER);
        vm.stopPrank();
    }

    function advanceTime(uint256 seconds_) external { vm.warp(block.timestamp + bound(seconds_, 1, 4 days)); }
    function count() external view returns (uint256) { return ids.length; }
}

contract DisputeLifecycleInvariantTest is Test {
    DisputeLifecycleHandler internal handler;
    function setUp() public {
        handler = new DisputeLifecycleHandler();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.settleNew.selector;
        selectors[1] = handler.release.selector;
        selectors[2] = handler.respond.selector;
        selectors[3] = handler.resolve.selector;
        selectors[4] = handler.changeProvider.selector;
        selectors[5] = handler.advanceTime.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    function invariant_VaultExactlyBacksRemainingPrincipalAndBonds() public view {
        assertEq(handler.token().balanceOf(address(handler.vault())), handler.locked());
    }

    function invariant_TotalTokensConservedAcrossParticipants() public view {
        MockERC20 token = handler.token();
        uint256 total = token.balanceOf(address(handler.wallet())) + token.balanceOf(address(handler.vault()))
            + token.balanceOf(handler.OWNER()) + token.balanceOf(handler.PAYOUT()) + token.balanceOf(handler.OTHER_PAYOUT());
        assertEq(total, handler.SUPPLY());
    }

    function invariant_TermsNeverChangeAndRemainderNeverPaysTwice() public view {
        for (uint256 i; i < handler.count(); ++i) {
            bytes32 id = handler.ids(i);
            DisputeVault.Settlement memory s = handler.vault().getSettlement(id);
            assertEq(s.payoutAddress, handler.expectedPayout(id));
            assertEq(s.arbiter, handler.expectedArbiter(id));
            DisputeVault.Dispute memory d = handler.vault().getDispute(id);
            assertLe(s.undisputedReleased, s.amount - d.amount);
        }
    }
}
