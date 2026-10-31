import { resolve } from "node:path";
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config";
import { publicRpcTransport } from "../src/rpc";

const endpoint = process.env.X402_ENDPOINT;
const key = process.env.X402_CLIENT_PRIVATE_KEY;
if (!endpoint || !key || !isHex(key, { strict: true }) || key.length !== 66)
  throw Error("Set X402_ENDPOINT and X402_CLIENT_PRIVATE_KEY in an ignored env file");

const config = loadConfig();
const network = `eip155:${config.chainId}` as const;
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({
  transport: publicRpcTransport(config.rpcUrls, config.chainId),
});
const scheme = new BatchSettlementEvmScheme(
  toClientEvmSigner(account, publicClient),
  {
    storage: new FileClientChannelStorage({
      directory: resolve(import.meta.dir, "../../.tools/x402-client"),
    }),
  },
);
const http = new x402HTTPClient(
  new x402Client().register(network, scheme),
);
const input = { text: "Sluice returns this API result only after payment is accepted." };
const first = await fetch(endpoint, {
  method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
  body: JSON.stringify(input),
});
if (first.status !== 402) throw Error(`Expected 402, received ${first.status}`);
const required = http.getPaymentRequiredResponse(
  (name) => first.headers.get(name),
  await first.json(),
);
const payment = await http.createPaymentPayload(required);
const paid = await fetch(endpoint, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    accept: "application/json",
    ...http.encodePaymentSignatureHeader(payment),
  },
  body: JSON.stringify(input),
});
await http.processPaymentResult(
  payment,
  (name) => paid.headers.get(name),
  paid.status,
);
if (!paid.ok) throw Error(`Paid API call failed: ${paid.status} ${await paid.text()}`);

// This is where the private API result appears for the calling agent/app.
console.log(await paid.json());
