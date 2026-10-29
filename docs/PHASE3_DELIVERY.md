# Phase 3 delivery — 2026-10-29

The user authorized completing the remaining Phase 3 work and redeploying V1/V2 together with V3. Code/integration and the coordinated testnet deployment are delivered. Two real timeout-resolution transactions remain pending their on-chain deadlines; no future job has been scheduled. This is not an independent security audit or a claim of production certification.

## Delivered

- [x] Factory-provenance onboarding, including spoofing and V1 identity compatibility tests.
- [x] Provider-signed receipts, separate request authorization, Merkle commitments/proofs and nonce-bounded/proportional dispute claims.
- [x] Snapshot terms, exclusive deadlines, automatic bond return on an agent award and one-time undisputed release.
- [x] TypeScript SDK with durable browser/file stores, spending/trust policies, profiles/domain proof, local flags and owner/dispute helpers.
- [x] Native Fetch and Express middleware, exact-price Supabase channel acceptance, replay-safe response cache, settlement trees and provider callbacks.
- [x] Private API/SIWE, V3 intake, receipt lists/reads, shared evidence and canonical/historical factory configuration.
- [x] Dashboard reads/transactions, identity/provider profiles, private receipts, settlement availability, evidence and deadline actions.
- [x] Source docs, operational runbook, integration examples and public reference pages updated.
- [x] Fresh Arc Testnet V1/V2/V3 factories plus registries/vault, runtime/artifact comparison and versioned source/tx manifests.
- [ ] Real silence-refund resolution after its 3-day deadline.
- [ ] Real arbiter-timeout resolution after its 3-day deadline.

## Validation

- Solidity: 274 unit/fuzz tests passed, zero failures.
- Invariant selection: 17 tests passed at 128 runs × 256 calls, fail-on-revert, zero handler reverts. This is 16 invariant properties plus one matching ordinary test, not the 256×500 profile.
- Runtime-size checks passed; V3 factory 20,064 bytes and vault 14,098 bytes.
- Local Anvil e2e: 9 paid calls and 8 scenario groups, covering multi-leaf proofs, request/cache replay protection, every dispute outcome, V1/V2 payment compatibility and the real Express adapter.
- Backend/SDK/middleware TypeScript checks pass: 32 tests, zero failures and 219 assertions. Frontend lint/typecheck and the final production build pass. Route verification passes for 54 routes, 36 static public pages, 48 internal-link targets and isolation across 17 public JavaScript assets.
- Final secret scan checked 505 Git-visible files against the local deployment, service-role and generated test-account secrets; no matches were found. Local env/test-key files are ignored by Git.
- Real Supabase/API smoke: 5 signed receipts and commitments read by the owner, anonymous reads rejected (401), non-party reads rejected (403), snapshot arbiter evidence access accepted (200), no cached response bodies exposed.

Logs: `.tools/phase3-full-unit.log`, `.tools/phase3-full-invariant.log`, `.tools/phase3-full-sizes.log`, `.tools/phase3-full-backend.log`, `.tools/phase3-full-frontend-build.log`, `.tools/phase3-full-routes.log`, `.tools/phase3-local-e2e.json`. Local and testnet reports are separate.

## Current testnet release

