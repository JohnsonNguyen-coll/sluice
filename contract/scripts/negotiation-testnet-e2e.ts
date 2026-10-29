import {
  createPublicClient,
  createWalletClient,
  keccak256,
  toHex,
  parseEther,
  type Address,
  type Hex,
  type Abi,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { loadConfig } from "../../backend/src/config";
import { publicRpcTransport } from "../../backend/src/rpc";
import {
  AgentPayClient,
  createAgentWallet,
  verifyReceipt,
  negotiationAbi,
  providerAbi,
} from "@sluice/sdk";
import { FileAgentStore } from "@sluice/sdk/file-store";
import { PaymentProvider, SupabaseProviderStore } from "@sluice/middleware";
const root = resolve(import.meta.dir, "../.."),
  reportPath = resolve(
    root,
    "contract/deployments/negotiation-testnet-e2e.json",
  ),
  keysPath = resolve(root, ".tools/negotiation-testnet-keys.json");
let report: any = (await Bun.file(reportPath).exists())
  ? await Bun.file(reportPath).json()
  : { setup: {}, createdAt: new Date().toISOString() };
if (report.status === "passed") {
  console.log(
    JSON.stringify({
      status: "already passed",
      report: "contract/deployments/negotiation-testnet-e2e.json",
    }),
  );
  process.exit(0);
}
const save = () => Bun.write(reportPath, JSON.stringify(report, null, 2));
if (!(await Bun.file(keysPath).exists()))
  await Bun.write(
    keysPath,
    JSON.stringify({
      provider: generatePrivateKey(),
      agent: generatePrivateKey(),
    }),
  );
const keys = await Bun.file(keysPath).json();
const config = loadConfig();
if (config.chainId !== 5042002 || !config.supabaseUrl || !config.supabaseKey)
  throw Error("Arc Testnet and Supabase required");
const factory = config.factories.find((f) => f.negotiationVault);
if (!factory) throw Error("Deploy negotiated contracts first");
const vault = factory.negotiationVault!;
const transport = publicRpcTransport(config.rpcUrls, config.chainId),
  client = createPublicClient({ transport, cacheTime: 0 }),
  owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex),
  provider = privateKeyToAccount(keys.provider),
  agent = privateKeyToAccount(keys.agent);
if ((await client.getChainId()) !== 5042002) throw Error("Wrong network");
const ownerClient = createWalletClient({ account: owner, transport }),
  providerClient = createWalletClient({ account: provider, transport });
const manifest = await Bun.file(
    resolve(root, "contract/deployments/arc-testnet.json"),
  ).json(),
  token = manifest.v1.contracts.AgentWalletFactory.constructorArgs
    .usdc as Address;
async function write(
  label: string,
  w: typeof ownerClient,
  address: Address,
  abi: Abi,
  name: string,
  args: unknown[],
) {
  if (report.setup[label]) return;
  const simulated = await client.simulateContract({
    address,
    abi,
    functionName: name,
    args,
    account: w.account,
  });
  const hash = await w.writeContract({
    ...simulated.request,
    chain: null,
    account: w.account,
  });
  if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
    throw Error("Transaction reverted");
  report.setup[label] = hash;
  await save();
}
report.chainId = 5042002;
report.factory = factory.address;
report.vault = vault;
report.provider = provider.address;
report.owner = owner.address;
await save();
if (!report.setup.providerGas) {
  const hash = await ownerClient.sendTransaction({
    to: provider.address,
    value: parseEther("0.25"),
    chain: null,
  });
  if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
    throw Error("Gas transfer failed");
  report.setup.providerGas = hash;
  await save();
}
await write(
  "providerRegistration",
  providerClient,
  config.providerRegistry!,
  providerAbi,
  "register",
  [
    provider.address,
    keccak256(
      toHex(
        "Sluice negotiated testnet integration provider; not a public model service",
      ),
    ),
    3600,
    "0x0000000000000000000000000000000000000000",
  ],
);
if (!report.wallet) {
  const created = await createAgentWallet({
    client,
    owner: ownerClient,
    factory,
    agentSigner: agent.address,
    settleWindow: 600,
    userSalt: keccak256(toHex("negotiation-e2e-v1")),
  });
  report.wallet = created.address;
  report.setup.walletCreation = created.transactionHash;
  await save();
}
const erc20 = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
const wallet = report.wallet as Address,
  agentStore = new FileAgentStore(
    resolve(root, ".tools/negotiation-testnet-agent-state.json"),
  ),
  sdk = new AgentPayClient({
    wallet,
    chainId: 5042002,
    publicClient: client,
    owner: ownerClient,
    agent,
    factories: config.factories,
    providerRegistry: config.providerRegistry,
    reputationRegistry: config.reputationRegistry,
    vault,
    store: agentStore,
    policy: {
      allowedProviders: [provider.address],
      allowedTokens: [token],
      maxPerCall: 10000n,
      requireRegisteredProvider: true,
    },
  });
