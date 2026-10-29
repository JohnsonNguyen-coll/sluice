import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import {
  AgentPayClient,
  MemoryAgentStore,
  createAgentWallet,
  verifyReceipt,
  negotiationAbi,
  type Factory,
} from "@sluice/sdk";
import { PaymentProvider, MemoryProviderStore } from "@sluice/middleware";
import { deployNegotiation, negotiationArtifact } from "./deploy-negotiation";
const transport = http("http://127.0.0.1:8545", { retryCount: 0 }),
  client = createPublicClient({ transport, cacheTime: 0 });
if ((await client.getChainId()) !== 31337) throw Error("Local chain only");
const mnemonic = "test test test test test test test test test test test junk",
  owner = mnemonicToAccount(mnemonic, { addressIndex: 0 }),
  provider = mnemonicToAccount(mnemonic, { addressIndex: 1 }),
  agent = mnemonicToAccount(mnemonic, { addressIndex: 2 }),
  arbiter = mnemonicToAccount(mnemonic, { addressIndex: 3 }),
  ownerClient = createWalletClient({ account: owner, transport }),
  providerClient = createWalletClient({ account: provider, transport }),
  arbiterClient = createWalletClient({ account: arbiter, transport });
async function deploy(name: string, args: unknown[] = []) {
  const a = await negotiationArtifact(name);
  const hash = await ownerClient.deployContract({
    abi: a.abi,
    bytecode: a.bytecode.object,
    args,
    chain: null,
  });
  return (await client.waitForTransactionReceipt({ hash })).contractAddress!;
}
async function write(
  w: typeof ownerClient,
  at: Address,
  abi: Abi,
  method: string,
  args: unknown[],
) {
  const sim = await client.simulateContract({
    address: at,
    abi,
    functionName: method,
    args,
    account: w.account,
  });
  const hash = await w.writeContract({
    ...sim.request,
    account: w.account,
    chain: null,
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw Error("Transaction reverted");
  return receipt;
}
const token = await deploy("MockERC20", ["USDC", "USDC", 6]),
  providers = await deploy("ProviderRegistry"),
  reputation = await deploy("ReputationRegistry");
const tokenAbi = (await negotiationArtifact("MockERC20")).abi,
  providerAbi = (await negotiationArtifact("ProviderRegistry")).abi;
const suite = await deployNegotiation(client, ownerClient, {
  providerRegistry: providers,
  reputationRegistry: reputation,
  arbiter: arbiter.address,
  token,
  feeRecipient: owner.address,
  feeBps: 30,
});
const vault = suite.contracts.NegotiationDisputeVault.address as Address,
  factory = suite.contracts.NegotiationWalletFactory.address as Address;
const factories: Factory[] = [
  { address: factory, version: 3, negotiationVault: vault },
];
await write(providerClient, providers, providerAbi, "register", [
  provider.address,
  keccak256(toHex("Local negotiation test provider")),
  3600,
  "0x0000000000000000000000000000000000000000",
]);
const createdWallet = await createAgentWallet({
  client,
  owner: ownerClient,
  factory: factories[0],
  agentSigner: agent.address,
  settleWindow: 600,
  userSalt: keccak256(toHex(crypto.randomUUID())),
});
const wallet = createdWallet.address;
const agentStore = new MemoryAgentStore(),
  providerStore = new MemoryProviderStore();
let now = Number((await client.getBlock()).timestamp);
const sdk = new AgentPayClient({
  wallet,
  chainId: 31337,
  publicClient: client,
  owner: ownerClient,
  agent,
  factories,
  store: agentStore,
  providerRegistry: providers,
  reputationRegistry: reputation,
  vault,
  now: () => now,
  policy: {
    allowedProviders: [provider.address],
    allowedTokens: [token],
    maxPerCall: 10000n,
    requireRegisteredProvider: true,
  },
});
await write(ownerClient, token, tokenAbi, "mint", [owner.address, 10000000n]);
await sdk.deposit(token, 5000000n);
await sdk.setProviderBudget(provider.address, token, 1000000n, 100000n);
await write(ownerClient, token, tokenAbi, "approve", [vault, 1000000n]);
const payments = new PaymentProvider({
  provider: provider.address,
  token,
  chainId: 31337,
  price: 10000n,
  signer: provider,
  publicClient: client,
  walletClient: providerClient,
  factories,
  store: providerStore,
  vault,
  now: () => now,
});
let executions = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: payments.wrap(() =>
    Response.json({ testOnly: true, execution: ++executions }),
  ),
});
async function advance(seconds: number) {
  await client.request({
    method: "evm_increaseTime" as any,
    params: [seconds],
  } as any);
  await client.request({ method: "evm_mine" as any } as any);
  now = Number((await client.getBlock()).timestamp);
}
async function caseOpen() {
  const result = await sdk.fetch(server.url + "paid-call");
  if (result.status !== 200) throw Error("Call failed");
  const call = (await agentStore.list()).at(-1)!;
  if (!call.receipt || !(await verifyReceipt(call.receipt)))
    throw Error("Receipt invalid");
  await payments.settle();
  const saved = await providerStore.get(call.id),
    id = saved!.commitment!.settlementId as Hex;
  await write(ownerClient, vault, negotiationAbi, "openDisputeWithReceipt", [
    id,
    {
      ...call.receipt.receipt,
      nonce: BigInt(call.receipt.receipt.nonce),
      timestamp: BigInt(call.receipt.receipt.timestamp),
      amount: BigInt(call.receipt.receipt.amount),
    },
    call.receipt.signature,
    saved!.commitment!.proof,
    4000n,
    1,
    keccak256(toHex("Test evidence")),
  ]);
  return id;
}
try {
  let blocked = false;
  try {
    await sdk.fetch(server.url + "paid-call");
  } catch {
    blocked = true;
  }
  if (!blocked || executions !== 0)
    throw Error("Unaccepted terms reached the paid handler");
  const hash = await client.readContract({
    address: vault,
    abi: negotiationAbi,
    functionName: "arbitrationTermsHash",
    args: [provider.address, token],
  });
  await write(ownerClient, vault, negotiationAbi, "acceptArbitrationTerms", [
    wallet,
    provider.address,
    token,
    hash,
  ]);
  const mutual = await caseOpen();
  await write(ownerClient, vault, negotiationAbi, "proposeResolution", [
    mutual,
    2000n,
    true,
    keccak256(toHex("Mutual reason")),
  ]);
  const proposal = (await client.readContract({
    address: vault,
    abi: negotiationAbi,
    functionName: "proposals",
    args: [mutual],
  })) as unknown[];
  await write(providerClient, vault, negotiationAbi, "acceptResolution", [
    mutual,
    proposal[0],
  ]);
  const escalated = await caseOpen();
  await write(providerClient, vault, negotiationAbi, "respondToDispute", [
    escalated,
    keccak256(toHex("Provider response")),
  ]);
  await advance(1800);
  await write(ownerClient, vault, negotiationAbi, "escalateDispute", [
    escalated,
  ]);
  await write(arbiterClient, vault, negotiationAbi, "resolveAfterEscalation", [
    escalated,
    1000n,
    3000n,
    true,
    keccak256(toHex("Reasoned arbiter decision")),
  ]);
  const silent = await caseOpen();
  await advance(1800);
  await write(ownerClient, vault, negotiationAbi, "autoRefund", [silent]);
  const timeout = await caseOpen();
  await write(providerClient, vault, negotiationAbi, "respondToDispute", [
    timeout,
    keccak256(toHex("Response")),
  ]);
  await advance(1800 + 86400);
  await write(ownerClient, vault, negotiationAbi, "arbiterTimeout", [timeout]);
  const output = {
    status: "passed",
    chainId: 31337,
    paidCalls: executions,
    scenarios: [
      "consent required before signing",
      "signed receipt and proof",
      "immediate mutual agreement",
      "last-resort escalation",
      "30-minute silence refund",
      "fixed 24-hour timeout without escalation",
    ],
    factory,
    vault,
    wallet,
  };
  await Bun.write(
    ".tools/negotiation-local-e2e.json",
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output));
} finally {
  await server.stop(true);
}
