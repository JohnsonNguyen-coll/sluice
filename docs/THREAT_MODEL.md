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

## Phase 3 additions (2026-10-29)

- **Forged wallets / unauthorized metrics:** trusted-factory provenance checks verify the factory's deployment record. Automatic reputation callers are limited to self-wallet settlements; vault outcomes still require an explicit trusted caller. An admin trusting a malicious factory/caller remains a privileged compromise.
- **Changing dispute terms:** payout and effective arbiter are captured at settlement. Later provider/default-arbiter changes do not rewrite pending cases. A provider-selected arbiter still requires trust; independent arbitration and signed acceptance before settlement are not established by a snapshot.
- **Deadline front-running:** response/decision are valid strictly before their deadlines; silence/timeout refunds become valid at the exact timestamp. Provider concession can still refund the whole disputed part. Validators' timestamp behavior remains a timing assumption.
- **Forged/borrowed receipts:** typed provider signatures bind chain, wallet, payment token, voucher hash, request/response hashes, status, nonce, price and time. Sorted Merkle proofs and stored nonce intervals prevent a proved receipt from being reused for another settlement interval. Proportional caps prevent a small receipt from claiming the whole payout. A provider root alone does not prove service quality; absent receipts use a bonded unverified claim path.
- **Replay and private responses:** modern clients sign an additional request authorization. Middleware verifies it before returning cached results. A publicly settled voucher is insufficient to retrieve cached V3 data. Application authentication must precede payment middleware; payment does not replace application authorization. Legacy wire clients without request signatures cannot retrieve cached responses.
- **Double release / cross-settlement theft:** undisputedReleased is deducted from every resolution path; state transitions and nonReentrant protect payout/refund/bond transfers. Fuzz/invariant tests cover partial release, all outcomes and isolated liabilities. Fee-on-transfer or rebasing tokens remain unsupported; the factory token allowlist is a trust boundary.
- **Spam/griefing:** owner-only opening, one dispute per settlement, configurable per-token bond and fixed deadlines bound resource locking. The undisputed remainder can release after the original hold. Bond economics must match provider prices; a zero bond removes the economic spam deterrent. Any positive agent award returns the bond.
- **Arbiter failure/bias:** timeout refunds the disputed part; the arbiter can divide only that part. An initially biased arbiter is not made independent by technical controls. Default arbiter and admin keys should be secured; testnet keys are not a production governance design.
- **Wash trading / sybils:** counters are objective protocol observations, not independent-customer attestations. Detectable same-owner feedback has zero fee weight; pair fees are capped. SDK per-wallet profiling excludes directly detected same-owner counterparties. Global historical pair exclusion requires indexing; distinct EOAs and owner-set USD rates do not establish economic independence or market values. Formula confidence and optional verified recency must not be marketed as credit guarantees.
- **Evidence privacy:** raw bodies/evidence stay off-chain in private storage or local client stores. API evidence is limited to the current wallet owner, provider and settlement-time arbiter; receipt bodies are never returned by receipt APIs. Metadata URIs are not fetched by the backend. Frontend sessions are memory-only and revoked on account/network disconnect; service-role keys never enter public bundles.
- **Provider/DB outage:** durable atomic acceptance prevents executing a duplicate after a normal retry, but cannot atomically commit arbitrary external application side effects with SQL. Unfinished accepted calls require operator investigation. A confirmed transaction followed by a DB failure needs reconciliation rather than blind rebroadcast. One settlement worker per signer is an operational requirement.
- **Pause and unsettled exposure:** owner emergency pause can stop settlement. Grace periods/caps bound exposure but do not guarantee payment to a provider holding an off-chain signature. Provider middleware must stop accepting when paused/unhealthy and settle within its risk limits. A compromised hot signer remains limited by on-chain budgets, daily settlement limits, signer validity and pause controls.

No independent security audit is claimed. Current testnet deployments and timed scenario status are recorded separately from local test results.

## Known accepted tradeoffs

| # | Tradeoff | Rationale |
|---|---|---|
| 1 | agentSigner key is hot | Required for low-latency signing. Blast radius is bounded by budgets. |
| 2 | `block.timestamp` used for timelocks | Standard practice. Validators can skew by ~15s on Ethereum, less on Arc. Windows are in hours/days, so manipulation is not practical. |
| 3 | Durable off-chain authorization state | CAS/SQL channel locks prevent normal races; crash recovery still requires retained history and external-side-effect reconciliation. |
| 4 | Scores are estimates | Registry counters are verifiable observations; full pair-level indexing and off-chain scoring are needed for broader trust decisions. |
