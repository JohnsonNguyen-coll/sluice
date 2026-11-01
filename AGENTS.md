# Sluice AgentPay Core — Agent Notes

## Project

Sluice AgentPay Core: production payment layer for AI agents. Pay-per-call USDC via prefunded wallets + off-chain EIP-712 vouchers + batched on-chain settlement.

## Contracts

### Deployed Addresses

| Network | Version | Contract | Address |
|---|---|---|---|
| Arc Testnet | V1 | `AgentWalletFactory` | `0x3662ab96c961915df01e141b62a2b785d0495790` |
| Arc Testnet | V2 | `AgentWalletFactoryV2` | `0xf3432dba7143e9c027a2b9496b78fff9989c6448` |
| Arc Testnet | V3 | `AgentWalletFactoryV3` | `0x5d89f395e912283d9b8814cf288414544321443c` |
| Arc Testnet | V3 | `AgentRegistry` | `0x2cbd940026b423e0fbeb04bc4c827d21578ce699` |
| Arc Testnet | V3 | `ProviderRegistry` | `0x52568fe53bc59c2aac6295ec351f928d8abbce92` |
| Arc Testnet | V3 | `ReputationRegistry` | `0x88b9d58a32b279b959bbb1f7143a7f18aaf2da58` |
| Arc Testnet | V3 | `DisputeVault` | `0x3699e8425a44f03bfd63bd754795ea10a1349b1e` |

Full deployment record: `contract/deployments/arc-testnet.json`

### Contract Files

| File | Contract | Purpose |
|---|---|---|
| `contract/src/AgentWalletFactory.sol` | `AgentWalletFactory` | V1 CREATE2 factory, single USDC, fee governance |
| `contract/src/AgentWallet.sol` | `AgentWallet` | V1 per-agent USDC wallet, EIP-712 settlement |
| `contract/src/AgentWalletFactoryV2.sol` | `AgentWalletFactoryV2` | V2 factory, token allowlist, no hardcoded USDC |
| `contract/src/AgentWalletV2.sol` | `AgentWalletV2` | V2 wallet, multi-token, swap adapter, USD daily limits |
| `contract/src/ISwapAdapter.sol` | `ISwapAdapter` | Pluggable swap interface |
| `contract/script/Deploy.s.sol` | `DeployScript` | Foundry V1 deploy script |
| `contract/test/AgentWallet.t.sol` | Various | V1: 43 unit + fuzz + invariant tests |
| `contract/test/AgentWalletV2.*.t.sol` | Various | V2: 79 unit + fuzz + invariant tests (6 files) |
| `contract/test/mocks/MockERC20.sol` | `MockERC20` | Mintable ERC-20 for tests |
| `contract/test/mocks/MockSwapAdapter.sol` | `MockSwapAdapter` | Configurable rate swap adapter for tests |
| `contract/test/mocks/MockFeeOnTransferERC20.sol` | `MockFeeOnTransferERC20` | Fee-on-transfer ERC-20 for deposit rejection tests |

### Test Status

**V1: 43 tests pass** (regression confirmed with V2 in the same build)
**V2: 79 tests pass**

V2 test breakdown:
- `AgentWalletV2.Factory.t.sol`: 22 factory tests
- `AgentWalletV2.Wallet.t.sol`: 32 tests including 2 fuzz (decimals mixing, rounding ≤1 unit)
- `AgentWalletV2.Swap.t.sol`: 4 swap adapter tests (happy path, slippage revert, no adapter)
- `AgentWalletV2.Limits.t.sol`: 15 tests (daily USD limit, decrease timelock, pause cooldown, signer rotation)
- `AgentWalletV2.Invariant.t.sol`: 6 invariant properties (256 runs × 500 calls each):
  - `balanceOf(wallet, tokenA) >= encumbered[tokenA]`
  - `balanceOf(wallet, tokenB) >= encumbered[tokenB]`
  - `settled[provider][tokenA] <= budget.maxTotal`
  - `settled[provider][tokenB] <= budget.maxTotal`
  - nonces monotonic per (provider, tokenA) and (provider, tokenB)

### Key Design Decisions

- `feeBps` snapshotted at wallet creation — factory fee changes don't affect existing wallets
- `settleWindow` minimum 600s — protects in-flight vouchers on decreases, rotations, pauses
- `pauseWithdrawDeadline` survives `unpause()` — prevents pause/unpause cooldown bypass
- `signerValidUntil` mapping per address — multiple rotations each keep independent grace windows
- CREATE2 salt = `keccak256(owner, agentSigner, userSalt)` — fully deterministic, predictable addresses
- `encumberedBalance` running total — O(1) freeBalance without provider iteration

