import {
  recoverTypedDataAddress,
  toHex,
  keccak256,
  encodeAbiParameters,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  parseVoucher,
  pack,
  unpack,
  requestHash,
  responseHash,
  readBounded,
  voucherHash,
  voucherData,
  authorizationData,
  parsePolicyAuthorization,
  verifyPolicyAuthorization,
  receiptData,
  receiptLeaf,
  merkleTree,
  verifyVoucherOnChain,
  walletAbis,
  vaultAbi,
  domainMessage,
  type DomainProof,
  type SignedVoucher,
  type SignedReceipt,
  type Version,
  type Factory,
} from "@sluice/sdk";
import type {
  ProviderStore,
  ProviderRecord,
  StoredResponse,
  ReceiptCommitment,
} from "./store";
export type PaymentContext = {
  wallet: Address;
  provider: Address;
  paid: bigint;
  cumulative: bigint;
  voucherHash: Hex;
};
export type ProviderOptions = {
  provider: Address;
  token: Address;
  chainId: number;
  price: bigint;
  signer: LocalAccount;
  publicClient: PublicClient;
  walletClient?: WalletClient;
  factories: readonly Factory[];
  store: ProviderStore;
  receipts?: boolean;
  versions?: readonly Version[];
  settleThreshold?: bigint;
  vault?: Address;
  autoAcceptBelow?: bigint;
  /** When configured, no response is served without a signed policy ticket.
   * This is the provider-side enforcement point for off-chain daily limits. */
  policySigner?: Address;
  /** Public authority endpoint advertised to compatible agent SDKs. */
  policyAuthorityUrl?: string;
  now?: () => number;
  onDispute?: (input: {
    id: Hex;
    amount: bigint;
  }) => Promise<
    { action: "accept" } | { action: "respond"; evidenceHash: Hex } | void
  >;
  onSettled?: (records: readonly ProviderRecord[]) => Promise<void> | void;
};
const body64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const cached = (r: StoredResponse, receipt?: SignedReceipt) => {
  const headers = new Headers(r.headers);
  headers.set("Access-Control-Expose-Headers", "X-AgentPay-Receipt");
  if (receipt) headers.set("X-AgentPay-Receipt", pack(receipt));
  return new Response(
    r.status === 204 || r.status === 304 ? null : Buffer.from(r.body, "base64"),
    { status: r.status, headers },
  );
};
export class PaymentProvider {
  private settling = false;
  constructor(readonly options: ProviderOptions) {
    if (
      options.price <= 0n ||
      options.signer.address.toLowerCase() !== options.provider.toLowerCase()
    )
      throw Error("Provider receipt signer must control provider address");
  }
  private now() {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }
  async domainProof(domain: string, validForSec = 86400): Promise<DomainProof> {
    const parsed = new URL("https://" + domain);
    if (
      parsed.hostname !== domain ||
      parsed.pathname !== "/" ||
      validForSec < 60 ||
      validForSec > 7 * 86400
    )
      throw Error("Invalid domain proof parameters");
    const proof = {
      domain,
      provider: this.options.provider,
      chainId: this.options.chainId,
      issuedAt: this.now(),
      expiresAt: this.now() + validForSec,
    };
    return {
      ...proof,
      signature: await this.options.signer.signMessage({
        message: domainMessage(proof),
      }),
    };
  }
  wrap(
    handler: (
      request: Request,
      context: PaymentContext,
    ) => Promise<Response> | Response,
  ) {
    return async (request: Request): Promise<Response> => {
      if (request.method === "OPTIONS")
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type, X-AgentPay-Voucher, X-AgentPay-Version, X-Sluice-Policy",
            "Access-Control-Expose-Headers": "X-AgentPay-Receipt",
          },
        });
      const requested = Number(
        request.headers.get("X-AgentPay-Version") || 3,
      ) as Version;
      if (!(this.options.versions || [1, 2, 3]).includes(requested))
        return Response.json(
          { error: "Unsupported wallet version" },
          { status: 400 },
        );
      const header = request.headers.get("X-AgentPay-Voucher");
      if (!header) {
        const quote = {
          chainId: this.options.chainId,
          provider: this.options.provider,
          token: this.options.token,
          price: String(this.options.price),
          version: requested,
          ...(this.options.policySigner
            ? { policy: { signer: this.options.policySigner, url: this.options.policyAuthorityUrl } }
            : {}),
        };
        return Response.json(quote, {
          status: 402,
          headers: {
            "X-AgentPay-Quote": pack(quote),
            "Access-Control-Expose-Headers":
              "X-AgentPay-Quote, X-AgentPay-Receipt",
          },
        });
      }
      try {
        let policyAuthorization: import("@sluice/sdk").PolicyAuthorization | undefined;
        const voucher = parseVoucher(unpack<SignedVoucher>(header));
        if (
          voucher.version !== requested ||
          voucher.provider.toLowerCase() !==
            this.options.provider.toLowerCase() ||
          voucher.token.toLowerCase() !== this.options.token.toLowerCase() ||
          BigInt(voucher.expiry) < BigInt(this.now())
        )
          throw Error("Invalid voucher destination or expiry");
        const bytes = await readBounded(request.clone().body, 32768);
        if (
          requestHash(request.method, request.url, bytes) !==
          voucher.requestHash
        )
          throw Error("Request hash mismatch");
        // Always authenticate before returning a cached result, including already-settled vouchers.
        const signer = await recoverTypedDataAddress({
          ...voucherData(voucher, voucher.version, this.options.chainId),
          signature: voucher.signature,
        });
        if (voucher.version === 3 && !voucher.requestSignature)
          throw Error("Request authorization required");
        if (
          voucher.requestSignature &&
          (
            await recoverTypedDataAddress({
              ...authorizationData(voucher, this.options.chainId),
              signature: voucher.requestSignature,
            })
          ).toLowerCase() !== signer.toLowerCase()
        )
          throw Error("Invalid request authorization");
        const validUntil = (await this.options.publicClient.readContract({
          address: voucher.wallet,
          abi: walletAbis[voucher.version],
          functionName: "signerValidUntil",
          args: [signer],
        })) as bigint;
        if (validUntil < BigInt(this.now()) || validUntil === 0n)
          throw Error("Unauthorized voucher signer");
        const id = voucherHash(voucher, this.options.chainId);
        if (this.options.policySigner) {
          const policyHeader = request.headers.get("X-Sluice-Policy");
          if (!policyHeader) throw Error("Policy authorization required");
          const policy = parsePolicyAuthorization(unpack(policyHeader));
          if (
            policy.voucherHash.toLowerCase() !== id.toLowerCase() ||
            policy.requestHash.toLowerCase() !== voucher.requestHash.toLowerCase() ||
            policy.wallet.toLowerCase() !== voucher.wallet.toLowerCase() ||
            policy.provider.toLowerCase() !== voucher.provider.toLowerCase() ||
            policy.token.toLowerCase() !== voucher.token.toLowerCase() ||
            policy.amount !== String(this.options.price) ||
            BigInt(policy.expiry) < BigInt(this.now()) ||
            !(await verifyPolicyAuthorization(
              policy,
              this.options.policySigner,
              this.options.chainId,
            ))
          )
            throw Error("Invalid policy authorization");
          policyAuthorization = policy;
        }
        const existing = await this.options.store.get(id);
        if (existing) {
          if (!voucher.requestSignature)
            return Response.json(
              {
                error:
                  "A request signature is required to retrieve a cached response",
              },
              { status: 409 },
            );
          if (
            existing.voucher.signature !== voucher.signature ||
            existing.voucher.requestHash !== voucher.requestHash
          )
            throw Error("Voucher replay mismatch");
          return existing.response
            ? cached(existing.response, existing.receipt)
            : Response.json(
                { error: "Payment is processing; retry the identical request" },
                { status: 425 },
              );
        }
        const state = await verifyVoucherOnChain(voucher, {
          client: this.options.publicClient,
          chainId: this.options.chainId,
          factories: this.options.factories,
        });
        const channel = [
          this.options.chainId,
          voucher.wallet,
          voucher.provider,
          voucher.token,
        ]
          .join(":")
          .toLowerCase();
        const record: ProviderRecord = { id, channel, voucher, ...(policyAuthorization ? { policyAuthorization } : {}) };
        const accepted = await this.options.store.accept(
          record,
          { nonce: String(state.nonce), amount: String(state.settled) },
          String(this.options.price),
        );
        if (accepted === "duplicate") {
          const duplicate = await this.options.store.get(id);
          return duplicate?.response
            ? cached(duplicate.response, duplicate.receipt)
            : Response.json(
                { error: "Payment is processing" },
                { status: 425 },
              );
        }
        if (accepted !== "created")
          throw Error(
            "Voucher must advance the accepted channel by exactly this call price",
          );
        let response: Response;
        try {
          response = await handler(request, {
            wallet: voucher.wallet,
            provider: voucher.provider,
            paid: this.options.price,
            cumulative: BigInt(voucher.cumulativeAmount),
            voucherHash: id,
          });
        } catch {
          response = Response.json(
            { error: "Provider request failed" },
            { status: 500 },
          );
        }
        const responseBytes =
          request.method === "HEAD"
            ? new Uint8Array()
            : await readBounded(response.body, 1024 * 1024);
        if (request.method === "HEAD") await response.body?.cancel();
        let receipt: SignedReceipt | undefined;
        if (voucher.version === 3 && this.options.receipts !== false) {
          receipt = {
            wallet: voucher.wallet,
            provider: voucher.provider,
            chainId: this.options.chainId,
            receipt: {
              voucherHash: id,
              requestHash: voucher.requestHash,
              responseHash: responseHash(responseBytes),
              status: response.status,
              timestamp: String(this.now()),
              token: voucher.token,
              nonce: voucher.nonce,
              amount: String(this.options.price),
            },
            signature: "0x",
          };
          receipt.signature = await this.options.signer.signTypedData(
            receiptData(receipt),
          );
        }
        const saved: StoredResponse = {
          status: response.status,
          headers: [...response.headers.entries()].filter(
            ([name]) =>
              ![
                "set-cookie",
                "transfer-encoding",
                "content-length",
                "content-encoding",
                "x-agentpay-receipt",
              ].includes(name.toLowerCase()),
          ),
          body: body64(responseBytes),
        };
        await this.options.store.complete(id, receipt, saved);
        if (
          this.options.settleThreshold &&
          BigInt(voucher.cumulativeAmount) - state.settled >=
            this.options.settleThreshold
        )
          await this.settle();
        return cached(saved, receipt);
      } catch {
        return Response.json(
          {
            error:
              "Payment could not be authorized or persisted; retry the same voucher",
          },
          { status: 402 },
        );
      }
    };
  }
  private async write(
    address: Address,
    abi: typeof vaultAbi,
    functionName: string,
    args: readonly unknown[],
  ) {
    const wallet = this.options.walletClient;
    if (
      !wallet?.account ||
      wallet.account.address.toLowerCase() !==
        this.options.provider.toLowerCase()
    )
      throw Error("Provider wallet client required");
    if ((await wallet.getChainId()) !== this.options.chainId)
      throw Error("Wrong provider wallet chain");
    const { request } = await this.options.publicClient.simulateContract({
      address,
      abi,
      functionName,
      args,
      account: wallet.account,
    });
    const hash = await wallet.writeContract({
      ...request,
      account: wallet.account,
      chain: wallet.chain,
    });
    const receipt = await this.options.publicClient.waitForTransactionReceipt({
      hash,
    });
    if (receipt.status !== "success")
      throw Error("Provider transaction reverted");
    return receipt;
  }
  async settle() {
    if (this.settling) return [];
    this.settling = true;
    try {
      const records = await this.options.store.pending(
          undefined,
          this.options.provider,
        ),
        channels = new Map<string, ProviderRecord[]>();
      for (const record of records) {
        if (!record.channel.startsWith(this.options.chainId + ":")) continue;
        const group = channels.get(record.channel) || [];
        group.push(record);
        channels.set(record.channel, group);
      }
      const settled: Hex[] = [];
      for (const group of channels.values()) {
        group.sort((a, b) =>
          BigInt(a.voucher.nonce) < BigInt(b.voucher.nonce) ? -1 : 1,
        );
        const latest = group.at(-1)!,
          v = latest.voucher;
        const chainNonce = (await this.options.publicClient.readContract({
          address: v.wallet,
          abi: walletAbis[v.version],
          functionName: "nonces",
          args: v.version === 1 ? [v.provider] : [v.provider, v.token],
        })) as bigint;
        const fresh = group.filter(
          (record) => BigInt(record.voucher.nonce) > chainNonce,
        );
        if (!fresh.length) continue;
        const leaves = fresh
            .filter((r) => r.receipt)
            .map((r) => receiptLeaf(r.receipt!)),
          tree = merkleTree(leaves);
        const message = voucherData(v, v.version, this.options.chainId).message;
        const receipt = await this.write(
          v.wallet,
          walletAbis[v.version],
          "settle",
          v.version === 1
            ? [message, v.signature]
            : v.version === 2
              ? [message, v.signature, 0n]
              : [message, v.signature, 0n, tree.root],
        );
        const settlementId = keccak256(
          encodeAbiParameters(
            [
              { type: "address" },
              { type: "address" },
              { type: "address" },
              { type: "uint256" },
              { type: "uint256" },
            ],
            [
              v.wallet,
              v.provider,
              v.token,
              BigInt(v.nonce),
              receipt.blockNumber,
            ],
          ),
        );
        const commitments: Record<string, ReceiptCommitment> = {};
        let index = 0;
        for (const record of fresh) {
          if (record.receipt)
            commitments[record.id] = {
              root: tree.root,
              proof: tree.proof(index++),
              settlementId,
              settlementNonce: v.nonce,
              transactionHash: receipt.transactionHash,
            };
        }
        await this.options.store.markSettled(
          fresh.map((r) => r.id),
          receipt.transactionHash,
          commitments,
        );
        await this.options.onSettled?.(fresh);
        settled.push(receipt.transactionHash);
      }
      return settled;
    } finally {
      this.settling = false;
    }
  }
  startSettler(
    intervalMs = 60000,
    onError: (error: unknown) => void = () => {},
  ) {
    if (intervalMs < 1000) throw Error("Settlement interval too short");
    const timer = setInterval(() => {
      void this.settle().catch(onError);
    }, intervalMs);
    return () => clearInterval(timer);
  }
  async respondToDispute(id: Hex, evidenceHash: Hex) {
    if (!this.options.vault) throw Error("Vault not configured");
    return this.write(this.options.vault, vaultAbi, "respondToDispute", [
      id,
      evidenceHash,
    ]);
  }
  async handleDispute(id: Hex) {
    if (!this.options.vault) throw Error("Vault not configured");
    const s = (await this.options.publicClient.readContract({
      address: this.options.vault,
      abi: vaultAbi,
      functionName: "getSettlement",
      args: [id],
    })) as { provider: Address };
    if (s.provider.toLowerCase() !== this.options.provider.toLowerCase())
      throw Error("Dispute belongs to another provider");
    const d = (await this.options.publicClient.readContract({
      address: this.options.vault,
      abi: vaultAbi,
      functionName: "getDispute",
      args: [id],
    })) as { amount: bigint; resolved: boolean; providerResponded: boolean };
    if (d.resolved || d.providerResponded) return;
    const decision =
      this.options.autoAcceptBelow !== undefined &&
      d.amount <= this.options.autoAcceptBelow
        ? { action: "accept" as const }
        : await this.options.onDispute?.({ id, amount: d.amount });
    if (decision?.action === "accept")
      return this.write(this.options.vault, vaultAbi, "acceptDispute", [id]);
    if (decision?.action === "respond")
      return this.respondToDispute(id, decision.evidenceHash);
  }
  watchDisputes(onError: (error: unknown) => void = () => {}) {
    if (!this.options.vault) throw Error("Vault not configured");
    return this.options.publicClient.watchContractEvent({
      address: this.options.vault,
      abi: vaultAbi,
      eventName: "DisputeOpened",
      onLogs: (logs) => {
        for (const log of logs) {
          const args = (log as unknown as { args: { settlementId: Hex } }).args;
          void this.handleDispute(args.settlementId).catch(onError);
        }
      },
      onError,
    });
  }
}
