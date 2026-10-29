# Sluice AgentPay Core — Design Decisions

| # | Decision | Alternatives Considered | Rationale |
|---|---|---|---|
| D1 | **Non-upgradeable contracts** | Transparent proxy, UUPS | Upgradability introduces admin keys and proxy complexity. For a payment protocol the upgrade risk (malicious upgrade, key compromise) outweighs the convenience. Immutability is the safer default for a custody contract. |
| D2 | **feeBps snapshotted at wallet creation** | Apply current factory feeBps at settle time | Protects agents from unexpected fee increases. Agents can evaluate the fee when they create the wallet. Factory owner can change feeBps for future wallets only. |
| D3 | **settleWindow minimum 600 seconds (10 min)** | No minimum | 10 minutes gives providers a reasonable window to submit pending settlements after a budget decrease or signer rotation. Sub-10-minute windows could cause providers to lose valid vouchers on fast networks. |
| D4 | **Pause withdrawal cooldown survives unpause()** | Clear cooldown on unpause | The spec requires "paused wallets let owner withdraw only after settleWindow from pause time." If unpause cleared the deadline, owners could bypass the cooldown trivially. The cooldown now tracks the last pause event independently. |
| D5 | **Per-signer validity map (signerValidUntil)** | Single pendingAgentSigner + signerRotatedAt | A single variable truncates the first signer's grace window when a second rotation happens before it expires. The map gives each old signer an independent window. Cost: one extra mapping slot; no iteration needed at verification time. |
| D6 | **Domain separator recomputed on chain fork** | Always use cached value | A hardcoded domain separator breaks fork-safety. We cache for the common path (`block.chainid == _deployChainId`) and recompute on the rare case (chain fork/migration). This costs one extra SLOAD on a forked chain, which is negligible. |
| D7 | **2-step ownership transfer in factory** | Single-step (immediate) | Typos or compromised sessions could transfer ownership to an unusable address permanently. 2-step requires the recipient to actively accept, making accidental transfers recoverable. |
| D8 | **CREATE2 salt uses user-supplied bytes32** | Timestamp + msg.sender in salt | A timestamp-based salt is non-deterministic (multiple calls in same tx/block give different results, but callers cannot precompute addresses). A user-supplied salt enables `predictWalletAddress()` so agents can pre-fund the wallet address before deployment. |
| D9 | **encumberedBalance as a single running total** | Iterate over all providers per freeBalance call | Iteration is unbounded gas. A running total is O(1) per operation at the cost of careful accounting on every budget change. Invariant: `freeBalance() = usdc.balanceOf(address(this)) - encumberedBalance`. |
| D10 | **No multi-stablecoin support** | Accept any ERC-20 | Simplifies accounting, fee calculation, and auditing surface. Out of scope for Phase 1. USDC is the protocol currency. |
| D11 | **Voucher nonce is provider-scoped** | Global nonce across all providers | Provider-scoped nonces allow parallel settlement by different providers without coordination. Global nonces would serialize all settlements through one counter. |
| D12 | **settled[] tracks gross (includes fees)** | Track net payout only | The invariant `settled[p] <= budget.maxTotal` is most natural with gross amounts. Fees are accounted separately in `totalFeesPaid`. The conservation identity is: `usdc.balanceOf(wallet) = totalDeposited - totalWithdrawn - paid_out_net - totalFeesPaid`, where `paid_out_net = sum(settled[p]) - totalFeesPaid` when fee is computed as a share of delta. This is consistent and auditable. |
| D13 | **ReentrancyGuard on settle() and settleBatch()** | Check-Effects-Interactions only | Defense-in-depth. CEI is implemented (all state updates before transfers), but the guard adds a second layer for USDC tokens with exotic hooks. No interaction cost on Arc Testnet (USDC is canonical). |
| D14 | **relayer set by provider, not owner** | Owner sets relayer for provider | Providers control their own submission infrastructure. The owner should not be able to block a provider by removing its relayer. Providers can self-service. |

---

## V2 Decisions

