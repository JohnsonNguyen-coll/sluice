> Provider onboarding now connects existing APIs through the gateway. See [API_GATEWAY.md](API_GATEWAY.md) for the current flow, key handling and per-attempt billing. The utility services below are retained as legacy integrations.

# Hosted APIs on Arc Testnet

The Provider page can create hosted **Text analysis** and **JSON validation** APIs without user-written server code. These are deterministic utilities that compute results from the submitted text. They are not LLM services or resold third-party model APIs.

## User flow

1. Connect the payout wallet and sign in on `/app/provider`.
2. Choose a template, name, URL name and price (0.000001–1 USDC per call). Accept hosted provider key custody and create the API.
3. Choose **Fund gas & activate**. If gas is insufficient, the wallet requests 0.25 testnet native USDC to the generated provider address. The backend registers this provider with the creator's wallet as payout and a one-hour dispute hold.
4. Use the generated endpoint. GET returns documentation; POST accepts AgentPay vouchers and returns computed output with a signed receipt. Callers configure their agent wallet's provider budget and accept arbitration terms before calling through the SDK.
5. The background worker checks every minute and settles accepted vouchers. Receipt links lead to actual payment/dispute details. Pausing stops new calls while already accepted vouchers still settle.

The creator can submit provider responses, proposals, exact-proposal acceptance, full claim acceptance and escalation from dispute details. These explicitly requested actions are signed by the hosted provider key. The server cannot act as arbiter through these routes.

## Configuration

Apply migrations `202610300004_managed_services.sql` and `202610300005_managed_publication.sql`. Store `MANAGED_PROVIDER_ENCRYPTION_KEY` as 32 random bytes encoded in hex in ignored `backend/.env`. Keep a secure backup: losing or replacing the key makes existing provider signers inaccessible. Each key is AES-256-GCM encrypted with chain/service/owner/provider identity bound as authenticated data; ciphertext and plaintext keys are excluded from API responses.

`MANAGED_API_BASE_URL` defaults to localhost. Directory publication requires an explicitly configured HTTPS origin and an actually deployed, reachable backend. Local creation does not deploy a public server. Service prices/templates/payout ownership are immutable in this release; pause/resume is supported. Gas top-ups are explicit wallet transactions; unused provider gas has no self-service withdrawal flow yet.

Only Arc Testnet and local development are enabled. Supabase service-role access and the encryption key remain backend-only. Creator SIWE sessions authorize management; this is custodial operation of provider signers, not a noncustodial delegation protocol.

## Worker recovery

On-chain provider operations share a persistent database lease. Concurrent workers cannot sign for the same provider simultaneously. Successful operations release their lease. A crash or uncertain broadcast retains it; do not automatically delete leases or resend transactions. Inspect the provider's transaction history, pending nonce, registration and receipt/commitment records first. After reconciling all in-flight operations, an operator may remove only that service's lease and clear its `worker_error`. Confirmed settlement with missing database commitments needs receipt/proof recovery before release.

New paid calls stop on recorded worker errors, insufficient gas or a stale worker heartbeat. The backend must stay running. The current worker scans up to 100 services per network; each creator is limited to 10 through the API. This is an initial bounded deployment, not an unlimited hosting fleet. No automated gas sponsorship, key export, arbitrary code execution or arbitrary upstream proxy is provided.

## Validation

51 backend tests cover encryption context binding, ownership isolation, explicit custody consent, real text/JSON computation, price/input limits, HTTP 402 challenges, stale-worker rejection, SIWE access and SQL lease/role isolation. Frontend lint/typecheck, production build and 56 route checks pass. The real Arc integration report is `contract/deployments/managed-testnet-e2e.json`; only a report with `status: passed` confirms the entire test completed. The script is resumable and does not duplicate recorded setup transactions.

The real integration completed successfully: two 0.01 USDC text-analysis calls, verified signed receipts, automatic background settlement, a server-signed provider proposal, owner-accepted 0.002 USDC refund and HTTP 503 after pausing. The hosted utility is left paused and unlisted after testing. Settlement transaction: `0xb9edac011f794caee3fa4c38a37c9f6f5f01f57971516ec42148b0e1df5eacd4`; agreement: `0x8ceb7a6da89ab9b29b9236d63e6b0f6edf60432402c82df1cb3be8e06bf6439d`. Controlled integration parties exercised the refund; it was not a claim that the tool returned an incorrect result.
