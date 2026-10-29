# Sluice integration guide

SDK and middleware are private TypeScript workspaces under `backend/packages/`. Run `bun install` at the repository root. They are not published on npm; do not use the historical npm-install instructions. This guide describes the implemented API, not an independent security audit.

## Run the application

1. Copy `backend/.env.example` to `backend/.env`, fill Supabase URL and server-only legacy service-role key, and apply both SQL files in `backend/supabase/migrations/` in order.
2. Run `bun run backend:dev` (port 3001), then `bun run dev --port 3010`. Set AUTH_ORIGIN to the exact frontend origin and NEXT_PUBLIC_API_URL if the backend runs elsewhere.
3. Read `/config` for active contract addresses and current/historical factories. `/health` checks RPC plus both private storage schemas; it does not prove payment correctness.
4. In the dashboard, connect a browser wallet on Arc Testnet. Create an agent wallet using a separate agent signing address, deposit USDC and set a provider budget. Only the owner signs these transactions.

## Provider

Create a server-only provider account and wallet client, use the shared public RPC failover transport, and instantiate a durable `SupabaseProviderStore`. See the runnable `backend/examples/minimal-provider.ts`.

```ts
import { PaymentProvider, SupabaseProviderStore } from '@sluice/middleware';

const payments = new PaymentProvider({
  provider: providerAccount.address,
  token: usdc,
  chainId: 5042002,
  price: 10_000n, // 0.01 USDC, six decimals
  signer: providerAccount,
  publicClient,
  walletClient: providerWalletClient,
  factories, // from your trusted deployment manifest, not a caller-supplied address
  store: new SupabaseProviderStore(supabaseUrl, serviceRoleKey),
  vault: disputeVault,
});

Bun.serve({ hostname: '127.0.0.1', port: 3002,
  fetch: payments.wrap(() => Response.json({ answer: 42 })) });
const stopSettler = payments.startSettler(60_000, console.error);
const stopDisputes = payments.watchDisputes(console.error);
```

Register the provider on-chain before advertising a nonzero dispute window. `ProviderRegistry.register(payout, metadataHash, disputeWindow, preferredArbiter)` is available in the dashboard. A zero window means immediate payout without vault refunds. A change requires request/apply after the old window; changing payout/arbiter affects future settlements only. Configure `onDispute` to return `{action:'respond', evidenceHash}` or `{action:'accept'}`, and optionally `autoAcceptBelow` in settlement-token base units. Callbacks run in your server; the protocol does not send external messages automatically.

For Express, use `agentpay(options)` and capture exact request bytes:

```ts
app.use(express.json({ verify(req, _res, bytes) { req.rawBody = bytes; } }));
const payment = agentpay(options);
app.post('/answer', payment, (req, res) => {
  res.json({ answer: 42, paid: String(req.agentpay.paid) });
});
payment.controller.startSettler();
```

Authentication/authorization must run before payment middleware when your application requires it. Payment is not application authentication. Express responses are buffered (maximum 1 MiB); streaming, SSE and compressed request bodies are not supported by this adapter. Request bodies are limited to 32 KiB. The native Fetch adapter has the same receipt/body limits.

The provider accepts a new cumulative authorization only when its nonce advances and its amount advances the durable channel head by exactly the configured call price. The Supabase RPC locks the channel row. Duplicate requests return the persisted response/receipt without invoking application code again. An accepted but unfinished request returns 425; do not rerun business side effects automatically after a crash. Settlement is a provider transaction, not a reservation or guarantee at intake time.

## Agent

An active agent needs its hot signer, an existing wallet and a durable state store. It does not need the owner key for API calls. Owner management helpers use an optional owner wallet client; never expose that client/key to an untrusted agent runtime.

