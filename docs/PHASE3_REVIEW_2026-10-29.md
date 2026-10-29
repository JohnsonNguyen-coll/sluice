# Phase 3 review and coordinated testnet redeployment

Current delivery supersedes the historical review below: see [PHASE3_DELIVERY.md](PHASE3_DELIVERY.md). R4/R5/R7 were subsequently implemented with factory-provenance authorization, individually signed/bounded receipt claims and V1 factory-record fallback, and the coordinated suite was deployed. Roots remain provider commitments; Merkle membership alone is intentionally not receipt authentication. Two real deadline scenarios are still pending their on-chain times.

Reviewed 2026-10-29. This is a source review with executable reproductions and local tests, not a full security audit. No deployment transactions were sent and no production Solidity source was changed.

## Follow-up: dispute fixes implemented locally

The review below describes the pre-fix checkpoint. A subsequent authorized change on the same day updates `DisputeVault` and its backend ABI:

- R1: arbiter is snapshotted on settlement, including the effective default; provider responses are required before arbitration, and arbitration stops at its deadline.
- R2: provider responses at/after the response deadline revert, preserving the silence-refund path.
- R3: payout destination is snapshotted on settlement and used by every payout/resolution path.
- R6: `releaseUndisputed` pays the remainder after the original hold expires. Resolution subtracts `undisputedReleased` to prevent double payment; disputed principal and bond remain held.

Four original reproductions in `Phase3ReviewTest` now assert fixed behavior. The two receipt and onboarding reproductions still demonstrate pending work (R4/R5); V1 identity compatibility (R7) remains unchanged. A provider-selected arbiter still requires trust; this change does not implement signed acceptance of terms before settlement. Fresh deployments are required; no existing vault was upgraded and no transaction was broadcast.

Additional tests cover the last allowed timestamp and exact deadline, provider/default-arbiter changes, future settlement terms, one-time partial releases, every resolution path, bond conservation, and isolation between settlements. `DisputeLifecycleInvariantTest` adds stateful settlement/dispute/response/release/resolution/configuration sequences with independent locked-funds accounting, whole-system token conservation and immutable-term checks. Commands/logs for this follow-up use `.tools/dispute-fix-unit.log`, `.tools/dispute-fix-invariant.log` and `.tools/dispute-fix-sizes.log`.

Follow-up validation: **265 unit/fuzz tests passed** (including the two intentionally pending receipt/onboarding reproductions), **17 invariant-selected tests passed** (16 properties at 64 runs × 128 calls, plus one ordinary matching unit test), and **20 backend tests passed** with TypeScript checks after ABI regeneration. Invariants ran with `FOUNDRY_INVARIANT_FAIL_ON_REVERT=true`; handler tables report zero reverts. This is bounded invariant validation, not the full 256×500 run. Runtime build sizes passed; the updated vault is 10,158 bytes, below 24,576 bytes. No deployment was performed.

## Decision

Do not deploy the current V3 as a completed payment/dispute protocol. Finish the findings below and the receipt/integration checkpoint first. Redeploying V1, V2 and V3 together is a reasonable release-management choice; it does not merge their features or migrate existing wallets. Keep old deployment records and supported historical factories.

## Findings

### R1 — High: provider can replace the arbiter for an existing dispute

`DisputeVault.arbiterDecide` calls `_arbiterFor(s.provider)`, which reads the provider's current `preferredArbiter`. `ProviderRegistry.updateArbiter` applies immediately. After the agent opens a dispute, the provider can choose an address it controls and have that address release the disputed amount to the provider. The arbiter can also decide before a provider response; the code has no response/deadline guard despite the comments describing an escalation flow.

Reproduction: `test_Review_ProviderCanReplaceArbiterOfExistingDispute` changes the arbiter after the agent opens a dispute, then resolves in the provider's favor without a provider response.

Before deployment: define how the agent accepts the arbitration terms, snapshot the accepted arbiter for each settlement, and enforce the intended response/escalation deadlines. A provider-selected arbiter is itself a trust assumption; snapshotting alone does not make it independent.

### R2 — High: late provider response defeats the silence refund deadline

