import {
  createPublicClient,
  createWalletClient,
  keccak256,
  getAddress,
  type Address,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolve } from "node:path";
import { loadConfig } from "../../backend/src/config";
import { publicRpcTransport } from "../../backend/src/rpc";
const root = resolve(import.meta.dir, "..");
export const negotiationArtifact = async (name: string) =>
  Bun.file(resolve(root, "out", name + ".sol", name + ".json")).json();
function verify(compiled: any, actual: Hex) {
  const normalize = (code: string) => {
    let out = code.slice(2).toLowerCase();
    for (const slots of Object.values(
      compiled.deployedBytecode.immutableReferences || {},
    ) as { start: number; length: number }[][])
      for (const slot of slots)
        out =
          out.slice(0, slot.start * 2) +
          "0".repeat(slot.length * 2) +
          out.slice((slot.start + slot.length) * 2);
    return out;
  };
  if (normalize(actual) !== normalize(compiled.deployedBytecode.object))
    throw Error("Runtime verification failed");
}
export async function deployNegotiation(
  client: PublicClient,
  signer: WalletClient,
  options: {
    providerRegistry: Address;
    reputationRegistry: Address;
    agentRegistry?: Address;
    arbiter: Address;
    token: Address;
    feeRecipient: Address;
    feeBps: number;
    checkpoint?: (value: any) => Promise<void>;
  },
) {
  const chainId = await client.getChainId();
  if (![31337, 5042002].includes(chainId) || !signer.account)
    throw Error("Local or Arc Testnet signer required");
  const record: any = {
    chainId,
    deployedAt: new Date().toISOString(),
    contracts: {},
    configurationTransactions: [],
    policy: {
      negotiationSeconds: 1800,
      arbitrationSeconds: 86400,
      timeout: "refund disputed principal and bond",
      maxDisputeUsdc: "100",
      bondUsdc: "0.1",
      arbiter: options.arbiter,
    },
    sourceHashes: {},
  };
  for (const name of [
    "NegotiationDisputeVault",
    "NegotiationAgentWallet",
    "NegotiationWalletFactory",
  ])
    record.sourceHashes[name] = keccak256(
      new Uint8Array(
        await Bun.file(resolve(root, "src", name + ".sol")).arrayBuffer(),
      ),
    );
  const save = () => options.checkpoint?.(record);
  async function deploy(name: string, args: unknown[]) {
    const artifact = await negotiationArtifact(name);
    const hash = await signer.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args,
      account: signer.account!,
      chain: signer.chain,
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw Error("Deployment failed");
    const actual = await client.getBytecode({
      address: receipt.contractAddress,
    });
    if (!actual) throw Error("Missing runtime");
    verify(artifact, actual);
    record.contracts[name] = {
      address: receipt.contractAddress,
      txHash: hash,
      blockNumber: String(receipt.blockNumber),
      constructorArgs: args,
      runtimeHash: keccak256(actual),
    };
    await save();
    return receipt.contractAddress;
  }
  async function write(
    address: Address,
    name: string,
    method: string,
    args: unknown[],
  ) {
    const artifact = await negotiationArtifact(name);
    const simulated = await client.simulateContract({
      address,
      abi: artifact.abi,
      functionName: method,
      args,
      account: signer.account!,
    });
    const hash = await signer.writeContract({
      ...simulated.request,
      account: signer.account!,
      chain: signer.chain,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Configuration failed");
    record.configurationTransactions.push(hash);
    await save();
  }
  const vault = await deploy("NegotiationDisputeVault", [
    options.arbiter,
    options.providerRegistry,
    options.reputationRegistry,
  ]);
  const factory = await deploy("NegotiationWalletFactory", [
    options.feeRecipient,
    options.feeBps,
    [options.token],
    vault,
    options.providerRegistry,
    options.reputationRegistry,
  ]);
  await write(vault, "NegotiationDisputeVault", "setTrustedFactory", [
    factory,
    true,
  ]);
  await write(vault, "NegotiationDisputeVault", "setDisputeBond", [
    options.token,
    100000n,
  ]);
  await write(vault, "NegotiationDisputeVault", "setMaxDisputeAmount", [
    options.token,
    100000000n,
  ]);
  await write(
    options.reputationRegistry,
    "ReputationRegistry",
    "setTrustedFactory",
    [factory, true],
  );
  await write(
    options.reputationRegistry,
    "ReputationRegistry",
    "setTrustedCaller",
    [vault, true],
  );
  if (options.agentRegistry)
    await write(options.agentRegistry, "AgentRegistry", "setTrustedFactory", [
      factory,
      true,
    ]);
  return record;
}
if (import.meta.main) {
  const config = loadConfig(),
    transport = publicRpcTransport(config.rpcUrls, config.chainId),
    client = createPublicClient({ transport, cacheTime: 0 });
  if ((await client.getChainId()) !== 5042002) throw Error("Arc Testnet only");
  const key = process.env.DEPLOYER_PRIVATE_KEY as Hex;
  if (!key) throw Error("Set the local deployer key");
  const account = privateKeyToAccount(key),
    signer = createWalletClient({ account, transport });
  const manifestPath = resolve(root, "deployments/arc-testnet.json"),
    manifest = await Bun.file(manifestPath).json();
  const getter = [
    {
      type: "function",
      name: "admin",
      stateMutability: "view",
      inputs: [],
      outputs: [{ type: "address" }],
    },
  ] as const;
  for (const at of [config.reputationRegistry, config.agentRegistry])
    if (
      !at ||
      (
        await client.readContract({
          address: at,
          abi: getter,
          functionName: "admin",
        })
      ).toLowerCase() !== account.address.toLowerCase()
    )
      throw Error("The deployer must administer the shared registries");
  const arbiter = (await client.readContract({
    address: config.disputeVault!,
    abi: [
      {
        type: "function",
        name: "defaultArbiter",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
      },
    ],
    functionName: "defaultArbiter",
  })) as Address;
  const fees = manifest.v3.contracts.AgentWalletFactoryV3.constructorArgs;
  if (!process.argv.includes("--broadcast")) {
    console.log(
      JSON.stringify({
        mode: "preflight",
        chainId: config.chainId,
        arbiter,
        feeBps: fees[1],
        contracts: ["NegotiationDisputeVault", "NegotiationWalletFactory"],
        policy:
          "30-minute negotiation; 24-hour fixed final arbitration deadline; timeout refunds disputed principal and bond; 100 USDC claim cap",
      }),
    );
    process.exit(0);
  }
  if (manifest.v3.contracts.DisputeVault.negotiationVersion === 1)
    throw Error(
      "Negotiated deployment is already canonical; do not redeploy it blindly",
    );
  const journal = resolve(
    root,
    "deployments/negotiation-pending-" + Date.now() + ".json",
  );
  const record = await deployNegotiation(client, signer, {
    providerRegistry: config.providerRegistry!,
    reputationRegistry: config.reputationRegistry!,
    agentRegistry: config.agentRegistry,
    arbiter,
    token: getAddress(
      manifest.v1.contracts.AgentWalletFactory.constructorArgs.usdc,
    ),
    feeRecipient: fees[0],
    feeBps: Number(fees[1]),
    checkpoint: (value) =>
      Bun.write(journal, JSON.stringify(value, null, 2)).then(() => {}),
  });
  manifest.history = [
    ...(manifest.history || []),
    { v3: structuredClone(manifest.v3) },
  ];
  manifest.v3 = {
    ...manifest.v3,
    deployedAt: record.deployedAt,
    contracts: {
      ...manifest.v3.contracts,
      AgentWalletFactoryV3: {
        ...record.contracts.NegotiationWalletFactory,
        contractName: "NegotiationWalletFactory",
      },
      DisputeVault: {
        ...record.contracts.NegotiationDisputeVault,
        contractName: "NegotiationDisputeVault",
        negotiationVersion: 1,
      },
    },
    negotiationPolicy: record.policy,
  };
  await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  await Bun.write(
    resolve(root, "deployments/negotiation-arc-testnet.json"),
    JSON.stringify(record, null, 2) + "\n",
  );
  const envPath = resolve(root, "../backend/.env");
  let env = await Bun.file(envPath).text();
  for (const [key, value] of Object.entries({
    FACTORY_V3_ADDRESS: record.contracts.NegotiationWalletFactory.address,
    DISPUTE_VAULT_ADDRESS: record.contracts.NegotiationDisputeVault.address,
  })) {
    const line = new RegExp("^" + key + "=.*$", "m");
    env = line.test(env)
      ? env.replace(line, key + "=" + value)
      : env + "\n" + key + "=" + value;
  }
  await Bun.write(envPath, env);
  console.log(
    JSON.stringify({
      status: "deployed",
      factory: record.contracts.NegotiationWalletFactory.address,
      vault: record.contracts.NegotiationDisputeVault.address,
      legacyPreserved: true,
    }),
  );
}
