# Sluice

**AgentPay Core** — a production payment layer for AI agents.

Pay-per-call USDC via prefunded agent wallets, off-chain EIP-712 payment vouchers, and batched on-chain settlement. No on-chain transaction per API call.

Built with [Arc Studio](https://studio.arc.io)

---

## What It Does

Sluice lets AI agents pay for API calls automatically. Providers add one middleware line. Agents use a drop-in `fetch` wrapper. Settlement happens off-chain (vouchers) with periodic batched on-chain settlement — no gas per request.

- **Agents** prefund a wallet, set per-provider budgets, and sign vouchers with a hot key.
- **Providers** verify vouchers off-chain, serve requests, and settle in batches.
- **No registry, no marketplace** — any provider can add middleware, any agent can use the SDK.

## Tech Stack

- **Contracts:** Solidity ^0.8.24, Foundry, OpenZeppelin 5.x
- **Chain:** EVM-compatible (Arc Testnet default; any EVM chain via config)
- **Token:** USDC (6 decimals) — address configured at factory deploy time
- **Signatures:** EIP-712 typed data with chain-aware domain separator
- **Frontend:** React 18, Vite, TypeScript, Tailwind CSS, wagmi v2, ConnectKit

## Repository Layout

```
contracts/                  Solidity contracts + tests + deploy scripts
  AgentWallet.sol           Per-agent USDC wallet with budget enforcement
  AgentWalletFactory.sol    CREATE2 factory and fee governance
  test/AgentWallet.t.sol    43 tests: unit, fuzz, invariant
  script/Deploy.s.sol       Foundry broadcast deploy script
docs/
  ARCHITECTURE.md           Mermaid diagrams, component overview
  THREAT_MODEL.md           T1-T10 threat analysis
  DECISIONS.md              D1-D14 design decisions with rationale
  INTEGRATION.md            Provider 10-min + agent 10-min quickstarts
  RUNBOOK.md                Incident procedures
examples/
  minimal-provider.ts       Express API with agentpay() middleware
  minimal-agent.ts          Agent using AgentPayClient.fetch()
deployments/
  template.json             Deployment record template
src/                        Dashboard frontend (React)
```

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [Foundry](https://book.getfoundry.sh) (`forge`, `cast`)

### Install

```bash
bun install
```

### Run frontend

```bash
bun run dev
```

### Build contracts

```bash
bun run contracts:build   # forge build
```

### Test contracts

```bash
bun run contracts:test    # forge test
```

### Deploy contracts

```bash
export USDC_ADDRESS=0x...
export FEE_RECIPIENT=0x...
export FEE_BPS=50

forge script contracts/script/Deploy.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --verify
```

## Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `VITE_FACTORY_ADDRESS` | `AgentWalletFactory` address shown in dashboard — Arc Testnet: `0xdae395f504be412ddfc0646b37ac1840a1462c08` | Dashboard |
| `VITE_CHAIN_ID` | Override chain ID (default: `5042002` Arc Testnet) | Optional |
| `USDC_ADDRESS` | USDC ERC-20 address on target chain | Deploy only |
| `FEE_RECIPIENT` | Protocol fee recipient address | Deploy only |
| `FEE_BPS` | Fee in basis points (0–500, e.g. 50 = 0.5%) | Deploy only |
| `RPC_PROXY_BASE_URL` | Proxied RPC base URL (provided by Arc Studio) | Optional outside Arc Studio |
| `RPC_PROXY_TOKEN` | RPC proxy auth token | Optional outside Arc Studio |

## Security

This code has not yet received a professional third-party audit. Review `docs/THREAT_MODEL.md` and `docs/DECISIONS.md` before deploying to mainnet with real funds.

Key properties:
- Non-upgradeable, no admin backdoors
- Fee changes apply to new wallets only (existing wallets snapshot at creation)
- Budget decreases, signer rotations, and pause withdrawals all use a configurable safety window
- Full CEI pattern + ReentrancyGuard on settlement paths
- Per-signer validity windows survive multiple rotations independently