`respondToDispute` does not check `responseDeadline`. After that deadline passes, a provider may respond before an agent's `autoRefund` transaction executes. `autoRefund` then rejects with `ProviderAlreadyResponded`, delaying recovery into the arbiter path.

Reproduction: `test_Review_ProviderRespondsAfterDeadlineAndBlocksAutoRefund`.

Before deployment: reject responses at/after the agreed deadline, make the refund and response boundary unambiguous, and test ordering at the exact timestamp.

### R3 — Medium: existing held payouts follow mutable provider configuration

`release` and dispute outcomes fetch the current `payoutAddressOf`. `updatePayoutAddress` says it affects only future settlements, but an already-held settlement follows the replacement address too. This is a behavior/documentation mismatch and increases the effect of a provider-key compromise on pending payouts.

Reproduction: `test_Review_PayoutChangeRedirectsAlreadyHeldSettlement`.

Before deployment: snapshot payout destinations if the intended promise is future-only updates; verify all release/refund/split paths use the same rule.

### R4 — Integration blocker: new factory wallets need manual privileged onboarding

`AgentWalletFactoryV3.createWallet` records the wallet in the factory but does not make it a trusted wallet in the vault or trusted caller in reputation. Tests grant both permissions manually. A normal freshly created wallet cannot settle a provider payment with a dispute window: `receiveSettlement` reverts with `NotTrustedWallet`. Instant payouts can succeed while reputation writes silently fail because they are best-effort.

Reproduction: `test_Review_NewFactoryWalletCannotSettleToVaultWithoutAdminOnboarding` verifies both missing permissions and the settlement revert.

Before deployment: choose and test a safe factory-verification/registration flow, including the first user-created wallet after deployment. Do not solve this by granting arbitrary addresses authority to write vault liabilities or reputation.

### R5 — Receipt implementation blocker: a stored root is not an authenticated receipt

The V3 voucher struct/type hash does not include the separately supplied `receiptsRoot`. The settler can supply an arbitrary root. `verifyReceiptProof` only checks membership against that root; it does not verify a provider signature, bind the receipt to a priced request/response, or constrain a dispute to proved calls. `openDispute` accepts an amount and evidence hash without a receipt proof. Backend `/receipts` and V3 voucher intake remain intentionally unavailable, and real SDK/middleware packages are absent.

Reproduction: `test_Review_RootIsNotBoundToAgentVoucherSignature` supplies an invented single-leaf root; an empty proof succeeds. This demonstrates the limited guarantee of the current API, not that a complete signed-receipt design exists.

Before deployment: specify receipt identity, signatures, signed settlement commitments, domain separation, amount/token/nonce binding, storage, proof rules, duplicate claims, and the no-receipt claim path. Then implement and test the full flow. This review does not begin that work.

### R6 — Medium/spec decision: a partial dispute locks the whole settlement

Opening a dispute changes the entire settlement to `DISPUTED`. There is no independent release path for its undisputed remainder while the dispute is unresolved. The remainder is paid only when the dispute finishes; `release` rejects in the meantime.

Reproduction: `test_Review_UndisputedRemainderCannotReleaseWhileDisputeOpen`.

Before deployment: decide whether the provider should receive undisputed funds promptly. If so, implement explicit accounting and test conservation across partial releases and later resolution.

### R7 — Compatibility limitation: redeploying unchanged V1 does not add registry identity

`AgentRegistry._isFromTrustedFactory` requires the wallet's `factory()` lookup and verifies the factory's `isFactoryWallet` record. V1 wallets have no `factory()` getter and are explicitly rejected by this path. Redeploying the existing V1 source preserves that limitation. Choose whether V1 remains payment-only or add a separately reviewed compatibility path without weakening factory provenance checks.

## Validation

