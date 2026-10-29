import {
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  concatHex,
  isAddress,
  isHex,
  type Address,
  type Hex,
} from "viem";

export type Version = 1 | 2 | 3;
export type Voucher = {
  wallet: Address;
  provider: Address;
  token: Address;
  cumulativeAmount: string;
  nonce: string;
  expiry: string;
};
export type SignedVoucher = Voucher & {
  version: Version;
  signature: Hex;
  requestHash: Hex;
  requestSignature?: Hex;
};
export type Receipt = {
  voucherHash: Hex;
  requestHash: Hex;
  responseHash: Hex;
  status: number;
  timestamp: string;
  token: Address;
  nonce: string;
  amount: string;
};
export type SignedReceipt = {
  wallet: Address;
  provider: Address;
  chainId: number;
  receipt: Receipt;
  signature: Hex;
};
export const receiptTypes = {
  Receipt: [
    { name: "voucherHash", type: "bytes32" },
    { name: "requestHash", type: "bytes32" },
    { name: "responseHash", type: "bytes32" },
    { name: "status", type: "uint16" },
    { name: "timestamp", type: "uint64" },
    { name: "token", type: "address" },
    { name: "nonce", type: "uint256" },
    { name: "amount", type: "uint256" },
  ],
} as const;
export const voucherTypes = (version: Version) => ({
  Voucher: [
    { name: "wallet", type: "address" },
    { name: "provider", type: "address" },
    ...(version === 1 ? [] : [{ name: "token", type: "address" }]),
    { name: "cumulativeAmount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint64" },
  ],
});
export function voucherData(v: Voucher, version: Version, chainId: number) {
  return {
    domain: {
      name: version === 2 ? "AgentPayV2" : "AgentPay",
      version: version === 2 ? "2" : "1",
      chainId,
      verifyingContract: v.wallet,
    },
    types: voucherTypes(version),
    primaryType: "Voucher" as const,
    message: {
      wallet: v.wallet,
      provider: v.provider,
      ...(version === 1 ? {} : { token: v.token }),
      cumulativeAmount: BigInt(v.cumulativeAmount),
      nonce: BigInt(v.nonce),
      expiry: BigInt(v.expiry),
    },
  };
}
export function receiptData(value: SignedReceipt) {
  return {
    domain: {
      name: "AgentPayReceipt",
      version: "1",
      chainId: value.chainId,
      verifyingContract: value.wallet,
    },
    types: receiptTypes,
    primaryType: "Receipt" as const,
    message: {
      ...value.receipt,
      timestamp: BigInt(value.receipt.timestamp),
      nonce: BigInt(value.receipt.nonce),
      amount: BigInt(value.receipt.amount),
    },
  };
}
export const voucherHash = (value: SignedVoucher, chainId: number) =>
  hashTypedData(voucherData(value, value.version, chainId));
export function authorizationData(value: SignedVoucher, chainId: number) {
  return {
    domain: {
      name: "AgentPayCall",
      version: "1",
      chainId,
      verifyingContract: value.wallet,
    },
    types: {
      CallAuthorization: [
        { name: "voucherHash", type: "bytes32" },
        { name: "requestHash", type: "bytes32" },
      ],
    },
    primaryType: "CallAuthorization" as const,
    message: {
      voucherHash: voucherHash(value, chainId),
      requestHash: value.requestHash,
    },
  };
}
export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw Error("Body size limit exceeded");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
export const receiptHash = (value: SignedReceipt) =>
  hashTypedData(receiptData(value));
export const receiptLeaf = (value: SignedReceipt) =>
  keccak256(receiptHash(value));
