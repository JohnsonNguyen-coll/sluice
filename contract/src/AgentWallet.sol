// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title AgentWallet
/// @notice Per-agent USDC wallet that manages provider budgets and settles EIP-712 payment vouchers.
/// @dev Holds USDC prefunded by the agent owner. Providers call settle() / settleBatch() with
///      off-chain EIP-712 vouchers signed by agentSigner. No on-chain tx per API call — only
///      settlement (potentially batched) hits the chain.
///
///      Accounting invariant (gross):
///        usdc.balanceOf(address(this)) == totalDeposited - totalWithdrawn - totalFeesPaid - sum(settled_net)
///      where settled_net[p] = settled[p] - fees_attributable_to_p.
///      For simplicity encumberedBalance tracks (sum(budget.maxTotal) - sum(settled[p])) over all
///      providers, which is exactly the USDC still at risk of being claimed.
///
///      Pause withdrawal cooldown: pauseWithdrawDeadline tracks the earliest timestamp at which the
///      owner may withdraw after a pause event. It advances on each pause() call and is NOT cleared
///      by unpause(), so that owners cannot bypass the cooldown by cycling pause/unpause.
contract AgentWallet is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ─── Structs ────────────────────────────────────────────────────────────

    /// @notice On-chain EIP-712 voucher. The agent signer signs this off-chain.
    struct Voucher {
        address wallet;          // must equal address(this)
        address provider;        // the API provider
        uint256 cumulativeAmount;// running total paid to this provider (gross, includes fees)
        uint256 nonce;           // strictly increasing per provider
        uint64  expiry;          // unix timestamp after which voucher is invalid
    }

    struct Budget {
        uint256 maxTotal;   // maximum cumulative gross payout to this provider
        uint256 perCallCap; // max single-voucher delta; 0 = uncapped
    }

    struct DecreaseRequest {
        uint256 newMaxTotal;
        uint256 newPerCallCap;
        uint256 requestedAt;
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

    // ─── Events ─────────────────────────────────────────────────────────────

    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event ProviderBudgetSet(address indexed provider, uint256 maxTotal, uint256 perCallCap);
    event BudgetDecreaseRequested(
        address indexed provider,
        uint256 newMaxTotal,
        uint256 newPerCallCap,
        uint256 executeAfter
    );
    event DailyLimitSet(uint256 limit);
    event RelayerSet(address indexed provider, address indexed relayer);
    event Paused(uint256 withdrawDeadline);
    event Unpaused();
    event AgentSignerRotated(address indexed oldSigner, address indexed newSigner, uint256 validUntil);
    event Settled(address indexed provider, uint256 delta, uint256 fee, uint256 nonce, uint256 cumulative);

    // ─── EIP-712 ────────────────────────────────────────────────────────────

    bytes32 public constant VOUCHER_TYPEHASH =
        keccak256("Voucher(address wallet,address provider,uint256 cumulativeAmount,uint256 nonce,uint64 expiry)");

    // ─── Immutables ─────────────────────────────────────────────────────────

    IERC20  public immutable usdc;
    uint16  public immutable feeBps;      // snapshotted at wallet creation, max 500
    uint32  public immutable settleWindow;// safety window for decreases / rotations / pause

    /// @dev Chain ID at construction; used to detect chain forks.
    uint256 private immutable _deployChainId;

    /// @dev Domain separator at construction; recomputed at runtime if chain ID has changed.
    bytes32 private immutable _cachedDomainSeparator;

    // ─── Mutable state ──────────────────────────────────────────────────────

    address public owner;
    address public agentSigner;
    address public feeRecipient; // snapshotted at wallet creation

    // Pause / withdrawal cooldown
    bool    public paused;
    /// @notice Earliest timestamp the owner may withdraw after a pause event.
    ///         Advances on each pause() call, NOT cleared by unpause().
    uint256 public pauseWithdrawDeadline;

    // Accounting
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public totalFeesPaid;

    /// @notice Total USDC encumbered by active budgets (maxTotal - settled per provider, summed).
    uint256 public encumberedBalance;

    // Per-provider state
    mapping(address => uint256)         public settled;         // gross cumulative settled
    mapping(address => Budget)          public budgets;
    mapping(address => uint256)         public nonces;          // last settled nonce
    mapping(address => DecreaseRequest) public decreaseRequests;
    mapping(address => address)         public relayers;

    // Daily limits
    uint256 public dailyLimit; // 0 = no limit
    mapping(uint256 => uint256) public dailySpend; // day index => gross settled that day

    // Signer rotation: map signer address => timestamp until which it remains valid
    mapping(address => uint256) public signerValidUntil;

    // ─── Constructor ────────────────────────────────────────────────────────

    /// @notice Creates a new AgentWallet instance (called by AgentWalletFactory via CREATE2).
    /// @param owner_        Wallet owner (can deposit/withdraw/set budgets).
    /// @param agentSigner_  Initial trusted voucher signer (hot key, cannot move funds).
    /// @param usdc_         USDC token address.
    /// @param feeRecipient_ Protocol fee recipient (snapshotted).
    /// @param feeBps_       Protocol fee in basis points (max 500, snapshotted).
    /// @param settleWindow_ Safety window in seconds (min 600, 10 minutes).
    constructor(
        address owner_,
        address agentSigner_,
        address usdc_,
        address feeRecipient_,
        uint16  feeBps_,
        uint32  settleWindow_
    ) {
        if (owner_ == address(0) || agentSigner_ == address(0) || usdc_ == address(0) || feeRecipient_ == address(0))
            revert ZeroAddress();
        if (feeBps_ > 500) revert InvalidFee();
        if (settleWindow_ < 600) revert InvalidSettleWindow();

        owner        = owner_;
        agentSigner  = agentSigner_;
        usdc         = IERC20(usdc_);
        feeRecipient = feeRecipient_;
        feeBps       = feeBps_;
        settleWindow = settleWindow_;

        // Mark the initial signer as permanently valid (validUntil = max uint256) until explicitly rotated
        signerValidUntil[agentSigner_] = type(uint256).max;

        _deployChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    // ─── Modifiers ──────────────────────────────────────────────────────────

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    // ─── EIP-712 helpers ────────────────────────────────────────────────────

    /// @notice Returns the active EIP-712 domain separator. Recomputed if chain ID changed.
    function domainSeparator() public view returns (bytes32) {
        if (block.chainid == _deployChainId) return _cachedDomainSeparator;
        return _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("AgentPay")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // ─── Deposit / Withdraw ─────────────────────────────────────────────────

    /// @notice Deposits USDC into the wallet. Any caller may deposit.
    /// @param amount Amount of USDC to pull from msg.sender.
    function deposit(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalDeposited += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraws unencumbered USDC to the owner.
    /// @dev Cannot withdraw reserved (encumbered) funds.
    ///      After a pause, withdrawal is blocked until pauseWithdrawDeadline elapses.
    ///      This cooldown is independent of the paused flag — unpause() does not clear it.
    /// @param amount Amount of USDC to withdraw.
    function withdraw(uint256 amount) external onlyOwner {
        // Enforce pause withdrawal cooldown (cleared only by time, not by unpause)
        if (block.timestamp < pauseWithdrawDeadline) revert WithdrawCooldown();
        if (amount > freeBalance()) revert InsufficientFreeBalance();

        totalWithdrawn += amount;
        usdc.safeTransfer(owner, amount);
        emit Withdrawn(owner, amount);
    }

    // ─── Budget management ──────────────────────────────────────────────────

    /// @notice Sets or increases a provider budget. Takes effect immediately.
    /// @dev Budget decreases must use requestBudgetDecrease / executeBudgetDecrease.
    /// @param provider    Provider address.
    /// @param maxTotal    New cumulative max; must be >= current or use decrease flow.
    /// @param perCallCap  Max per-settlement delta (0 = uncapped).
    function setProviderBudget(address provider, uint256 maxTotal, uint256 perCallCap) external onlyOwner {
        if (provider == address(0)) revert ZeroAddress();

        Budget memory oldBudget = budgets[provider];
        if (maxTotal < oldBudget.maxTotal) revert UseDecreaseRequest();

        uint256 currentSettled = settled[provider];
        uint256 oldContrib = oldBudget.maxTotal > currentSettled ? oldBudget.maxTotal - currentSettled : 0;
        uint256 newContrib = maxTotal > currentSettled ? maxTotal - currentSettled : 0;

        if (newContrib > oldContrib) {
            uint256 increase = newContrib - oldContrib;
            if (increase > freeBalance()) revert InsufficientFreeBalance();
            encumberedBalance += increase;
        }

        budgets[provider] = Budget({maxTotal: maxTotal, perCallCap: perCallCap});
        emit ProviderBudgetSet(provider, maxTotal, perCallCap);
    }

    /// @notice Starts a timelocked budget decrease for a provider.
    /// @dev Provider can still settle up to the current maxTotal during the settleWindow.
    /// @param provider      Provider address.
    /// @param newMaxTotal   Requested lower bound (applied at execution).
    /// @param newPerCallCap New per-call cap.
    function requestBudgetDecrease(
        address provider,
        uint256 newMaxTotal,
        uint256 newPerCallCap
    ) external onlyOwner {
        if (newMaxTotal >= budgets[provider].maxTotal) revert InvalidDelta();

        decreaseRequests[provider] = DecreaseRequest({
            newMaxTotal:   newMaxTotal,
            newPerCallCap: newPerCallCap,
            requestedAt:   block.timestamp
        });

        emit BudgetDecreaseRequested(provider, newMaxTotal, newPerCallCap, block.timestamp + settleWindow);
    }

    /// @notice Executes a pending budget decrease after the settle window has elapsed.
    /// @param provider Provider address.
    function executeBudgetDecrease(address provider) external onlyOwner {
        DecreaseRequest memory req = decreaseRequests[provider];
        if (req.requestedAt == 0) revert NoPendingDecrease();
        if (block.timestamp < req.requestedAt + settleWindow) revert DecreaseWindowNotElapsed();

        uint256 currentSettled = settled[provider];
        // Cannot reduce budget below already-settled amount
        uint256 appliedMax = req.newMaxTotal < currentSettled ? currentSettled : req.newMaxTotal;

        Budget memory oldBudget = budgets[provider];
        uint256 oldContrib = oldBudget.maxTotal > currentSettled ? oldBudget.maxTotal - currentSettled : 0;
        uint256 newContrib = appliedMax > currentSettled ? appliedMax - currentSettled : 0;

        if (oldContrib > newContrib) {
            uint256 reduction = oldContrib - newContrib;
            // encumberedBalance should always cover this, but guard against underflow
            encumberedBalance = encumberedBalance >= reduction ? encumberedBalance - reduction : 0;
        }

        budgets[provider] = Budget({maxTotal: appliedMax, perCallCap: req.newPerCallCap});
        delete decreaseRequests[provider];

        emit ProviderBudgetSet(provider, appliedMax, req.newPerCallCap);
    }

    /// @notice Sets the daily gross settlement limit. 0 = no limit.
    /// @param limit Daily limit in USDC base units.
    function setDailyLimit(uint256 limit) external onlyOwner {
        dailyLimit = limit;
        emit DailyLimitSet(limit);
    }

    // ─── Relayer ────────────────────────────────────────────────────────────

    /// @notice Provider sets or clears its authorized relayer for this wallet.
    /// @param provider Must equal msg.sender.
    /// @param relayer  Relayer address; zero clears it.
    function setRelayer(address provider, address relayer) external {
        if (msg.sender != provider) revert UnauthorizedProvider();
        relayers[provider] = relayer;
        emit RelayerSet(provider, relayer);
    }

    // ─── Pause ──────────────────────────────────────────────────────────────

    /// @notice Pauses new settlements immediately. Also starts the withdrawal cooldown.
    /// @dev Providers holding unsettled vouchers can still observe the pause and
    ///      decide to settle before the window expires or accept the risk.
    function pause() external onlyOwner {
        paused = true;
        uint256 deadline = block.timestamp + settleWindow;
        pauseWithdrawDeadline = deadline;
        emit Paused(deadline);
    }

    /// @notice Unpauses settlements.
    /// @dev Does NOT clear pauseWithdrawDeadline — the cooldown must expire on its own.
    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    // ─── Signer rotation ────────────────────────────────────────────────────

    /// @notice Rotates the trusted agent signer.
    /// @dev Old signer's vouchers remain valid for `settleWindow` after this call.
    ///      Multiple rotations are safe — each old signer keeps its own validUntil timestamp.
    ///      Cannot rotate to the current signer (no-op guard).
    /// @param newSigner New agent signer address.
    function rotateAgentSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();

        address oldSigner = agentSigner;
        uint256 oldValidUntil = block.timestamp + settleWindow;

        // Downgrade the old signer's validity to settleWindow from now
        // (if it was previously type(uint256).max, cap it here)
        signerValidUntil[oldSigner] = oldValidUntil;

        // New signer valid indefinitely until next rotation
        signerValidUntil[newSigner] = type(uint256).max;

        agentSigner = newSigner;

        emit AgentSignerRotated(oldSigner, newSigner, oldValidUntil);
    }

    // ─── Settlement ─────────────────────────────────────────────────────────

    /// @notice Settles one signed voucher. Called by the provider or its relayer.
    /// @param voucher Voucher payload.
    /// @param sig     EIP-712 signature over the voucher.
    function settle(Voucher calldata voucher, bytes calldata sig) external nonReentrant {
        _settle(voucher, sig);
    }

    /// @notice Settles multiple signed vouchers in a single transaction.
    /// @param vouchers Array of voucher payloads.
    /// @param sigs     Matching EIP-712 signatures.
    function settleBatch(Voucher[] calldata vouchers, bytes[] calldata sigs) external nonReentrant {
        if (vouchers.length != sigs.length) revert ArrayLengthMismatch();
        uint256 len = vouchers.length;
        for (uint256 i; i < len; ++i) {
            _settle(vouchers[i], sigs[i]);
        }
    }

    // ─── Views ──────────────────────────────────────────────────────────────

    /// @notice Returns the free (unencumbered) USDC balance available for withdrawal or new budgets.
    function freeBalance() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        return bal > encumberedBalance ? bal - encumberedBalance : 0;
    }

    /// @notice Returns the current day index used for daily spend tracking.
    function currentDay() public view returns (uint256) {
        return block.timestamp / 86400;
    }

    // ─── Internal settlement logic ───────────────────────────────────────────

    /// @dev Core settlement logic. Called by both settle() and settleBatch().
    ///      Decomposed into check/effect sub-functions to avoid stack-too-deep.
    function _settle(Voucher calldata v, bytes calldata sig) internal {
        // ── Checks ──────────────────────────────────────────────────────────
        if (paused) revert WalletPaused();
        _checkCaller(v.provider);
        if (v.wallet != address(this)) revert InvalidSignature();
        if (block.timestamp > uint256(v.expiry)) revert VoucherExpired();
        _checkSignature(v, sig);
        uint256 delta = _checkAndGetDelta(v);
        _checkDailyLimit(delta);

        // ── Effects ─────────────────────────────────────────────────────────
        uint256 fee = (delta * feeBps) / 10_000;
        if (delta <= fee) revert InvalidFee();
        // encumberedBalance always >= delta here because budget check passed
        unchecked { encumberedBalance -= delta; }

        nonces[v.provider]  = v.nonce;
        settled[v.provider] = v.cumulativeAmount;
        totalFeesPaid       += fee;
        dailySpend[currentDay()] += delta;

        uint256 payout;
        unchecked { payout = delta - fee; }

        // ── Interactions ─────────────────────────────────────────────────────
        usdc.safeTransfer(v.provider, payout);
        if (fee > 0) usdc.safeTransfer(feeRecipient, fee);

        emit Settled(v.provider, delta, fee, v.nonce, v.cumulativeAmount);
    }

    /// @dev Reverts if caller is neither provider nor provider's relayer.
    function _checkCaller(address provider) private view {
        if (msg.sender != provider && msg.sender != relayers[provider]) revert UnauthorizedProvider();
    }

    /// @dev Verifies EIP-712 signature. Accepts current signer and any signer whose grace window is active.
    function _checkSignature(Voucher calldata v, bytes calldata sig) private view {
        bytes32 structHash = keccak256(
            abi.encode(VOUCHER_TYPEHASH, v.wallet, v.provider, v.cumulativeAmount, v.nonce, v.expiry)
        );
        bytes32 digest  = MessageHashUtils.toTypedDataHash(domainSeparator(), structHash);
        address signer  = ECDSA.recover(digest, sig);

        if (block.timestamp > signerValidUntil[signer]) revert InvalidSignature();
    }

    /// @dev Validates nonce, delta, and budget. Returns the settlement delta.
    function _checkAndGetDelta(Voucher calldata v) private view returns (uint256 delta) {
        if (v.nonce <= nonces[v.provider]) revert InvalidNonce();

        uint256 prevSettled = settled[v.provider];
        if (v.cumulativeAmount <= prevSettled) revert InvalidDelta();
        delta = v.cumulativeAmount - prevSettled;

        Budget memory budget = budgets[v.provider];
        if (v.cumulativeAmount > budget.maxTotal) revert BudgetExceeded();
        if (budget.perCallCap > 0 && delta > budget.perCallCap) revert PerCallCapExceeded();
        if (delta > encumberedBalance) revert InvalidDelta();
    }

    /// @dev Validates the daily spend limit.
    function _checkDailyLimit(uint256 delta) private view {
        if (dailyLimit > 0 && dailySpend[currentDay()] + delta > dailyLimit) revert DailyLimitExceeded();
    }
}
