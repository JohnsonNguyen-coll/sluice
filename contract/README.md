# Contract workspace

Solidity, tests and deployment tooling belong here. Core Solidity files moved without changes to their logic; only test/deploy imports and filesystem paths changed.

```sh
# From the repository root:
bun run contracts:build
bun run contracts:test

# Or from contract/:
bun run build
bun run test
forge script script/Deploy.s.sol --rpc-url "$RPC_URL"
```

The local forge runner finds ~/.foundry/bin/forge (forge.exe on Windows), falls back to PATH and supports FORGE_BIN. Foundry settings remain in foundry.toml. OpenZeppelin is resolved from the root hoisted install; forge-std stays vendored in lib/.

Deployment scripts resolve this workspace from import.meta.url rather than the old hardcoded /home/user/app path. They use config/onchain-facts.ts, out/ and metadata/. Circle/private-key credentials stay in the ignored contract/.env. No deployment or financial transaction is part of this reorganization.

The optional compass:deploy script references @circlefin/compass-chains supplied by its original Circle/Studio environment. That package was already undeclared/unavailable in this public checkout and is not installed here. Its private registry currently returns 404; other workspace commands do not depend on it.

deployments/ and metadata/ retain recorded addresses and transaction hashes. Absolute paths inside historical metadata describe the original deployment environment; they are not rewritten as new deployments. Fresh deployment runs write the new source/artifact locations.
