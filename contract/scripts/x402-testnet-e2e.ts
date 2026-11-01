import { resolve } from "node:path";
import { createPublicClient, createWalletClient, parseEther, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { toClientEvmSigner } from "@x402/evm";
import { loadConfig } from "../../backend/src/config";
import { publicRpcTransport } from "../../backend/src/rpc";

const reportPath = "contract/deployments/x402-testnet-e2e.json";
const gateway = await Bun.file("contract/deployments/gateway-testnet-e2e.json").json();
const endpoint = gateway.service?.x402Endpoint as string | undefined;
if (!endpoint) throw Error("Run gateway-testnet-e2e.ts through service creation first");
const report = (await Bun.file(reportPath).exists())
  ? await Bun.file(reportPath).json() as Record<string, any>
  : { serviceId: gateway.service.id, createdAt: new Date().toISOString() } as Record<string, any>;
if (report.status === "passed") {
  console.log(JSON.stringify({ status: "already passed", report: reportPath }));
  process.exit(0);
}
const save = () => Bun.write(reportPath, JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2) + "\n");
const config = loadConfig();
if (config.chainId !== 5042002) throw Error("Arc Testnet only");
const keys = await Bun.file(".tools/negotiation-testnet-keys.json").json();
const account = privateKeyToAccount(keys.agent as Hex);
const publicClient = createPublicClient({ transport: publicRpcTransport(config.rpcUrls, config.chainId) });
const ownerKey = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
if (!ownerKey) throw Error("Missing local owner key for testnet funding");
const owner = privateKeyToAccount(ownerKey);
const ownerClient = createWalletClient({ account: owner, transport: publicRpcTransport(config.rpcUrls, config.chainId) });
if (!report.nativeFunding) {
  const hash = await ownerClient.sendTransaction({ to: account.address, value: parseEther("0.1"), chain: null });
  if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw Error("Agent gas funding failed");
  report.nativeFunding = hash;
  await save();
}
if (!report.usdcFunding) {
  const hash = await ownerClient.writeContract({
    address: gateway.service.token,
    abi: parseAbi(["function transfer(address to,uint256 value) returns(bool)"]),
    functionName: "transfer", args: [account.address, 500000n], chain: null,
  });
  if ((await publicClient.waitForTransactionReceipt({ hash })).status !== "success") throw Error("Agent USDC funding failed");
  report.usdcFunding = hash;
  await save();
}
const scheme = new BatchSettlementEvmScheme(toClientEvmSigner(account, publicClient), {
  storage: new FileClientChannelStorage({ directory: resolve(".tools/x402-testnet-client") }),
});
const http = new x402HTTPClient(new x402Client().register(`eip155:${config.chainId}`, scheme));
const input = JSON.stringify({ query: {} });
const request = () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: input });
const first = await request();
if (first.status !== 402 || !first.headers.has("payment-required"))
  throw Error(`Expected unpaid x402 challenge, got ${first.status}`);
report.unpaidStatus = first.status;
await save();
const required = http.getPaymentRequiredResponse((name) => first.headers.get(name), await first.json());
const payment = await http.createPaymentPayload(required);
const paid = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json", ...http.encodePaymentSignatureHeader(payment) },
  body: input,
});
await http.processPaymentResult(payment, (name) => paid.headers.get(name), paid.status);
const result = await paid.json();
if (!paid.ok || result.full_name !== "x402-foundation/x402")
  throw Error(`Paid x402 result failed: ${paid.status} ${result.error || ""}`);
report.paidStatus = paid.status;
report.repository = result.full_name;
report.paymentResponse = paid.headers.has("payment-response");
await save();

const base = "http://127.0.0.1:3001";
const challenge = await (await fetch(base + "/auth/nonce", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: owner.address }) })).json();
const signature = await owner.signMessage({ message: challenge.message });
const login = await (await fetch(base + "/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: challenge.id, signature }) })).json();
if (!login.token) throw Error("Owner login failed");
try {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const response = await fetch(base + "/managed-services", { headers: { authorization: "Bearer " + login.token } });
    if (!response.ok) throw Error("Could not read hosted worker status");
    const list = await response.json();
    const service = list.items.find((item: any) => item.id === gateway.service.id);
    if (service?.workerError) throw Error(`Worker stopped: ${service.workerError}`);
    if (service?.lastSettlementTx) {
      report.settlementTransaction = service.lastSettlementTx;
      report.status = "passed";
      await save();
      console.log(JSON.stringify({ status: report.status, serviceId: report.serviceId, unpaid: report.unpaidStatus,
        paid: report.paidStatus, paymentResponse: report.paymentResponse, settlement: report.settlementTransaction }));
      break;
    }
    await Bun.sleep(5000);
  }
  if (report.status !== "passed") throw Error("x402 settlement worker did not complete");
} finally {
  await fetch(base + "/auth/logout", { method: "POST", headers: { authorization: "Bearer " + login.token } });
}
