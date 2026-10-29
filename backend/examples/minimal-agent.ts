import { createPublicClient, type Hex, type Address, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentPayClient, detectWallet } from "@sluice/sdk";
import { FileAgentStore } from "@sluice/sdk/file-store";
import { resolve } from "node:path";
import { loadConfig } from "../src/config";
import { publicRpcTransport } from "../src/rpc";
import deployment from "../../contract/deployments/arc-testnet.json";

const config = loadConfig(),
  key = process.env.AGENT_SIGNER_PRIVATE_KEY;
const wallet = process.env.AGENT_WALLET_ADDRESS,
  provider = process.env.PROVIDER_ADDRESS;
if (
  !key ||
  !/^0x[0-9a-fA-F]{64}$/.test(key) ||
  !wallet ||
  !isAddress(wallet) ||
  !provider ||
  !isAddress(provider)
)
  throw Error(
    "Set agent signer, agent wallet and allowed provider in backend/.env",
  );
const publicClient = createPublicClient({
  transport: publicRpcTransport(config.rpcUrls, config.chainId),
  cacheTime: 0,
});
const version = await detectWallet(publicClient, wallet, config.factories);
const url = process.env.PROVIDER_URL || "http://127.0.0.1:3002/answer";
const client = new AgentPayClient({
  wallet,
  chainId: config.chainId,
  publicClient,
  agent: privateKeyToAccount(key as Hex),
  factories: config.factories,
  providerRegistry: config.providerRegistry,
  reputationRegistry: config.reputationRegistry,
  vault: config.disputeVault,
  store: new FileAgentStore(
    resolve(import.meta.dir, "../../.tools/minimal-agent.agentpay-state.json"),
  ),
  policy: {
    allowedProviders: [provider],
    allowedTokens: [
      deployment.v1.contracts.AgentWalletFactory.constructorArgs
        .usdc as Address,
    ],
    allowedOrigins: [new URL(url).origin],
    maxPerCall: 10000n,
    ...(version === 3
      ? { requireRegisteredProvider: true, maxDisputeWindow: 86400 }
      : {}),
  },
});
const response = await client.fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ question: "hello" }),
});
console.log("API status:", response.status);
console.log(await response.json());
