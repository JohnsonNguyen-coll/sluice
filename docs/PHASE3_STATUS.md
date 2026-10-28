# Phase 3 implementation checkpoint

Reviewed 2026-10-28. This records source review and local validation, not a deployment or security audit.

## Current repository

Identity, provider and reputation registries, DisputeVault, V3 wallet/factory and Solidity tests already exist. Their presence does not establish that Phase 3 is complete. The Next.js frontend lives in `frontend/`; the `packages/sdk` and `packages/middleware` directories described in the roadmap are absent. Examples importing those packages are integration sketches, not evidence of a working SDK.

## Checkpoint 1: registry hardening

- Factory deployment-record verification prevents forged wallets from registering.
- Registration is protected against receiver-callback reentrancy; standard NFT transfers synchronize identity owner and clear previous nominations.
- Agent content-hash registration/updates and registry administration events are available.
- Feedback supports the payment wallet's current owner, uses actual fees separately from volume and excludes detectable same-owner pairs from score weight.
- Disputes are counted when opened; outcomes no longer inflate opened counters. Auto-refunds are available on agent stats.
- V3 settlement and vault opening hooks pass the new data; V1/V2 source contracts are unchanged.
- ERC-8004 primary sources and compatibility limits are documented in DECISIONS.md D21–D23.

## Remaining work after this checkpoint

1. Implement real SDK/middleware packages and signed receipts, receipt storage, Merkle trees and verification against the V3 contract. A stored root alone does not prove a complete receipt flow.
2. Review DisputeVault/V3 against the full spec, especially receipt-proof/no-receipt claims, payout/arbiter snapshots, undisputed fund release, deadline boundaries, bond accounting, delisted tokens and paused wallets. Existing V3 code must not be treated as completed merely because current tests pass.
3. Add the SDK policy/profile/dispute APIs, provider callbacks, dashboard profiles and dispute center. Keep V1/V2 behavior supported.
4. Deploy fresh V3/registry contracts only after these checks, then record the requested six testnet scenarios with transaction hashes. `contract/deployments/arc-testnet.json` contains only V1/V2, but `contract/metadata/*.json` records earlier V3/registry deployments and transaction hashes. Those records have not been independently verified here and predate these source changes; non-upgradeable deployed instances do not receive these fixes.
5. Complete architecture diagrams, threat model, integration guide, defaults and runbook for the final behavior.

The supplied work order says to stop and show results after registries/tests. This checkpoint follows that boundary; no claim is made that receipts, disputes, UI or testnet e2e are complete.

## Local validation

- Solidity 0.8.28, pinned OpenZeppelin 5.6.1, offline Foundry execution after dependency setup.
- `forge test --offline --threads 2 --no-match-test 'invariant_' --summary`: **248 passed, 0 failed**, including 90 registry tests and unit/fuzz regressions for V1/V2/V3/vault. Fuzz tests use 256 runs.
- `FOUNDRY_INVARIANT_RUNS=64 FOUNDRY_INVARIANT_DEPTH=128 forge test --offline --threads 2 --match-test 'invariant_' --summary`: **14 passed, 0 failed** (13 invariant properties plus one unit test whose name contains `invariant_`). Each invariant ran 8,192 handler calls. The long 256×500 run was interrupted; it is not claimed as completed validation.
- The vault invariant handler previously consumed its prank on `balanceOf`, making every attempted settlement revert. The corrected handler now exercises settlement and release with zero reverts in the recorded run (4,083 settlements and 4,109 release-handler calls).
- `forge build --offline --sizes`: passed. Runtime sizes: AgentRegistry 9,554 bytes, ReputationRegistry 5,551, V3 wallet 15,571, V3 factory 19,580, vault 9,848; all below the 24,576-byte runtime limit. Existing compiler/linter warnings remain.

Local logs: `.tools/phase3-unit-tests.log`, `.tools/phase3-invariant-tests.log`, `.tools/phase3-sizes.log`. The earlier interrupted `.tools/phase3-tests.log` is not the final result. No testnet transactions were submitted for these changes.
