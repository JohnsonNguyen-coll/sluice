# Sluice AgentPay Core — Threat Model

## Actors

| Actor | Trust Level | What They Control |
|---|---|---|
| Agent owner | High (on-chain) | Wallet funds, budgets, pause, signer rotation |
| agentSigner | Medium (hot key) | Voucher signing only |
| Provider | Low | Calls `settle()`; cannot exceed approved budget |
| Relayer | Low | Submits settle txs on provider's behalf |
| Factory owner | Protocol-level | `feeBps` (new wallets only), `feeRecipient` (2-step) |
| End user / RPC | Untrusted | Public nodes, mempool observers |

---

## Threat Scenarios

### T1 — Voucher Replay

**Attack:** Provider submits the same signed voucher twice.

**Mitigation:** Nonces are strictly increasing per provider. Once `nonces[provider] = N` is set, any voucher with `nonce <= N` reverts with `InvalidNonce`. Cumulative amounts compound — a replayed older voucher has `cumulativeAmount <= settled[provider]` and reverts with `InvalidDelta`.

**Residual risk:** None for exact replays. A provider can replay a valid *later* nonce on a different chain if the domain separator is wrong — mitigated by chain-aware domain separator (recomputed if `block.chainid` differs from deployment chain ID).

---

### T2 — Double-spend / Over-settlement

**Attack:** Provider crafts a voucher with `cumulativeAmount > budgets[provider].maxTotal`.

**Mitigation:** `settle()` checks `voucher.cumulativeAmount <= budget.maxTotal` and reverts `BudgetExceeded`. `encumberedBalance` tracks the reserved amount and is decremented on settlement, so freeBalance() always reflects what is truly available.

**Residual risk:** Provider could submit two valid sequential vouchers atomically (both would pass individually) — but `nonces` are updated in the same tx before the second call, so batching is safe due to the nonReentrant guard and ordered nonce checks within `_settle`.

---

### T3 — Compromised agentSigner

**Attack:** Attacker gains the agentSigner private key and signs vouchers up to `budget.maxTotal` for each provider.

**Impact:** Attacker can drain up to `encumberedBalance` (the budgeted amount) but cannot touch the free balance or move funds directly.

**Mitigation:**
1. Owner detects compromise and calls `pause()` immediately — blocks all new settlements.
2. Owner calls `rotateAgentSigner(newSigner)` — old key's vouchers expire after `settleWindow`.
3. Per-provider `maxTotal` and `perCallCap` limit blast radius.
4. `dailyLimit` limits per-day exposure.

**See RUNBOOK.md → "Compromised agentSigner".**

---

### T4 — Malicious Provider

**Attack a — Budget drain:** Provider calls `settle()` with max-value voucher every block.

**Mitigation:** `maxTotal` is set by owner. Provider can only claim what the owner approved. `perCallCap` further limits single-call exposure.

**Attack b — Griefing via nonce exhaustion:** Provider refuses to settle, holding stale vouchers. Agent's nonce counter advances in the SDK but the provider can still settle old vouchers.

**Mitigation:** Nonces are strictly increasing on-chain. The provider can only settle each voucher once. The SDK uses per-provider mutexes and idempotent retry so nonce gaps do not arise.

**Attack c — Provider impersonation:** Attacker calls `settle()` claiming to be PROVIDER with a forged voucher.

**Mitigation:** The recovered signer must be `agentSigner` (or a grace-window signer). A forged voucher with a valid wallet signature from the real signer cannot be produced without the key.

---

### T5 — Griefing / DoS

**Attack a — Budget fragmentation:** Owner sets thousands of providers with tiny budgets.

**Impact:** `encumberedBalance` accounting is O(1) per provider (no iteration). Each `setProviderBudget` is a discrete tx so cost is borne by the griefer (the owner).

**Attack b — Large batch DoS:** Provider calls `settleBatch` with thousands of vouchers.

**Impact:** Gas cost is linear in batch size. Provider pays gas. No per-tx fee limit in the contract. Operators can set `thresholdUsdc` and `intervalSec` in middleware to bound batch sizes.

**Attack c — Spam 402s:** Malicious client sends requests without paying.

**Impact:** Middleware performs sig verification off-chain. Rate limiting per wallet (`packages/middleware`) and request-size limits bound exposure.

---

### T6 — RPC Lies / Node Compromise

**Attack:** Provider's middleware verifies against a compromised RPC node that reports false on-chain state (wallet not paused, budget not exceeded).

**Mitigation:**
- Settlement is validated entirely on-chain in `AgentWallet.sol` — the contract is the source of truth.
- Off-chain verification in middleware is defense-in-depth (reduces gas waste on invalid submissions).
- Providers should use multiple independent RPC endpoints for verification.

**Residual risk:** Middleware might serve requests for a paused wallet if its RPC is wrong — but on-chain settlement will revert, so the provider loses gas on the settlement tx.

---

### T7 — Reorgs

**Attack:** A settlement tx is included in a block that is reorged out. The provider served the request assuming settlement was final.

**Mitigation:**
- Middleware indexer tracks confirmation depth (configurable, default 12 blocks on Ethereum, 1 on Arc Testnet).
- The provider's settler worker handles revert + retry with backoff.
- Vouchers are crash-safe (persisted in SQLite/Postgres) — a reorged tx is re-submitted.

**Residual risk:** Provider may over-serve during reorg depth. Mitigated by waiting for confirmations before serving high-value requests.

---

### T8 — Pause / Withdrawal Race

**Attack:** Owner pauses wallet, immediately unpauses, and withdraws — bypassing provider protection.

**Mitigation:** `pauseWithdrawDeadline` is set to `block.timestamp + settleWindow` on every `pause()` call. `unpause()` does NOT clear this deadline. Owner cannot withdraw until `pauseWithdrawDeadline` has passed, regardless of how many times they call `unpause()`.

---

### T9 — Fee Recipient Attack

**Attack:** Factory owner instantly changes `feeRecipient` to steal accumulated fees.

**Mitigation:** `feeRecipient` transfer uses 2-step acceptance. The new recipient must call `acceptFeeRecipient()`. An accidental transfer to a wrong address is recoverable by re-initiating a new transfer.

**Note:** Each wallet snapshots `feeRecipient` at creation time. The factory owner cannot retroactively redirect fees from deployed wallets.

---

### T10 — Signer Grace Window Truncation

**Attack:** Owner rotates signer twice quickly, truncating the first old signer's grace window.

**Mitigation:** `signerValidUntil` is a mapping per signer address. Each rotation sets `signerValidUntil[oldSigner] = block.timestamp + settleWindow`. A second rotation of a *different* signer does not affect the first old signer's `validUntil`. A rotation to the *same* signer address would overwrite its `validUntil` to `type(uint256).max` (new signer path).

---

## Known Accepted Tradeoffs

| # | Tradeoff | Rationale |
|---|---|---|
| 1 | agentSigner key is hot | Required for low-latency signing. Blast radius is bounded by budgets. |
| 2 | `block.timestamp` used for timelocks | Standard practice. Validators can skew by ~15s on Ethereum, less on Arc. Windows are in hours/days, so manipulation is not practical. |
| 3 | Provider trusts its off-chain nonce store | A crashed store can cause nonce gaps. The SDK uses atomic increment and per-provider mutexes. |
| 4 | No on-chain registry of providers | Registry-free by design. Providers are identified by address. |