```ts
import { AgentPayClient } from '@sluice/sdk';
import { FileAgentStore } from '@sluice/sdk/file-store';

const agent = new AgentPayClient({
  wallet, chainId: 5042002, publicClient, agent: agentAccount, factories,
  providerRegistry, reputationRegistry, vault: disputeVault,
  store: new FileAgentStore('.tools/my-agent.agentpay-state.json'),
  policy: {
    allowedProviders: [providerAddress], allowedTokens: [usdc],
    maxPerCall: 10_000n, requireRegisteredProvider: true,
    maxDisputeWindow: 3600,
  },
});
const response = await agent.fetch('https://provider.example/answer', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ query: 'hello' }),
});
```

`IndexedDBAgentStore` supports browser persistence and transactional channel compare-and-swap. `FileAgentStore` uses atomic replacement and a bounded filesystem lock for Node/Bun. `MemoryAgentStore` is for tests or short-lived experiments: do not reset signed authorization history in a live agent. Multiple independent stores/signers for one channel can conflict. The SDK serializes each channel and persists reservations before transmitting signatures.

Non-2xx responses and optional `validateResponse` schema failures are flagged in the local call store. `flagCall(voucherHash, reason)` adds another dispute candidate. A missing/invalid receipt or network failure keeps the authorization pending; retry the identical request. `reconcile(provider, token)` clears that pending state only when chain state confirms it was settled. It does not silently cancel a signature or promise a refund.

## Exact wire formats

402 JSON contains `{chainId, provider, token, price, version}`. The client sends `X-AgentPay-Version` and a base64url JSON `X-AgentPay-Voucher` containing `{version,wallet,provider,token,cumulativeAmount,nonce,expiry,signature,requestHash,requestSignature}`. Integers are decimal strings. A five-minute expiry is used by the SDK; on-chain checks remain authoritative.

| Wallet | EIP-712 name/version | Voucher fields |
| --- | --- | --- |
| V1 | AgentPay / 1 | wallet, provider, cumulativeAmount, nonce, expiry |
| V2 | AgentPayV2 / 2 | V1 fields plus token before cumulativeAmount |
| V3 | AgentPay / 1 | same field schema as V2; a different wallet/factory/domain instance |

The V3 name/version follows the existing source; it is not `AgentPayV3`. All domains include chainId and the payment wallet as verifyingContract. SDK detection verifies a trusted factory's deployment record rather than trusting a claimed version.

Request authorization uses EIP-712 `AgentPayCall / 1` and `{voucherHash,requestHash}`. `requestHash = keccak256(abi.encode(uppercaseMethod, pathnameAndQuery, keccak256(exactBodyBytes)))`. Headers and origin are not included; configure application authentication and provider/domain policies separately. The current SDK signs this authorization for all versions. V3 requires it; legacy clients without it cannot retrieve cached responses. This extra signature is not published in the on-chain settlement voucher.

## Receipts and Merkle trees

V3 responses carry base64url JSON `X-AgentPay-Receipt` with `{wallet,provider,chainId,receipt,signature}`. `receipt` is:

```
Receipt(bytes32 voucherHash,bytes32 requestHash,bytes32 responseHash,
        uint16 status,uint64 timestamp,address token,uint256 nonce,uint256 amount)
```

The EIP-712 domain is `AgentPayReceipt / 1`, chainId, and the payment wallet. The provider signs the digest. Response hash is Keccak-256 of the exact buffered response bytes; amount is that call's gross price in payment-token base units. The SDK verifies every field, signer, chain, wallet, nonce, price and response hash. Middleware receipt signers are provider EOAs; the on-chain claim verifier additionally supports ERC-1271 provider signatures.

Leaf = `keccak256(receiptTypedDataDigest)`. Nodes hash concatenated bytes32 siblings in numeric order; an odd last node is promoted. An empty tree has root zero. Provider settlement stores the root, nonce interval, payment token and gross delta. Receipt data/signatures remain off-chain until a proved dispute is submitted. Roots are provider commitments, not agent signatures or independent proof of result quality.

