import { createPublicClient, getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  authorizationData,
  detectWallet,
  parseVoucher,
  policyAuthorizationData,
  voucherHash,
  voucherData,
  walletAbis,
  verifyVoucherOnChain,
  type PolicyAuthorization,
  type SignedVoucher,
  type Version,
} from "@sluice/sdk";
import type { Config } from "./config";
import { publicRpcTransport } from "./rpc";
import { fail } from "./errors";

type Reservation = {
  voucher_hash: string;
  request_hash: string;
  wallet: string;
  provider: string;
  token: string;
  amount: string;
  day: string;
  expiry: string;
  signature: Hex | null;
};

/**
 * The authority is intentionally an explicit server-side trust boundary: it
 * atomically reserves a wallet's day allowance before a provider runs its
 * handler. The signed result is independently checked by middleware.
 */
export class PolicyAuthority {
  private readonly account;
  private readonly client;
  constructor(private readonly config: Config, private readonly transport: typeof fetch = fetch) {
    if (!config.policyAuthorityKey || !config.policyAuthoritySigner)
      fail(503, "POLICY_AUTHORITY_UNAVAILABLE", "Configure POLICY_AUTHORITY_PRIVATE_KEY to enable enforced spending policies");
    this.account = privateKeyToAccount(config.policyAuthorityKey);
    this.client = createPublicClient({
      transport: publicRpcTransport(config.rpcUrls, config.chainId),
      cacheTime: 0,
    });
  }

  signer() {
    return this.account.address;
  }

