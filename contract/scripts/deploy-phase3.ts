import {
  createPublicClient,
  createWalletClient,
  getAddress,
  isHex,
  keccak256,
  type Address,
  type Abi,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mkdir, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { ARC_PUBLIC_RPCS } from "../../backend/src/config";
import { publicRpcTransport } from "../../backend/src/rpc";
import { CONTRACT_ROOT } from "./workspace-paths";
export type DeployedContract = {
  address: Address;
  txHash: Hex;
  blockNumber: string;
  constructorArgs: unknown[];
  runtimeHash: Hex;
};
export type Suite = {
  chainId: number;
  deployedAt: string;
  feeBps: number;
  feeRecipient: Address;
  usdc: Address;
  contracts: Record<string, DeployedContract>;
  configurationTransactions: Hex[];
  build: {
    solc: string;
    optimizerRuns: number;
    evmVersion: string;
    sourceHashes: Record<string, string>;
  };
};
type Artifact = {
  abi: Abi;
  bytecode: { object: Hex };
  deployedBytecode: {
    object: Hex;
    immutableReferences: Record<string, { start: number; length: number }[]>;
  };
};
const artifact = async (name: string) =>
  Bun.file(
    resolve(CONTRACT_ROOT, "out", name + ".sol", name + ".json"),
  ).json() as Promise<Artifact>;
function verifyRuntime(compiled: Artifact, actual: Hex) {
  const normalize = (code: Hex) => {
    let value = code.slice(2).toLowerCase();
    for (const positions of Object.values(
      compiled.deployedBytecode.immutableReferences || {},
    ))
      for (const item of positions)
        value =
          value.slice(0, item.start * 2) +
          "0".repeat(item.length * 2) +
          value.slice((item.start + item.length) * 2);
    return value;
  };
  if (normalize(compiled.deployedBytecode.object) !== normalize(actual))
    throw Error("Deployed runtime does not match compiled artifact");
}
export async function deploySuite(
  client: PublicClient,
  wallet: WalletClient,
  options: {
    usdc: Address;
    feeRecipient: Address;
    feeBps: number;
    arbiter: Address;
    legacyFactories?: Address[];
    checkpoint?: (suite: Suite) => Promise<void>;
  },
): Promise<Suite> {
  if (!wallet.account) throw Error("Deployment signer required");
  const chainId = await client.getChainId();
  if (
    ![31337, 5042002].includes(chainId) ||
    (await wallet.getChainId()) !== chainId
  )
    throw Error("Only Arc Testnet or local development deployment allowed");
  if (
    !Number.isInteger(options.feeBps) ||
    options.feeBps < 0 ||
    options.feeBps > 500
  )
    throw Error("Invalid fee");
  const sourceHashes: Record<string, string> = {};
  for (const file of (await readdir(resolve(CONTRACT_ROOT, "src")))
    .filter((f) => f.endsWith(".sol"))
    .sort())
    sourceHashes[file] = keccak256(
      new Uint8Array(
        await Bun.file(resolve(CONTRACT_ROOT, "src", file)).arrayBuffer(),
      ),
    );
  const suite: Suite = {
    chainId,
    deployedAt: new Date().toISOString(),
    feeBps: options.feeBps,
    feeRecipient: options.feeRecipient,
    usdc: options.usdc,
    contracts: {},
    configurationTransactions: [],
    build: {
      solc: "0.8.28",
      optimizerRuns: 200,
      evmVersion: "cancun",
      sourceHashes,
    },
  };
  async function deploy(name: string, args: unknown[]) {
    const compiled = await artifact(name),
      hash = await wallet.deployContract({
        abi: compiled.abi,
        bytecode: compiled.bytecode.object,
        args,
        account: wallet.account!,
        chain: wallet.chain,
      });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success" || !receipt.contractAddress)
      throw Error(name + " deployment reverted");
    const code = await client.getBytecode({ address: receipt.contractAddress });
    if (!code || code === "0x") throw Error("Missing deployed code");
    verifyRuntime(compiled, code);
    suite.contracts[name] = {
      address: receipt.contractAddress,
      txHash: hash,
      blockNumber: String(receipt.blockNumber),
      constructorArgs: args,
      runtimeHash: keccak256(code),
    };
    await options.checkpoint?.(suite);
    console.log(name, receipt.contractAddress, hash);
    return receipt.contractAddress;
  }
  async function configure(
    name: string,
    functionName: string,
    args: unknown[],
  ) {
    const compiled = await artifact(name),
      address = suite.contracts[name].address;
    const { request } = await client.simulateContract({
      address,
      abi: compiled.abi,
      functionName,
      args,
      account: wallet.account!,
    });
    const hash = await wallet.writeContract({
      ...request,
      account: wallet.account!,
      chain: wallet.chain,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Deployment configuration reverted");
    suite.configurationTransactions.push(hash);
    await options.checkpoint?.(suite);
  }
  const v1 = await deploy("AgentWalletFactory", [
    options.usdc,
    options.feeRecipient,
    options.feeBps,
  ]);
  const v2 = await deploy("AgentWalletFactoryV2", [
    options.feeRecipient,
    options.feeBps,
    [options.usdc],
  ]);
  const providers = await deploy("ProviderRegistry", []),
    reputation = await deploy("ReputationRegistry", []);
  const vault = await deploy("DisputeVault", [
    options.arbiter,
    providers,
    reputation,
  ]);
  const v3 = await deploy("AgentWalletFactoryV3", [
    options.feeRecipient,
    options.feeBps,
    [options.usdc],
    vault,
    providers,
    reputation,
  ]);
  await deploy("AgentRegistry", [
    [v1, v2, v3, ...(options.legacyFactories || [])],
  ]);
  await configure("DisputeVault", "setTrustedFactory", [v3, true]);
  await configure("ReputationRegistry", "setTrustedFactory", [v3, true]);
  await configure("ReputationRegistry", "setTrustedCaller", [vault, true]);
  await configure("DisputeVault", "setDisputeBond", [options.usdc, 100000n]);
  for (const name of ["DisputeVault", "ReputationRegistry"]) {
    const compiled = await artifact(name);
    if (
      !(await client.readContract({
        address: suite.contracts[name].address,
        abi: compiled.abi,
        functionName: "trustedFactory",
        args: [v3],
      }))
    )
      throw Error("Factory permission verification failed");
  }
  return suite;
}

export async function writeRelease(suite: Suite) {
  if (suite.chainId !== 5042002)
    throw Error("Local results cannot overwrite the testnet manifest");
  const manifestPath = resolve(CONTRACT_ROOT, "deployments/arc-testnet.json"),
    previous = await Bun.file(manifestPath).json();
  const stamp = suite.deployedAt.replaceAll(":", "-").replaceAll(".", "-");
  await Bun.write(
    resolve(CONTRACT_ROOT, "deployments", "arc-testnet-" + stamp + ".json"),
    JSON.stringify(
      suite,
      (_, v) => (typeof v === "bigint" ? String(v) : v),
      2,
    ) + "\n",
  );
  const next = {
    ...previous,
    chainId: suite.chainId,
    v1: {
      deployedAt: suite.deployedAt,
      contracts: { AgentWalletFactory: suite.contracts.AgentWalletFactory },
    },
    v2: {
      deployedAt: suite.deployedAt,
      contracts: { AgentWalletFactoryV2: suite.contracts.AgentWalletFactoryV2 },
    },
    v3: {
      deployedAt: suite.deployedAt,
      contracts: Object.fromEntries(
        Object.entries(suite.contracts).filter(
          ([name]) =>
            !["AgentWalletFactory", "AgentWalletFactoryV2"].includes(name),
        ),
      ),
    },
    history: [
      ...(previous.history || []),
      {
        v1: previous.v1,
        v2: previous.v2,
        ...(previous.v3 ? { v3: previous.v3 } : {}),
      },
    ],
  };
  // Keep the original frontend-compatible constructor configuration shape.
  (
    next.v1.contracts.AgentWalletFactory as unknown as {
      constructorArgs: unknown;
    }
  ).constructorArgs = {
    usdc: suite.usdc,
    feeRecipient: suite.feeRecipient,
    feeBps: suite.feeBps,
  };
  (
    next.v2.contracts.AgentWalletFactoryV2 as unknown as {
      constructorArgs: unknown;
    }
  ).constructorArgs = {
    feeRecipient: suite.feeRecipient,
    feeBps: suite.feeBps,
    initialTokens: [suite.usdc],
  };
  await Bun.write(
    manifestPath,
    JSON.stringify(next, (_, v) => (typeof v === "bigint" ? String(v) : v), 2) +
      "\n",
  );
  const envPath = resolve(CONTRACT_ROOT, "../backend/.env");
  if (await Bun.file(envPath).exists()) {
    let value = await Bun.file(envPath).text();
    const variables: Record<string, string> = {
      FACTORY_V1_ADDRESS: suite.contracts.AgentWalletFactory.address,
      FACTORY_V2_ADDRESS: suite.contracts.AgentWalletFactoryV2.address,
      FACTORY_V3_ADDRESS: suite.contracts.AgentWalletFactoryV3.address,
      AGENT_REGISTRY_ADDRESS: suite.contracts.AgentRegistry.address,
      PROVIDER_REGISTRY_ADDRESS: suite.contracts.ProviderRegistry.address,
      REPUTATION_REGISTRY_ADDRESS: suite.contracts.ReputationRegistry.address,
      DISPUTE_VAULT_ADDRESS: suite.contracts.DisputeVault.address,
    };
    for (const [key, address] of Object.entries(variables)) {
      const pattern = new RegExp("^" + key + "=.*$", "m");
      value = pattern.test(value)
        ? value.replace(pattern, key + "=" + address)
        : value + "\n" + key + "=" + address;
    }
    await Bun.write(envPath, value);
  }
}
if (import.meta.main) {
  try {
    const key = process.env.DEPLOYER_PRIVATE_KEY;
    if (!key || !isHex(key) || key.length !== 66)
      throw Error("Fill DEPLOYER_PRIVATE_KEY in contract/.env");
    const account = privateKeyToAccount(key),
      override = process.env.RPC_URLS?.trim() || process.env.RPC_URL?.trim(),
      urls = override
        ? override
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : [...ARC_PUBLIC_RPCS];
    if (process.env.ALCHEMY_RPC_URL) urls.push(process.env.ALCHEMY_RPC_URL);
    const client = createPublicClient({
      transport: publicRpcTransport(urls, 5042002),
      cacheTime: 0,
    });
    const wallet = createWalletClient({
      account,
      transport: publicRpcTransport(urls, 5042002),
    });
    const options = {
      usdc: getAddress(
        process.env.USDC_ADDRESS ||
          "0x3600000000000000000000000000000000000000",
      ),
      feeRecipient: getAddress(process.env.FEE_RECIPIENT || account.address),
      feeBps: Number(process.env.FEE_BPS || 30),
      arbiter: getAddress(
        process.env.DEFAULT_ARBITER_ADDRESS || account.address,
      ),
    };
    if ((await client.getChainId()) !== 5042002)
      throw Error("Wrong deployment chain");
    const nativeBalance = await client.getBalance({ address: account.address });
    if (nativeBalance === 0n)
      throw Error("Deployment signer needs testnet gas");
    if (!Bun.argv.includes("--broadcast")) {
      console.log(
        JSON.stringify({
          mode: "preflight",
          chainId: 5042002,
          deployer: account.address,
          nativeBalance: String(nativeBalance),
          ...options,
        }),
      );
      process.exit(0);
    }
    const current = await Bun.file(
      resolve(CONTRACT_ROOT, "deployments/arc-testnet.json"),
    ).json();
    const legacyFactories = [
      current.v1.contracts.AgentWalletFactory.address,
      current.v2.contracts.AgentWalletFactoryV2.address,
    ] as Address[];
    const journal = resolve(
      CONTRACT_ROOT,
      "deployments",
      "pending-arc-testnet-" + Date.now() + ".json",
    );
    const suite = await deploySuite(client, wallet, {
      ...options,
      legacyFactories,
      checkpoint: (value) =>
        Bun.write(
          journal,
          JSON.stringify(
            value,
            (_, v) => (typeof v === "bigint" ? String(v) : v),
            2,
          ),
        ).then(() => {}),
    });
    await writeRelease(suite);
    console.log(
      "Arc Testnet release written; keep historical deployment records.",
    );
  } catch (error) {
    console.error(
      "Deployment stopped:",
      error instanceof Error ? error.name : "Unknown error",
    );
    process.exitCode = 1;
  }
}
