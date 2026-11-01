import { createPublicClient, createWalletClient, parseEther, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentPayClient, walletAbis, verifyReceipt } from "@sluice/sdk";
import { FileAgentStore } from "@sluice/sdk/file-store";
import { channelState } from "@sluice/sdk";
import { SupabaseProviderStore } from "@sluice/middleware";
import { loadConfig } from "../../backend/src/config";
import { publicRpcTransport } from "../../backend/src/rpc";
import deployment from "../deployments/arc-testnet.json";

const reportPath = "contract/deployments/gateway-testnet-e2e.json";
const report = (await Bun.file(reportPath).exists())
  ? await Bun.file(reportPath).json() as Record<string, any>
  : { setup: {}, createdAt: new Date().toISOString() } as Record<string, any>;
if (report.status === "passed") {
  console.log(JSON.stringify({ status: "already passed", report: reportPath }));
  process.exit(0);
}
const save = () => Bun.write(reportPath, JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2) + "\n");
const base = "http://127.0.0.1:3001";
const config = loadConfig();
if (config.chainId !== 5042002) throw Error("Arc Testnet only");
const ownerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!ownerKey) throw Error("Missing local deployer key");
const owner = privateKeyToAccount(ownerKey);
const keys = await Bun.file(".tools/negotiation-testnet-keys.json").json();
const agent = privateKeyToAccount(keys.agent as Hex);
const previous = await Bun.file("contract/deployments/negotiation-testnet-e2e.json").json();
const wallet = previous.wallet as Address;
const transport = publicRpcTransport(config.rpcUrls, config.chainId);
const chain = createPublicClient({ transport, cacheTime: 0 });
const ownerClient = createWalletClient({ account: owner, transport });
const token = deployment.v1.contracts.AgentWalletFactory.constructorArgs.usdc as Address;
if (await chain.getChainId() !== 5042002) throw Error("Wrong chain");

