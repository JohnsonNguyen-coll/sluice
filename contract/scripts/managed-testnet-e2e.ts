import {
  createPublicClient,
  createWalletClient,
  parseEther,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentPayClient, negotiationAbi, verifyReceipt } from "@sluice/sdk";
import { FileAgentStore } from "@sluice/sdk/file-store";
import { loadConfig } from "../../backend/src/config";
import { publicRpcTransport } from "../../backend/src/rpc";
import deployment from "../deployments/arc-testnet.json";
const path = "contract/deployments/managed-testnet-e2e.json";
const report: any = (await Bun.file(path).exists())
  ? await Bun.file(path).json()
  : { setup: {}, createdAt: new Date().toISOString() };
if (report.status === "passed") {
  console.log(JSON.stringify({ status: "already passed", report: path }));
  process.exit(0);
}
const save = () => Bun.write(path, JSON.stringify(report, null, 2) + "\n");
const config = loadConfig(),
  base = "http://127.0.0.1:3001",
  owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY as Hex),
  keys = await Bun.file(".tools/negotiation-testnet-keys.json").json(),
  agent = privateKeyToAccount(keys.agent);
if (config.chainId !== 5042002) throw Error("Arc Testnet only");
const transport = publicRpcTransport(config.rpcUrls, config.chainId),
  client = createPublicClient({ transport, cacheTime: 0 }),
  ownerClient = createWalletClient({ account: owner, transport }),
  previous = await Bun.file(
    "contract/deployments/negotiation-testnet-e2e.json",
  ).json(),
  wallet = previous.wallet as Address;
