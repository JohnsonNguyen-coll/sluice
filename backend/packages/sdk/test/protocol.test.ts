import { test, expect } from "bun:test";
import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toHex, hashTypedData, type Hex, type Address } from "viem";
import {
  receiptData,
  receiptLeaf,
  verifyReceipt,
  merkleTree,
  verifyProof,
  pack,
  unpack,
  requestHash,
  parseReceipt,
  voucherData,
  authorizationData,
  policyAuthorizationData,
  verifyPolicyAuthorization,
  type SignedReceipt,
  type SignedVoucher,
} from "../src/protocol";
import { MemoryAgentStore } from "../src/store";
import { computeReputation, domainMessage } from "../src/profiles";
const provider = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex),
  wallet = ("0x" + "44".repeat(20)) as Address,
  token = ("0x" + "55".repeat(20)) as Address;
test("policy authorizations bind one exact voucher, request and call amount", async () => {
  const authority = privateKeyToAccount(("0x" + "66".repeat(32)) as Hex);
  const value = {
    voucherHash: keccak256(toHex("voucher")), requestHash: keccak256(toHex("request")),
    wallet, provider: provider.address, token, amount: "10000", day: "20000", expiry: "1728000000",
  };
  const signed = { ...value, signature: await authority.signTypedData(policyAuthorizationData(value, 31337)) };
  expect(await verifyPolicyAuthorization(signed, authority.address, 31337)).toBe(true);
  expect(await verifyPolicyAuthorization({ ...signed, amount: "10001" }, authority.address, 31337)).toBe(false);
});
test("receipts bind provider, wallet, chain and every call field", async () => {
  const value: SignedReceipt = {
    provider: provider.address,
    wallet,
    chainId: 31337,
    receipt: {
      voucherHash: keccak256(toHex("voucher")),
      requestHash: keccak256(toHex("request")),
      responseHash: keccak256(toHex("response")),
      status: 200,
      timestamp: "100",
      token,
      nonce: "1",
      amount: "10",
    },
    signature: "0x",
  };
  value.signature = await provider.signTypedData(receiptData(value));
  expect(await verifyReceipt(value)).toBe(true);
  expect(await verifyReceipt({ ...value, chainId: 1 })).toBe(false);
  expect(
    await verifyReceipt({
      ...value,
      receipt: { ...value.receipt, status: 500 },
    }),
  ).toBe(false);
  expect(unpack(pack(value))).toEqual(value);
  expect(() =>
    parseReceipt({ ...value, receipt: { ...value.receipt, nonce: "-1" } }),
  ).toThrow();
});
test("Merkle proofs work for odd/even batches without accepting a changed leaf", () => {
  for (let size = 1; size <= 9; size++) {
    const leaves = Array.from({ length: size }, (_, i) =>
        keccak256(toHex("leaf" + i)),
      ),
      tree = merkleTree(leaves);
    leaves.forEach((leaf, i) => {
      expect(verifyProof(leaf, tree.proof(i), tree.root)).toBe(true);
      expect(
        verifyProof(keccak256(toHex("other")), tree.proof(i), tree.root),
      ).toBe(false);
    });
  }
});
test("request hashes bind method, path/query and exact body bytes", () => {
  const body = new TextEncoder().encode('{"x":1}'),
    hash = requestHash("POST", "https://api.test/path?q=1", body);
  expect(hash).not.toBe(requestHash("POST", "https://api.test/path?q=2", body));
  expect(hash).not.toBe(requestHash("GET", "https://api.test/path?q=1", body));
  expect(hash).not.toBe(
    requestHash(
      "POST",
      "https://api.test/path?q=1",
      new TextEncoder().encode('{ "x":1}'),
    ),
  );
});
test("channel CAS prevents competing reservations and preserves pending state", async () => {
  const store = new MemoryAgentStore(),
    next = { nonce: "1", cumulativeAmount: "10" };
  expect(await store.reserve("channel", null, next)).toBe(true);
  expect(await store.reserve("channel", null, next)).toBe(false);
  expect(await store.channel("channel")).toEqual(next);
});
test("score exposes uncertainty and decays confidence rather than inventing recency", () => {
  expect(
    computeReputation({
      settledCount: 0n,
      disputesLost: 0n,
      disputesAutoRefunded: 0n,
    }).score,
  ).toBeNull();
  const raw = {
    settledCount: 100n,
    disputesLost: 10n,
    disputesAutoRefunded: 2n,
    lastSeen: 0,
  };
  expect(computeReputation(raw, 30 * 86400)).toEqual({
    score: 90,
    confidence: 0.5,
    formulaVersion: 1,
  });
  expect(computeReputation({ ...raw, sameOwner: true }).score).toBeNull();
});
