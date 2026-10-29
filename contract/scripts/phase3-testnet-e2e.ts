import {
  createPublicClient,
  createWalletClient,
  keccak256,
  toHex,
  parseEther,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { CONTRACT_ROOT } from "./workspace-paths";
import { publicRpcTransport } from "../../backend/src/rpc";
import { ARC_PUBLIC_RPCS } from "../../backend/src/config";
import {
  AgentPayClient,
  createAgentWallet,
  providerAbi,
  vaultAbi,
  agentAbi,
  verifyReceipt,
  type SignedReceipt,
} from "@sluice/sdk";
import { FileAgentStore } from "@sluice/sdk/file-store";
import { PaymentProvider, SupabaseProviderStore } from "@sluice/middleware";
type Scenario = {
  voucherId?: string;
  settlementId?: Hex;
  settleTx?: Hex;
  openTx?: Hex;
  respondTx?: Hex;
  resolveTx?: Hex;
  undisputedReleaseTx?: Hex;
  readyAt?: string;
  status?: string;
};
type Report = {
  chainId: number;
  releaseFactory: Address;
  owner: Address;
  provider: Address;
  agent: Address;
  arbiter: Address;
  wallet?: Address;
  setup: Record<string, Hex>;
  scenarios: Record<string, Scenario>;
  updatedAt: string;
};
const manifest = await Bun.file(
  resolve(CONTRACT_ROOT, "deployments/arc-testnet.json"),
).json();
if (!manifest.v3) throw Error("Deploy the V3 suite before running this script");
const existingReportFile = Bun.file(resolve(CONTRACT_ROOT, "deployments/phase3-testnet-e2e.json"));
const existingReport: Report | undefined = await existingReportFile.exists() ? await existingReportFile.json() : undefined;
const release = existingReport
  ? [manifest.v3, ...(manifest.history || []).map((entry: {v3?: typeof manifest.v3}) => entry.v3)]
      .find(entry => entry?.contracts.AgentWalletFactoryV3.address.toLowerCase() === existingReport.releaseFactory.toLowerCase())
  : manifest.v3;
if (!release || release.contracts.DisputeVault.negotiationVersion === 1)
  throw Error("Legacy e2e requires its recorded legacy release; use negotiation-testnet-e2e.ts for negotiated wallets");
const at = (name: string): Address => release.contracts[name].address;
const key = process.env.DEPLOYER_PRIVATE_KEY as Hex;
if (!key) throw Error("Set DEPLOYER_PRIVATE_KEY locally");
const owner = privateKeyToAccount(key),
  override = process.env.RPC_URLS?.trim() || process.env.RPC_URL?.trim(),
  urls = override
    ? override
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    : [...ARC_PUBLIC_RPCS];
if (process.env.ALCHEMY_RPC_URL) urls.push(process.env.ALCHEMY_RPC_URL);
const transport = publicRpcTransport(urls, 5042002),
  client = createPublicClient({ transport, cacheTime: 0 });
if ((await client.getChainId()) !== 5042002) throw Error("Arc Testnet only");
const privatePath = resolve(
    CONTRACT_ROOT,
    "../.tools/phase3-testnet-accounts.json",
  ),
  reportPath = resolve(CONTRACT_ROOT, "deployments/phase3-testnet-e2e.json");
let secrets: { provider: Hex; agent: Hex; arbiter: Hex };
if (await Bun.file(privatePath).exists())
  secrets = await Bun.file(privatePath).json();
else {
  secrets = {
    provider: generatePrivateKey(),
    agent: generatePrivateKey(),
    arbiter: generatePrivateKey(),
  };
  await Bun.write(privatePath, JSON.stringify(secrets));
}
const provider = privateKeyToAccount(secrets.provider),
  agent = privateKeyToAccount(secrets.agent),
  arbiter = privateKeyToAccount(secrets.arbiter);
const ownerClient = createWalletClient({ account: owner, transport }),
  providerClient = createWalletClient({ account: provider, transport }),
  arbiterClient = createWalletClient({ account: arbiter, transport });
const erc20 = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { type: "address", name: "spender" },
      { type: "uint256", name: "amount" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
const token = manifest.v1.contracts.AgentWalletFactory.constructorArgs
  .usdc as Address;
let report: Report = (await Bun.file(reportPath).exists())
  ? await Bun.file(reportPath).json()
  : {
      chainId: 5042002,
      releaseFactory: at("AgentWalletFactoryV3"),
      owner: owner.address,
      provider: provider.address,
      agent: agent.address,
      arbiter: arbiter.address,
      setup: {},
      scenarios: {},
      updatedAt: new Date().toISOString(),
    };
if (
  report.releaseFactory.toLowerCase() !==
    at("AgentWalletFactoryV3").toLowerCase() ||
  report.owner.toLowerCase() !== owner.address.toLowerCase()
)
  throw Error(
    "Existing e2e report belongs to another release or signer; archive it explicitly first",
  );
async function save() {
  report.updatedAt = new Date().toISOString();
  await Bun.write(reportPath, JSON.stringify(report, null, 2) + "\n");
}
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
  const tx = await wallet.writeContract({ ...request, chain: wallet.chain });
  const receipt = await client.waitForTransactionReceipt({ hash: tx });
  if (receipt.status !== "success") throw Error("E2E transaction reverted");
  return receipt;
}
async function setup(name: string, action: () => Promise<Hex>) {
  if (report.setup[name]) return;
  report.setup[name] = await action();
  await save();
  console.log("confirmed", name, report.setup[name]);
}
const factories = [
  { version: 1, address: manifest.v1.contracts.AgentWalletFactory.address },
  { version: 2, address: manifest.v2.contracts.AgentWalletFactoryV2.address },
  { version: 3, address: at("AgentWalletFactoryV3") },
] as const;
async function run() {
  await setup("provider gas", async () => {
    if (
      (await client.getBalance({ address: provider.address })) >=
      parseEther("0.1")
    )
      return toHex(0, { size: 32 });
    const hash = await ownerClient.sendTransaction({
      to: provider.address,
      value: parseEther("0.2"),
      chain: ownerClient.chain,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Gas funding failed");
    return hash;
  });
  await setup("arbiter gas", async () => {
    if (
      (await client.getBalance({ address: arbiter.address })) >=
      parseEther("0.1")
    )
      return toHex(0, { size: 32 });
    const hash = await ownerClient.sendTransaction({
      to: arbiter.address,
      value: parseEther("0.2"),
      chain: ownerClient.chain,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Gas funding failed");
    return hash;
  });
  await setup(
    "provider registration",
    async () =>
      (
        await write(
          providerClient,
          at("ProviderRegistry"),
          providerAbi,
          "register",
          [
            provider.address,
            keccak256(toHex("Sluice synthetic testnet e2e provider")),
            120,
            arbiter.address,
          ],
        )
      ).transactionHash,
  );
  if (!report.wallet) {
    const created = await createAgentWallet({
      client,
      owner: ownerClient,
      factory: factories[2],
      agentSigner: agent.address,
      settleWindow: 600,
      userSalt: keccak256(toHex(report.releaseFactory + "e2e")),
    });
    report.wallet = created.address;
    report.setup["agent wallet"] = created.transactionHash;
    await save();
  }
  const api = new AgentPayClient({
    wallet: report.wallet,
    chainId: 5042002,
    publicClient: client,
    owner: ownerClient,
    agent,
    factories,
    registry: at("AgentRegistry"),
    providerRegistry: at("ProviderRegistry"),
    reputationRegistry: at("ReputationRegistry"),
    vault: at("DisputeVault"),
    store: new FileAgentStore(
      resolve(CONTRACT_ROOT, "../.tools/phase3-testnet-agent-state.json"),
    ),
    policy: {
      allowedProviders: [provider.address],
      allowedTokens: [token],
      maxPerCall: 10000n,
      requireRegisteredProvider: true,
      maxDisputeWindow: 120,
    },
  });
  await setup(
    "agent deposit",
    async () => (await api.deposit(token, 1_000_000n)).transactionHash,
  );
  await setup(
    "agent budget",
    async () =>
      (await api.setProviderBudget(provider.address, token, 800_000n, 100_000n))
        .transactionHash,
  );
  await setup(
    "agent identity",
    async () =>
      (
        await api.registerAgent(
          keccak256(toHex("Sluice synthetic testnet e2e agent")),
        )
      ).transactionHash,
  );
  await setup(
    "dispute bond approval",
    async () =>
      (
        await write(ownerClient, token, erc20, "approve", [
          at("DisputeVault"),
          1_000_000n,
        ])
      ).transactionHash,
  );
  const store = new SupabaseProviderStore(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const controller = new PaymentProvider({
    provider: provider.address,
    token,
    chainId: 5042002,
    price: 10000n,
    signer: provider,
    publicClient: client,
    walletClient: providerClient,
    factories,
    store,
    vault: at("DisputeVault"),
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: controller.wrap(() =>
      Response.json({ answer: 42, environment: "synthetic testnet e2e" }),
    ),
  });
  try {
    for (const name of ["clean", "accept", "silent", "split", "timeout"]) {
      const state = report.scenarios[name] || {};
      report.scenarios[name] = state;
      if (!state.voucherId) {
        const response = await api.fetch(
          server.url + "answer?scenario=" + name,
        );
        if (!response.ok) throw Error("Paid test call failed");
        const record = (await api.store.list()).at(-1)!;
        if (!record.receipt || !(await verifyReceipt(record.receipt)))
          throw Error("Receipt signature verification failed");
        state.voucherId = record.id;
        state.status = "paid call with signed receipt";
        await save();
      }
      if (!state.settlementId) {
        await controller.settle();
        const record = await store.get(state.voucherId);
        if (!record?.commitment)
          throw Error("Settlement commitment not persisted");
        state.settlementId = record.commitment.settlementId as Hex;
        state.settleTx = record.commitment.transactionHash as Hex;
        await save();
      }
      if (name === "clean") {
        if (!state.resolveTx) {
          const s = (await client.readContract({
            address: at("DisputeVault"),
            abi: vaultAbi,
            functionName: "getSettlement",
            args: [state.settlementId],
          })) as { releaseAfter: bigint };
          state.readyAt = String(s.releaseAfter);
          if ((await client.getBlock()).timestamp >= s.releaseAfter) {
            state.resolveTx = (
              await write(
                ownerClient,
                at("DisputeVault"),
                vaultAbi,
                "release",
                [state.settlementId],
              )
            ).transactionHash;
            state.status = "passed";
          } else state.status = "waiting for dispute window";
          await save();
        }
        continue;
      }
      if (!state.openTx) {
        const record = await store.get(state.voucherId);
        state.openTx = (
          await api.openDispute({
            id: state.settlementId,
            amount: 4000n,
            reasonCode: 1,
            evidenceHash: keccak256(toHex("synthetic e2e " + name)),
            receipt: record!.receipt,
            proof: record!.commitment!.proof as Hex[],
          })
        ).transactionHash;
        await save();
      }
      if (name === "accept" && !state.resolveTx) {
        state.resolveTx = (
          await write(
            providerClient,
            at("DisputeVault"),
            vaultAbi,
            "acceptDispute",
            [state.settlementId],
          )
        ).transactionHash;
        state.status = "passed";
        await save();
      }
      if (["split", "timeout"].includes(name) && !state.respondTx) {
        state.respondTx = (
          await controller.respondToDispute(
            state.settlementId,
            keccak256(toHex("synthetic provider evidence")),
          )
        ).transactionHash;
        await save();
      }
      if (name === "split" && !state.resolveTx) {
        state.resolveTx = (
          await write(
            arbiterClient,
            at("DisputeVault"),
            vaultAbi,
            "arbiterDecide",
            [state.settlementId, 2000n, 2000n, true],
          )
        ).transactionHash;
        state.status = "passed";
        await save();
      }
      if (["silent", "timeout"].includes(name) && !state.resolveTx) {
        if (!state.undisputedReleaseTx) {
          const held = (await client.readContract({address:at("DisputeVault"),abi:vaultAbi,functionName:"getSettlement",args:[state.settlementId]})) as {releaseAfter:bigint;undisputedReleased:bigint};
          if ((await client.getBlock()).timestamp >= held.releaseAfter && held.undisputedReleased === 0n) {
            state.undisputedReleaseTx=(await write(ownerClient,at("DisputeVault"),vaultAbi,"releaseUndisputed",[state.settlementId])).transactionHash;
            await save();
          }
        }
        const d = (await client.readContract({
          address: at("DisputeVault"),
          abi: vaultAbi,
          functionName: "getDispute",
          args: [state.settlementId],
        })) as { responseDeadline: bigint; arbiterDeadline: bigint };
        const deadline =
          name === "silent" ? d.responseDeadline : d.arbiterDeadline;
        state.readyAt = String(deadline);
        if ((await client.getBlock()).timestamp >= deadline) {
          state.resolveTx = (
            await write(
              ownerClient,
              at("DisputeVault"),
              vaultAbi,
              name === "silent" ? "autoRefund" : "arbiterTimeout",
              [state.settlementId],
            )
          ).transactionHash;
          state.status = "passed";
        } else state.status = "waiting for on-chain deadline";
        await save();
      }
    }
  } finally {
    server.stop(true);
  }
  console.log(
    JSON.stringify({
      report: "contract/deployments/phase3-testnet-e2e.json",
      scenarios: report.scenarios,
    }),
  );
}
try {
  await run();
} catch (error) {
  console.error(
    "Testnet e2e stopped:",
    error instanceof Error ? error.name : "Unknown error",
    "Resume after checking the persisted report.",
  );
  process.exitCode = 1;
}