if ((await client.getChainId()) !== 5042002) throw Error("Wrong chain");
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
async function api(path: string, value?: unknown) {
  const r = await fetch(base + path, {
    method: value === undefined ? "GET" : "POST",
    headers: {
      Authorization: "Bearer " + auth.token,
      ...(value === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: value === undefined ? undefined : JSON.stringify(value),
  });
  const data = await r.json();
  if (!r.ok)
    throw Error("API " + path + ": " + (data.error?.message || r.status));
  return data;
}
try {
  if (!report.service) {
    const created = await api("/managed-services", {
      name: "Hosted text analysis integration",
      slug: "hosted-text-integration",
      kind: "text-analysis",
      priceUsdc: "0.01",
      published: false,
      acceptHostedCustody: true,
    });
    report.service = created.service;
    report.chainId = 5042002;
    report.owner = owner.address;
    report.wallet = wallet;
    await save();
  }
  const service = report.service;
  if (!report.setup.funding) {
    const hash = await ownerClient.sendTransaction({
      to: service.provider,
      value: parseEther("0.25"),
      chain: null,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Provider gas funding failed");
    report.setup.funding = hash;
    await save();
  }
  if (!report.setup.activation) {
    const activated = await api(
      "/managed-services/" + service.id + "/activate",
      {},
    );
    report.service = activated.service;
    report.setup.activation = activated.service.registrationTx;
    await save();
  }
  const agentStore = new FileAgentStore(".tools/managed-testnet-agent.json"),
    sdk = new AgentPayClient({
      wallet,
      chainId: 5042002,
      publicClient: client,
      owner: ownerClient,
      agent,
      factories: config.factories,
      providerRegistry: config.providerRegistry,
    reputationRegistry: config.reputationRegistry,
      vault: config.disputeVault,
      store: agentStore,
      policy: {
        allowedProviders: [service.provider],
        allowedTokens: [
          deployment.v1.contracts.AgentWalletFactory.constructorArgs
            .usdc as Address,
        ],
        allowedOrigins: [base],
        maxPerCall: 10000n,
        requireRegisteredProvider: true,
      },
    });
  const token = deployment.v1.contracts.AgentWalletFactory.constructorArgs
    .usdc as Address;
  if (!report.setup.budget) {
    report.setup.budget = (
      await sdk.setProviderBudget(service.provider, token, 100000n, 10000n)
    ).transactionHash;
    await save();
  }
  if (!report.setup.batchBudget) { report.setup.batchBudget=(await sdk.setProviderBudget(service.provider,token,100000n,100000n)).transactionHash; await save(); }
  if (!report.setup.terms) {
    report.setup.terms = (
      await sdk.acceptArbitrationTerms(service.provider, token)
    ).transactionHash;
    await save();
  }
  const noPayment = await fetch(service.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "No unpaid execution" }),
  });
  if (noPayment.status !== 402) throw Error("Unpaid call was not challenged");
  report.unpaidStatus = 402;
  let calls = await agentStore.list();
  while (calls.length < 2) {
    const response = await sdk.fetch(service.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Agents can pay for useful APIs through Sluice.",
      }),
    });
    const output = await response.json();
    if (response.status !== 200 || output.words !== 8 || output.sentences !== 1)
      throw Error("Hosted API did not return computed text analysis");
    report.output = output;
    calls = await agentStore.list();
    report.paidCalls = calls.length;
    await save();
  }
  if (!calls.every((c) => !!c.receipt)) throw Error("Signed receipts missing");
  for (const call of calls)
    if (!(await verifyReceipt(call.receipt!)))
      throw Error("Invalid signed receipt");
  report.receiptsVerified = true;
  await save();
  let stored: any;
  const end = Date.now() + 150000;
  while (Date.now() < end) {
    const list = await api("/receipts?provider=" + service.provider);
    stored = list.items.find((r: any) => r.receipt.receipt.voucherHash === calls.at(-1)!.id);
    if (stored?.commitment) break;
    console.log("Waiting for automatic hosted settlement...");
    await Bun.sleep(5000);
  }
  if (!stored?.commitment)
    throw Error(
      "Automatic settlement did not complete; inspect hosted worker status",
    );
  report.automaticSettlement = stored.commitment.transactionHash;
  report.settlementId = stored.commitment.settlementId;
  report.workerWasAutomatic = true;
  await save();
  const id = stored.commitment.settlementId as Hex,
    receipt = calls.at(-1)!.receipt!;
  if (!report.setup.bondAllowance) {
    const abi = [
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
    const hash = await ownerClient.writeContract({
      address: token,
      abi,
      functionName: "approve",
      args: [config.disputeVault!, 100000n],
      chain: null,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Bond allowance failed");
    report.setup.bondAllowance = hash;
    await save();
  }
  async function write(name: string, args: unknown[]) {
    const simulation = await client.simulateContract({
      address: config.disputeVault!,
      abi: negotiationAbi,
      functionName: name,
      args,
      account: owner,
    });
    const hash = await ownerClient.writeContract({
      ...simulation.request,
      account: owner,
      chain: null,
    });
    if ((await client.waitForTransactionReceipt({ hash })).status !== "success")
      throw Error("Dispute transaction failed");
    return hash;
  }
  if (!report.setup.claim) {
    report.setup.claim = await write("openDisputeWithReceipt", [
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
      keccak256(
        toHex(
          "Integration exercise of negotiated refund; not a service defect",
        ),
      ),
    ]);
    await save();
  }
  const evidence = await api("/disputes/" + id + "/evidence", {
    content:
      "Integration exercise: the actual hosted text tool returned correct metrics. Both controlled test parties agree to exercise a partial refund.",
  });
  if (!report.setup.providerProposal) {
    const result = await api("/disputes/" + id + "/managed-provider", {
      action: "propose",
      refund: "2000",
      returnBond: true,
      evidenceHash: evidence.evidenceHash,
    });
    report.setup.providerProposal = result.transactionHash;
    await save();
  }
  if (!report.setup.agreement) {
    const state = await api("/disputes/" + id);
    report.setup.agreement = await write("acceptResolution", [
      id,
      state.negotiation.proposal.hash,
    ]);
    await save();
  }
  const final = await api("/disputes/" + id);
  if (!final.dispute.resolved) throw Error("Hosted refund was not resolved");
  if (!report.setup.pause) {
    await api("/managed-services/" + service.id + "/pause", {});
    const response = await fetch(service.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Paused service must not charge" }),
    });
    if (response.status !== 503) throw Error("Paused API still accepts calls");
    report.setup.pause = true;
    report.pausedCallStatus = 503;
    await save();
  }
  report.status = "passed";
  report.updatedAt = new Date().toISOString();
  await save();
  console.log(
    JSON.stringify({
      status: report.status,
      serviceId: service.id,
      provider: service.provider,
      paidCalls: report.paidCalls,
      automaticSettlement: report.automaticSettlement,
      refundAgreement: report.setup.agreement,
      finalState: "paused after integration test",
    }),
  );
} finally {
  await fetch(base + "/auth/logout", {
    method: "POST",
    headers: { Authorization: "Bearer " + auth.token },
  });
}
