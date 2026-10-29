import { test, expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex, Address, PublicClient } from "viem";
import { PaymentProvider } from "../src/provider";
import { MemoryProviderStore } from "../src/store";
const signer = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex),
  token = ("0x" + "55".repeat(20)) as Address;
const options = {
  provider: signer.address,
  token,
  chainId: 31337,
  price: 1000n,
  signer,
  publicClient: {} as PublicClient,
  factories: [],
  store: new MemoryProviderStore(),
};
test("402 quotes do not execute the API and honor legacy wallet version negotiation", async () => {
  let calls = 0;
  const handle = new PaymentProvider(options).wrap(() => {
    calls++;
    return Response.json({ paid: true });
  });
  for (const version of [1, 2, 3]) {
    const response = await handle(
      new Request("https://api.example/answer", {
        headers: { "X-AgentPay-Version": String(version) },
      }),
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      price: "1000",
      version,
      provider: signer.address,
    });
  }
  expect(calls).toBe(0);
});
test("invalid and oversized vouchers cannot invoke application handlers", async () => {
  let calls = 0;
  const handle = new PaymentProvider(options).wrap(() => {
    calls++;
    return Response.json({ paid: true });
  });
  for (const header of ["not-json", "a".repeat(25000)])
    expect(
      (
        await handle(
          new Request("https://api.example/answer", {
            headers: { "X-AgentPay-Voucher": header },
          }),
        )
      ).status,
    ).toBe(402);
  expect(calls).toBe(0);
});
test("receipt signer must match provider identity", () => {
  expect(() => new PaymentProvider({ ...options, provider: token })).toThrow(
    "must control provider",
  );
});