if (!report.setup.deposit) {
  const receipt = await sdk.deposit(token, 1000000n);
  report.setup.deposit = receipt.transactionHash;
  await save();
}
if (!report.setup.budget) {
  const receipt = await sdk.setProviderBudget(
    provider.address,
    token,
    100000n,
    10000n,
  );
  report.setup.budget = receipt.transactionHash;
  await save();
}
if (!report.setup.terms) {
  const receipt = await sdk.acceptArbitrationTerms(provider.address, token);
  report.setup.terms = receipt.transactionHash;
  await save();
}
await write("bondAllowance", ownerClient, token, erc20 as Abi, "approve", [
  vault,
  100000n,
]);
const store = new SupabaseProviderStore(config.supabaseUrl, config.supabaseKey),
  payments = new PaymentProvider({
    provider: provider.address,
    token,
    chainId: 5042002,
    price: 10000n,
    signer: provider,
    publicClient: client,
    walletClient: providerClient,
    factories: config.factories,
    store,
    vault,
  });
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: payments.wrap(() =>
    Response.json({
      testOnly: true,
      purpose: "Real testnet negotiated payment integration",
      digest: keccak256(toHex("negotiated-payment-v1")),
    }),
  ),
});
try {
  let call = (await agentStore.list()).at(-1);
  if (!call?.receipt) {
    const result = await sdk.fetch(server.url + "negotiation-test");
    if (result.status !== 200) throw Error("Paid call failed");
    call = (await agentStore.list()).at(-1);
  }
  if (!call?.receipt || !(await verifyReceipt(call.receipt)))
    throw Error("Verified signed receipt required");
  report.voucherId = call.id;
  await save();
  const settled = await payments.settle();
  if (settled.length) {
    report.settleTx = settled.at(-1);
    await save();
  }
  const stored = await store.get(call.id);
  if (!stored?.commitment) throw Error("Supabase commitment missing");
  const id = stored.commitment.settlementId as Hex;
  report.settlementId = id;
  report.settleTx = stored.commitment.transactionHash;
  await save();
  const receipt = call.receipt;
  await write(
    "claim",
    ownerClient,
    vault,
    negotiationAbi,
    "openDisputeWithReceipt",
    [
      id,
      {
        ...receipt.receipt,
        nonce: BigInt(receipt.receipt.nonce),
        amount: BigInt(receipt.receipt.amount),
        timestamp: BigInt(receipt.receipt.timestamp),
      },
      receipt.signature,
      stored.commitment.proof,
      4000n,
      1,
      keccak256(toHex("Request partial refund: integration-test evidence")),
    ],
  );
  const base = "http://127.0.0.1:3001";
  const challenge = await (
    await fetch(base + "/auth/nonce", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: owner.address }),
    })
  ).json();
  const signature = await owner.signMessage({ message: challenge.message });
  const auth = await (
    await fetch(base + "/auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: challenge.id, signature }),
    })
  ).json();
  if (!auth.token) throw Error("Owner login failed");
  try {
    const content =
      "Negotiation integration test: both parties agree to refund 0.002 USDC out of the disputed 0.004 USDC.";
    const saved = await fetch(base + "/disputes/" + id + "/evidence", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content }),
    });
    if (!saved.ok)
      throw Error(
        "Private evidence could not be saved after opening the claim",
      );
    const evidence = await saved.json();
    report.privateEvidenceStored = true;
    await write(
      "proposal",
      ownerClient,
      vault,
      negotiationAbi,
      "proposeResolution",
      [id, 2000n, true, evidence.evidenceHash],
    );
    const proposal = (await client.readContract({
      address: vault,
      abi: negotiationAbi,
      functionName: "proposals",
      args: [id],
    })) as unknown[];
    await write(
      "agreement",
      providerClient,
      vault,
      negotiationAbi,
      "acceptResolution",
      [id, proposal[0]],
    );
    const status = await fetch(base + "/disputes/" + id, {
      headers: { Authorization: "Bearer " + auth.token },
    });
    const result = await status.json();
    if (
      !status.ok ||
      !result.dispute?.resolved ||
      result.vault?.toLowerCase() !== vault.toLowerCase()
    )
      throw Error(
        "Final API state did not match the confirmed negotiated resolution",
      );
    report.finalState = result.settlement.state;
    report.apiResolved = true;
    report.arbiterUsed = false;
  } finally {
    await fetch(base + "/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + auth.token },
    });
  }
  report.status = "passed";
  report.updatedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      wallet,
      vault,
      settlementId: id,
      agreement: report.setup.agreement,
      privateEvidenceStored: report.privateEvidenceStored,
      arbiterUsed: false,
    }),
  );
} finally {
  await server.stop(true);
}