  /** Called only after the provider has a confirmed settlement receipt. */
  async release(voucherHashes: readonly Hex[]) {
    if (!voucherHashes.length) return;
    if (!this.config.supabaseUrl || !this.config.supabaseKey)
      fail(503, "POLICY_STORAGE_UNAVAILABLE", "Policy storage unavailable");
    const response = await this.transport(
      this.config.supabaseUrl + "/rest/v1/rpc/release_policy_authorizations",
      {
        method: "POST",
        headers: { apikey: this.config.supabaseKey, Authorization: "Bearer " + this.config.supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify({ p_voucher_hashes: [...new Set(voucherHashes.map((hash) => hash.toLowerCase()))] }),
        redirect: "error", signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok)
      fail(503, "POLICY_STORAGE_UNAVAILABLE", "Could not reconcile settled policy reservations");
  }

  private now() {
    return Math.floor(Date.now() / 1000);
  }

  async authorize(input: unknown) {
    const value = input as { voucher?: unknown; amount?: unknown };
    let voucher: SignedVoucher;
    try {
      voucher = parseVoucher(value?.voucher);
    } catch {
      fail(400, "INVALID_POLICY_REQUEST", "A valid signed voucher is required for policy authorization");
    }
    if (voucher.version !== 3)
      fail(400, "POLICY_VERSION_UNSUPPORTED", "Enforced policy authorization requires a V3 wallet");
    if (typeof value.amount !== "string" || !/^(0|[1-9]\d*)$/.test(value.amount) || BigInt(value.amount) <= 0n)
      fail(400, "INVALID_POLICY_AMOUNT", "amount must be a positive payment integer");
    if (BigInt(voucher.expiry) < BigInt(this.now()) || BigInt(voucher.expiry) > BigInt(this.now() + 300))
      fail(400, "INVALID_POLICY_EXPIRY", "Voucher expiry must be within five minutes");
    const version = await detectWallet(this.client, voucher.wallet, this.config.factories);
    if (version !== voucher.version)
      fail(400, "POLICY_WALLET_VERSION", "Voucher does not match its factory wallet version");
    const signer = await this.recoverSigner(voucher);
    const [validUntil, paused, dailyLimit, tokenRate] = await Promise.all([
      this.client.readContract({ address: voucher.wallet, abi: walletAbis[version], functionName: "signerValidUntil", args: [signer] }) as Promise<bigint>,
      this.client.readContract({ address: voucher.wallet, abi: walletAbis[version], functionName: "paused", args: [] }) as Promise<boolean>,
      this.client.readContract({ address: voucher.wallet, abi: walletAbis[version], functionName: "dailyLimitUsdE6", args: [] }) as Promise<bigint>,
      this.client.readContract({ address: voucher.wallet, abi: walletAbis[version], functionName: "tokenRates", args: [voucher.token] }) as Promise<unknown>,
    ]);
    if (paused || validUntil === 0n || validUntil < BigInt(this.now()))
      fail(403, "POLICY_SIGNER_UNAUTHORIZED", "Wallet is paused or the agent signer is no longer authorized");
    const state = await verifyVoucherOnChain(voucher, { client: this.client, chainId: this.config.chainId, factories: this.config.factories });
    if (state.delta !== BigInt(value.amount))
      fail(403, "POLICY_AMOUNT_MISMATCH", "Voucher amount must equal the live provider call price");
    const rate = tokenRate as { usdRateE6?: bigint; decimals?: number } | readonly [bigint, number];
    const tuple = rate as readonly unknown[];
    const usdRate = tuple.length === 2 ? tuple[0] as bigint : (rate as { usdRateE6?: bigint }).usdRateE6;
    const decimals = tuple.length === 2 ? tuple[1] as number : (rate as { decimals?: number }).decimals;
    if (usdRate === undefined || decimals === undefined || usdRate <= 0n || decimals < 0 || decimals > 36)
      fail(400, "POLICY_TOKEN_UNPRICED", "The wallet does not have a valid USD rate for this payment token");
    const day = Math.floor(this.now() / 86400);
    const alreadySpent = await this.client.readContract({
      address: voucher.wallet, abi: walletAbis[version], functionName: "dailySpendUsdE6", args: [BigInt(day)],
    }) as bigint;
    const amount = BigInt(value.amount);
    const amountUsdE6 = (amount * usdRate) / 10n ** BigInt(decimals);
    const unsigned = {
      voucherHash: voucherHash(voucher, this.config.chainId),
      requestHash: voucher.requestHash,
      wallet: getAddress(voucher.wallet),
      provider: getAddress(voucher.provider),
      token: getAddress(voucher.token),
      amount: value.amount,
      day: String(day),
      expiry: voucher.expiry,
    };
    const reservation = await this.reserve({
      voucher_hash: unsigned.voucherHash,
      request_hash: unsigned.requestHash,
      wallet: unsigned.wallet,
      provider: unsigned.provider,
      token: unsigned.token,
      amount: unsigned.amount,
      day: unsigned.day,
      expiry: unsigned.expiry,
      amount_usd_e6: amountUsdE6.toString(),
      // On-chain daily spend is already final; reservations cover only the
      // remaining allowance for this UTC day.
      daily_limit_usd_e6: dailyLimit.toString(),
      chain_spend_usd_e6: alreadySpent.toString(),
      signature: null,
      chain_id: this.config.chainId,
    });
    // The database row is the canonical retry result. A null signature means
    // this first call must sign it; concurrent retries race through CAS below.
    if (reservation.signature) return { authorization: this.fromReservation(reservation), policy: { day: reservation.day, amountUsdE6: amountUsdE6.toString(), dailyLimitUsdE6: dailyLimit.toString() } };
    const unsignedStored = this.unsigned(reservation);
    const signature = await this.account.signTypedData(policyAuthorizationData(unsignedStored, this.config.chainId));
    const saved = await this.saveSignature(reservation.voucher_hash, signature);
    return { authorization: this.fromReservation(saved), policy: { day: saved.day, amountUsdE6: amountUsdE6.toString(), dailyLimitUsdE6: dailyLimit.toString() } };
  }

  private async recoverSigner(voucher: SignedVoucher): Promise<Address> {
    const { recoverTypedDataAddress } = await import("viem");
    const signer = await recoverTypedDataAddress({ ...voucherData(voucher, voucher.version, this.config.chainId), signature: voucher.signature });
    if (!voucher.requestSignature || (await recoverTypedDataAddress({ ...authorizationData(voucher, this.config.chainId), signature: voucher.requestSignature })).toLowerCase() !== signer.toLowerCase())
      fail(400, "POLICY_REQUEST_UNAUTHORIZED", "Voucher must include a matching request authorization");
    return signer;
  }

  private fromReservation(row: Reservation): PolicyAuthorization {
    if (!row.signature) fail(503, "POLICY_TICKET_PENDING", "Policy authorization is being signed; retry the identical request");
    return {
      voucherHash: row.voucher_hash as Hex,
      requestHash: row.request_hash as Hex,
      wallet: getAddress(row.wallet), provider: getAddress(row.provider), token: getAddress(row.token),
      amount: String(row.amount), day: String(row.day), expiry: String(row.expiry), signature: row.signature,
    };
  }

  private unsigned(row: Reservation) {
    return {
      voucherHash: row.voucher_hash as Hex, requestHash: row.request_hash as Hex,
      wallet: getAddress(row.wallet), provider: getAddress(row.provider), token: getAddress(row.token),
      amount: String(row.amount), day: String(row.day), expiry: String(row.expiry),
    };
  }

  private async reserve(input: Record<string, unknown>): Promise<Reservation> {
    if (!this.config.supabaseUrl || !this.config.supabaseKey)
      fail(503, "POLICY_STORAGE_UNAVAILABLE", "Configure Supabase and apply the policy reservations migration");
    let response: Response;
    try {
      response = await this.transport(this.config.supabaseUrl + "/rest/v1/rpc/reserve_policy_authorization", {
        method: "POST",
        headers: { apikey: this.config.supabaseKey, Authorization: "Bearer " + this.config.supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify(input), redirect: "error", signal: AbortSignal.timeout(8000),
      });
    } catch {
      fail(503, "POLICY_STORAGE_UNAVAILABLE", "Policy reservation storage is unavailable");
    }
    if (!response!.ok) {
      const text = await response!.text();
      if (/DAILY_POLICY_EXCEEDED/.test(text)) fail(403, "DAILY_POLICY_EXCEEDED", "This call would exceed the wallet's daily spending policy");
      fail(503, "POLICY_STORAGE_UNAVAILABLE", "Apply migration 202610310007_policy_reservations.sql and retry");
    }
    return (await response!.json()) as Reservation;
  }

  private async saveSignature(voucherHashValue: string, signature: Hex): Promise<Reservation> {
    if (!this.config.supabaseUrl || !this.config.supabaseKey) fail(503, "POLICY_STORAGE_UNAVAILABLE", "Policy storage unavailable");
    const response = await this.transport(this.config.supabaseUrl + "/rest/v1/policy_authorizations?voucher_hash=eq." + encodeURIComponent(voucherHashValue.toLowerCase()) + "&signature=is.null", {
      method: "PATCH", headers: { apikey: this.config.supabaseKey, Authorization: "Bearer " + this.config.supabaseKey, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ signature }), redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) fail(503, "POLICY_STORAGE_UNAVAILABLE", "Could not persist policy authorization signature");
    const rows = await response.json() as Reservation[];
    if (rows[0]) return rows[0];
    const read = await this.transport(this.config.supabaseUrl + "/rest/v1/policy_authorizations?voucher_hash=eq." + encodeURIComponent(voucherHashValue.toLowerCase()) + "&select=*", {
      headers: { apikey: this.config.supabaseKey, Authorization: "Bearer " + this.config.supabaseKey }, redirect: "error", signal: AbortSignal.timeout(8000),
    });
    if (!read.ok) fail(503, "POLICY_STORAGE_UNAVAILABLE", "Could not read the saved policy authorization");
    const saved = (await read.json() as Reservation[])[0];
    if (!saved?.signature) fail(503, "POLICY_TICKET_PENDING", "Policy authorization is being signed; retry the identical request");
    return saved;
  }
}
