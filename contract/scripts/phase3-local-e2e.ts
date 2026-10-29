import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  keccak256,
  toHex,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { deploySuite } from "./deploy-phase3";
import {
  AgentPayClient,
  MemoryAgentStore,
  verifyReceipt,
  verifyProof,
  receiptLeaf,
  createAgentWallet,
  pack,
  walletAbis,
  factoryAbis,
  agentAbi,
  providerAbi,
  vaultAbi,
} from "@sluice/sdk";
import { PaymentProvider, MemoryProviderStore } from "@sluice/middleware";
import { expressHarness } from "../../backend/packages/middleware/test/express-harness";
const url = "http://127.0.0.1:8545",
  transport = http(url, { retryCount: 0 }),
  client = createPublicClient({ transport, cacheTime: 0 });
if ((await client.getChainId()) !== 31337)
  throw Error("This e2e script only runs on local chain 31337");
const mnemonic = "test test test test test test test test test test test junk";
const owner = mnemonicToAccount(mnemonic, { addressIndex: 0 }),
  provider = mnemonicToAccount(mnemonic, { addressIndex: 1 }),
  agent = mnemonicToAccount(mnemonic, { addressIndex: 2 }),
  arbiter = mnemonicToAccount(mnemonic, { addressIndex: 3 });
const ownerClient = createWalletClient({ account: owner, transport }),
  providerClient = createWalletClient({ account: provider, transport }),
  arbiterClient = createWalletClient({ account: arbiter, transport });
const tokenArtifact = await Bun.file(
  new URL("../out/MockERC20.sol/MockERC20.json", import.meta.url),
).json();
const tokenTx = await ownerClient.deployContract({
  abi: tokenArtifact.abi,
  bytecode: tokenArtifact.bytecode.object,
  args: ["USDC", "USDC", 6],
  chain: null,
});
const token = (await client.waitForTransactionReceipt({ hash: tokenTx }))
  .contractAddress!;
async function write(
  wallet: typeof ownerClient,
  address: Address,
  abi: Abi,
  functionName: string,
  args: unknown[],
) {
  const { request } = await client.simulateContract({
    address,
    abi,
    functionName,
    args,
    account: wallet.account,
  });
  const hash = await wallet.writeContract({ ...request, chain: null });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success")
    throw Error("E2E transaction reverted: " + functionName);
  return receipt;
}
const suite = await deploySuite(client, ownerClient, {
  usdc: token,
  feeRecipient: owner.address,
  feeBps: 30,
  arbiter: arbiter.address,
});
const at = (name: string) => suite.contracts[name].address;
await write(ownerClient, token, tokenArtifact.abi, "mint", [
  owner.address,
  1_000_000_000n,
]);
await write(providerClient, at("ProviderRegistry"), providerAbi, "register", [
  provider.address,
  keccak256(toHex("provider")),
  30,
  arbiter.address,
]);
const factories = ([1, 2, 3] as const).map((version) => ({
  version,
  address: at(
    version === 1 ? "AgentWalletFactory" : "AgentWalletFactoryV" + version,
  ),
}));
const created = await write(
  ownerClient,
  at("AgentWalletFactoryV3"),
  factoryAbis[3],
  "createWallet",
  [owner.address, agent.address, 600, toHex(1, { size: 32 })],
);
let wallet: Address | undefined;
for (const log of created.logs) {
  try {
    const event = decodeEventLog({
      abi: factoryAbis[3],
      ...log,
    }) as unknown as { eventName: string; args: { wallet: Address } };
    if (event.eventName === "WalletCreated") wallet = event.args.wallet;
  } catch {}
}
if (!wallet) throw Error("WalletCreated event missing");
let now = Number((await client.getBlock()).timestamp);
const store = new MemoryAgentStore(),
  providerStore = new MemoryProviderStore();
