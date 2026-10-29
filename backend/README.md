# Sluice backend API

Bun HTTP server + Supabase PostgreSQL (PostgREST), with read-only viem RPC access.
No SQLite, private signing key, automatic on-chain transaction or fake chain data.
This is an initial API implementation, not completion of the Phase 3 receipt/dispute work order.

## Run locally

From the repository root:
```powershell
Copy-Item backend/.env.example backend/.env
# Edit backend/.env with your project's values.
bun run backend:dev
```

The API listens at http://127.0.0.1:3001, separate from the frontend preview on 3010.
Bun loads backend/.env because the workspace command runs in backend/.
`bun run backend:check` runs TypeScript and tests.
Use `bun run backend:start` without watch mode for a process manager.

## Set up Supabase

1. Use an existing or new Supabase project.
2. Apply [the migration](supabase/migrations/202610290001_backend.sql) through the Supabase SQL editor or your normal migration pipeline.
3. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in backend/.env. Use the server-only legacy service_role JWT key for the PostgREST authorization headers.
4. Configure RPC_URL for the expected chain and set AUTH_ORIGIN to the exact frontend origin (localhost and 127.0.0.1 are different).
5. Set optional registry/vault addresses only after verifying their deployments match the current contracts. Historical metadata is not selected automatically.

No Supabase credentials were available during implementation, so no remote project/schema was changed or live database connectivity verified. The migration was executed against embedded PostgreSQL in tests, including denied anon/authenticated access.

Every table has RLS enabled. All privileges and RPC execution are revoked from public, anon and authenticated. Only the backend service_role may use this storage. Browser clients call this API with a wallet session bearer token; those sessions are not Supabase Auth JWTs. Do not send the service-role key to a browser.

## Endpoints

| Method | Path | Authentication / parameters | Behavior |
| --- | --- | --- | --- |
| GET | /health | Public | Liveness and dependency status, ready or degraded; HTTP 200 even when degraded |
| POST | /auth/nonce | JSON address | Server-built EIP-4361 SIWE message, challenge id, 5 minute expiry |
| POST | /auth/verify | JSON id, signature | Verify exact stored message; atomically consume challenge; issue 1 hour bearer token |
| GET | /auth/me | Bearer | Session address |
| POST | /auth/logout | Bearer | Revoke this session |
| GET | /wallets | owner, limit, offset | Factory creation records, not ownership-transfer indexing |
| GET | /wallets/:address | Public | Current owner, signer, pause state, factory version, block |
| GET | /wallets/:address/budgets | provider; token required on V2/V3 | Current budget tuple [maxTotal, perCallCap], settled amount and nonce |
| GET | /wallets/:address/activity | Block window + pagination | Decoded wallet event logs |
| GET | /agents/:id | Public, integer id | Registry entry, URI and metadata hash; no arbitrary URL fetching |
| GET | /providers/:address | Public | Provider registry entry |
| GET | /reputation/:address | Public | Raw provider/agent counters; aggregate score is null |
| POST | /vouchers | Bearer of provider, signed voucher JSON | Validate V1/V2 domain, signer, chain state, budget and settlement simulation; persist authorization atomically |
| GET | /vouchers | Bearer | Only this provider's stored vouchers |
| GET | /settlements | wallet for V1/V2/V3 wallet Settled logs, otherwise configured vault | Block-window event results |
| GET | /settlements/:id | Public; vault settlement bytes32 id | Current vault settlement |
| GET | /disputes | Public, block window | DisputeOpened logs from configured vault |
| GET | /disputes/:id | Public; vault settlement bytes32 id | Settlement and dispute state |
| POST | /disputes/:id/evidence | Bearer of current wallet owner or provider; JSON content | Store UTF-8 evidence and return keccak256 hash; no transaction |
| GET | /disputes/:id/evidence | Same party access | Stored evidence, up to 100 entries |
| GET | /receipts/:id | Reserved | HTTP 501 until Phase 3 receipt implementation/checkpoint |

Amounts, nonces, block numbers and contract uint values are decimal strings in JSON. A signature or id is 0x-prefixed hex. Bodies are limited to 32 KiB; evidence content to 16 KiB. Metadata hashes and URIs are returned as recorded, not fetched or endorsed.

### Authentication example

```ts
const challenge = await fetch('http://127.0.0.1:3001/auth/nonce', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: walletAddress }),
}).then(r => r.json());

// Sign the exact returned message using the user's wallet.
const signature = await walletClient.signMessage({
  account: walletAddress,
  message: challenge.message,
});
const session = await fetch('http://127.0.0.1:3001/auth/verify', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: challenge.id, signature }),
}).then(r => r.json());

// Keep session.token private and send Authorization: Bearer <token>.
```

EOA signatures work without an RPC. Contract-wallet authentication uses viem's public-client verifier and requires RPC_URL. A login signature never signs a voucher or transfer.

### Voucher input

```json
{
  "wallet": "0x...",
  "provider": "0x...",
  "token": "0x...",
  "cumulativeAmount": "100000",
  "nonce": "1",
  "expiry": "1800000000",
  "signature": "0x..."
}
```

Use real addresses, a future expiry and a 65-byte EIP-712 signature. V1 infers its USDC token and signs AgentPay / version 1 with no token in the message. V2 signs AgentPayV2 / version 2 with token included. The API authenticates the provider, not the signing agent. A rotated signer may remain valid within its on-chain grace period.

The API rejects paused wallets and cumulative deltas above the on-chain per-call cap, and simulates settlement with minOut=0. Swap-sensitive providers must handle their own slippage and settlement transaction. Saved vouchers are not reservations, guaranteed payments, receipts or executed settlements. Revalidate before submitting a transaction. No background settler is included.

V3 intake returns 501 because receipt-root/dispute semantics are still behind the Phase 3 checkpoint. V3/registry/vault reads require explicit configuration; no V3 deployment is assumed current.

### Event windows and errors

Event endpoints default to the most recent 1000 blocks, excluding the latest two blocks. Supply fromBlock/toBlock decimal strings to walk history. Maximum range is 5000 blocks, at most 1000 matching logs before pagination, limit 1–100 and offset 0–100000. Responses include the actual block window and nextFromBlock; an empty window is not proof of no historical activity. There is no persistent event indexer or reorg reconciliation worker.

Errors use `{ "error": { "code": "...", "message": "..." } }`.
400 invalid inputs; 401 missing/invalid session or signature; 403 origin/party denial; 409 stale or un-settleable voucher; 413 oversized body/range; 429 throttling; 501 pending feature; 503 missing/unavailable dependency; 502 upstream RPC failures. RPC reverts may return 502 for missing registry entries. CORS permits exactly AUTH_ORIGIN, with no wildcard or cookie authentication.

The current limiter is process-local (120 requests/minute/IP; 20 auth requests/minute/IP). Do not trust client X-Forwarded-For values. Multi-instance deployments need shared gateway rate limits. Keep the service behind HTTPS, configure proxy/IP handling deliberately, manage env secrets, and run `select public.api_prune_expired();` daily through trusted database maintenance.

## ABI maintenance and tests

Checked-in read/event/settlement ABIs are derived from Foundry artifacts. Rebuild contracts, then run:
```
bun run backend/scripts/generate-abis.ts
```

Tests use real PostgreSQL semantics through PGlite for migrations, grants, nonce consumption and voucher-channel transactions, plus deterministic mock RPC responses for contract reads and V1/V2 EIP-712 validation. No real chain transactions are sent.

The files in examples/ remain historical SDK/middleware sketches; @sluice/sdk and @sluice/middleware still do not exist and are not included in the backend build.
