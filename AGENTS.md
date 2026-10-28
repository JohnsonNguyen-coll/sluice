# Sluice AgentPay Core — Agent Notes

## Project

Sluice AgentPay Core: production payment layer for AI agents. Pay-per-call USDC via prefunded wallets + off-chain EIP-712 vouchers + batched on-chain settlement.

## Contracts

### Deployed Addresses

| Network | Version | Contract | Address |
|---|---|---|---|
| Arc Testnet | V1 | `AgentWalletFactory` | `0xdae395f504be412ddfc0646b37ac1840a1462c08` |
| Arc Testnet | V2 | `AgentWalletFactoryV2` | `0x92f357b256f5fb6a0f7e635a29462601c1cb6547` |

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

## Current phase (reviewed 2026-10-28)

Phase 3 contract work is in progress: AgentRegistry, ProviderRegistry,
ReputationRegistry, DisputeVault, AgentWalletV3 and AgentWalletFactoryV3 exist.
See `docs/PHASE3_STATUS.md` for the verified checkpoint and remaining work;
do not infer completion from existing contract files or historical test counts.

The SDK (`packages/sdk`) and middleware (`packages/middleware`) directories are
absent in this checkout. Receipts and end-to-end integrations still require work.
Earlier V3 deployment records exist in `contract/metadata`, while
`contract/deployments/arc-testnet.json` currently lists only V1/V2. Non-upgradeable deployed
instances do not receive local source fixes; new deployments are required.

The supplied Phase 3 work order requires stopping to show results after the
registry/test checkpoint, before proceeding to receipts.

## Workspace layout

- `contract/`: Solidity in `src/`, Foundry tests/scripts/lib, deployment tooling, metadata and deployment records.
- `frontend/`: Next.js app, public assets, web config/tests and `docs/WEBSITE.md`.
- `backend/`: reserved backend source plus the original integration examples; no runnable server yet.
- Run web commands from the repository root or `frontend/`; run Foundry directly from `contract/`.
- Canonical generated chain facts are in `contract/config/onchain-facts.ts`; the frontend keeps a re-export compatibility entry point.
