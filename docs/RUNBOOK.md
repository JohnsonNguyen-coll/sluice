# Sluice operations runbook

Use the configured release manifest and the wallet's actual version. V1/V2 contracts remain separate non-upgradeable instances. Do not overwrite old addresses or reset signed channel history to repair an operational error.

## Compromised agent signer

1. Connect the wallet owner on the correct chain and pause the affected wallet. SDK helpers bind to `client.options.wallet`: use `await client.pause()`; do not pass another wallet address.
2. Record balances, provider budgets, settled amounts/nonces, outstanding signed vouchers and any vault settlements. Use the provider+token channel for V2/V3.
3. Rotate with `await client.rotateAgentSigner(newSignerAddress)`. Old signers retain independent grace windows; rotation does not instantly invalidate old signatures.
4. Keep the wallet paused while assessing old signer validity, voucher expiry and withdrawals/decreases. Do not resume merely because rotation mined. Pause blocks settlement; settlement delay and budget limits do not turn an off-chain authorization into a payment guarantee for providers.
5. After applicable grace periods, use request/apply budget decreases or withdraw free balance. Pausing/unpausing does not erase withdrawal cooldowns. Never hand the owner key to the active agent runtime.

## Provider/settler failure

- Stop serving new calls when RPC/storage is unavailable, the wallet is paused, a signer is invalid, or exposure exceeds the contract cap/budget. Vouchers are not on-chain reservations.
- Persist acceptance before application execution and persist receipt/response before acknowledging it. Use the Supabase store in a running provider, not MemoryProviderStore.
- An identical request with an accepted unfinished voucher returns 425. Investigate the application's business-side effects; do not delete the row and execute again blindly.
- Run one active settlement worker per provider signer. The channel nonce makes duplicate settlements revert, but that does not avoid duplicate gas costs. Do not run overlapping deployment/e2e scripts against the same account.
- After a confirmed settlement, mark its receipt commitments with the actual transaction hash/root/proofs. If persistence fails after broadcast, reconcile the on-chain Settled event and root before retrying; do not generate a different root for an already-settled nonce.
- Stop a watcher/settler using the function returned by `startSettler`/`watchDisputes`. Callbacks should be idempotent. The provider identity must match the signer/wallet client.

## Pending or missing agent receipts

Retry the identical method/path/query/body and voucher. V3 requires the separate request-authorization signature even for cached responses; an on-chain voucher alone must not expose cached API data. A network error does not prove that execution/payment failed. Use `flagCall` and keep the pending authorization.

`client.reconcile(provider, token)` clears pending state only after the chain confirms that nonce/cumulative amount settled. Unsettled expired/cancelled authorizations require explicit owner/provider reconciliation; the SDK deliberately does not reset cumulative spend or silently pay a gap. A stuck FileAgentStore lock must be removed only after confirming no process is using that signer/store. Back up state and never reset it while valid signed vouchers may exist.

## Disputes and deadlines

- Determine settlement token, held amount, original releaseAfter, snapshotted payout/arbiter and undisputedReleased from the vault.
- Obtain a signed receipt and its commitment/proof via an authenticated owner/provider `/receipts` read. A provider signature and database root are not alone proof of on-chain inclusion; opening a proved dispute verifies both.
- Approve the configured bond, then open before releaseAfter. A no-receipt claim is explicitly unverified and still requires bond/arbitration.
- Provider response must mine strictly before responseDeadline. At that timestamp, anyone may call autoRefund if no response exists.
- After response, only the settlement-time arbiter can decide, strictly before arbiterDeadline. At that timestamp anyone may call arbiterTimeout. Positive agent awards return the bond even if the arbiter requests forfeiture.
- After the original hold ends, anyone may release the undisputed remainder once. All final resolution paths deduct it; do not count an early release twice in accounting.
- Refunds return to the wallet in the payout/settlement token, including paused wallets or delisted tokens. Protocol fees stay paid.
- Private evidence is shared with the current wallet owner, provider and snapshotted arbiter. No raw evidence or personal data is put on-chain; only content hashes.

## RPC/Supabase incident

Arc Testnet public RPCs are attempted in order, Alchemy last when configured. Failures cool down for 30 seconds. All endpoints unavailable means fail closed, not mock chain data. Check chain ID 5042002 before accepting traffic. Never expose private RPC credentials in NEXT_PUBLIC_*.

Apply both SQL migrations in order. `/health` checks private auth and provider-record tables plus RPC. A healthy response confirms connectivity, not completion of a transaction or an independent audit. Service-role keys remain server-side; SIWE sessions are opaque hashed bearer tokens, not Supabase Auth JWTs. Revoke compromised API sessions and rotate the service-role credential through the Supabase project if exposed.

## Release/redeployment

`bun run deploy:phase3` is preflight; `--broadcast` submits Arc Testnet transactions using contract/.env. Keep the release JSON, pending journal, runtime hashes, source hashes and configuration transaction hashes. Do not rerun a partial broadcast blindly: inspect the journal and chain before deciding which contracts/configuration calls remain.

The canonical manifest keeps history. Existing wallet balances, budgets, approvals, signatures and identities do not move automatically. Backend configuration must retain the old factories; restart the API after changing manifests or .env (Bun watch does not watch files outside its workspace). ABI changes need versioned old-reader support before changing an existing vault endpoint.

## Resume the real testnet scenarios

Run from contract/:

```sh
bun --env-file=../backend/.env --env-file=.env run scripts/phase3-testnet-e2e.ts
```

Completed steps are preserved in deployments/phase3-testnet-e2e.json; keys/state stay in ignored .tools files. The two 3-day cases must wait for their recorded readyAt timestamps. Do not change protocol deadlines or use local time travel to report these real testnet scenarios as passed. Local Anvil results are recorded separately.
