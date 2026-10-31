import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { X402Gateway } from "../src/x402-gateway";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("x402 gateway", () => {
  test("unpaid calls return standard payment requirements without executing or leaking the handler", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sluice-x402-"));
    directories.push(directory);
    const account = privateKeyToAccount(generatePrivateKey());
    const unavailable = async () => { throw Error("unexpected chain access"); };
    const gateway = await X402Gateway.create({
      network: "eip155:5042002",
      receiver: account.address,
      token: "0x3600000000000000000000000000000000000000",
      price: "10000",
      resourceUrl: "https://pay.example/x402/11111111-1111-4111-8111-111111111111",
      serviceName: "Private analysis",
      storageDirectory: directory,
      receiverAuthorizerSigner: account,
      facilitatorSigner: {
        address: account.address,
        readContract: unavailable,
        verifyTypedData: unavailable,
        writeContract: unavailable,
        sendTransaction: unavailable,
        waitForTransactionReceipt: unavailable,
        getCode: unavailable,
      },
    });
    let called = false;
    const response = await gateway.handle(
      new Request("https://pay.example/x402/11111111-1111-4111-8111-111111111111", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ prompt: "secret request" }),
      }),
      { prompt: "secret request" },
      async () => {
        called = true;
        return Response.json({ secretResult: "must not leak" });
      },
    );

    expect(response.status).toBe(402);
    expect(response.headers.has("payment-required")).toBe(true);
    expect(await response.text()).not.toContain("must not leak");
    expect(called).toBe(false);
  });
});