### D15 — No oracle for daily USD limit
**Decision:** `usdRateE6` is set manually by the wallet owner, not read from a price oracle.
**Rationale:** Oracles add attack surface (manipulation, downtime), deployment complexity, and chain dependencies. For v2 the daily limit is a soft abuse-prevention mechanism, not a hard financial guarantee. A stale rate is acceptable because: (a) stablecoins do not move far from $1, (b) the owner can update the rate at any time, (c) if no rate is set, the daily limit is skipped for that token rather than failing closed.
**Accepted tradeoff:** An attacker with a compromised signer key and a stale rate could over-spend the USD-equivalent limit. Mitigated by: settleWindow for signer rotation, perCallCap, and absolute maxTotal budget ceiling.
**Future:** Replace with a TWAP oracle read in V3 once a trusted price feed is available on the target chain.

### D16 — Fee-on-transfer tokens rejected at deposit
**Decision:** `deposit()` compares `balanceOf` before and after the pull and reverts with `FeeOnTransferToken` if `received != amount`.
**Rationale:** The accounting invariant `balanceOf(wallet) >= encumbered` requires that every deposited unit is actually held. A fee-on-transfer token would silently under-fund the wallet, allowing over-settlement. Rejecting them at deposit is simpler and safer than tracking per-token net-received amounts.

### D17 — emergencyWithdraw only for de-listed tokens
**Decision:** `emergencyWithdraw` reverts if the token is still in the factory allowlist.
**Rationale:** Prevents the owner from bypassing encumbrance accounting while settlements are still possible. Once a token is de-listed, no new settlements can occur so the encumbered accounting for that token is frozen; emergency withdrawal of the raw balance is then safe.
**Risk:** If the factory owner is lost/compromised and cannot call `removeToken`, funds in allowed tokens are unrecoverable without governance intervention. Documented for operators.

### D18 — Swap adapter pulls tokenIn via safeTransfer + approve pattern
**Decision:** The wallet calls `safeIncreaseAllowance(swapAdapter, payout)` then calls `swapAdapter.swapExactIn(...)`. The adapter pulls tokenIn from the wallet via `transferFrom`.
**Rationale:** This is the standard "approve + pull" pattern. The alternative (wallet transfers to adapter first) would require the adapter to accept arbitrary token pushes, which is harder to audit. The allowance is set to exactly `payout` (not unlimited), minimising exposure if the adapter is compromised.
**Reentrancy:** The `nonReentrant` modifier on `settle` covers the adapter call.

### D19 — Protocol fee deducted before swap
**Decision:** `fee = delta * feeBps / 10_000` is paid to `feeRecipient` in the voucher token before the swap. Only `payout = delta - fee` is swapped.
**Rationale:** Avoids slippage risk on the protocol fee amount. The protocol always receives the exact fee in the agreed token. Providers receive the swap output of the net payout.

### D20 — Per-(provider, token) nonces, not global nonces
**Decision:** `nonces[provider][token]` is independent per token.
**Rationale:** A provider can serve an agent for multiple tokens simultaneously. Sharing a nonce across tokens would require the provider to coordinate nonce ordering across token streams, which is operationally complex and error-prone. Independent nonces per token are simpler and match the independent accounting model.

## Phase 3 registry decisions (2026-10-28)

### D21 — ERC-8004 identity alignment and authoritative wallet provenance