const nonceResponse = await fetch(base + "/auth/nonce", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ address: owner.address }),
});
const challenge = await nonceResponse.json();
if (!nonceResponse.ok) throw Error("SIWE challenge failed");
const signature = await owner.signMessage({ message: challenge.message });
const loginResponse = await fetch(base + "/auth/verify", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ id: challenge.id, signature }),
});
const login = await loginResponse.json();
if (!loginResponse.ok || !login.token) throw Error("SIWE login failed");
async function api(path: string, input?: unknown) {
  const response = await fetch(base + path, {
    method: input === undefined ? "GET" : "POST",
    headers: { authorization: "Bearer " + login.token, ...(input === undefined ? {} : { "content-type": "application/json" }) },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const value = await response.json();
  if (!response.ok) throw Error(`API ${path}: ${value.error?.code || response.status} ${value.error?.message || ""}`);
  return value;
}

try {
  if (!report.service) {
    const created = await api("/managed-services", {
      name: "External repository metadata test", slug: "external-repository-metadata-test",
      kind: "http-proxy", upstreamUrl: "https://api.github.com/repos/x402-foundation/x402",
      upstreamMethod: "GET", upstreamAuth: "none", priceUsdc: "0.01", published: false,
      acceptHostedCustody: true, acceptUpstreamRights: true, acceptAttemptBilling: true,
    });
    report.service = created.service;
    report.owner = owner.address;
    report.wallet = wallet;
    await save();
  }
  const service = report.service;
  if (!report.setup.connectionTest) {
    const tested = await api(`/managed-services/${service.id}/test`, { confirm: true, payload: { query: {} } });
    if (!tested.ok || tested.status !== 200) throw Error("Real HTTPS connection test failed");
    report.setup.connectionTest = tested.status;
    await save();
  }
  if (!report.setup.funding) {
    const hash = await ownerClient.sendTransaction({ to: service.provider, value: parseEther("0.05"), chain: null });
    if ((await chain.waitForTransactionReceipt({ hash })).status !== "success") throw Error("Provider gas funding failed");
    report.setup.funding = hash;
    await save();
  }
  if (!report.setup.activation) {
    const activated = await api(`/managed-services/${service.id}/activate`, {});
    report.setup.activation = activated.service.registrationTx;
    await save();
  }
  if (!report.expiredVoucherReconciled) {
    const old = (await new FileAgentStore(".tools/gateway-testnet-agent.json").list())[0];
    if (old) {
      const accepted = await new SupabaseProviderStore(config.supabaseUrl!, config.supabaseKey!).get(old.id);
      const state = await channelState(chain, old.voucher.wallet, old.voucher.provider, old.voucher.token, old.voucher.version);
      if (accepted || state.nonce >= BigInt(old.voucher.nonce) || BigInt(old.voucher.expiry) >= BigInt(Math.floor(Date.now() / 1000)))
        throw Error("Old voucher is not safely expired/unaccepted; reconcile before another authorization");
      report.expiredVoucherReconciled = { oldVoucherHash: old.id, providerAccepted: false, onchainNonce: String(state.nonce) };
      await save();
    }
  }
  const sdkStore = new FileAgentStore(".tools/gateway-testnet-agent-reconciled.json");
  const sdk = new AgentPayClient({
    wallet, chainId: 5042002, publicClient: chain, owner: ownerClient, agent,
    factories: config.factories, providerRegistry: config.providerRegistry,
    reputationRegistry: config.reputationRegistry, vault: config.disputeVault,
    store: sdkStore,
    policy: { allowedProviders: [service.provider], allowedTokens: [token],
      allowedOrigins: [base], maxPerCall: 10000n, requireRegisteredProvider: true },
  });
  if (!report.setup.budget) {
    report.setup.budget = (await sdk.setProviderBudget(service.provider, token, 100000n, 10000n)).transactionHash;
    await save();
  }
  if (!report.setup.terms) {
    report.setup.terms = (await sdk.acceptArbitrationTerms(service.provider, token)).transactionHash;
    await save();
  }
  if (!report.setup.usdcRate) {
    const simulation = await chain.simulateContract({ address: wallet, abi: walletAbis[3],
      functionName: "setTokenRate", args: [token, 1000000n, 6], account: owner });
    const hash = await ownerClient.writeContract({ ...simulation.request, account: owner, chain: null });
    if ((await chain.waitForTransactionReceipt({ hash })).status !== "success") throw Error("USDC rate setup failed");
    report.setup.usdcRate = hash;
    await save();
  }
  const input = JSON.stringify({ query: {} });
  const unpaid = await fetch(service.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: input });
  if (unpaid.status !== 402) throw Error(`Unpaid gateway returned ${unpaid.status}, expected 402`);
  report.unpaidStatus = unpaid.status;
  if (!report.paid) {
    const paid = await sdk.fetch(service.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: input });
    const result = await paid.json();
    if (paid.status !== 200 || result.full_name !== "x402-foundation/x402") throw Error(`External paid result failed: ${paid.status}`);
    const calls = await sdkStore.list();
    if (calls.length !== 1 || !calls[0].receipt || !(await verifyReceipt(calls[0].receipt))) throw Error("Signed receipt verification failed");
    report.paid = { status: paid.status, repository: result.full_name, receiptVerified: true, voucherHash: calls[0].id };
    await save();
  }
  if (!report.settlement) {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      let receipts: any;
      try {
        receipts = await api(`/receipts?provider=${service.provider}`);
      } catch (error) {
        if (!String(error).includes("DATABASE_UNAVAILABLE")) throw error;
        await Bun.sleep(5000);
        continue;
      }
      const item = receipts.items.find((entry: any) => entry.receipt.receipt.voucherHash === report.paid.voucherHash);
      if (item?.commitment) {
        report.settlement = { transactionHash: item.commitment.transactionHash, settlementId: item.commitment.settlementId };
        await save();
        break;
      }
      await Bun.sleep(5000);
    }
    if (!report.settlement) throw Error("Automatic settlement did not complete");
  }
  await api(`/managed-services/${service.id}/pause`, {});
  report.status = "passed";
  await save();
  console.log(JSON.stringify({ status: report.status, serviceId: service.id,
    connectionTest: report.setup.connectionTest, paid: report.paid.status,
    receiptVerified: report.paid.receiptVerified, settlement: report.settlement.transactionHash }));
} finally {
  await fetch(base + "/auth/logout", { method: "POST", headers: { authorization: "Bearer " + login.token } });
}