See `docs/DECISIONS.md` for full rationale.

## Docs

| File | Contents |
|---|---|
| `docs/ARCHITECTURE.md` | Mermaid sequence diagrams, component overview, security properties |
| `docs/THREAT_MODEL.md` | T1-T10 threat scenarios, mitigations, accepted tradeoffs |
| `docs/DECISIONS.md` | D1-D14 design decisions with alternatives and rationale |
| `docs/INTEGRATION.md` | Provider 10-min quickstart, agent 10-min quickstart, voucher format |
| `docs/RUNBOOK.md` | Incident procedures: compromised signer, pause, settler down, key rotation |

## Examples

| File | Purpose |
|---|---|
| `backend/examples/minimal-provider.ts` | Express provider with agentpay() middleware |
| `backend/examples/minimal-agent.ts` | Agent with AgentPayClient drop-in fetch |

## Env Vars (for deployment)

| Variable | Purpose |
|---|---|
| `USDC_ADDRESS` | USDC ERC-20 address on target chain |
| `FEE_RECIPIENT` | Initial protocol fee recipient address |
| `FEE_BPS` | Protocol fee in basis points (0–500) |

## Current phase (reviewed 2026-10-29)

The user explicitly authorized completing the remaining Phase 3 work after the
earlier registry/dispute checkpoints. Contracts, signed receipts, factory-provenance
onboarding, SDK/middleware, Supabase persistence and dashboard/API integration are implemented.
See `docs/PHASE3_STATUS.md` and `docs/PHASE3_DELIVERY.md` for actual validation and limitations.

SDK and middleware live in `backend/packages/sdk` and `backend/packages/middleware`.
They are private local workspaces, not published npm packages. The canonical manifest
now lists a fresh coordinated V1/V2/V3 release and retains historical factories.
Non-upgradeable deployed instances do not receive local fixes or migrate balances.

Real testnet paid calls, receipts, clean release, provider-accepted refund and arbiter
split are confirmed. Silence refund and arbiter timeout were also confirmed after
their real 3-day deadlines on 2026-11-01. The public transaction report is
`contract/deployments/phase3-testnet-e2e.json`.
Keep private keys/state in ignored .env/.tools files; never print or commit them.

## Workspace layout

Hosted APIs (2026-10-30): `docs/HOSTED_APIS.md` documents real text-analysis/JSON-validation services, encrypted provider custody, SIWE owner controls, automatic settlement, and explicit gas funding. Supabase migrations 004/005 are required. Do not clear persistent provider leases without reconciling transactions. Never expose the managed encryption key or signer ciphertext through public APIs.

Negotiation-first extension (2026-10-30): see `docs/NEGOTIATION_DELIVERY.md`.
Active V3 factory is `NegotiationWalletFactory`; active vault is `NegotiationDisputeVault`.
Canonical addresses are in the deployment manifest. New wallets require owner terms
consent and a registered provider with a nonzero hold. Negotiation lasts 30 minutes;
explicit escalation enables final arbitration before the fixed additional 24-hour deadline.
AI analysis is optional and non-binding, with explicit private-evidence export consent.
Historical wallets/disputes retain their original vault and deadlines. The current
approved arbiter is the protocol operator EOA; do not describe it as independent.

- `contract/`: Solidity in `src/`, Foundry tests/scripts/lib, deployment tooling, metadata and deployment records.
- `frontend/`: Next.js app, public assets, web config/tests and `docs/WEBSITE.md`.
- `backend/`: Bun API, private Supabase schema, SDK/middleware packages and integration examples.
- Run web commands from the repository root or `frontend/`; run Foundry directly from `contract/`.
- Canonical generated chain facts are in `contract/config/onchain-facts.ts`; the frontend keeps a re-export compatibility entry point.

Gateway onboarding (2026-10-31): `docs/API_GATEWAY.md` is the current Provider flow. Migration 006 stores encrypted upstream config. GET/POST JSON, public HTTPS IPv4 only; keys are server-side, test required before activation. Billing is per accepted attempt including upstream failures; never claim success-only charges or automatic refunds. Legacy utilities stay readable. Actual private-provider and new paid-gateway E2E are not yet validated.