- Existing unit/fuzz suite: **248 passed, 0 failed**, using `forge test --offline --threads 2 --no-match-test 'invariant_' --summary` before adding the review reproductions. Fuzz tests use 256 runs.
- Six additional review reproductions: **6 passed, 0 failed**, using `forge test --offline --threads 2 --match-contract Phase3ReviewTest -vv`. A passing reproduction confirms the current problematic/limited behavior; it is not a successful fix.
- Invariant selection: **14 passed, 0 failed**, using `FOUNDRY_INVARIANT_RUNS=64 FOUNDRY_INVARIANT_DEPTH=128` and `forge test --offline --threads 2 --match-test 'invariant_' --summary`. This includes 13 invariant properties and one ordinary unit test matching the name filter. Each invariant ran 8,192 handler calls. This was not the full 256×500 configuration.
- Vault invariant handler exercised 4,064 settlements and 4,128 releases, zero reverts. It does not exercise dispute opening/resolution and does not prove the safety of those paths.
- `forge build --offline --sizes`: passed. V1/V2/V3 factory runtime sizes: 11,759 / 16,560 / 19,580 bytes; all below 24,576 bytes. Existing compiler/linter warnings remain.
- Local logs: `.tools/phase3-review-unit.log`, `.tools/phase3-review-invariant.log`, `.tools/phase3-review-reproductions.log`, `.tools/phase3-review-sizes.log`.

## Read-only Arc Testnet checks

RPC reads confirmed code exists at the canonical deployed V1/V2 factory addresses:

| Field | V1 | V2 |
| --- | --- | --- |
| Factory | `0xdae395f504be412ddfc0646b37ac1840a1462c08` | `0x92f357b256f5fb6a0f7e635a29462601c1cb6547` |
| Observed runtime bytes | 11,759 | 16,467 |
| Current local artifact runtime bytes | 11,759 | 16,560 |
| Fee | 30 bps (0.3%) | 30 bps (0.3%) |
| Owner | `0xa3039A54856ed74B5AEc999EeF3fc954Ab010Cf6` | same |
| Fee recipient | `0x5B12Ce46C7194aD57d143bC22847224047b1Ef42` | same |
| USDC | `0x3600000000000000000000000000000000000000` | same token is allowed |

V2 deployed bytecode length differs from the current build. This requires source/compiler/settings reconciliation; it does not by itself identify a bug. Matching V1 length does not prove source equivalence either. No claim of complete bytecode verification or of a deployment matching current sources is made. Historical V3/registry metadata was not promoted to the canonical deployment manifest.

## Coordinated redeployment plan

1. Resolve and test the V3 findings; complete the receipt/integration checkpoint before presenting the release as Phase 3 complete.
2. Freeze source revision, Solidity 0.8.28, dependency versions, optimizer/EVM settings, constructor arguments, owner/admin/arbiter roles, and a uniform fee. Current on-chain fees are 30 bps; the overview's default 1% would be 100 bps. Do not silently change that choice.
3. Deploy new V1 and V2 factories with the chosen fee recipient and USDC allowlist. Deploy ProviderRegistry and ReputationRegistry, then DisputeVault, then V3 factory with its immutable registry/vault addresses. Deploy AgentRegistry with the intended new trusted factories, accounting for V1 compatibility above. This is a dependency order, not an existing atomic all-contract deployment script.
4. Wire vault reputation permission, secure wallet onboarding, supported tokens and dispute bonds. Transfer administrative ownership through the appropriate two-step accept calls if needed. Verify each role after configuration.
5. Verify deployed bytecode/constructor arguments and record addresses, transaction hashes, deployment blocks, source commit/build settings and permissions in a versioned release manifest. Preserve old manifests and metadata.
6. Switch new-wallet creation to the new release while retaining read/settlement support for old wallets and in-flight vouchers. The backend currently configures only one factory per version; preserving old wallets needs an explicit factory-list/migration policy before replacing those addresses. Old wallet signatures remain bound to the old wallet address/domain; do not reuse them for a new wallet.
7. Update backend configuration/ABI, frontend wallet creation and contract links together. Test deposits, policy limits, V1/V2 settlement and V3 instant payout, delayed release, accepted dispute, silence refund and arbitrated split. Record transaction hashes and token conservation; health checks alone do not validate these flows.

No funds, budgets, nonces, identities or token approvals move automatically to new contracts. Treat active old balances and outstanding vouchers as a migration/runbook concern rather than deleting the old addresses.
