import {
  recoverTypedDataAddress,
  type Address,
  type PublicClient,
  type Abi,
} from "viem";
import { walletAbis, factoryAbis } from "./contracts";
import {
  parseVoucher,
  voucherData,
  authorizationData,
  type Version,
  type SignedVoucher,
} from "./protocol";
export type Factory = { address: Address; version: Version };
export async function detectWallet(
  client: PublicClient,
  wallet: Address,
  factories: readonly Factory[],
): Promise<Version> {
  for (const factory of factories) {
    if (
      await client.readContract({
        address: factory.address,
        abi: factoryAbis[factory.version],
        functionName: "isFactoryWallet",
        args: [wallet],
      })
    )
      return factory.version;
  }
  throw Error("Wallet is not recorded by a trusted factory");
}
export async function channelState(
  client: PublicClient,
  wallet: Address,
  provider: Address,
  token: Address,
  version: Version,
) {
  const abi = walletAbis[version],
    args = version === 1 ? [provider] : [provider, token];
  const read = (functionName: string, params: unknown[] = args) =>
    client.readContract({ address: wallet, abi, functionName, args: params });
  const [budget, settled, nonce, paused] = await Promise.all([
    read("budgets"),
    read("settled"),
    read("nonces"),
    read("paused", []),
  ]);
  if (version === 1) {
    const usdc = (await read("usdc", [])) as Address;
    if (usdc.toLowerCase() !== token.toLowerCase())
      throw Error("Wrong V1 payment token");
  }
  return {
    maxTotal: (budget as bigint[])[0],
    perCallCap: (budget as bigint[])[1],
    settled: settled as bigint,
    nonce: nonce as bigint,
    paused: paused as boolean,
  };
}
export async function verifyVoucherOnChain(
  v: SignedVoucher,
  options: {
    client: PublicClient;
    chainId: number;
    factories: readonly Factory[];
  },
) {
  parseVoucher(v);
  if ((await options.client.getChainId()) !== options.chainId)
    throw Error("Wrong RPC chain");
  if (
    (await detectWallet(options.client, v.wallet, options.factories)) !==
    v.version
  )
    throw Error("Voucher version mismatch");
  const block = await options.client.getBlock();
  if (BigInt(v.expiry) < block.timestamp) throw Error("Expired voucher");
  const signer = await recoverTypedDataAddress({
    ...voucherData(v, v.version, options.chainId),
    signature: v.signature,
  });
  if (
    v.version === 3 &&
    (!v.requestSignature ||
      (
        await recoverTypedDataAddress({
          ...authorizationData(v, options.chainId),
          signature: v.requestSignature,
        })
      ).toLowerCase() !== signer.toLowerCase())
  )
    throw Error("Invalid request authorization");
  const abi = walletAbis[v.version];
  const validUntil = (await options.client.readContract({
    address: v.wallet,
    abi,
    functionName: "signerValidUntil",
    args: [signer],
  })) as bigint;
  if (validUntil < block.timestamp || validUntil === 0n)
    throw Error("Unauthorized voucher signer");
  const state = await channelState(
    options.client,
    v.wallet,
    v.provider,
    v.token,
    v.version,
  );
  if (
    state.paused ||
    BigInt(v.nonce) <= state.nonce ||
    BigInt(v.cumulativeAmount) <= state.settled
  )
    throw Error("Voucher does not advance an active channel");
  const message = voucherData(v, v.version, options.chainId).message;
  await options.client.simulateContract({
    address: v.wallet,
    abi: abi as Abi,
    functionName: "settle",
    args:
      v.version === 1
        ? [message, v.signature]
        : v.version === 2
          ? [message, v.signature, 0n]
          : [message, v.signature, 0n, "0x" + "00".repeat(32)],
    account: v.provider,
  });
  return { ...state, delta: BigInt(v.cumulativeAmount) - state.settled };
}
