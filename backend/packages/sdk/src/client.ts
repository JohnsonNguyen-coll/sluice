import {
  keccak256,
  decodeEventLog,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
  type Abi,
} from "viem";
import {
  walletAbis,
  factoryAbis,
  agentAbi,
  vaultAbi,negotiationAbi,
  reputationAbi,
} from "./contracts";
import { channelState, detectWallet, assertNegotiationConsent,type Factory } from "./chain";
import { getProviderProfile, verifyDomain } from "./profiles";
import { MemoryAgentStore, type AgentStore, type Channel } from "./store";
import {
  address,
  uint,
  hash,
  pack,
  unpack,
  parseReceipt,
  requestHash,
  responseHash,
  verifyReceipt,
  voucherData,
  voucherHash,
  authorizationData,
  parsePolicyAuthorization,
  verifyPolicyAuthorization,
  readBounded,
  type Version,
  type SignedVoucher,
  type SignedReceipt,
  type PolicyAuthorization,
} from "./protocol";

export type PaymentPolicy = {
  allowedProviders: readonly Address[];
  allowedTokens: readonly Address[];
  allowedOrigins?: readonly string[];
  maxPerCall: bigint;
  maxDisputeWindow?: number;
  minProviderScore?: number;
  requireVerifiedDomain?: boolean;
  requireRegisteredProvider?: boolean;
};
export type ClientOptions = {
  wallet: Address;
  chainId: number;
  publicClient: PublicClient;
  agent: LocalAccount;
  factories: readonly Factory[];
  owner?: WalletClient;
  registry?: Address;
  providerRegistry?: Address;
  reputationRegistry?: Address;
  vault?: Address;
  store?: AgentStore;
  policy: PaymentPolicy;
  /** Optional policy authority. Configure this for providers which require a
   * server-verified daily-spend reservation before they serve a request. */
  policyAuthority?: { url: string; signer: Address };
  fetch?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  validateResponse?: (response: Response) => Promise<boolean> | boolean;
};
export class AgentPayClient {
  readonly store: AgentStore;
  private transport: typeof fetch;
  private locks = new Map<string, Promise<void>>();
  constructor(readonly options: ClientOptions) {
    this.store = options.store || new MemoryAgentStore();
    this.transport = options.fetch || fetch;
  }
  private now() {
    return this.options.now?.() ?? Math.floor(Date.now() / 1000);
  }
  private async serial<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) || Promise.resolve();
    let finish!: () => void;
    const gate = new Promise<void>((r) => {
      finish = r;
    });
    const tail = prior.then(() => gate);
    this.locks.set(key, tail);
    await prior;
    try {
      return await action();
    } finally {
      finish();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    if (!["http:", "https:"].includes(new URL(request.url).protocol))
      throw Error("Unsupported API URL");
    if (
      this.options.policy.allowedOrigins &&
      !this.options.policy.allowedOrigins.includes(new URL(request.url).origin)
    )
      throw Error("API origin is not allowed");
    const domainProof = this.options.policy.requireVerifiedDomain
      ? await verifyDomain(request.url, this.options.chainId, this.transport)
      : undefined;
    if (
      domainProof &&
      !this.options.policy.allowedProviders.some(
        (p) => p.toLowerCase() === domainProof.provider.toLowerCase(),
      )
    )
      throw Error("Domain provider is not allowed");
    const body = await readBounded(request.clone().body, 32768);
    const detectedVersion = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    request.headers.set("X-AgentPay-Version", String(detectedVersion));
    const first = await this.transport(request.clone(), {
      redirect: "error",
      signal: AbortSignal.any([
        request.signal,
        AbortSignal.timeout(this.options.requestTimeoutMs ?? 15000),
      ]),
    });
    if (first.status !== 402) return first;
    const quoteHeader = first.headers.get("X-AgentPay-Quote");
    const quote = (quoteHeader ? unpack(quoteHeader) : await first.json()) as {
      chainId: number;
      provider: Address;
      token: Address;
      price: string;
      version: Version;
      policy?: { signer?: Address; url?: string };
    };
    address(quote.provider);
    address(quote.token);
    uint(quote.price);
    if (
      domainProof &&
      domainProof.provider.toLowerCase() !== quote.provider.toLowerCase()
    )
      throw Error("Quote provider differs from verified domain");
    if (
      quote.chainId !== this.options.chainId ||
      BigInt(quote.price) <= 0n ||
      BigInt(quote.price) > this.options.policy.maxPerCall ||
      !this.options.policy.allowedProviders.some(
        (p) => p.toLowerCase() === quote.provider.toLowerCase(),
      ) ||
      !this.options.policy.allowedTokens.some(
        (p) => p.toLowerCase() === quote.token.toLowerCase(),
      )
    )
      throw Error("Payment denied by spending policy");
    const version = detectedVersion;
    if (quote.version !== version)
      throw Error("Provider does not support this wallet version");
    let policyAuthority = this.options.policyAuthority;
    if (quote.policy?.signer) {
      address(quote.policy.signer);
      if (policyAuthority && policyAuthority.signer.toLowerCase() !== quote.policy.signer.toLowerCase())
        throw Error("Provider policy authority does not match the configured authority");
      if (!policyAuthority) {
        if (!quote.policy.url) throw Error("Provider requires a policy authority but did not advertise one");
        const authorityUrl = new URL(quote.policy.url);
        // Hosted Sluice APIs use their own origin for the authority. Do not
        // let an API quote redirect an agent to a third-party ticket service.
        if (authorityUrl.origin !== new URL(request.url).origin)
          throw Error("Provider policy authority must use the API origin");
        policyAuthority = { url: authorityUrl.toString(), signer: quote.policy.signer };
      }
    }
    await this.checkProfile(
      quote.provider,
      request.url,
      version,
      !!domainProof,
    );
    if(version===3)await assertNegotiationConsent(this.options.publicClient,this.options.wallet,quote.provider,quote.token,this.options.factories);
    const key = [
      this.options.chainId,
      this.options.wallet,
      quote.provider,
      quote.token,
    ]
      .join(":")
      .toLowerCase();
    return this.serial(key, async () => {
      const reqHash = requestHash(request.method, request.url, body),
        state = await channelState(
          this.options.publicClient,
          this.options.wallet,
          quote.provider,
          quote.token,
          version,
        );
      if (state.paused) throw Error("Wallet is paused");
      let local = await this.store.channel(key),
        voucher: SignedVoucher;
      if (local?.pending) {
        if (local.pending.requestHash !== reqHash)
          throw Error(
            "Previous payment is unresolved; retry the original request or reconcile it first",
          );
        voucher = local.pending;
      } else {
        const previous = local;
        const base =
          BigInt(local?.cumulativeAmount || "0") > state.settled
            ? BigInt(local!.cumulativeAmount)
            : state.settled;
        const nonce =
            (BigInt(local?.nonce || "0") > state.nonce
              ? BigInt(local!.nonce)
              : state.nonce) + 1n,
          cumulative = base + BigInt(quote.price);
        if (
          cumulative > state.maxTotal ||
          (state.perCallCap > 0n &&
            cumulative - state.settled > state.perCallCap)
        )
          throw Error("Wallet budget or unsettled exposure limit exceeded");
        const value = {
          wallet: this.options.wallet,
          provider: quote.provider,
          token: quote.token,
          cumulativeAmount: String(cumulative),
          nonce: String(nonce),
          expiry: String(this.now() + 300),
        };
        voucher = {
          ...value,
          version,
          requestHash: reqHash,
          signature: await this.options.agent.signTypedData(
            voucherData(value, version, this.options.chainId),
          ),
        };
        voucher.requestSignature = await this.options.agent.signTypedData(
          authorizationData(voucher, this.options.chainId),
        );
        local = {
          nonce: String(nonce),
          cumulativeAmount: String(cumulative),
          pending: voucher,
        };
        if (!(await this.store.reserve(key, previous, local)))
          throw Error("Payment channel changed concurrently; retry");
      }
      const id = voucherHash(voucher, this.options.chainId),
        createdAt = Date.now();
      await this.store.save({ id, voucher, createdAt });
      let response: Response;
      try {
        const headers = new Headers(request.headers);
        headers.set("X-AgentPay-Voucher", pack(voucher));
        if (policyAuthority) {
          const policyResponse = await this.transport(
            new Request(policyAuthority.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ voucher, amount: quote.price }),
              signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 15000),
            }),
          );
          if (!policyResponse.ok) {
            const failure = await policyResponse.json().catch(() => null) as { error?: { code?: unknown } } | null;
            const code = failure?.error?.code;
            const reason = typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)
              ? code : "POLICY_UNAVAILABLE";
            throw Error(`Policy authority denied this payment (${reason}, HTTP ${policyResponse.status})`);
          }
          const body = (await policyResponse.json()) as {
            authorization?: PolicyAuthorization;
          };
          const authorization = parsePolicyAuthorization(body.authorization);
          if (
            authorization.voucherHash.toLowerCase() !== id.toLowerCase() ||
            authorization.requestHash.toLowerCase() !== voucher.requestHash.toLowerCase() ||
            authorization.wallet.toLowerCase() !== voucher.wallet.toLowerCase() ||
            authorization.provider.toLowerCase() !== voucher.provider.toLowerCase() ||
            authorization.token.toLowerCase() !== voucher.token.toLowerCase() ||
            authorization.amount !== quote.price ||
            BigInt(authorization.expiry) < BigInt(this.now()) ||
            !(await verifyPolicyAuthorization(
              authorization,
              policyAuthority.signer,
              this.options.chainId,
            ))
          )
            throw Error("Invalid policy authorization");
          headers.set("X-Sluice-Policy", pack(authorization));
        }
        response = await this.transport(new Request(request, { headers }), {
          redirect: "error",
          signal: AbortSignal.any([
            request.signal,
            AbortSignal.timeout(this.options.requestTimeoutMs ?? 15000),
          ]),
        });
      } catch (error) {
        await this.store.save({
          id,
          voucher,
          createdAt,
          flag: "timeout or network failure; payment may be outstanding",
        });
        throw error;
      }
      if (version !== 3) {
        if (response.status !== 402) {
          await this.store.reserve(key, local, {
            nonce: local!.nonce,
            cumulativeAmount: local!.cumulativeAmount,
          });
        }
        return response;
      }
      try {
        const header = response.headers.get("X-AgentPay-Receipt");
        if (!header) throw Error("Missing signed receipt");
        const receipt = parseReceipt(unpack<SignedReceipt>(header));
        const r = receipt.receipt;
        const bytes = await readBounded(response.clone().body, 1024 * 1024);
        if (
          receipt.chainId !== this.options.chainId ||
          receipt.wallet.toLowerCase() !== this.options.wallet.toLowerCase() ||
          receipt.provider.toLowerCase() !== quote.provider.toLowerCase() ||
          r.token.toLowerCase() !== quote.token.toLowerCase() ||
          r.voucherHash !== id ||
          r.requestHash !== reqHash ||
          r.responseHash !== responseHash(bytes) ||
          r.status !== response.status ||
          r.nonce !== voucher.nonce ||
          r.amount !== quote.price ||
          Math.abs(Number(r.timestamp) - this.now()) > 300 ||
          !(await verifyReceipt(receipt))
        )
          throw Error("Receipt verification failed");
        const flag = !response.ok
          ? "non-2xx response"
          : this.options.validateResponse &&
              !(await this.options.validateResponse(response.clone()))
            ? "schema mismatch"
            : undefined;
        await this.store.save({
          id,
          voucher,
          receipt,
          createdAt,
          ...(flag ? { flag } : {}),
        });
        if (
          !(await this.store.reserve(key, local, {
            nonce: local!.nonce,
            cumulativeAmount: local!.cumulativeAmount,
          }))
        )
          throw Error("Payment channel changed before receipt commit");
      } catch (error) {
        await this.store.save({
          id,
          voucher,
          createdAt,
          flag: error instanceof Error ? error.message : "Invalid receipt",
        });
        throw error;
      }
      return response;
    });
  }
  private async checkProfile(
    provider: Address,
    url: string,
    version: Version,
    domainVerified = false,
  ) {
    const p = this.options.policy;
    if (version !== 3) {
      if (
        p.requireRegisteredProvider ||
        p.requireVerifiedDomain ||
        p.minProviderScore !== undefined ||
        p.maxDisputeWindow !== undefined
      )
        throw Error("Trust policies require V3");
      return;
    }
    if (!this.options.providerRegistry || !this.options.reputationRegistry) {
      if (
        p.requireRegisteredProvider ||
        p.requireVerifiedDomain ||
        p.minProviderScore !== undefined ||
        p.maxDisputeWindow !== undefined
      )
        throw Error("Provider registries are not configured");
      return;
    }
    const profile = await this.getProviderProfile(
      p.requireVerifiedDomain && !domainVerified ? url : provider,
    );
    if (
      profile.provider.toLowerCase() !== provider.toLowerCase() ||
      (p.requireRegisteredProvider &&
        (!profile.registered || !profile.entry?.active)) ||
      (p.requireVerifiedDomain && !domainVerified && !profile.verifiedDomain) ||
      (p.maxDisputeWindow !== undefined &&
        Number(profile.entry?.disputeWindow || 0) > p.maxDisputeWindow) ||
      (p.minProviderScore !== undefined &&
        (profile.reputation.score === null ||
          profile.reputation.score < p.minProviderScore))
    )
      throw Error("Provider trust policy denied payment");
  }
  getProviderProfile(input: string) {
    if (!this.options.providerRegistry || !this.options.reputationRegistry)
      throw Error("Provider registries not configured");
    return getProviderProfile(input, {
      client: this.options.publicClient,
      chainId: this.options.chainId,
      registry: this.options.providerRegistry,
      reputation: this.options.reputationRegistry,
      wallet: this.options.wallet,
      fetch: this.transport,
    });
  }
  async flagCall(id: string, reason: string) {
    const record = await this.store.get(id);
    if (!record) throw Error("Unknown call");
    if (reason.length > 1000) throw Error("Flag too long");
    await this.store.save({ ...record, flag: reason });
  }
  private async write(
    at: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
  ) {
    const owner = this.options.owner;
    if (!owner?.account) throw Error("Owner wallet connection is required");
    if (
      (await this.options.publicClient.getChainId()) !== this.options.chainId ||
      (await owner.getChainId()) !== this.options.chainId
    )
      throw Error("Wrong chain");
    const { request } = await this.options.publicClient.simulateContract({
      address: at,
      abi,
      functionName,
      args,
      account: owner.account,
    });
    const tx = await owner.writeContract({
      ...request,
      account: owner.account,
      chain: owner.chain,
    });
    const receipt = await this.options.publicClient.waitForTransactionReceipt({
      hash: tx,
    });
    if (receipt.status !== "success") throw Error("Transaction reverted");
    return receipt;
  }
  async registerAgent(metadataHash: Hex) {
    if (!this.options.registry) throw Error("Agent registry not configured");
    return this.write(
      this.options.registry,
      agentAbi,
      "registerWithMetadataHash",
      [this.options.wallet, hash(metadataHash)],
    );
  }
  async disputeVaultAddress():Promise<Address>{const version=await detectWallet(this.options.publicClient,this.options.wallet,this.options.factories);if(version!==3)throw Error('This wallet version has no dispute vault');const factory=await this.options.publicClient.readContract({address:this.options.wallet,abi:walletAbis[3],functionName:'factory'}) as Address;return await this.options.publicClient.readContract({address:factory,abi:factoryAbis[3],functionName:'disputeVault'}) as Address;}
  async acceptArbitrationTerms(provider:Address,token:Address){const vault=await this.disputeVaultAddress();const expected=await this.options.publicClient.readContract({address:vault,abi:negotiationAbi,functionName:'arbitrationTermsHash',args:[provider,token]});return this.write(vault,negotiationAbi,'acceptArbitrationTerms',[this.options.wallet,provider,token,expected]);}
  async openDispute(input: {
    id: Hex;
    amount: bigint;
    reasonCode: number;
    evidenceHash: Hex;
    receipt?: SignedReceipt;
    proof?: Hex[];
  }) {
    const vault=await this.disputeVaultAddress();
    if (
      (await detectWallet(
        this.options.publicClient,
        this.options.wallet,
        this.options.factories,
      )) !== 3
    )
      throw Error("Disputes require V3");
    if (input.receipt) {
      const r = input.receipt;
      if (!(await verifyReceipt(r))) throw Error("Invalid receipt signature");
      return this.write(
        vault,
        vaultAbi,
        "openDisputeWithReceipt",
        [
          hash(input.id),
          {
            ...r.receipt,
            timestamp: BigInt(r.receipt.timestamp),
            nonce: BigInt(r.receipt.nonce),
            amount: BigInt(r.receipt.amount),
          },
          r.signature,
          input.proof || [],
          input.amount,
          input.reasonCode,
          hash(input.evidenceHash),
        ],
      );
    }
    return this.write(vault, vaultAbi, "openDispute", [
      hash(input.id),
      input.amount,
      input.reasonCode,
      hash(input.evidenceHash),
    ]);
  }
  async trackDispute(id: Hex) {
    const vault=await this.disputeVaultAddress();
    const read = (functionName: string) =>
      this.options.publicClient.readContract({
        address: vault,
        abi: vaultAbi,
        functionName,
        args: [hash(id)],
      });
    const [settlement, dispute] = await Promise.all([
      read("getSettlement"),
      read("getDispute"),
    ]);
    return { settlement, dispute };
  }
  async setProviderBudget(
    provider: Address,
    token: Address,
    maxTotal: bigint,
    perCallCap: bigint,
  ) {
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      "setProviderBudget",
      version === 1
        ? [provider, maxTotal, perCallCap]
        : [provider, token, maxTotal, perCallCap],
    );
  }
  async deposit(token: Address, amount: bigint) {
    const erc20 = [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ type: "bool" }],
      },
    ] as const;
    await this.write(token, erc20, "approve", [this.options.wallet, amount]);
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      "deposit",
      version === 1 ? [amount] : [token, amount],
    );
  }
  async reconcile(provider: Address, token: Address) {
    const key = [this.options.chainId, this.options.wallet, provider, token]
        .join(":")
        .toLowerCase(),
      local = await this.store.channel(key);
    if (!local?.pending) return;
    const version = await detectWallet(
        this.options.publicClient,
        this.options.wallet,
        this.options.factories,
      ),
      state = await channelState(
        this.options.publicClient,
        this.options.wallet,
        provider,
        token,
        version,
      );
    if (
      state.nonce < BigInt(local.pending.nonce) ||
      state.settled < BigInt(local.pending.cumulativeAmount)
    )
      throw Error(
        "Pending authorization has not settled; retain and retry the identical request",
      );
    if (
      !(await this.store.reserve(key, local, {
        nonce: local.nonce,
        cumulativeAmount: local.cumulativeAmount,
      }))
    )
      throw Error("Channel changed during reconciliation");
  }
  async requestBudgetDecrease(
    provider: Address,
    token: Address,
    maxTotal: bigint,
    perCallCap: bigint,
  ) {
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      "requestBudgetDecrease",
      version === 1
        ? [provider, maxTotal, perCallCap]
        : [provider, token, maxTotal, perCallCap],
    );
  }
  async executeBudgetDecrease(provider: Address, token: Address) {
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      "executeBudgetDecrease",
      version === 1 ? [provider] : [provider, token],
    );
  }
  async withdraw(token: Address, amount: bigint) {
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      "withdraw",
      version === 1 ? [amount] : [token, amount],
    );
  }
  async pause(paused = true) {
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      paused ? "pause" : "unpause",
      [],
    );
  }
  async rotateAgentSigner(signer: Address) {
    const version = await detectWallet(
      this.options.publicClient,
      this.options.wallet,
      this.options.factories,
    );
    return this.write(
      this.options.wallet,
      walletAbis[version],
      "rotateAgentSigner",
      [signer],
    );
  }
  async giveFeedback(
    provider: Address,
    score: number,
    tagHash: Hex,
    evidenceHash: Hex,
  ) {
    if (
      !this.options.reputationRegistry ||
      !Number.isInteger(score) ||
      score < 1 ||
      score > 5
    )
      throw Error(
        "Configure reputation registry and choose a score from 1 to 5",
      );
    return this.write(
      this.options.reputationRegistry,
      reputationAbi,
      "giveFeedback",
      [this.options.wallet, provider, score, hash(tagHash), hash(evidenceHash)],
    );
  }
}
export async function createAgentWallet(options: {
  client: PublicClient;
  owner: WalletClient;
  factory: Factory;
  agentSigner: Address;
  settleWindow: number;
  userSalt: Hex;
}) {
  const owner = options.owner;
  if (!owner.account) throw Error("Owner connection required");
  if ((await owner.getChainId()) !== (await options.client.getChainId()))
    throw Error("Wallet/RPC chain mismatch");
  const { request } = await options.client.simulateContract({
    address: options.factory.address,
    abi: factoryAbis[options.factory.version],
    functionName: "createWallet",
    args: [
      owner.account.address,
      options.agentSigner,
      options.settleWindow,
      options.userSalt,
    ],
    account: owner.account,
  });
  const hash = await owner.writeContract({
    ...request,
    account: owner.account,
    chain: owner.chain,
  });
  const receipt = await options.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw Error("Wallet creation reverted");
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== options.factory.address.toLowerCase())
      continue;
    try {
      const event = decodeEventLog({
        abi: factoryAbis[options.factory.version],
        ...log,
      }) as unknown as { eventName: string; args: { wallet: Address } };
      if (event.eventName === "WalletCreated")
        return { address: event.args.wallet, transactionHash: hash };
    } catch {}
  }
  throw Error("Confirmed wallet creation event is missing");
}
