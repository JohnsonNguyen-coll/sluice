# Sluice — AgentPay

Payment infrastructure for AI agents on Arc: prefunded wallets, off-chain EIP-712 vouchers and batched on-chain settlement.

## Repository layout

```text
contract/
  src/              Solidity contracts (V1, V2, V3, registries, vault)
  test/             Unit, fuzz and invariant tests
  script/           Foundry deployment scripts
  scripts/          TypeScript deployment tooling and Foundry runner
  lib/              Vendored forge-std
  config/           Canonical generated chain facts
  deployments/      Recorded addresses and transaction hashes
  metadata/         Historical contract deployment metadata
  foundry.toml
frontend/
  src/              Next.js routes, app shell and web components
  public/           Logo variants, favicon and static assets
  scripts/          ABI fetching and web tooling
  tests/            Website route smoke tests
  docs/WEBSITE.md    Website implementation guide and route map
backend/
  src/              Reserved for backend implementation
  examples/         Existing agent/provider integration sketches
docs/               Shared architecture, decisions and protocol guides
```

Backend SDK/middleware packages and a runnable server are not present yet. See [backend/README.md](backend/README.md) for the current boundary. Historical deployment metadata is retained; reorganizing files does not deploy or upgrade contracts.

## Development

Requires Node >=20.9, Bun, and Foundry for Solidity work.

Install all workspaces from the repository root:

```sh
bun install
bun run dev
```

The existing root commands forward to the relevant workspace:

| Root command | Workspace / purpose |
| --- | --- |
| `bun run dev` | Frontend development server |
| `bun run build` / `bun run start` | Frontend production build/server |
| `bun run lint` / `bun run typecheck` | Frontend checks |
| `bun run test:routes` | Frontend route checks against a running production server |
| `bun run contracts:build` / `bun run contracts:test` | Foundry in contract/ |
| `bun run deploy:self` | Existing Circle deployment script in contract/ |
| `bun run compass:deploy` | Optional Compass deployment integration |
| `bun run fetch:abi` | ABI fetching into frontend/src/contracts |

You can also `cd frontend` or `cd contract` and run the workspace scripts directly. One root bun.lock and a hoisted dependency install are used.

## Configuration

- Frontend public configuration: [frontend/.env.example](frontend/.env.example). Copy to frontend/.env.local if needed.
- Contract deployment credentials: contract/.env (ignored), with [contract/.env.example](contract/.env.example) as a safe template. The existing local .env was moved here without printing its values.
- Future backend secrets belong in backend/.env.
- Contract addresses: [contract/deployments/arc-testnet.json](contract/deployments/arc-testnet.json).
- Foundry libraries: contract/lib and the pinned OpenZeppelin package in the root node_modules.

## Documentation

- [Website foundations and route map](frontend/docs/WEBSITE.md)
- [Contract workspace](contract/README.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Design decisions](docs/DECISIONS.md)
- [Integration guide](docs/INTEGRATION.md)
- [Runbook](docs/RUNBOOK.md)
- [Phase 3 checkpoint](docs/PHASE3_STATUS.md)

The contracts have not received a published independent professional audit. See the threat model and design decisions before using real funds.
