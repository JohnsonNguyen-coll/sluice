# Backend

This workspace owns server-side AgentPay integrations.

- `src/`: reserved for the provider API, middleware, settler and dispute workers.
- `examples/`: existing minimal agent/provider integration sketches.

There is no runnable backend server or implemented SDK/middleware package in this checkout yet. The examples reference `@sluice/sdk` and `@sluice/middleware`, which are not present. They are retained as unverified examples, not wired into install/build scripts.

Future backend runtime code, tests, dependencies and private environment configuration belong here. Frontend code belongs in `../frontend`; Solidity and deployment tooling belong in `../contract`.