After confirmed settlement, each persisted receipt gets `{root,proof,settlementId,settlementNonce,transactionHash}`. `GET /receipts` and `/receipts/:voucherHash` require an owner/provider wallet session, return signatures and commitment metadata, and never return cached API response bodies. Contracts verify proofs and claim eligibility; a database row alone proves neither.

## Disputes

Owner helpers: `registerAgent(metadataHash)`, `openDispute({id,amount,reasonCode,evidenceHash,receipt?,proof?})`, `trackDispute(id)` and `giveFeedback(provider,score,tagHash,evidenceHash)`. Configure the registry/vault addresses and optional owner wallet client. Approve the configured per-token bond before opening a dispute.

- Proved claims verify the provider signature, chain/wallet domain, root, payment token and settlement nonce interval. Refund claims are bounded proportionally to that receipt's gross amount and the actual held payout, including swapped payout tokens.
- Missing-receipt claims use `openDispute` and are explicitly emitted as unverified claims. Absence cannot be cryptographically proved; bond, provider response and arbitration handle this path.
- Provider response must occur before its 3-day deadline. Silence refunds become available at the exact deadline.
- The snapshotted arbiter can decide after a response and before its 3-day arbiter deadline; timeout then refunds the disputed part. Any positive agent award returns the bond regardless of the arbiter's bond flag.
- Anyone can release undisputed funds after the original window. An explicit counter prevents their being paid again at resolution.
- Refunds return to the agent wallet in the settlement token. Protocol fees are not refunded.

Owner management also includes `createAgentWallet`, `deposit`, `withdraw`, `setProviderBudget`, `requestBudgetDecrease`, `executeBudgetDecrease`, `pause`, and `rotateAgentSigner`. Budgets/caps apply to gross settlement deltas. Batch exposure must stay below the cap; setting a cap is not proof of each individual API call on-chain. Daily limits account for settlement time.

## Domain verification and reputation

Host `await payments.domainProof('provider.example')` at `https://provider.example/.well-known/agentpay.json`. It is a provider-signed domain/chain/issuedAt/expiresAt statement, valid for at most 7 days. `getProviderProfile(urlOrAddress)` verifies URL proofs off-chain, reads registry terms and raw reputation. SDK policies include minProviderScore, maxDisputeWindow, requireVerifiedDomain and requireRegisteredProvider; provider/token allowlists and per-call price limits remain mandatory. Directly detected same-owner wallet/provider pairs return no score.

Formula v1 starts with successful-outcome fraction, optionally blends vetted fee-weighted feedback (80% outcomes, 20% feedback, $10,000 fee cap per pair), and reports separate confidence. Confidence matures over 100 settlements and halves per 30 days only when verified lastSeen data is supplied. No recency is invented from firstSeen. Full historical self-dealing/collusion filtering requires verified pair-level indexing; distinct EOAs do not prove independent beneficial ownership. Scores are off-chain estimates, not credit guarantees.

## Verification and deployment

Run `bun run backend:check`, `bun run protocol:check`, frontend `check`/`build`, and Foundry tests. Run Anvil on 127.0.0.1:8545 with chain 31337, then `bun run test:e2e:local` for receipts, multi-leaf proofs, replay protection, V1/V2 compatibility and all dispute outcomes, including Express raw-body handling.

`bun run deploy:phase3` performs a read-only Arc Testnet preflight. `--broadcast` deploys the coordinated suite, verifies runtime against artifacts with immutable slots normalized, records source hashes/transactions and updates backend public addresses. Existing wallets/approvals/budgets do not migrate. Source verification in an explorer and an independent security audit are separate tasks; neither is implied by runtime comparison.

The real testnet report is `contract/deployments/phase3-testnet-e2e.json`. Resume without recreating completed steps:

```sh
cd contract
bun --env-file=../backend/.env --env-file=.env run scripts/phase3-testnet-e2e.ts
```

The silence and arbiter-timeout scenarios preserve actual 3-day deadlines. Until their recorded readyAt times pass and transactions confirm, they remain pending rather than reported as completed.
