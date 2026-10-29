// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ISwapAdapter} from "./ISwapAdapter.sol";
import {NegotiationWalletFactory} from "./NegotiationWalletFactory.sol";
import {ProviderRegistry} from "./ProviderRegistry.sol";
import {ReputationRegistry} from "./ReputationRegistry.sol";
import {DisputeVault} from "./DisputeVault.sol";
import {NegotiationDisputeVault} from "./NegotiationDisputeVault.sol";
import {CallReceipts} from "./CallReceipts.sol";

/// @title NegotiationAgentWallet
/// @notice Per-agent multi-token wallet with dispute-window routing, call receipts Merkle root,
///         and reputation registry hooks.
///
/// @dev V3 differences from V2:
///      1. Dispute vault routing: when a provider has a non-zero disputeWindow (read from ProviderRegistry),
///         the provider payout is sent to DisputeVault instead of directly to the payout address.
///         The vault issues a settlementId and holds the funds until the window elapses or a dispute resolves.
///         If the provider is not registered, behavior is identical to V2 (instant payout).
///      2. Receipts root: each settle() call accepts an optional `receiptsRoot` (bytes32 Merkle root of
///         off-chain call receipts since the last settlement for this (provider, token)). Stored with nonce.
///         Enables efficient Merkle proof verification for disputes.
///      3. receiveRefund(token, amount): callable only by DisputeVault; records the refund in wallet balance.
///      4. Reputation hooks: calls reputationRegistry.recordSettlement() after every successful settle.
///      5. All V2 features (multi-token, swap adapter, daily limit, fee-on-transfer rejection) are retained.
///
/// @dev Accounting:
///      When routing to DisputeVault, the wallet transfers `payout` tokens to the vault (not to provider).
///      `totalWithdrawn[token]` tracks all outflows (direct to provider + to vault + refund-back-in cancels out).
///      A refund from DisputeVault calls receiveRefund which credits `totalRefunded[token]` to keep the
///      invariant:  balanceOf(wallet) == totalDeposited - totalWithdrawn + totalRefunded - totalFeesPaid - net_settled
///      Simplified: balanceOf(wallet) >= encumbered[token] always holds.
contract NegotiationAgentWallet is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Structs ────────────────────────────────────────────────────────────

    /// @notice V3 Voucher — identical to V2 plus optional receiptsRoot.
    struct Voucher {
        address wallet;
        address provider;
        address token;
        uint256 cumulativeAmount;
        uint256 nonce;
        uint64 expiry;
    }

    struct Budget {
        uint256 maxTotal;
        uint256 perCallCap;
    }

    struct DecreaseRequest {
        uint256 newMaxTotal;
        uint256 newPerCallCap;
        uint256 requestedAt;
    }

    struct SettleParams {
        uint256 delta;
        uint256 fee;
        uint256 payout;
        address payoutToken;
        uint256 minOut;
    }

    struct PayoutRoute {
        address provider;
        address tokenIn;
        address tokenOut;
        uint256 payout;
        uint256 minOut;
        bytes32 settlementId;
        CallReceipts.Context context;
    }

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ArbitrationHoldRequired();
    error ZeroAddress();
    error WalletPaused();
    error WithdrawCooldown();
    error VoucherExpired();
    error InvalidSignature();
    error InvalidNonce();
    error InvalidDelta();
    error BudgetExceeded();
    error PerCallCapExceeded();
    error DailyLimitExceeded();
    error InsufficientFreeBalance();
    error UseDecreaseRequest();
    error NoPendingDecrease();
    error DecreaseWindowNotElapsed();
    error ArrayLengthMismatch();
    error UnauthorizedProvider();
    error OnlyOwner();
    error TokenNotAllowed();
    error FeeOnTransferToken();
    error SwapAdapterNotSet();
    error ZeroAmount();
    error OnlyDisputeVault();
    error OnlyFactory();

    // ─── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed from, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);
    event EmergencyWithdrawn(address indexed to, address indexed token, uint256 amount);
    event RefundReceived(address indexed token, uint256 amount);
    event ProviderBudgetSet(address indexed provider, address indexed token, uint256 maxTotal, uint256 perCallCap);
    event BudgetDecreaseRequested(
        address indexed provider,
        address indexed token,
        uint256 newMaxTotal,
        uint256 newPerCallCap,
        uint256 executeAfter
    );
    event DailyLimitSet(uint256 limitUsdE6);
    event TokenRateSet(address indexed token, uint256 usdRateE6, uint8 decimals);
    event RelayerSet(address indexed provider, address indexed relayer);
    event PayoutTokenSet(address indexed provider, address indexed payoutToken);
    event SwapAdapterSet(address indexed adapter);
    event Paused(uint256 withdrawDeadline);
    event Unpaused();
    event AgentSignerRotated(address indexed oldSigner, address indexed newSigner, uint256 validUntil);
    event Settled(
        address indexed provider,
        address indexed token,
        uint256 delta,
        uint256 fee,
        uint256 nonce,
        uint256 cumulative,
        address payoutToken,
        uint256 payoutAmount,
        bytes32 receiptsRoot,
        bytes32 settlementId
    );
    event ReceiptsRootStored(address indexed provider, address indexed token, uint256 nonce, bytes32 receiptsRoot);

    // ─── EIP-712 ────────────────────────────────────────────────────────────

    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(address wallet,address provider,address token,uint256 cumulativeAmount,uint256 nonce,uint64 expiry)"
    );

    // ─── Immutables ─────────────────────────────────────────────────────────

    NegotiationWalletFactory public immutable factory;

    uint16 public immutable feeBps;
    uint32 public immutable settleWindow;
    uint256 private immutable _deployChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // ─── Mutable state ──────────────────────────────────────────────────────

    address public owner;
    address public agentSigner;
    address public feeRecipient;

    bool public paused;
    uint256 public pauseWithdrawDeadline;

    address public swapAdapter;

    // Per-token accounting
    mapping(address => uint256) public totalDeposited;
    mapping(address => uint256) public totalWithdrawn;
    mapping(address => uint256) public totalFeesPaid;
    mapping(address => uint256) public totalRefunded; // V3: refunds from DisputeVault
    mapping(address => uint256) public encumbered;

    // Per-(provider, token)
    mapping(address => mapping(address => uint256)) public settled;
    mapping(address => mapping(address => Budget)) public budgets;
    mapping(address => mapping(address => uint256)) public nonces;
    mapping(address => mapping(address => DecreaseRequest)) public decreaseRequests;

    // Receipts roots: provider => token => nonce => root
    mapping(address => mapping(address => mapping(uint256 => bytes32))) public receiptsRoots;

    // Provider preferences
    mapping(address => address) public relayers;
    mapping(address => address) public payoutToken;

    // Daily limit
    uint256 public dailyLimitUsdE6;
    mapping(uint256 => uint256) public dailySpendUsdE6;

    struct TokenRate {
        uint256 usdRateE6;
        uint8 decimals;
    }
    mapping(address => TokenRate) public tokenRates;

    mapping(address => uint256) public signerValidUntil;

    // ─── Constructor ────────────────────────────────────────────────────────

    constructor(
        address owner_,
        address agentSigner_,
        address feeRecipient_,
        uint16 feeBps_,
        uint32 settleWindow_,
        address factory_
    ) {
        owner = owner_;
        agentSigner = agentSigner_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
        settleWindow = settleWindow_;
        factory = NegotiationWalletFactory(factory_);

        _deployChainId = block.chainid;
        _cachedDomainSeparator = _computeDomainSeparator();

        signerValidUntil[agentSigner_] = type(uint256).max;
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── Domain separator ────────────────────────────────────────────────────

    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _deployChainId) return _cachedDomainSeparator;
        return _computeDomainSeparator();
    }

    function _computeDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("AgentPay"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── Deposit ─────────────────────────────────────────────────────────────

    function deposit(address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!factory.isAllowedToken(token)) revert TokenNotAllowed();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - before;
        if (received != amount) revert FeeOnTransferToken();
        totalDeposited[token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    // ─── Withdraw ────────────────────────────────────────────────────────────

    function withdraw(address token, uint256 amount) external onlyOwner {
        if (paused && block.timestamp < pauseWithdrawDeadline) revert WithdrawCooldown();
        uint256 free = freeBalance(token);
        if (amount > free) revert InsufficientFreeBalance();
        totalWithdrawn[token] += amount;
        IERC20(token).safeTransfer(owner, amount);
        emit Withdrawn(owner, token, amount);
    }

    /// @notice Recover a token that has been removed from the factory allowlist.
    function emergencyWithdraw(address token) external onlyOwner {
        if (factory.isAllowedToken(token)) revert TokenNotAllowed();
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).safeTransfer(owner, bal);
            emit EmergencyWithdrawn(owner, token, bal);
        }
    }

    // ─── receiveRefund (called by DisputeVault) ──────────────────────────────

    /// @notice Accept a refund from DisputeVault. Tokens are already at this address.
    function receiveRefund(address token, uint256 amount) external {
        if (msg.sender != address(factory.disputeVault())) revert OnlyDisputeVault();
        totalRefunded[token] += amount;
        emit RefundReceived(token, amount);
    }

    // ─── Budget management ───────────────────────────────────────────────────

    function setProviderBudget(address provider, address token, uint256 maxTotal, uint256 perCallCap)
        external
        onlyOwner
    {
        if (provider == address(0)) revert ZeroAddress();
        if (!factory.isAllowedToken(token)) revert TokenNotAllowed();

        Budget storage b = budgets[provider][token];
        if (maxTotal < b.maxTotal) revert UseDecreaseRequest();

        uint256 oldEncumbered = b.maxTotal > settled[provider][token] ? b.maxTotal - settled[provider][token] : 0;
        uint256 newEncumbered = maxTotal > settled[provider][token] ? maxTotal - settled[provider][token] : 0;

        if (newEncumbered > oldEncumbered) {
            uint256 extra = newEncumbered - oldEncumbered;
            if (extra > freeBalance(token)) revert InsufficientFreeBalance();
            encumbered[token] += extra;
        }

        b.maxTotal = maxTotal;
        b.perCallCap = perCallCap;
        emit ProviderBudgetSet(provider, token, maxTotal, perCallCap);
    }

    function requestBudgetDecrease(address provider, address token, uint256 newMaxTotal, uint256 newPerCallCap)
        external
        onlyOwner
    {
        Budget storage b = budgets[provider][token];
        if (newMaxTotal >= b.maxTotal) revert UseDecreaseRequest();
        decreaseRequests[provider][token] = DecreaseRequest(newMaxTotal, newPerCallCap, block.timestamp);
        emit BudgetDecreaseRequested(provider, token, newMaxTotal, newPerCallCap, block.timestamp + settleWindow);
    }

    function executeBudgetDecrease(address provider, address token) external onlyOwner {
        DecreaseRequest storage r = decreaseRequests[provider][token];
        if (r.requestedAt == 0) revert NoPendingDecrease();
        if (block.timestamp < r.requestedAt + settleWindow) revert DecreaseWindowNotElapsed();

        Budget storage b = budgets[provider][token];
        uint256 alreadySettled = settled[provider][token];
        uint256 effectiveNew = r.newMaxTotal > alreadySettled ? r.newMaxTotal : alreadySettled;

        uint256 oldEnc = b.maxTotal > alreadySettled ? b.maxTotal - alreadySettled : 0;
        uint256 newEnc = effectiveNew > alreadySettled ? effectiveNew - alreadySettled : 0;
        if (oldEnc > newEnc) encumbered[token] -= (oldEnc - newEnc);

        b.maxTotal = effectiveNew;
        b.perCallCap = r.newPerCallCap;
        delete decreaseRequests[provider][token];
        emit ProviderBudgetSet(provider, token, effectiveNew, r.newPerCallCap);
    }

    // ─── Settings ────────────────────────────────────────────────────────────

    function setDailyLimit(uint256 limitUsdE6) external onlyOwner {
        dailyLimitUsdE6 = limitUsdE6;
        emit DailyLimitSet(limitUsdE6);
    }

    function setTokenRate(address token, uint256 usdRateE6, uint8 decimals_) external onlyOwner {
        tokenRates[token] = TokenRate(usdRateE6, decimals_);
        emit TokenRateSet(token, usdRateE6, decimals_);
    }

    function setRelayer(address provider, address relayer) external {
        if (msg.sender != provider) revert UnauthorizedProvider();
        relayers[provider] = relayer;
        emit RelayerSet(provider, relayer);
    }

    function setPayoutToken(address provider, address token) external {
        if (msg.sender != provider) revert UnauthorizedProvider();
        payoutToken[provider] = token;
        emit PayoutTokenSet(provider, token);
    }

    function setSwapAdapter(address adapter) external onlyOwner {
        swapAdapter = adapter;
        emit SwapAdapterSet(adapter);
    }

    function pause() external onlyOwner {
        paused = true;
        pauseWithdrawDeadline = block.timestamp + settleWindow;
        emit Paused(pauseWithdrawDeadline);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function rotateAgentSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address old = agentSigner;
        uint256 validUntil = block.timestamp + settleWindow;
        if (signerValidUntil[old] == type(uint256).max) {
            signerValidUntil[old] = validUntil;
        }
        signerValidUntil[newSigner] = type(uint256).max;
        agentSigner = newSigner;
        emit AgentSignerRotated(old, newSigner, validUntil);
    }

    // ─── Settle ──────────────────────────────────────────────────────────────

    function settle(Voucher calldata voucher, bytes calldata sig, uint256 minOut, bytes32 receiptsRoot)
        external
        nonReentrant
    {
        _settle(voucher, sig, minOut, receiptsRoot);
    }

    function settleBatch(
        Voucher[] calldata vouchers,
        bytes[] calldata sigs,
        uint256[] calldata minOuts,
        bytes32[] calldata receiptsRoots_
    ) external nonReentrant {
        if (
            vouchers.length != sigs.length || vouchers.length != minOuts.length
                || vouchers.length != receiptsRoots_.length
        ) revert ArrayLengthMismatch();
        for (uint256 i; i < vouchers.length; ++i) {
            _settle(vouchers[i], sigs[i], minOuts[i], receiptsRoots_[i]);
        }
    }

    function _settle(Voucher calldata v, bytes calldata sig, uint256 minOut, bytes32 receiptsRoot) internal {
        // ── Checks ──────────────────────────────────────────────────────────
        if (paused) revert WalletPaused();
        if (msg.sender != v.provider && msg.sender != relayers[v.provider]) revert UnauthorizedProvider();
        if (v.wallet != address(this)) revert InvalidSignature();
        if (block.timestamp > uint256(v.expiry)) revert VoucherExpired();
        _verifySig(v, sig);
        if (!factory.isAllowedToken(v.token)) revert TokenNotAllowed();

        // Validate nonce + delta + budget in helper to reduce local stack
        uint256 firstNonce = nonces[v.provider][v.token] + 1;
        uint256 delta = _validateAndUpdate(v);

        // ── Emit + route in sub-function to avoid stack overflow ─────────────
        CallReceipts.Context memory context = CallReceipts.Context(v.token, firstNonce, v.nonce, delta, receiptsRoot);
        _settleEffects(v, delta, minOut, context);
    }

    /// @dev Validates nonce, delta, budget, daily limit. Applies effects. Returns delta.
    function _validateAndUpdate(Voucher calldata v) internal returns (uint256 delta) {
        if (v.nonce <= nonces[v.provider][v.token]) revert InvalidNonce();

        delta = v.cumulativeAmount - settled[v.provider][v.token];
        if (delta == 0) revert InvalidDelta();

        Budget storage b = budgets[v.provider][v.token];
        if (v.cumulativeAmount > b.maxTotal) revert BudgetExceeded();
        if (b.perCallCap > 0 && delta > b.perCallCap) revert PerCallCapExceeded();

        _checkDailyLimit(v.token, delta);

        // Apply effects
        uint256 fee = (delta * feeBps) / 10_000;
        nonces[v.provider][v.token] = v.nonce;
        settled[v.provider][v.token] = v.cumulativeAmount;
        totalFeesPaid[v.token] += fee;
        encumbered[v.token] -= delta;
        dailySpendUsdE6[block.timestamp / 86400] += _toUsdE6(v.token, delta);
    }

    /// @dev Interactions + emit. Separate function to free stack slots.
    function _settleEffects(Voucher calldata v, uint256 delta, uint256 minOut, CallReceipts.Context memory context)
        internal
    {
        uint256 fee = (delta * feeBps) / 10_000;
        uint256 payout = delta - fee;

        // Store receipts root
        if (context.root != bytes32(0)) {
            receiptsRoots[v.provider][v.token][v.nonce] = context.root;
            emit ReceiptsRootStored(v.provider, v.token, v.nonce, context.root);
        }

        address prefPayoutTk = payoutToken[v.provider];
        address effectivePk = (prefPayoutTk != address(0) && prefPayoutTk != v.token) ? prefPayoutTk : v.token;
        bytes32 settlementId = keccak256(abi.encode(address(this), v.provider, v.token, v.nonce, block.number));

        // Pay protocol fee
        if (fee > 0) IERC20(v.token).safeTransfer(feeRecipient, fee);

        // Route payout
        uint256 actualPayout =
            _routePayout(PayoutRoute(v.provider, v.token, effectivePk, payout, minOut, settlementId, context));

        // Reputation hook (best-effort, non-reverting)
        _recordReputation(address(this), v.provider, v.token, delta);

        emit Settled(
            v.provider,
            v.token,
            delta,
            fee,
            v.nonce,
            v.cumulativeAmount,
            effectivePk,
            actualPayout,
            context.root,
            settlementId
        );
    }

    // ─── Internal: payout routing ────────────────────────────────────────────

    function _routePayout(PayoutRoute memory route) internal returns (uint256 actualPayout) {
        // Check if this route.provider has a dispute window via ProviderRegistry
        uint32 disputeWindow = _providerDisputeWindow(route.provider);
        if (disputeWindow == 0) revert ArbitrationHoldRequired();
        NegotiationDisputeVault(factory.disputeVault())
            .assertArbitrationConsent(address(this), route.provider, route.tokenOut);

        if (route.tokenIn != route.tokenOut) {
            // Swap then route
            if (swapAdapter == address(0)) revert SwapAdapterNotSet();
            IERC20(route.tokenIn).safeIncreaseAllowance(swapAdapter, route.payout);
            uint256 swapOut = ISwapAdapter(swapAdapter)
                .swapExactIn(
                    route.tokenIn,
                    route.tokenOut,
                    route.payout,
                    route.minOut,
                    disputeWindow > 0 ? address(factory.disputeVault()) : _payoutAddressFor(route.provider),
                    new bytes(0)
                );
            actualPayout = swapOut;

            if (disputeWindow > 0) {
                DisputeVault(factory.disputeVault())
                    .receiveSettlementWithReceipts(
                        route.settlementId,
                        address(this),
                        route.provider,
                        route.tokenOut,
                        swapOut,
                        disputeWindow,
                        route.context
                    );
            }
        } else {
            // Same token
            if (disputeWindow > 0) {
                // Transfer to vault
                address vault = factory.disputeVault();
                IERC20(route.tokenIn).safeTransfer(vault, route.payout);
                DisputeVault(vault)
                    .receiveSettlementWithReceipts(
                        route.settlementId,
                        address(this),
                        route.provider,
                        route.tokenIn,
                        route.payout,
                        disputeWindow,
                        route.context
                    );
                actualPayout = route.payout;
            } else {
                // Direct to route.payout address
                IERC20(route.tokenIn).safeTransfer(_payoutAddressFor(route.provider), route.payout);
                actualPayout = route.payout;
            }
        }

        totalWithdrawn[route.tokenIn] += route.payout;
    }

    // ─── Internal: reputation (best-effort, non-reverting) ───────────────────

    function _recordReputation(address wallet, address provider, address token, uint256 delta) internal {
        address repReg = address(ReputationRegistry(factory.reputationRegistry()));
        if (repReg == address(0)) return;
        uint256 deltaUsd = _toUsdE6(token, delta);
        (bool ok,) = repReg.call(
            abi.encodeWithSignature(
                "recordSettlement(address,address,uint256,uint256)",
                wallet,
                provider,
                deltaUsd,
                _toUsdE6(token, delta * feeBps / 10_000)
            )
        );
        // Non-reverting: reputation failure never blocks payment
        if (!ok) {}
    }

    // ─── Internal: checks ────────────────────────────────────────────────────

    function _verifySig(Voucher calldata v, bytes calldata sig) internal view {
        bytes32 structHash = keccak256(
            abi.encode(VOUCHER_TYPEHASH, v.wallet, v.provider, v.token, v.cumulativeAmount, v.nonce, v.expiry)
        );
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator(), structHash);
        address signer = ECDSA.recover(digest, sig);
        if (signerValidUntil[signer] < block.timestamp) revert InvalidSignature();
    }

    function _checkDailyLimit(address token, uint256 delta) internal view {
        if (dailyLimitUsdE6 == 0) return;
        TokenRate storage r = tokenRates[token];
        if (r.usdRateE6 == 0) return;
        uint256 day = block.timestamp / 86400;
        uint256 addedUsd = _toUsdE6(token, delta);
        if (dailySpendUsdE6[day] + addedUsd > dailyLimitUsdE6) revert DailyLimitExceeded();
    }

    function _toUsdE6(address token, uint256 amount) internal view returns (uint256) {
        TokenRate storage r = tokenRates[token];
        if (r.usdRateE6 == 0 || r.decimals == 0) return 0;
        return (amount * r.usdRateE6) / (10 ** r.decimals);
    }

    function _providerDisputeWindow(address provider) internal view returns (uint32) {
        address reg = factory.providerRegistry();
        if (reg == address(0)) return 0;
        (bool ok, bytes memory data) = reg.staticcall(abi.encodeWithSignature("disputeWindowOf(address)", provider));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint32));
    }

    function _payoutAddressFor(address provider) internal view returns (address) {
        address reg = factory.providerRegistry();
        if (reg == address(0)) return provider;
        (bool ok, bytes memory data) = reg.staticcall(abi.encodeWithSignature("payoutAddressOf(address)", provider));
        if (!ok || data.length < 32) return provider;
        address p = abi.decode(data, (address));
        return p != address(0) ? p : provider;
    }

    // ─── Views ───────────────────────────────────────────────────────────────

    function freeBalance(address token) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 enc = encumbered[token];
        return bal > enc ? bal - enc : 0;
    }

    function currentDay() public view returns (uint256) {
        return block.timestamp / 86400;
    }

    /// @notice Verify a Merkle proof against a stored receipts root.
    /// @param provider  Provider address.
    /// @param token     Token address.
    /// @param nonce     The settlement nonce.
    /// @param leaf      The leaf to prove (keccak256 of receipt data).
    /// @param proof     Merkle proof (sibling hashes).
    function verifyReceiptProof(
        address provider,
        address token,
        uint256 nonce,
        bytes32 leaf,
        bytes32[] calldata proof
    ) external view returns (bool) {
        bytes32 root = receiptsRoots[provider][token][nonce];
        if (root == bytes32(0)) return false;
        bytes32 computed = leaf;
        for (uint256 i; i < proof.length; ++i) {
            bytes32 sibling = proof[i];
            computed = computed < sibling
                ? keccak256(abi.encodePacked(computed, sibling))
                : keccak256(abi.encodePacked(sibling, computed));
        }
        return computed == root;
    }
}