const api = new AgentPayClient({
  wallet,
  chainId: 31337,
  publicClient: client,
  owner: ownerClient,
  agent,
  factories,
  registry: at("AgentRegistry"),
  providerRegistry: at("ProviderRegistry"),
  reputationRegistry: at("ReputationRegistry"),
  vault: at("DisputeVault"),
  store,
  policy: {
    allowedProviders: [provider.address],
    allowedTokens: [token],
    maxPerCall: 1_000_000n,
    requireRegisteredProvider: true,
    maxDisputeWindow: 30,
  },
  now: () => now,
});
await api.deposit(token, 100_000_000n);
await api.setProviderBudget(provider.address, token, 50_000_000n, 10_000_000n);
await api.registerAgent(keccak256(toHex("agent metadata")));
await write(ownerClient, token, tokenArtifact.abi, "approve", [
  at("DisputeVault"),
  100_000_000n,
]);
const middleware = new PaymentProvider({
  provider: provider.address,
  token,
  chainId: 31337,
  price: 1_000_000n,
  signer: provider,
  publicClient: client,
  walletClient: providerClient,
  factories,
  store: providerStore,
  vault: at("DisputeVault"),
  now: () => now,
});
let executions = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: middleware.wrap(() => {
    executions++;
    return Response.json({ answer: 42, call: executions });
  }),
});
const scenarios: unknown[] = [];
async function callAndSettle(count = 1) {
  for (let i = 0; i < count; i++) {
    const response = await api.fetch(server.url + "answer", {
      method: "POST",
      body: JSON.stringify({ query: "call " + executions }),
      headers: { "Content-Type": "application/json" },
    });
    if (response.status !== 200) throw Error("Paid API call failed");
  }
  const call = (await store.list()).at(-1)!;
  if (!call.receipt || !(await verifyReceipt(call.receipt)))
    throw Error("Missing valid receipt");
  await middleware.settle();
  const record = await providerStore.get(call.id);
  if (
    !record?.commitment ||
    !verifyProof(
      receiptLeaf(record.receipt!),
      record.commitment.proof as Hex[],
      record.commitment.root as Hex,
    )
  )
    throw Error("Invalid settlement commitment");
  return record;
}
async function advance(seconds: number) {
  await client.request({
    method: "evm_increaseTime" as never,
    params: [seconds] as never,
  });
  await client.request({ method: "evm_mine" as never });
  now = Number((await client.getBlock()).timestamp);
}
try {
  const clean = await callAndSettle(2);
  const beforeReplay = executions;
  const replay = await fetch(server.url + "answer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AgentPay-Version": "3",
      "X-AgentPay-Voucher": pack(clean.voucher),
    },
    body: JSON.stringify({ query: "call " + (beforeReplay - 1) }),
  });
  if (replay.status !== 200 || executions !== beforeReplay)
    throw Error("Paid replay was executed twice");
  const withoutAuthorization = {
    ...clean.voucher,
    requestSignature: undefined,
  };
  const leaked = await fetch(server.url + "answer", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AgentPay-Version": "3",
      "X-AgentPay-Voucher": pack(withoutAuthorization),
    },
    body: JSON.stringify({ query: "call " + (beforeReplay - 1) }),
  });
  if (leaked.status !== 402 || executions !== beforeReplay)
    throw Error("Public settlement voucher exposed a cached response");
  await advance(31);
  const released = await write(
    ownerClient,
    at("DisputeVault"),
    vaultAbi,
    "release",
    [clean.commitment!.settlementId],
  );
  scenarios.push({
    scenario: "clean release",
    settle: clean.commitment!.transactionHash,
    tx: released.transactionHash,
  });
  for (const path of ["accept", "silent", "split", "timeout"] as const) {
    const record = await callAndSettle(),
      id = record.commitment!.settlementId as Hex;
    const opened = await api.openDispute({
      id,
      amount: 400_000n,
      reasonCode: 1,
      evidenceHash: keccak256(toHex(path)),
      receipt: record.receipt,
      proof: record.commitment!.proof as Hex[],
    });
    let resolved;
    if (path === "accept")
      resolved = await write(
        providerClient,
        at("DisputeVault"),
        vaultAbi,
        "acceptDispute",
        [id],
      );
    else if (path === "silent") {
      await advance(3 * 86400);
      resolved = await write(
        ownerClient,
        at("DisputeVault"),
        vaultAbi,
        "autoRefund",
        [id],
      );
    } else {
      await middleware.respondToDispute(
        id,
        keccak256(toHex("provider evidence")),
      );
      if (path === "split")
        resolved = await write(
          arbiterClient,
          at("DisputeVault"),
          vaultAbi,
          "arbiterDecide",
          [id, 200_000n, 200_000n, true],
        );
      else {
        await advance(3 * 86400);
        resolved = await write(
          ownerClient,
          at("DisputeVault"),
          vaultAbi,
          "arbiterTimeout",
          [id],
        );
      }
    }
    const tracked = (await api.trackDispute(id)) as {
      dispute: { resolved: boolean };
    };
    if (!tracked.dispute.resolved) throw Error("Dispute was not resolved");
    scenarios.push({
      scenario: path,
      settle: record.commitment!.transactionHash,
      open: opened.transactionHash,
      resolve: resolved.transactionHash,
    });
  }
  for (const version of [1, 2] as const) {
    const legacy = await createAgentWallet({
      client,
      owner: ownerClient,
      factory: factories.find((f) => f.version === version)!,
      agentSigner: agent.address,
      settleWindow: 600,
      userSalt: toHex(version + 10, { size: 32 }),
    });
    const legacyApi = new AgentPayClient({
      wallet: legacy.address,
      chainId: 31337,
      publicClient: client,
      owner: ownerClient,
      agent,
      factories,
      now: () => now,
      policy: {
        allowedProviders: [provider.address],
        allowedTokens: [token],
        maxPerCall: 1_000_000n,
      },
    });
    await legacyApi.deposit(token, 10_000_000n);
    await legacyApi.setProviderBudget(
      provider.address,
      token,
      5_000_000n,
      2_000_000n,
    );
    if (
      (
        await legacyApi.fetch(server.url + "answer", {
          method: "POST",
          body: "legacy " + version,
        })
      ).status !== 200
    )
      throw Error("Legacy payment failed");
    await middleware.settle();
    scenarios.push({
      scenario: "V" + version + " payment compatibility",
      wallet: legacy.address,
      create: legacy.transactionHash,
    });
  }
  const express = await expressHarness(middleware.options);
  try {
    if (
      (
        await api.fetch(express.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{ "query": "exact raw bytes" }',
        })
      ).status !== 200 ||
      express.calls() !== 1
    )
      throw Error("Express payment/receipt adapter failed");
    await express.controller.settle();
    scenarios.push({
      scenario: "Express raw-body middleware",
      calls: express.calls(),
    });
  } finally {
    await express.close();
  }
  const report = {
    network: "local",
    chainId: 31337,
    suite,
    agentWallet: wallet,
    paidCalls: executions + 1,
    scenarios,
  };
  await Bun.write(
    new URL("../../.tools/phase3-local-e2e.json", import.meta.url),
    JSON.stringify(
      report,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: "passed",
      paidCalls: executions + 1,
      scenarios: scenarios.length,
      report: ".tools/phase3-local-e2e.json",
    }),
  );
} finally {
  server.stop(true);
}
