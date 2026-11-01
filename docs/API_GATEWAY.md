# Connect an existing API

The Provider page now creates a payment gateway, not a copy of a sample utility.
The provider must already operate an HTTPS JSON endpoint or have permission to
expose it. Sluice does not deploy the provider's application or grant resale rights.
Existing hosted utilities remain available to their owners and historical receipts.

## Provider setup

1. Connect the payout wallet and sign in (SIWE).
2. Enter the fixed HTTPS upstream URL and GET or POST method.
3. Choose no authentication, Bearer token, or a dedicated key header such as
   `x-api-key`, `x-goog-api-key`, or `api-key`. Paste the key into the password field.
4. Set the name, Directory slug and USDC price. The slug is not the upstream URL
   or the generated gateway endpoint. Confirm operation and billing terms.
5. Save the connection. This stores an encrypted configuration; it does not call
   the upstream or submit a transaction.
6. In the saved connection, enter a valid example request. Confirm and send one
   real test request. This may consume upstream credits or execute side effects.
   No Sluice voucher is charged. Only status is returned, never the response body.
7. A successful JSON response within the last 24 hours is required for activation.
   Fund provider gas and activate. Requests then use the generated `/hosted/<id>` URL.

Pause before replacing a key. Key replacement invalidates the previous connection
test. Endpoint, authentication type, method and price are immutable for this
release: create a new connection to change them. This avoids repointing signed
requests to a different service. Pause does not cancel in-flight accepted calls.

## What an agent sends

For POST upstreams, the agent sends the same JSON object that the upstream accepts.
For GET upstreams, the agent POSTs `{ "query": { "q": "example", "limit": 5 } }`;
Sluice safely encodes the query and sends GET to the configured upstream path.

An ordinary unauthenticated request receives HTTP 402 and a payment quote. It
does **not** invoke the upstream. The AgentPay SDK checks spending policy, signs a
voucher bound to the gateway method/URL/body, and repeats the identical request.
Sluice validates and durably accepts the voucher before injecting the provider's
upstream credential and making the request. The response includes a signed receipt.
See `backend/examples/minimal-agent.ts` for wallet, signer and client configuration.
The caller never needs or receives the upstream key.

Repeated completed vouchers retrieve the stored response. An in-flight or
crash-interrupted acceptance is not executed again automatically; it requires
retrying the same voucher or operator reconciliation. The gateway supplies an
`Idempotency-Key` derived from the voucher hash, but cannot guarantee that an
arbitrary upstream honors that header. It never retries upstream requests itself.

## Billing and failure semantics

This is **per accepted request attempt**, not success-only billing. Once a voucher
has been accepted, upstream 4xx/5xx, timeout and unsupported-response errors are
recorded in the signed receipt and the accepted payment can settle. Refunds use
the existing negotiation/dispute process; there is no automatic error refund.
Both the creation form and public endpoint documentation state this explicitly.
Upstream HTTP 402 is mapped to 502 (with original status in the error body) to
avoid confusing an upstream billing error with a new Sluice voucher request.
Invalid request shape, paused service, failed payment authorization and gas/worker
prechecks fail before the upstream is invoked.

## Credentials and egress boundaries

- Migration `202610300006_api_gateway.sql` adds encrypted upstream configuration
  and connection-test timestamps to the existing service-role-only table.
- AES-256-GCM binds the ciphertext to chain, service, owner and provider, with a
  separate domain from the payment signer. The configured master key stays in the
  ignored backend environment. Browser responses never include stored credentials
  or ciphertext. Connection URL/method/auth metadata is owner-only.
- Only public IPv4 DNS destinations, HTTPS port 443 and fixed paths are supported.
  DNS answers are validated on every call and a validated address is pinned to the
  connection; TLS validates the original hostname. No IP literal URLs, private or
  special-use addresses, URL credentials, configured query parameters or redirects.
- Only the configured credential and a small fixed header set leave the gateway.
  Caller authorization, cookies and voucher headers are not forwarded.
- Upstream errors, response headers and cookies are not relayed. Successful JSON
  bodies reflecting the raw credential are rejected. An untrusted upstream may
  still encode or transform content: use an endpoint you control/trust and a scoped
  key. The backend operator can decrypt credentials; this is custodial hosting.
- Input limit 24 KiB, output limit 1 MiB; DNS timeout 5 seconds, network timeout
  15 seconds. Responses must be JSON. No streaming/SSE, multipart, OAuth refresh,
  arbitrary extra headers, dynamic paths or IPv6-only upstreams in this release.
- Connection tests require SIWE ownership, explicit confirmation, and a 5/minute
  per-owner limit. Persistent provider leases serialize tests, rotation and activation.

Public clients also need a continuously running HTTPS Sluice backend. Localhost
is for local integration and cannot be published in the public Directory.

## Validation (2026-10-31)

Gateway tests cover authenticated encryption, URL/header validation, SSRF and mixed
DNS rejection, exact auth/body/query forwarding, bounded responses, sanitized errors,
no retries, owner scoping, key rotation invalidation, activation gating and private
database privileges. A read-only real HTTPS request through the pinned transport
returned GitHub repository JSON, and the applied Supabase columns were verified.
This does not establish compatibility with a provider's private API/key; run that
connection's real test in the UI. No new paid gateway transaction is claimed here.

## Arc Testnet follow-up (2026-11-01)

`contract/scripts/gateway-testnet-e2e.ts` connected to the public, read-only
GitHub repository API through the encrypted gateway configuration. Its connection
test returned 200; an unpaid call returned 402; the paid AgentPay call returned
the upstream JSON, produced a verified signed receipt and settled automatically.
The test service was paused afterward. Public transaction and state evidence is
in `contract/deployments/gateway-testnet-e2e.json`.

This test has no upstream credential. Credential forwarding, rotation and
redaction are covered by isolated tests, but a paid call against a private
provider API with a scoped real key remains to be verified by that provider.
The test also exposed an ambiguous SQL column in policy reservations, fixed by
`202611010010_policy_reservation_ambiguity.sql`; the migration has a PostgreSQL
regression test and was applied before the paid call succeeded.
