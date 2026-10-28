// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20}       from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20}          from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA}           from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ISwapAdapter}    from "./ISwapAdapter.sol";
import {AgentWalletFactoryV2} from "./AgentWalletFactoryV2.sol";

/// @title AgentWalletV2
/// @notice Per-agent multi-stablecoin wallet.  Holds any factory-allowlisted ERC-20 token,
///         manages per-(provider,token) budgets, and settles EIP-712 payment vouchers.
///
/// @dev V2 differences from V1
///      ─────────────────────────────────────────────────────────────────────────────────────
///      1. Multi-token: Voucher includes a `token` field.  All accounting is keyed by
///         (provider, token).  A separate `encumbered[token]` mapping replaces the single
///         `encumberedBalance` of V1.
///
///      2. Token allowlist gate: checked at deposit AND at settle time via factory callback.
///         Removing a token from the allowlist mid-flight prevents new deposits and settlements
///         but does NOT freeze existing balances — owner can recover via emergencyWithdraw.
///
///      3. Fee-on-transfer rejection: deposit records the balance delta before/after the pull,
///         and reverts with `FeeOnTransferToken` if actual received < requested.
///         This is essential for the accounting invariant to hold.
///
///      4. Provider payout preference: each provider may set a preferred output token via
///         setPayoutToken(provider, tokenOut).  When tokenOut ≠ voucher token, the wallet
///         approves `swapAdapter` and calls swapExactIn(tokenIn, tokenOut, payout, minOut, provider).
///         `minOut` is supplied by the provider in the settle call (slippage-protected).
///         Protocol fee is always taken in the voucher token BEFORE the swap.
///
///      5. Daily limit in USD-equivalent: the owner sets `usdRateE6[token]` (price of 1 full
///         token in USD, scaled by 1e6; e.g. 1_000_000 for a $1 token with 6 decimals).
///         Daily spend is accumulated in "USD micro-units" = amount_base_units * usdRateE6 / 10^tokenDecimals.
///         No oracle dependency — tradeoff documented in docs/DECISIONS.md.
///
///      ─────────────────────────────────────────────────────────────────────────────────────
///      Accounting invariant (per token):
///        token.balanceOf(address(this))
///          == totalDeposited[token] - totalWithdrawn[token] - totalFeesPaid[token]
///             - sum_over_providers(settled[provider][token])_net_of_fees
///      Simplified:  balance >= encumbered[token]  at all times (no under-floor).
///
///      Pause cooldown: same as V1 — pauseWithdrawDeadline is NOT cleared by unpause().
contract AgentWalletV2 is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Structs ────────────────────────────────────────────────────────────

    /// @notice V2 Voucher — adds `token` field for multi-stablecoin support.
    struct Voucher {
        address wallet;           // must equal address(this)
        address provider;         // API provider
        address token;            // ERC-20 token being spent
        uint256 cumulativeAmount; // running total paid to this provider for this token
        uint256 nonce;            // strictly increasing per (provider, token)
        uint64  expiry;           // unix timestamp
    }

    struct Budget {
        uint256 maxTotal;   // max cumulative gross payout to this provider for this token
        uint256 perCallCap; // max single-voucher delta; 0 = uncapped
    }

    struct DecreaseRequest {
        uint256 newMaxTotal;
        uint256 newPerCallCap;
        uint256 requestedAt;
    }

    /// @dev Parameters for settle that exceed stack depth if passed inline.
    struct SettleParams {
        uint256 delta;
        uint256 fee;
        uint256 payout;
        address payoutToken;
        uint256 minOut;
    }

    // ─── Errors ─────────────────────────────────────────────────────────────

    error ZeroAddress();
    error InvalidFee();
    error InvalidSettleWindow();
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

    // ─── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed from, address indexed token, uint256 amount);
    event Withdrawn(address indexed to, address indexed token, uint256 amount);
    event EmergencyWithdrawn(address indexed to, address indexed token, uint256 amount);
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
        uint256 payoutAmount
    );

    // ─── EIP-712 ────────────────────────────────────────────────────────────

    /// @notice V2 typehash includes the `token` field.
    bytes32 public constant VOUCHER_TYPEHASH = keccak256(
        "Voucher(address wallet,address provider,address token,uint256 cumulativeAmount,uint256 nonce,uint64 expiry)"
    );

    // ─── Immutables ─────────────────────────────────────────────────────────

    /// @notice Factory that deployed this wallet (used for allowlist + fee snapshot reads).
    AgentWalletFactoryV2 public immutable factory;

    uint16  public immutable feeBps;
    uint32  public immutable settleWindow;

    uint256 private immutable _deployChainId;
    bytes32 private immutable _cachedDomainSeparator;

    // ─── Mutable state ──────────────────────────────────────────────────────

    address public owner;
    address public agentSigner;
    address public feeRecipient; // snapshotted at creation

    bool    public paused;
    uint256 public pauseWithdrawDeadline;

    // Swap
    address public swapAdapter; // ISwapAdapter; address(0) = swaps not enabled

    // Per-token accounting
    mapping(address => uint256) public totalDeposited;  // token => total deposited (gross)
    mapping(address => uint256) public totalWithdrawn;  // token => total withdrawn
    mapping(address => uint256) public totalFeesPaid;   // token => total fees paid
    mapping(address => uint256) public encumbered;      // token => sum(budget.maxTotal - settled) over providers

    // Per-(provider, token) state
    mapping(address => mapping(address => uint256))         public settled;         // [provider][token]
    mapping(address => mapping(address => Budget))          public budgets;         // [provider][token]
    mapping(address => mapping(address => uint256))         public nonces;          // [provider][token]
    mapping(address => mapping(address => DecreaseRequest)) public decreaseRequests;// [provider][token]

    // Provider preferences
    mapping(address => address)  public relayers;       // provider => relayer
    mapping(address => address)  public payoutToken;    // provider => preferred output token

    // Daily limit (USD-equivalent micro-units, 0 = no limit)
    uint256 public dailyLimitUsdE6;
    mapping(uint256 => uint256) public dailySpendUsdE6; // day index => accumulated USD-equiv spend

    // Per-token price config (no oracle — owner-set)
    struct TokenRate {
        uint256 usdRateE6; // price of 1 full token in USD * 1e6; e.g. 1_000_000 for a $1 token
        uint8   decimals;  // token decimals (needed for USD conversion)
    }
    mapping(address => TokenRate) public tokenRates; // token => rate config

    // Signer rotation
    mapping(address => uint256) public signerValidUntil; // signer => valid until timestamp

    // ─── Constructor ────────────────────────────────────────────────────────

    /// @notice Created by AgentWalletFactoryV2 via CREATE2.
    constructor(
        address owner_,
        address agentSigner_,
        address factory_,
        address feeRecipient_,
        uint16  feeBps_,
        uint32  settleWindow_
    ) {
        if (owner_ == address(0) || agentSigner_ == address(0)
                || factory_ == address(0) || feeRecipient_ == address(0))
            revert ZeroAddress();
        if (feeBps_ > 500)    revert InvalidFee();
        if (settleWindow_ < 600) revert InvalidSettleWindow();

        owner        = owner_;
        agentSigner  = agentSigner_;
        factory      = AgentWalletFactoryV2(factory_);
        feeRecipient = feeRecipient_;
        feeBps       = feeBps_;
        settleWindow = settleWindow_;

        signerValidUntil[agentSigner_] = type(uint256).max;

        _deployChainId         = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── EIP-712 ────────────────────────────────────────────────────────────

    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _deployChainId) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes("AgentPayV2")),
            keccak256(bytes("2")),
            block.chainid,
            address(this)
        ));
    }

    // ─── Deposit ────────────────────────────────────────────────────────────

    /// @notice Deposits a factory-allowlisted token into the wallet.
    /// @dev Rejects fee-on-transfer tokens: reverts if actual received < amount.
    /// @param token  ERC-20 token address (must be in factory allowlist).
    /// @param amount Amount to pull from msg.sender.
    function deposit(address token, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (!factory.isAllowedToken(token)) revert TokenNotAllowed();

        uint256 balBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balBefore;

        // Reject fee-on-transfer tokens: actual received must equal requested amount.
        if (received != amount) revert FeeOnTransferToken();

        totalDeposited[token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    // ─── Withdraw ───────────────────────────────────────────────────────────

    /// @notice Withdraws free (unencumbered) balance of a token to the owner.
    /// @param token  Token to withdraw.
    /// @param amount Amount to withdraw.
    function withdraw(address token, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp < pauseWithdrawDeadline) revert WithdrawCooldown();
        if (amount > freeBalance(token)) revert InsufficientFreeBalance();

        totalWithdrawn[token] += amount;
        IERC20(token).safeTransfer(owner, amount);
        emit Withdrawn(owner, token, amount);
    }

    /// @notice Allows the owner to recover any token balance regardless of encumbrance.
    /// @dev Only usable after a token is removed from the factory allowlist (or as a last resort).
    ///      Does NOT update accounting — emits EmergencyWithdrawn instead of Withdrawn.
    ///      Use only when the token is no longer settable (de-listed from allowlist).
    /// @param token  Token to recover.
    /// @param amount Amount to recover.
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();
        // Allow only if token is NOT in the allowlist (de-listed) to avoid misuse
        if (factory.isAllowedToken(token)) revert TokenNotAllowed();
        if (amount > IERC20(token).balanceOf(address(this))) revert InsufficientFreeBalance();

        IERC20(token).safeTransfer(owner, amount);
        emit EmergencyWithdrawn(owner, token, amount);
    }

    // ─── Budget management ──────────────────────────────────────────────────

    /// @notice Sets or increases the budget for a (provider, token) pair.
    /// @param provider   Provider address.
    /// @param token      Token for which to set the budget.
    /// @param maxTotal   New cumulative max (must be >= current or use decrease flow).
    /// @param perCallCap Max per-settlement delta (0 = uncapped).
    function setProviderBudget(
        address provider,
        address token,
        uint256 maxTotal,
        uint256 perCallCap
    ) external onlyOwner {
        if (provider == address(0)) revert ZeroAddress();
        if (!factory.isAllowedToken(token)) revert TokenNotAllowed();

        Budget memory old = budgets[provider][token];
        if (maxTotal < old.maxTotal) revert UseDecreaseRequest();

        uint256 prevSettled = settled[provider][token];
        uint256 oldContrib  = old.maxTotal > prevSettled ? old.maxTotal - prevSettled : 0;
        uint256 newContrib  = maxTotal > prevSettled     ? maxTotal - prevSettled     : 0;

        if (newContrib > oldContrib) {
            uint256 increase = newContrib - oldContrib;
            if (increase > freeBalance(token)) revert InsufficientFreeBalance();
            encumbered[token] += increase;
        }

        budgets[provider][token] = Budget({maxTotal: maxTotal, perCallCap: perCallCap});
        emit ProviderBudgetSet(provider, token, maxTotal, perCallCap);
    }

    /// @notice Starts a timelocked budget decrease for a (provider, token) pair.
    function requestBudgetDecrease(
        address provider,
        address token,
        uint256 newMaxTotal,
        uint256 newPerCallCap
    ) external onlyOwner {
        if (newMaxTotal >= budgets[provider][token].maxTotal) revert InvalidDelta();

        decreaseRequests[provider][token] = DecreaseRequest({
            newMaxTotal:   newMaxTotal,
            newPerCallCap: newPerCallCap,
            requestedAt:   block.timestamp
        });

        emit BudgetDecreaseRequested(
            provider, token, newMaxTotal, newPerCallCap, block.timestamp + settleWindow
        );
    }

    /// @notice Executes a pending budget decrease after the settle window.
    function executeBudgetDecrease(address provider, address token) external onlyOwner {
        DecreaseRequest memory req = decreaseRequests[provider][token];
        if (req.requestedAt == 0) revert NoPendingDecrease();
        if (block.timestamp < req.requestedAt + settleWindow) revert DecreaseWindowNotElapsed();

        uint256 prevSettled = settled[provider][token];
        uint256 appliedMax  = req.newMaxTotal < prevSettled ? prevSettled : req.newMaxTotal;

        Budget memory old   = budgets[provider][token];
        uint256 oldContrib  = old.maxTotal > prevSettled ? old.maxTotal - prevSettled : 0;
        uint256 newContrib  = appliedMax > prevSettled   ? appliedMax - prevSettled   : 0;

        if (oldContrib > newContrib) {
            uint256 reduction = oldContrib - newContrib;
            encumbered[token] = encumbered[token] >= reduction
                ? encumbered[token] - reduction
                : 0;
        }

        budgets[provider][token] = Budget({maxTotal: appliedMax, perCallCap: req.newPerCallCap});
        delete decreaseRequests[provider][token];

        emit ProviderBudgetSet(provider, token, appliedMax, req.newPerCallCap);
    }

    // ─── Daily limit ────────────────────────────────────────────────────────

    /// @notice Sets the daily USD-equivalent spend limit.  0 = no limit.
    /// @param limitUsdE6 Limit in USD micro-units (e.g. 1_000_000_000 = $1000).
    function setDailyLimit(uint256 limitUsdE6) external onlyOwner {
        dailyLimitUsdE6 = limitUsdE6;
        emit DailyLimitSet(limitUsdE6);
    }

    /// @notice Sets the USD rate for a token (no oracle — owner-managed).
    /// @param token      Token address.
    /// @param usdRateE6  Price of 1 full token in USD scaled by 1e6 (e.g. 1_000_000 = $1.00).
    /// @param decimals_  Token decimals (needed for USD-equivalent conversion).
    function setTokenRate(address token, uint256 usdRateE6, uint8 decimals_) external onlyOwner {
        tokenRates[token] = TokenRate({usdRateE6: usdRateE6, decimals: decimals_});
        emit TokenRateSet(token, usdRateE6, decimals_);
    }

    // ─── Relayer / payout preference ────────────────────────────────────────

    /// @notice Provider sets or clears its authorized relayer for this wallet.
    function setRelayer(address provider, address relayer_) external {
        if (msg.sender != provider) revert UnauthorizedProvider();
        relayers[provider] = relayer_;
        emit RelayerSet(provider, relayer_);
    }

    /// @notice Provider sets its preferred payout token.
    /// @dev If tokenOut != voucher token, the wallet will swap before paying out.
    ///      Requires swapAdapter to be set.
    function setPayoutToken(address provider, address tokenOut) external {
        if (msg.sender != provider) revert UnauthorizedProvider();
        payoutToken[provider] = tokenOut;
        emit PayoutTokenSet(provider, tokenOut);
    }

    // ─── Swap adapter ────────────────────────────────────────────────────────

    /// @notice Owner sets the swap adapter address.  address(0) disables swaps.
    function setSwapAdapter(address adapter) external onlyOwner {
        swapAdapter = adapter;
        emit SwapAdapterSet(adapter);
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        paused = true;
        uint256 deadline = block.timestamp + settleWindow;
        pauseWithdrawDeadline = deadline;
        emit Paused(deadline);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    // ─── Signer rotation ────────────────────────────────────────────────────

    function rotateAgentSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        address old = agentSigner;
        signerValidUntil[old]       = block.timestamp + settleWindow;
        signerValidUntil[newSigner] = type(uint256).max;
        agentSigner                 = newSigner;
        emit AgentSignerRotated(old, newSigner, block.timestamp + settleWindow);
    }

    // ─── Settlement ─────────────────────────────────────────────────────────

    /// @notice Settles one signed V2 voucher.
    /// @param voucher Voucher payload (includes token field).
    /// @param sig     EIP-712 signature.
    /// @param minOut  Minimum output tokens when a swap is needed (0 if no swap).
    function settle(
        Voucher calldata voucher,
        bytes calldata sig,
        uint256 minOut
    ) external nonReentrant {
        _settle(voucher, sig, minOut);
    }

    /// @notice Settles multiple signed V2 vouchers in one transaction.
    /// @param vouchers Array of voucher payloads.
    /// @param sigs     Matching EIP-712 signatures.
    /// @param minOuts  Per-voucher minOut values for optional swaps.
    function settleBatch(
        Voucher[] calldata vouchers,
        bytes[]   calldata sigs,
        uint256[] calldata minOuts
    ) external nonReentrant {
        if (vouchers.length != sigs.length || vouchers.length != minOuts.length)
            revert ArrayLengthMismatch();
        uint256 len = vouchers.length;
        for (uint256 i; i < len; ++i) {
            _settle(vouchers[i], sigs[i], minOuts[i]);
        }
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns the free (unencumbered) balance for a specific token.
    function freeBalance(address token) public view returns (uint256) {
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 enc = encumbered[token];
        return bal > enc ? bal - enc : 0;
    }

    function currentDay() public view returns (uint256) {
        return block.timestamp / 86400;
    }

    // ─── Internal settlement ─────────────────────────────────────────────────

    function _settle(
        Voucher calldata v,
        bytes   calldata sig,
        uint256 minOut
    ) internal {
        // ── Checks ──────────────────────────────────────────────────────────
        if (paused) revert WalletPaused();
        _checkCaller(v.provider);
        if (v.wallet != address(this)) revert InvalidSignature();
        if (block.timestamp > uint256(v.expiry)) revert VoucherExpired();
        if (!factory.isAllowedToken(v.token)) revert TokenNotAllowed();
        _checkSignature(v, sig);

        uint256 delta = _checkAndGetDelta(v);
        _checkDailyLimit(v.token, delta);

        // ── Fee math ─────────────────────────────────────────────────────────
        uint256 fee    = (delta * feeBps) / 10_000;
        if (delta <= fee) revert InvalidFee();
        uint256 payout;
        unchecked { payout = delta - fee; }

        // ── Effects ──────────────────────────────────────────────────────────
        // Update encumbrance (encumbered[token] always >= delta by budget check)
        unchecked { encumbered[v.token] -= delta; }

        nonces[v.provider][v.token]  = v.nonce;
        settled[v.provider][v.token] = v.cumulativeAmount;
        totalFeesPaid[v.token]       += fee;
        _accumulateDailySpend(v.token, delta);

        // ── Interactions ────────────────────────────────────────────────────
        // 1. Pay fee (always in voucher token)
        if (fee > 0) IERC20(v.token).safeTransfer(feeRecipient, fee);

        // 2. Pay provider (direct or swap)
        address prefToken = payoutToken[v.provider];
        uint256 payoutAmount;
        if (prefToken == address(0) || prefToken == v.token) {
            // Direct payout in voucher token
            IERC20(v.token).safeTransfer(v.provider, payout);
            payoutAmount = payout;
        } else {
            // Swap payout into provider's preferred token
            if (swapAdapter == address(0)) revert SwapAdapterNotSet();
            IERC20(v.token).safeIncreaseAllowance(swapAdapter, payout);
            payoutAmount = ISwapAdapter(swapAdapter).swapExactIn(
                v.token,
                prefToken,
                payout,
                minOut,
                v.provider,
                new bytes(0)
            );
        }

        emit Settled(
            v.provider,
            v.token,
            delta,
            fee,
            v.nonce,
            v.cumulativeAmount,
            prefToken == address(0) ? v.token : prefToken,
            payoutAmount
        );
    }

    function _checkCaller(address provider) private view {
        if (msg.sender != provider && msg.sender != relayers[provider])
            revert UnauthorizedProvider();
    }

    function _checkSignature(Voucher calldata v, bytes calldata sig) private view {
        bytes32 structHash = keccak256(abi.encode(
            VOUCHER_TYPEHASH,
            v.wallet,
            v.provider,
            v.token,
            v.cumulativeAmount,
            v.nonce,
            v.expiry
        ));
        bytes32 digest = MessageHashUtils.toTypedDataHash(domainSeparator(), structHash);
        address signer = ECDSA.recover(digest, sig);
        if (block.timestamp > signerValidUntil[signer]) revert InvalidSignature();
    }

    function _checkAndGetDelta(Voucher calldata v) private view returns (uint256 delta) {
        if (v.nonce <= nonces[v.provider][v.token]) revert InvalidNonce();

        uint256 prev = settled[v.provider][v.token];
        if (v.cumulativeAmount <= prev) revert InvalidDelta();
        delta = v.cumulativeAmount - prev;

        Budget memory b = budgets[v.provider][v.token];
        if (v.cumulativeAmount > b.maxTotal) revert BudgetExceeded();
        if (b.perCallCap > 0 && delta > b.perCallCap) revert PerCallCapExceeded();
        if (delta > encumbered[v.token]) revert InvalidDelta();
    }

    function _checkDailyLimit(address token, uint256 delta) private view {
        if (dailyLimitUsdE6 == 0) return;

        TokenRate memory rate = tokenRates[token];
        if (rate.usdRateE6 == 0) return; // no rate configured → skip daily limit for this token

        // USD-equivalent in micro-units: delta_base_units * usdRateE6 / 10^decimals
        // Use uint256 arithmetic; decimals <= 18 so 10^18 fits.
        uint256 usdVal = (delta * rate.usdRateE6) / (10 ** uint256(rate.decimals));
        if (dailySpendUsdE6[currentDay()] + usdVal > dailyLimitUsdE6) revert DailyLimitExceeded();
    }

    function _accumulateDailySpend(address token, uint256 delta) private {
        if (dailyLimitUsdE6 == 0) return;
        TokenRate memory rate = tokenRates[token];
        if (rate.usdRateE6 == 0) return;
        uint256 usdVal = (delta * rate.usdRateE6) / (10 ** uint256(rate.decimals));
        dailySpendUsdE6[currentDay()] += usdVal;
    }
}
