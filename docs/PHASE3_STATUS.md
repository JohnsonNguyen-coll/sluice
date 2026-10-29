# Phase 3 implementation status

Reviewed 2026-10-29. This is an implementation/deployment checkpoint, not an independent security audit. The user authorized completing the work after the earlier stop-and-review checkpoints.

## Implemented

- AgentRegistry supports metadata hashes/URIs, two-step identity ownership and authoritative V1/V2/V3 factory provenance. V1 fallback scans a bounded 32-factory set; spoofed/unrecorded wallets remain rejected.
- ProviderRegistry holds payout/window/arbiter terms. V3 vault snapshots payout/effective arbiter per settlement. Wallets from explicitly trusted V3 factories use the vault and record self-wallet settlements without per-wallet admin grants; dispute counters remain separately privileged.
- Middleware signs per-call EIP-712 receipts. SDK verifies request/response binding, records flags, enforces provider/token/price/trust policies and preserves pending authorization state. Request authorization is checked before cached responses.
- V3 settlement commits roots, payment token, gross delta and nonce intervals. Proved disputes verify provider signatures, Merkle inclusion, interval and proportional payout caps; missing-receipt claims remain explicitly unverified and bonded.
- Response/arbitration deadlines are exclusive, positive agent awards return bonds, and undisputed principal can release once without double payment.
- Private Supabase stores atomically accept provider channels and persist receipt/response/proof metadata. The Bun API has SIWE sessions, V1/V2/V3 intake, authenticated receipt/evidence reads and current/historical contract configuration.
- Dashboard reads real API/chain state, creates/funds/configures wallets, registers identities/providers, lists private receipts/settlement availability and exposes dispute/evidence/deadline actions with wallet simulation/confirmation.
- Source docs, integration examples, threat model, runbook and deployment manifests are updated. SDK/middleware are private local workspaces, not npm publications.

## Verification

- Solidity unit/fuzz: **274 passed**, zero failures, including new provenance/receipt/V1 compatibility regressions.
- Invariant selection: **17 passed**, zero failures, using 128 runs × 256 handler calls and fail-on-revert. This is 16 invariant properties plus one matching ordinary unit test; it is not the 256×500 configuration.
- Runtime-size build passes. V3 factory 20,064 bytes, vault 14,098, AgentRegistry 10,407, ReputationRegistry 6,300, all below 24,576 bytes.
- Local Anvil end-to-end includes 9 paid calls, multi-leaf receipts/proofs, cache replay protection, missing request-signature rejection, V1/V2 compatibility, every dispute outcome and a real Express raw-body adapter. Local time travel is not testnet completion.
- TypeScript/backend/SDK/middleware checks, production frontend build and 54-route smoke checks pass; final delivery details/logs are in PHASE3_DELIVERY.md.

## Real Arc Testnet release

Fresh V1/V2/V3 factories, AgentRegistry, ProviderRegistry, ReputationRegistry and DisputeVault were deployed. Runtime bytecode was compared with build artifacts with immutable slots normalized. Source/runtime hashes, constructor arguments, configuration transactions and old deployment history are in `contract/deployments/arc-testnet.json` and the dated release file. This is not explorer source verification or an external audit.

The real flow registered an agent/provider, created/funded a V3 wallet, served 5 paid calls with verified receipts persisted in Supabase, settled them, released a clean payment, accepted/refunded a dispute and completed an arbiter split. API smoke checks confirmed SIWE, authenticated receipt access, stored proofs, V3 reads and anonymous receipt denial.

Two scenarios are correctly pending real chain time: silent-provider refund at 2026-11-01 10:31:24 UTC and arbiter timeout at 2026-11-01 10:31:56 UTC. All opening/response/settlement hashes and readyAt timestamps are in `contract/deployments/phase3-testnet-e2e.json`. Resume the script after those times; no automatic future run has been scheduled.

## Operational limits

Provider clients must retain signed channel state and run one settlement worker per signer. Storage cannot atomically commit arbitrary external application side effects. Unfinished requests and confirmed-tx/DB failures require reconciliation. There is no persistent global event indexer; public activity uses bounded windows and private receipt lists are paginated. Global historical collusion/self-dealing filtering needs verified indexing. Provider-selected arbiters remain a trust assumption. Full production hardening, independent audit, explorer verification and npm publication are not claimed.

The historical pre-fix review remains at PHASE3_REVIEW_2026-10-29.md. Its R4/R5/R7 gaps were subsequently implemented in this release; use this status/delivery record for current behavior.
