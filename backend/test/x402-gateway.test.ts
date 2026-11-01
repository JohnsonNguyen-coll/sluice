import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { X402Gateway } from "../src/x402-gateway";
import { FilePendingSettlementStore } from "../src/x402-pending-store";
import { ManagedHost } from "../src/managed-host";
import { loadConfig } from "../src/config";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("x402 gateway", () => {
  test("production refuses to start without an absolute persistent storage path", () => {
    const config = loadConfig({ AUTH_ORIGIN: "http://127.0.0.1:3010" });
    const create = (env: Record<string, string>) =>
      new ManagedHost(config, {} as never, {} as never, {} as never, env, {} as never);
    expect(() => create({ NODE_ENV: "production" })).toThrow("X402_STORAGE_DIR");
    expect(() => create({ NODE_ENV: "production", X402_STORAGE_DIR: "relative/path" })).toThrow("absolute");
    expect(() => create({ NODE_ENV: "production", X402_STORAGE_DIR: resolve(tmpdir(), "x402-volume") })).not.toThrow();
  });

  test("pending deposit broadcast survives a new facilitator instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sluice-x402-pending-"));
    directories.push(directory);
    const hash = `0x${"ab".repeat(32)}`;
    await new FilePendingSettlementStore(directory).set("deposit-signature", hash);
    const restarted = new FilePendingSettlementStore(directory);
    expect(await restarted.get("deposit-signature")).toBe(hash);
    expect(await restarted.get("different-signature")).toBeUndefined();
    await restarted.delete("deposit-signature");
    expect(await new FilePendingSettlementStore(directory).get("deposit-signature")).toBeUndefined();
  });

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
