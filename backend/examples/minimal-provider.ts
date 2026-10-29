import { createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, Address } from "viem";
import { PaymentProvider, SupabaseProviderStore } from "@sluice/middleware";
import { loadConfig } from "../src/config";
import { publicRpcTransport } from "../src/rpc";
import deployment from "../../contract/deployments/arc-testnet.json";

const config = loadConfig();
const key = process.env.PROVIDER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key))
  throw Error(
    "Set PROVIDER_PRIVATE_KEY in backend/.env; never use the owner key in an agent",
  );
if (!config.supabaseUrl || !config.supabaseKey)
  throw Error("Configure Supabase and apply both migrations");
const account = privateKeyToAccount(key as Hex);
const publicClient = createPublicClient({
  transport: publicRpcTransport(config.rpcUrls, config.chainId),
  cacheTime: 0,
});
const walletClient = createWalletClient({
  account,
  transport: publicRpcTransport(config.rpcUrls, config.chainId),
});
const payments = new PaymentProvider({
  provider: account.address,
  token: deployment.v1.contracts.AgentWalletFactory.constructorArgs
    .usdc as Address,
  chainId: config.chainId,
  price: BigInt(process.env.PRICE_USDC_BASE_UNITS || "10000"),
  signer: account,
  publicClient,
  walletClient,
  factories: config.factories,
  store: new SupabaseProviderStore(config.supabaseUrl, config.supabaseKey),
  vault: config.disputeVault,
  onDispute: async ({ id }) => {
    console.log("Provider dispute needs review:", id);
  },
});
const handle = payments.wrap(async (request) => {
  const input =
    request.method === "POST"
      ? ((await request.json()) as { question?: string })
      : {};
  return Response.json({ answer: 42, question: input.question || "hello" });
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 3002,
  async fetch(request) {
    const origin = request.headers.get("origin");
    if (origin && origin !== config.authOrigin)
      return Response.json({ error: "Origin denied" }, { status: 403 });
    const response = await handle(request);
    if (origin === config.authOrigin)
      response.headers.set("Access-Control-Allow-Origin", origin);
    response.headers.set("Vary", "Origin");
    return response;
  },
});
const stopSettler = payments.startSettler(60000, () =>
  console.error("Settlement worker failed; inspect stored channel state"),
);
const stopDisputes = config.disputeVault
  ? payments.watchDisputes(() => console.error("Dispute watcher failed"))
  : () => {};
console.log("Provider:", account.address, "API:", String(server.url));
process.on("SIGINT", () => {
  stopSettler();
  stopDisputes();
  void server.stop();
});
