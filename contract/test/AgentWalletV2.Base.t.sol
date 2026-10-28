// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test}               from "forge-std/Test.sol";
import {AgentWalletV2}      from "../src/AgentWalletV2.sol";
import {AgentWalletFactoryV2} from "../src/AgentWalletFactoryV2.sol";
import {MockERC20}          from "./mocks/MockERC20.sol";
import {MockSwapAdapter}    from "./mocks/MockSwapAdapter.sol";
import {MockFeeOnTransferERC20} from "./mocks/MockFeeOnTransferERC20.sol";

/// @notice Shared setup inherited by every AgentWalletV2 test category.
abstract contract AgentWalletV2TestBase is Test {

    // ─── Tokens ─────────────────────────────────────────────────────────────
    MockERC20  internal tokenA;  // 6-decimal (USDC-like)
    MockERC20  internal tokenB;  // 18-decimal (DAI-like)

    // ─── Infra ──────────────────────────────────────────────────────────────
    AgentWalletFactoryV2 internal factory;
    AgentWalletV2        internal wallet;
    MockSwapAdapter      internal swapAdapter;

    // ─── Actors ─────────────────────────────────────────────────────────────
    address internal OWNER         = makeAddr("owner");
    address internal FEE_RECIPIENT = makeAddr("feeRecipient");
    address internal PROVIDER      = makeAddr("provider");
    address internal PROVIDER2     = makeAddr("provider2");
    address internal RELAYER       = makeAddr("relayer");

    address internal AGENT_SIGNER;
    uint256 internal AGENT_SIGNER_PK;
    address internal AGENT_SIGNER2;
    uint256 internal AGENT_SIGNER2_PK;

    // ─── Constants ──────────────────────────────────────────────────────────
    uint16  internal FEE_BPS       = 30;   // 0.3 %
    uint32  internal SETTLE_WINDOW = 3600; // 1 h

    // ─── setUp ──────────────────────────────────────────────────────────────

    function setUp() public virtual {
        (AGENT_SIGNER,  AGENT_SIGNER_PK)  = makeAddrAndKey("agentSigner");
        (AGENT_SIGNER2, AGENT_SIGNER2_PK) = makeAddrAndKey("agentSigner2");

        tokenA = new MockERC20("Mock USDC", "mUSDC", 6);
        tokenB = new MockERC20("Mock DAI",  "mDAI",  18);

        address[] memory initial = new address[](2);
        initial[0] = address(tokenA);
        initial[1] = address(tokenB);

        factory = new AgentWalletFactoryV2(FEE_RECIPIENT, FEE_BPS, initial);

        wallet = AgentWalletV2(
            factory.createWallet(OWNER, AGENT_SIGNER, SETTLE_WINDOW, bytes32("salt1"))
        );

        swapAdapter = new MockSwapAdapter();

        // Fund owner and pre-approve both tokens
        tokenA.mint(OWNER, 1_000_000e6);
        tokenB.mint(OWNER, 1_000_000e18);

        vm.startPrank(OWNER);
        tokenA.approve(address(wallet), type(uint256).max);
        tokenB.approve(address(wallet), type(uint256).max);
        vm.stopPrank();
    }

    // ─── EIP-712 helpers ────────────────────────────────────────────────────

    function _makeVoucher(
        address provider,
        address token,
        uint256 cumulative,
        uint256 nonce,
        uint64  expiry
    ) internal view returns (AgentWalletV2.Voucher memory) {
        return AgentWalletV2.Voucher({
            wallet:           address(wallet),
            provider:         provider,
            token:            token,
            cumulativeAmount: cumulative,
            nonce:            nonce,
            expiry:           expiry
        });
    }

    function _sign(AgentWalletV2.Voucher memory v, uint256 pk)
        internal view returns (bytes memory)
    {
        bytes32 structHash = keccak256(abi.encode(
            wallet.VOUCHER_TYPEHASH(),
            v.wallet,
            v.provider,
            v.token,
            v.cumulativeAmount,
            v.nonce,
            v.expiry
        ));
        bytes32 digest = keccak256(abi.encodePacked(
            "\x19\x01",
            wallet.domainSeparator(),
            structHash
        ));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, vv);
    }

    // ─── Action helpers ─────────────────────────────────────────────────────

    function _deposit(address token, uint256 amount) internal {
        vm.prank(OWNER);
        wallet.deposit(token, amount);
    }

    function _setBudget(
        address provider,
        address token,
        uint256 maxTotal,
        uint256 perCall
    ) internal {
        vm.prank(OWNER);
        wallet.setProviderBudget(provider, token, maxTotal, perCall);
    }

    /// @dev Sign + settle a single voucher via PROVIDER (or RELAYER).
    function _settle(
        address provider,
        address token,
        uint256 cumulative,
        uint256 nonce,
        address caller
    ) internal {
        AgentWalletV2.Voucher memory v = _makeVoucher(
            provider,
            token,
            cumulative,
            nonce,
            uint64(block.timestamp + 1 hours)
        );
        bytes memory sig = _sign(v, AGENT_SIGNER_PK);
        vm.prank(caller);
        wallet.settle(v, sig, 0);
    }

    function _settle(
        address provider,
        address token,
        uint256 cumulative,
        uint256 nonce
    ) internal {
        _settle(provider, token, cumulative, nonce, provider);
    }

    /// @dev Compute expected fee for a gross delta.
    function _fee(uint256 delta) internal view returns (uint256) {
        return (delta * FEE_BPS) / 10_000;
    }
}