export function pack(value: unknown): string {
  return btoa(
    String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function unpack<T>(value: string, maxLength = 24000): T {
  if (value.length > maxLength || !/^[A-Za-z0-9_-]+$/.test(value))
    throw Error("Invalid payment header");
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(
        atob(value.replaceAll("-", "+").replaceAll("_", "/")),
        (c) => c.charCodeAt(0),
      ),
    ),
  ) as T;
}
export function uint(value: unknown, bits = 256): string {
  if (
    typeof value !== "string" ||
    !/^(0|[1-9]\d*)$/.test(value) ||
    value.length > 78 ||
    BigInt(value) >= 2n ** BigInt(bits)
  )
    throw Error("Invalid payment integer");
  return value;
}
export function address(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value))
    throw Error("Invalid payment address");
  return value;
}
export function hash(value: unknown): Hex {
  if (typeof value !== "string" || !isHex(value) || value.length !== 66)
    throw Error("Invalid payment hash");
  return value;
}
export function parseVoucher(value: unknown): SignedVoucher {
  const v = value as SignedVoucher;
  if (
    !v ||
    ![1, 2, 3].includes(v.version) ||
    typeof v.signature !== "string" ||
    !isHex(v.signature) ||
    v.signature.length !== 132
  )
    throw Error("Invalid voucher");
  address(v.wallet);
  address(v.provider);
  address(v.token);
  uint(v.nonce);
  uint(v.cumulativeAmount);
  uint(v.expiry, 64);
  hash(v.requestHash);
  return v;
}
export function parseReceipt(value: unknown): SignedReceipt {
  const v = value as SignedReceipt;
  if (
    !v ||
    !Number.isSafeInteger(v.chainId) ||
    v.chainId < 1 ||
    !v.receipt ||
    typeof v.signature !== "string" ||
    !isHex(v.signature) ||
    v.signature.length !== 132
  )
    throw Error("Invalid receipt");
  address(v.wallet);
  address(v.provider);
  const r = v.receipt;
  hash(r.voucherHash);
  hash(r.requestHash);
  hash(r.responseHash);
  address(r.token);
  uint(r.nonce);
  uint(r.amount);
  uint(r.timestamp, 64);
  if (!Number.isInteger(r.status) || r.status < 100 || r.status > 599)
    throw Error("Invalid receipt status");
  return v;
}
export async function verifyReceipt(value: SignedReceipt): Promise<boolean> {
  parseReceipt(value);
  return (
    (
      await recoverTypedDataAddress({
        ...receiptData(value),
        signature: value.signature,
      })
    ).toLowerCase() === value.provider.toLowerCase()
  );
}
export function requestHash(
  method: string,
  url: string,
  body: Uint8Array,
): Hex {
  const u = new URL(url);
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "string" }, { type: "bytes32" }],
      [method.toUpperCase(), u.pathname + u.search, keccak256(body)],
    ),
  );
}
export const responseHash = (bytes: Uint8Array) => keccak256(bytes);
const pair = (a: Hex, b: Hex) =>
  keccak256(concatHex(BigInt(a) < BigInt(b) ? [a, b] : [b, a]));
export function merkleTree(leaves: readonly Hex[]): {
  root: Hex;
  proof: (index: number) => Hex[];
} {
  const levels: Hex[][] = [[...leaves]];
  while (levels.at(-1)!.length > 1) {
    const row = levels.at(-1)!,
      next: Hex[] = [];
    for (let i = 0; i < row.length; i += 2)
      next.push(i + 1 < row.length ? pair(row[i], row[i + 1]) : row[i]);
    levels.push(next);
  }
  return {
    root: levels.at(-1)?.[0] || toHex(0, { size: 32 }),
    proof(index) {
      if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
        throw Error("Invalid proof index");
      const proof: Hex[] = [];
      for (const row of levels.slice(0, -1)) {
        const sibling = index ^ 1;
        if (sibling < row.length) proof.push(row[sibling]);
        index = Math.floor(index / 2);
      }
      return proof;
    },
  };
}
export function verifyProof(
  leaf: Hex,
  proof: readonly Hex[],
  root: Hex,
): boolean {
  return proof.reduce(pair, leaf).toLowerCase() === root.toLowerCase();
}