| Contract | Address | Deployment |
| --- | --- | --- |
| AgentWalletFactory | `0x3662ab96c961915df01e141b62a2b785d0495790` | [transaction](https://explorer.testnet.arc.io/tx/0x3ee2c8ef63e8db9eb2cbb370d9012c101b44792b3a8d63dd10b80e5da98b15db) |
| AgentWalletFactoryV2 | `0xf3432dba7143e9c027a2b9496b78fff9989c6448` | [transaction](https://explorer.testnet.arc.io/tx/0x61b530289a3aa98e9ae089ca952f00599bc997614f24971605e508a7101cdfa2) |
| ProviderRegistry | `0x52568fe53bc59c2aac6295ec351f928d8abbce92` | [transaction](https://explorer.testnet.arc.io/tx/0x9601f64c197927c68808be724c0b9d713c224678bd87014e936d53d89fef5ad9) |
| ReputationRegistry | `0x88b9d58a32b279b959bbb1f7143a7f18aaf2da58` | [transaction](https://explorer.testnet.arc.io/tx/0x9a11e557b37bf309a1fcd60ab6b121ab60f3632f24cf594cb2030bc01f747227) |
| DisputeVault | `0x3699e8425a44f03bfd63bd754795ea10a1349b1e` | [transaction](https://explorer.testnet.arc.io/tx/0x298a27e54dd75f39b8453809e6794630e6634f070647d6d51145b2a8d644209e) |
| AgentWalletFactoryV3 | `0x5d89f395e912283d9b8814cf288414544321443c` | [transaction](https://explorer.testnet.arc.io/tx/0xe316fcf91e7518d7a6a4e5faed4fa68a8fd0b913dfe20786fb9a4ffe7fd3bca6) |
| AgentRegistry | `0x2cbd940026b423e0fbeb04bc4c827d21578ce699` | [transaction](https://explorer.testnet.arc.io/tx/0x2224b74ae4a657c36efcd9ff84d9d67f0ccc973d89996eb7bddb31a56a31666c) |

Fee: 30 bps (0.3%), recipient and ownership recorded in the manifests. Old factories remain in manifest history and API reads. Existing balances/approvals do not migrate. Runtime/artifact comparison does not mean an explorer has published/verified source.

## Real scenario evidence

Agent wallet: `0xB83059016958a074B3F7b65B008ea5446dE24CaD`. Provider/agent/arbiter are synthetic testnet actors; their private keys remain in ignored .tools files. Owner/deployer key stays in ignored contract/.env.

Identity/provider setup: [transaction](https://explorer.testnet.arc.io/tx/0x0603d013f268fa31ed9de9f14be769c9bb1e788c1c7085e4e9d6b37d21d6b8ac), [transaction](https://explorer.testnet.arc.io/tx/0x9a67dd3e1d4ea5599197570533f1b62c876e95cfaa4090ecd851e3e269e9cd54), [transaction](https://explorer.testnet.arc.io/tx/0xfb38900e59127bba81727e549da9679e0d5ec6223557e942f9def882c86bc794).

| Scenario | State | Transactions |
| --- | --- | --- |
| clean | passed | [transaction](https://explorer.testnet.arc.io/tx/0xd5ac67fb0aff686a3f7db0dce3f7edf7d7c1c2f7db5e56b49b195c615997ce90), [transaction](https://explorer.testnet.arc.io/tx/0x41b896431299a3e110f02febf0fc89d3abde67da3506f3cd46121bbe7986634c) |
| accept | passed | [transaction](https://explorer.testnet.arc.io/tx/0xed8286f1fab0868f36963bd87e78441b1bc50b8c038650e48416a4a187b04419), [transaction](https://explorer.testnet.arc.io/tx/0x5e0f0da6a6fbc57fd0af7ef9ea86b3789a7b3958709c3f85671c3e594c149d1a), [transaction](https://explorer.testnet.arc.io/tx/0xd04b9a914fa3113eec5e1173d00f9778b29b6587d87f84797bd7506ea457d94e) |
| silent | waiting for on-chain deadline — 2026-11-01T10:31:24.000Z | [transaction](https://explorer.testnet.arc.io/tx/0x903e155e08fdae81779689136cbad7e81c682836c830399744c1271302bf7790), [transaction](https://explorer.testnet.arc.io/tx/0x5312cd01d635434286779fc5f7458940382312cc79d998d633379c23ad803a67), [transaction](https://explorer.testnet.arc.io/tx/0x3016877caa32df0f49ba14e6d836da89af8dc15e93753f4da64bdd65b1e40db2) |
| split | passed | [transaction](https://explorer.testnet.arc.io/tx/0x6e1a6ab6ef75fdfff0b3924754508234e56212d0febe05da6183e3b47e979fa6), [transaction](https://explorer.testnet.arc.io/tx/0x4c1ba5d16c157ca568131f8534e91fe8e82b0dd57c410835fc73c10a34128d51), [transaction](https://explorer.testnet.arc.io/tx/0x74d09dba1df4626c513e39f35f53e8fbbcf516c6dab2082522bd908b631bde6a), [transaction](https://explorer.testnet.arc.io/tx/0x8b6857b6f40cd4bc6cadbf9a3a2ff59f21e1f253288a570af894e1f2d08ca2c5) |
| timeout | waiting for on-chain deadline — 2026-11-01T10:31:56.000Z | [transaction](https://explorer.testnet.arc.io/tx/0x01a809100c22e4c1f975d8bcd3e7627c8b545c13bfdaa67b94cb5ac7ed94afab), [transaction](https://explorer.testnet.arc.io/tx/0x8f9e16cf5ffd838ed30a8a1fd9068c44a2457c855c3a3b96c13c451deadea02e), [transaction](https://explorer.testnet.arc.io/tx/0xe407d73a23e045a8f4261c105e888ac9b64ebbfadbf5bbfc684f13a1da3fe102), [transaction](https://explorer.testnet.arc.io/tx/0xd4fbfdacbe96a74c319ef3226bb9eb56d8c3f94a42b51986769d4b63491b6856) |

For silence and timeout, the undisputed remainder has already been released. Only disputed principal and its bond remain held. Ready times in Asia/Bangkok: **2026-11-01 17:31:24** (silence) and **17:31:56** (arbiter timeout). Resume the persisted script after those times; do not report them as resolved before a confirming transaction exists.

## Resume and operate

From contract/:

```sh
bun --env-file=../backend/.env --env-file=.env run scripts/phase3-testnet-e2e.ts
```

Frontend preview: http://127.0.0.1:3010/app. API: http://127.0.0.1:3001/health. Public RPCs are first; optional Alchemy is last. Service-role keys and signing keys are never NEXT_PUBLIC variables or public API data.

## Limits

SDK/middleware are private local workspaces, not published npm releases. Provider signers in the supplied middleware are EOAs. Streaming/SSE are not supported by the buffered Express adapter. Keep one settlement worker per signer. Unfinished external business effects and confirmed-transaction/DB failures require explicit reconciliation. No global event indexer or complete historical collusion filter is claimed; page totals are scoped to verified returned records. Provider-selected arbitration and admin trust remain assumptions. Independent audit, production certification, explorer source publication and npm publication are separate work.