The [ERC-8004 draft](https://eips.ethereum.org/EIPS/eip-8004) defines ERC-721 identities and off-chain registration files. The [8004 team's deployment list](https://github.com/erc-8004/erc-8004-contracts#arc-testnet) lists Arc Testnet identity `0x8004A818BFB912233c491871b3d84c89A494BD9e` and reputation `0x8004B663056A597Dffe9eCcC1965A193B7388713`. These addresses are references from the upstream list, not independently verified deployment evidence for this project.

AgentPay keeps a non-upgradeable, payment-specific registry with ERC-721/URIStorage, `agentURI` and `setAgentURI`. It is partially aligned, **not a full ERC-8004 implementation or ABI-compatible substitute**: standard registration overloads, arbitrary metadata and verified receiving-wallet operations are not implemented. An integration with the canonical registry remains future work; use `(chainId, registryAddress, agentId)` as the identity key for migration.

Registration must verify both a trusted `wallet.factory()` and that factory's `isFactoryWallet(wallet)` deployment record. The wallet's factory claim alone is untrusted. Wallets without a factory getter cannot register here; V1 payment behavior is unchanged. Registration uses a reentrancy guard and commits the wallet link before the ERC-721 receiver callback. All NFT transfers synchronize the cached identity owner and cancel pending owner nominations. Identity NFT ownership does not transfer custody or ownership of the linked payment wallet.

Use `registerWithMetadataHash(wallet, hash)` and `updateMetadata(agentId, hash)` for content-hash-only identity records. The legacy URI entry point remains for existing clients; it must reference off-chain content, never embed personal data or inline JSON. Names, contact information, domains and evidence remain off-chain. Zero hash means no content commitment. URI and hash are independent references; clients must verify content against the hash when present.

### D22 — Separate address-keyed providers

ProviderRegistry stores payout address, metadata hash, preferred arbiter and dispute window. A provider's address is its protocol identifier and controlling account; it is not a transferable NFT. Maximum window is 7 days; 0 means instant payout. A window change requires an explicit apply transaction after the old window has elapsed. Domain verification stays off-chain through `/.well-known/agentpay.json`. This schema is an AgentPay extension, not the ERC-8004 registry ABI.

### D23 — Fee-weighted feedback and observable dispute lifecycle

Only explicitly trusted protocol callers write counters. Volume and fee weight are separate USD E6 values. V3 passes the actual rounded token fee converted with the wallet's configured USD rate. Fees cannot exceed gross volume. The legacy three-argument settlement hook records volume/history but contributes zero fee weight because it supplies no fee evidence. USD values retain V2's owner-configured rate limitation; they are not oracle-attested market values.

Feedback is authorized on-chain for the settled wallet or its current wallet owner, with score 1–5 and one active entry per pair. Weight is capped at 10,000 USD E6 of paid fees per pair, preserving the existing cap. Same-owner wallet/provider pairs get zero weight, including contract providers exposing `owner()`. Once observed during settlement/feedback, this flag remains set so ownership rotation cannot erase self-dealing history. `getFeedback` also rechecks current ownership; indexers must use it rather than relying solely on the raw public storage getter or a cached flag. Common beneficial ownership behind unrelated addresses cannot be established by this check.

Disputes-opened/received increment at opening; outcome hooks only change won/lost/auto-refund counters. Agent stats also expose auto-refunds. Outcomes outside 0–3 revert. Split counts as an agent partial win/provider partial loss. Arbiter timeout currently maps to agent win, distinct from the silent-provider auto-refund counter. All hooks require deployment-time trust configuration (including DisputeVault); these contracts cannot prove off-chain facts. Score computation and time decay belong in the SDK, not this registry.

### D24 — Settlement terms and exclusive dispute deadlines (2026-10-29)

The vault snapshots the provider payout address and effective arbiter (preferred or default) when receiving each settlement. Provider changes and two-step default-arbiter rotations affect future settlements only. A provider-selected arbiter remains a trust assumption; snapshots do not establish independence or agent acceptance of terms before settlement. Receipt/policy integration must still define that acceptance.

Provider responses require `timestamp < responseDeadline`. At the exact deadline, silence refunds become available and a late response cannot preempt them. Arbitration requires a timely provider response and `timestamp < arbiterDeadline`; at that deadline only the timeout refund path remains available to resolve arbitration. Provider concession remains available because it refunds the full disputed amount.

### D25 — Release undisputed principal without double payment (2026-10-29)

Anyone may call `releaseUndisputed` on an unresolved disputed settlement once its original `releaseAfter` has elapsed. Only `amount - disputedAmount` is released to the snapshotted payout address; disputed principal and its bond remain in the vault. `undisputedReleased` records the amount already paid, and every resolution path subtracts it. The original amount stays unchanged for historical accounting. The partial release emits `UndisputedReleased` and does not mark the dispute resolved or the settlement terminal.

Refunds continue transferring tokens to the wallet before a best-effort `receiveRefund` notification, including paused wallets and delisted tokens. These source/ABI changes require a fresh non-upgradeable vault deployment; historical instances and their ABI must remain versioned separately.
