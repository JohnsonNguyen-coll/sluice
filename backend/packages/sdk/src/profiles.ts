import {
  isAddress,
  recoverMessageAddress,
  type PublicClient,
  type Address,
  type Hex,
} from "viem";
import { providerAbi, reputationAbi } from "./contracts";
export type ReputationInput = {
  settledCount: bigint;
  disputesLost: bigint;
  disputesAutoRefunded: bigint;
  feedback?: { score: number; feesPaidUsdE6: bigint }[];
  lastSeen?: number;
  sameOwner?: boolean;
};
export function computeReputation(
  raw: ReputationInput,
  now = Math.floor(Date.now() / 1000),
): { score: number | null; confidence: number; formulaVersion: 1 } {
  if (raw.settledCount === 0n || raw.sameOwner)
    return { score: null, confidence: 0, formulaVersion: 1 };
  const losses =
    raw.disputesLost > raw.settledCount ? raw.settledCount : raw.disputesLost;
  let score =
    Number(((raw.settledCount - losses) * 100000n) / raw.settledCount) / 1000;
  const feedback = raw.feedback || [];
  let weight = 0n,
    weighted = 0n;
  for (const f of feedback) {
    if (f.score < 1 || f.score > 5) continue;
    const w =
      f.feesPaidUsdE6 < 10_000_000_000n ? f.feesPaidUsdE6 : 10_000_000_000n;
    if (w <= 0n) continue;
    weight += w;
    weighted += BigInt(f.score) * w;
  }
  if (weight)
    score = 0.8 * score + (0.2 * Number((weighted * 20000n) / weight)) / 1000;
  const maturity = Math.min(
    Number(raw.settledCount > 100n ? 100n : raw.settledCount) / 100,
    1,
  );
  const decay =
    raw.lastSeen === undefined
      ? 1
      : 2 ** (-Math.max(0, now - raw.lastSeen) / (30 * 86400));
  return {
    score: Math.round(score * 100) / 100,
    confidence: Math.round(maturity * decay * 10000) / 10000,
    formulaVersion: 1,
  };
}
export type DomainProof = {
  domain: string;
  provider: Address;
  chainId: number;
  issuedAt: number;
  expiresAt: number;
  signature: Hex;
};
export const domainMessage = (p: Omit<DomainProof, "signature">) =>
  `AgentPay domain verification\nDomain: ${p.domain}\nProvider: ${p.provider.toLowerCase()}\nChain ID: ${p.chainId}\nIssued at: ${p.issuedAt}\nExpires at: ${p.expiresAt}`;
export async function verifyDomain(
  url: string,
  chainId: number,
  transport: typeof fetch = fetch,
): Promise<DomainProof> {
  const origin = new URL(url);
  if (origin.protocol !== "https:")
    throw Error("Domain verification requires HTTPS");
  const result = await transport(origin.origin + "/.well-known/agentpay.json", {
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  if (!result.ok) throw Error("Domain proof unavailable");
  const text = await result.text();
  if (text.length > 16000) throw Error("Domain proof too large");
  const proof = JSON.parse(text) as DomainProof,
    now = Math.floor(Date.now() / 1000);
  if (
    proof.domain !== origin.hostname ||
    proof.chainId !== chainId ||
    !isAddress(proof.provider) ||
    !Number.isSafeInteger(proof.issuedAt) ||
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.issuedAt > now + 60 ||
    proof.expiresAt <= now ||
    proof.expiresAt - proof.issuedAt > 7 * 86400
  )
    throw Error("Invalid domain proof");
  if (
    (
      await recoverMessageAddress({
        message: domainMessage(proof),
        signature: proof.signature,
      })
    ).toLowerCase() !== proof.provider.toLowerCase()
  )
    throw Error("Domain proof signer mismatch");
  return proof;
}
export async function getProviderProfile(
  input: string,
  options: {
    client: PublicClient;
    chainId: number;
    registry: Address;
    reputation: Address;
    wallet?: Address;
    fetch?: typeof fetch;
  },
) {
  const proof = isAddress(input)
    ? undefined
    : await verifyDomain(input, options.chainId, options.fetch);
  const provider = (proof?.provider || input) as Address;
  const registered = (await options.client.readContract({
    address: options.registry,
    abi: providerAbi,
    functionName: "isRegistered",
    args: [provider],
  })) as boolean;
  const entry = registered
    ? ((await options.client.readContract({
        address: options.registry,
        abi: providerAbi,
        functionName: "getProvider",
        args: [provider],
      })) as {
        payoutAddress: Address;
        disputeWindow: number;
        preferredArbiter: Address;
        active: boolean;
        metadataHash: Hex;
      })
    : null;
  const stats = (await options.client.readContract({
    address: options.reputation,
    abi: reputationAbi,
    functionName: "getProviderStats",
    args: [provider],
  })) as ReputationInput;
  let sameOwner = false;
  if (options.wallet) {
    const ownerAbi = [
      {
        type: "function",
        name: "owner",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "address" }],
      },
    ] as const;
    const walletOwner = await options.client.readContract({
      address: options.wallet,
      abi: ownerAbi,
      functionName: "owner",
    });
    let providerOwner = provider;
    if (await options.client.getBytecode({ address: provider })) {
      try {
        providerOwner = await options.client.readContract({
          address: provider,
          abi: ownerAbi,
          functionName: "owner",
        });
      } catch {}
    }
    sameOwner = walletOwner.toLowerCase() === providerOwner.toLowerCase();
  }
  return {
    provider,
    registered,
    verifiedDomain: !!proof,
    domain: proof?.domain,
    entry,
    stats,
    sameOwner,
    reputation: computeReputation({ ...stats, sameOwner }),
  };
}
