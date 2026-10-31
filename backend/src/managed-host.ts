import { upstreamConfig, sealUpstream, openUpstream, gatewayInput, callUpstream, type Upstream } from "./api-gateway";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  parseEther,
  parseUnits,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type Abi,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  PaymentProvider,
  SupabaseProviderStore,
  type ProviderStore,
} from "@sluice/middleware";
import { providerAbi, negotiationAbi, vaultAbi } from "@sluice/sdk";
import deployment from "../../contract/deployments/arc-testnet.json";
import type { Config } from "./config";
import type { Gateway } from "./chain";
import type { CatalogStore } from "./catalog";
import { shortText } from "./catalog";
import { publicRpcTransport } from "./rpc";
import { fail, apiError } from "./errors";
import { address, body, hex, uint } from "./validation";
import {
  encryptionKey,
  encryptSigner,
  decryptSigner,
  managedTemplates,
  runManagedTool,
} from "./managed-tools";
import { type ManagedStore, type ManagedService } from "./managed-store";
import { X402Gateway } from "./x402-gateway";
import { PolicyAuthority } from "./policy-authority";

const ZERO = "0x0000000000000000000000000000000000000000";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export interface HostedApi {
  capabilities(): unknown;
  list(owner: Address): Promise<unknown>;
  create(owner: Address, input: Record<string, unknown>): Promise<unknown>;
  activate(owner: Address, id: string): Promise<unknown>;
  pause(owner: Address, id: string): Promise<unknown>;
  testConnection(owner: Address, id: string, input: Record<string,unknown>): Promise<unknown>;
  updateConnection(owner: Address, id: string, input: Record<string,unknown>): Promise<unknown>;
  ownsProvider(owner: Address, provider: Address): Promise<boolean>;
  receiptList(owner: Address, id: string): Promise<unknown>;
  disputeService(owner: Address, id: Hex): Promise<unknown>;
  disputeAction(
    owner: Address,
    id: Hex,
    input: Record<string, unknown>,
  ): Promise<unknown>;
  serve(id: string, req: Request): Promise<Response>;
  serveX402(id: string, req: Request): Promise<Response>;
  start(): () => Promise<void>;
}
export class ManagedHost implements HostedApi {
  private client: PublicClient;
  private token: Address;
  private base: string;
  private busy = new Set<string>();
  private x402Gateways = new Map<string, Promise<X402Gateway>>();
  private closing = false;
  private tasks = new Set<Promise<unknown>>();
  private policyAuthority?: PolicyAuthority;
  constructor(
    private config: Config,
    private store: ManagedStore,
    private catalog: CatalogStore,
    private chain: Gateway,
    private env: Record<string, string | undefined> = process.env,
    private providers: ProviderStore = new SupabaseProviderStore(
      config.supabaseUrl || "",
      config.supabaseKey || "",
    ),
    client?: PublicClient,
  ) {
    this.client =
      client ||
      createPublicClient({
        transport: publicRpcTransport(config.rpcUrls, config.chainId),
        cacheTime: 0,
      });
    this.token = address(
      env.MANAGED_PAYMENT_TOKEN ||
        deployment.v1.contracts.AgentWalletFactory.constructorArgs.usdc,
    );
    const url = new URL(
      env.MANAGED_API_BASE_URL || "http://127.0.0.1:" + config.port,
    );
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(url.hostname))
      )
    )
      throw Error("MANAGED_API_BASE_URL must be an HTTPS origin or localhost");
    this.base = url.origin;
    if (config.policyAuthorityKey) this.policyAuthority = new PolicyAuthority(config);
  }
  capabilities() {
    let configured = false;
    try {
      encryptionKey(this.env);
      configured =
        !!this.config.supabaseUrl &&
        !!this.config.supabaseKey &&
        !!this.config.providerRegistry &&
        this.config.factories.some((f) => !!f.negotiationVault) &&
        [5042002, 31337].includes(this.config.chainId);
    } catch {}
    return {
      available: configured,
      templates: managedTemplates,
      gateway: { methods: ["GET", "POST"], authentication: ["none", "bearer", "header"], response: "JSON", maxInputBytes: 24000, maxOutputBytes: 1048576, timeoutSeconds: 15, billing: "per-accepted-request" },
      publicBaseUrl: this.base,
      canPublish: this.base.startsWith("https://"),
      gasDepositWei: parseEther("0.25").toString(),
      gasCurrency: "testnet native USDC",
      notice:
        "Sluice stores an encrypted operational provider key and runs this API. Payouts go to your connected wallet. Gas funding is separate from API earnings. Only Arc Testnet/local development is enabled.",
    };
  }
  private ready() {
    if (!(this.capabilities() as { available: boolean }).available)
      fail(
        503,
        "MANAGED_NOT_CONFIGURED",
        "Hosted APIs need Supabase, a server encryption key and a negotiated wallet deployment",
      );
  }
  private context(s: ManagedService) {
    return [s.chain_id, s.id, s.owner, s.provider].join(":");
  }
  private account(s: ManagedService) {
    const account = privateKeyToAccount(
      decryptSigner(
        s.signer_ciphertext,
        this.context(s),
        encryptionKey(this.env),
      ),
    );
    if (account.address.toLowerCase() !== s.provider)
      fail(
        503,
        "SIGNER_UNAVAILABLE",
        "Hosted provider identity does not match its signer",
      );
    return account;
  }
  private wallet(s: ManagedService) {
    return createWalletClient({
      account: this.account(s),
      transport: publicRpcTransport(this.config.rpcUrls, this.config.chainId),
    });
  }
  private x402(s: ManagedService) {
    const cached = this.x402Gateways.get(s.id);
    if (cached) return cached;
    const account = this.account(s), wallet = this.wallet(s), client = this.client;
    const gateway = X402Gateway.create({
      network: `eip155:${this.config.chainId}`,
      receiver: address(s.owner),
      token: this.token,
      price: s.price,
      resourceUrl: this.base + "/x402/" + s.id,
      serviceName: s.name,
      storageDirectory: resolve(import.meta.dir, "../../.tools/x402", s.id),
      receiverAuthorizerSigner: account,
      facilitatorSigner: {
        address: account.address,
        readContract: (args) => client.readContract(args as never),
        verifyTypedData: (args) => client.verifyTypedData(args as never),
        writeContract: (args) => wallet.writeContract({
          ...args,
          account,
          chain: null,
        } as never),
        sendTransaction: (args) => wallet.sendTransaction({
          ...args,
          account,
          chain: null,
        } as never),
        waitForTransactionReceipt: (args) =>
          client.waitForTransactionReceipt(args as never),
        getCode: (args) => client.getCode(args),
      },
    }).catch((error) => {
      this.x402Gateways.delete(s.id);
      throw error;
    });
    this.x402Gateways.set(s.id, gateway);
    return gateway;
  }
  private async get(id: string) {
    this.ready();
    if (!uuid.test(id)) fail(400, "INVALID_SERVICE", "Invalid hosted API ID");
    const s = await this.store.get(id);
    if (!s || s.chain_id !== this.config.chainId)
      fail(404, "SERVICE_NOT_FOUND", "Hosted API not found");
    return s;
  }
  private async owned(owner: Address, id: string) {
    const s = await this.get(id);
    if (s.owner !== owner.toLowerCase())
      fail(403, "FORBIDDEN", "Only this hosted API owner may manage it");
    return s;
  }
  private view(s: ManagedService) {
    return {
      id: s.id,
      name: s.name,
      connection: s.kind === "http-proxy" ? this.connectionView(s) : null,
      slug: s.slug,
      kind: s.kind,
      owner: s.owner,
      provider: s.provider,
      price: s.price,
      state: s.state,
      published: s.published,
      endpoint: this.base + "/hosted/" + s.id,
      x402Endpoint: this.base + "/x402/" + s.id,
      token: this.token,
      decimals: 6,
      registrationTx: s.registration_tx || null,
      lastSettlementTx: s.last_settlement_tx || null,
      lastWorkerAt: s.last_worker_at || null,
      workerError: s.worker_error || null,
      createdAt: s.created_at,
      disputeWindow: 3600,
    };
  }
  private upstream(s: ManagedService): Upstream {
    if (s.kind !== "http-proxy" || !s.upstream_ciphertext)
      fail(400, "NOT_GATEWAY", "This API has no upstream connection");
    return openUpstream(s.upstream_ciphertext, this.context(s), encryptionKey(this.env));
  }
  private connectionView(s: ManagedService) {
    const config = this.upstream(s);
    return { url: config.url, method: config.method, auth: config.auth, header: config.header, hasKey: !!config.secret, testedAt: s.upstream_tested_at || null };
  }
  async updateConnection(owner: Address, id: string, input: Record<string,unknown>) {
    const initial = await this.owned(owner, id);
    return this.exclusive(initial, async () => {
    const s = await this.owned(owner, id);
    if (s.kind !== "http-proxy") fail(400, "NOT_GATEWAY", "Only gateway APIs have a connection");
    // Immutable target/method. Credentials may rotate without changing what an
    // already signed voucher authorizes. A new key is required.
    if (s.state === "active") fail(409, "PAUSE_REQUIRED", "Pause new calls before rotating the upstream key");
    const current = this.upstream(s);
    if (current.auth === "none") fail(400, "NO_UPSTREAM_KEY", "This connection does not use an API key");
    const next = upstreamConfig({ upstreamUrl: current.url, upstreamMethod: current.method, upstreamAuth: current.auth, upstreamHeader: current.header, upstreamKey: input.upstreamKey });
    await this.store.update(s.id, { upstream_ciphertext: sealUpstream(next, this.context(s), encryptionKey(this.env)), upstream_tested_at: null });
    return { service: this.view((await this.get(id))) };
    });
  }
  async testConnection(owner: Address, id: string, input: Record<string,unknown>) {
    const initial = await this.owned(owner, id);
    return this.exclusive(initial, async () => {
    const s = await this.owned(owner, id);
    if (input.confirm !== true) fail(400, "TEST_CONSENT_REQUIRED", "Confirm this sends a real upstream request, which may incur upstream charges");
    if (s.state === "active") fail(409, "PAUSE_REQUIRED", "Pause the API before testing its connection");
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) fail(400, "INVALID_INPUT", "Supply a JSON object for the test request");
    const result = await callUpstream(this.upstream(s), input.payload as Record<string,unknown>, "sluice-test-" + randomUUID());
    const testedAt = result.ok ? new Date().toISOString() : null;
    await this.store.update(s.id, { upstream_tested_at: testedAt });
    return { ok: result.ok, status: result.status, testedAt, message: result.ok ? "Upstream returned valid JSON. Ready to activate." : "Connection check failed. Verify endpoint, credentials and request body. Upstream errors are redacted." };
    });
  }
  async list(owner: Address) {
    this.ready();
    const items = await this.store.list(this.config.chainId, owner);
    return { items: items.map((s) => this.view(s)) };
  }
  async create(owner: Address, input: Record<string, unknown>) {
    this.ready();
    if (input.acceptHostedCustody !== true)
      fail(
        400,
        "HOSTED_CONSENT_REQUIRED",
        "Confirm that Sluice operates this API and stores its encrypted provider signer",
      );
    const kind = String(input.kind);
    if (kind !== "http-proxy" && !managedTemplates.some((t) => t.id === kind))
      fail(400, "INVALID_TEMPLATE", "Choose a hosted API template");
    const upstream = kind === "http-proxy" ? upstreamConfig(input) : null;
    if (upstream && (input.acceptUpstreamRights !== true || input.acceptAttemptBilling !== true))
      fail(400, "GATEWAY_CONSENT_REQUIRED", "Confirm your right to expose this API and the per-accepted-request billing terms");
    const slug = shortText(input.slug, "API URL name", 48);
    if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(slug))
      fail(400, "INVALID_SLUG", "Use lowercase letters, numbers and hyphens");
    const price = shortText(input.priceUsdc, "Price", 20);
    if (!/^\d{1,2}(\.\d{1,6})?$/.test(price))
      fail(
        400,
        "INVALID_PRICE",
        "Use a USDC price with up to six decimal places",
      );
    const units = parseUnits(price, 6);
    if (units <= 0n || units > 1000000n)
      fail(
        400,
        "INVALID_PRICE",
        "Hosted tools cost more than 0 and at most 1 USDC per call",
      );
    if (typeof input.published !== "boolean")
      fail(400, "INVALID_INPUT", "Choose whether to publish");
    if (input.published && !this.base.startsWith("https://"))
      fail(
        400,
        "HTTPS_REQUIRED",
        "Configure a public HTTPS API origin before publishing",
      );
    const existing = await this.store.list(this.config.chainId, owner);
    if (existing.length >= 10)
      fail(
        409,
        "SERVICE_LIMIT",
        "Each wallet can create at most 10 hosted APIs",
      );
    const key = generatePrivateKey(),
      provider = privateKeyToAccount(key),
      s: ManagedService = {
        id: randomUUID(),
        chain_id: this.config.chainId,
        owner: owner.toLowerCase(),
        provider: provider.address.toLowerCase(),
        slug,
        name: shortText(input.name, "API name", 80),
        kind: kind as ManagedService["kind"],
        price: units.toString(),
        signer_ciphertext: "",
        state: "draft",
        published: input.published,
      };
    s.signer_ciphertext = encryptSigner(
      key,
      this.context(s),
      encryptionKey(this.env),
    );
    if (upstream) s.upstream_ciphertext = sealUpstream(upstream, this.context(s), encryptionKey(this.env));
    await this.store.insert(s);
    return { service: this.view(s) };
  }
  private payments(s: ManagedService) {
    const factory = this.config.factories.filter((f) => !!f.negotiationVault);
    return new PaymentProvider({
      provider: address(s.provider),
      token: this.token,
      chainId: this.config.chainId,
      price: BigInt(s.price),
      signer: this.account(s),
      publicClient: this.client,
      walletClient: this.wallet(s),
      factories: factory,
      store: this.providers,
      versions: [3],
      vault: this.config.disputeVault,
      // Managed APIs never serve a paid response unless the authority reserved
      // the wallet's current-day allowance for this exact voucher.
      policySigner: this.config.policyAuthoritySigner,
      policyAuthorityUrl: this.config.policyAuthoritySigner
        ? this.base + "/policy/authorize"
        : undefined,
      onSettled: async (records) => {
        await this.policyAuthority?.release(records.flatMap((record) =>
          record.policyAuthorization ? [record.policyAuthorization.voucherHash] : [],
        ));
      },
    });
  }
  // Every on-chain operation shares a persistent per-provider lease. A crash or
  // uncertain broadcast keeps that lease until an operator reconciles chain state.
  private async exclusive<T>(
    s: ManagedService,
    action: (sending: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.closing || this.busy.has(s.id))
      fail(409, "PROVIDER_BUSY", "Provider is processing another operation");
    const holder = randomUUID();
    this.busy.add(s.id);
    let locked = false,
      sent = false,
      complete = false;
    try {
      locked = await this.store.lock(s.id, holder);
      if (!locked)
        fail(
          409,
          "PROVIDER_LOCKED",
          "Provider is busy or requires operator reconciliation",
        );
      const result = await action(() => {
        sent = true;
      });
      complete = true;
      return result;
    } catch (error) {
      if (locked && sent)
        await this.store.update(s.id, {
          worker_error:
            "An on-chain operation needs operator reconciliation. New paid calls are stopped.",
        });
      throw error;
    } finally {
      this.busy.delete(s.id);
      if (locked && (!sent || complete)) await this.store.unlock(s.id, holder);
    }
  }
  private async write(
    s: ManagedService,
    at: Address,
    abi: Abi,
    name: string,
    args: unknown[],
    sending: () => void,
  ) {
    const wallet = this.wallet(s);
    if ((await this.client.getChainId()) !== this.config.chainId)
      fail(503, "CHAIN_MISMATCH", "Wrong managed provider chain");
    const simulation = await this.client.simulateContract({
      address: at,
      abi,
      functionName: name,
      args,
      account: wallet.account,
    });
    sending();
    const hash = await wallet.writeContract({
      ...simulation.request,
      account: wallet.account,
      chain: null,
    });
    const receipt = await this.client.waitForTransactionReceipt({
      hash,
      timeout: 60000,
    });
    if (receipt.status !== "success")
      fail(409, "PROVIDER_TX_FAILED", "Provider transaction reverted");
    return receipt;
  }
  private async publish(s: ManagedService) {
    const template = managedTemplates.find((t) => t.id === s.kind)!;
    await this.catalog.saveListing({
      chain_id: s.chain_id,
      provider: s.provider,
      slug: s.slug,
      name: s.name,
      description:
        (s.kind === "http-proxy" ? "Payment gateway for a provider-operated JSON API." : template.description) +
        " Hosted and operated by Sluice; payout recipient: " +
        s.owner +
        ".",
      category: "Tools",
      endpoint: this.base + "/hosted/" + s.id,
      method: "POST",
      docs_url: this.base + "/hosted/" + s.id,
      price: s.price,
      published: s.published && s.state === "active",
      updated_at: new Date().toISOString(),
    });
  }
  async activate(owner: Address, id: string) {
    let s = await this.owned(owner, id);
    if (s.worker_error) fail(409, "PROVIDER_REVIEW_REQUIRED", s.worker_error);
    if (s.kind === "http-proxy" && (!s.upstream_tested_at || Date.now() - Date.parse(s.upstream_tested_at) > 86400000)) fail(409, "CONNECTION_TEST_REQUIRED", "Run a successful upstream connection check within 24 hours before activation");
    if (
      (await this.client.getBalance({ address: address(s.provider) })) <
      parseEther("0.01")
    )
      fail(
        409,
        "PROVIDER_GAS_REQUIRED",
        "Fund this provider with testnet native USDC before activating",
      );
    return this.exclusive(s, async (sending) => {
      s = await this.owned(owner, id);
      if (s.kind === "http-proxy" && (!s.upstream_tested_at || Date.now() - Date.parse(s.upstream_tested_at) > 86400000)) fail(409, "CONNECTION_TEST_REQUIRED", "Test the current upstream connection before activating");
      const at = this.config.providerRegistry!;
      const registered = await this.client.readContract({
        address: at,
        abi: providerAbi,
        functionName: "isRegistered",
        args: [s.provider],
      });
      if (!registered) {
        const receipt = await this.write(
          s,
          at,
          providerAbi,
          "register",
          [
            owner,
            keccak256(
              toHex(
                JSON.stringify({
                  kind: s.kind,
                  service: s.id,
                  hostedBy: "Sluice",
                }),
              ),
            ),
            3600,
            ZERO,
          ],
          sending,
        );
        s.registration_tx = receipt.transactionHash;
        await this.store.update(s.id, {
          registration_tx: receipt.transactionHash,
        });
      }
      const provider = (await this.chain.provider(address(s.provider))) as {
        entry: {
          payoutAddress: Address;
          active: boolean;
          disputeWindow: number;
        };
      };
      if (
        !provider.entry.active ||
        provider.entry.payoutAddress.toLowerCase() !== s.owner ||
        Number(provider.entry.disputeWindow) !== 3600
      )
        fail(
          409,
          "PROVIDER_TERMS_MISMATCH",
          "Hosted provider registration does not match the agreed payout and hold",
        );
      s.state = "active";
      await this.store.update(s.id, {
        state: s.state,
        last_worker_at: new Date().toISOString(),
      });
      await this.publish(s);
      return { service: this.view(s) };
    });
  }
  async pause(owner: Address, id: string) {
    const initial = await this.owned(owner, id);
    return this.exclusive(initial, async () => {
      const s = await this.owned(owner, id);
      s.state = "paused";
      await this.store.update(s.id, { state: s.state });
      await this.publish(s);
      return { service: this.view(s) };
    });
  }
  async ownsProvider(owner: Address, provider: Address) {
    return (await this.store.list(this.config.chainId, owner)).some(
      (s) => s.provider === provider.toLowerCase(),
    );
  }
  async receiptList(owner: Address, id: string) {
    const s = await this.owned(owner, id);
    const records = await this.providers.pending(undefined, s.provider);
    return {
      items: records.slice(0, 100),
      scope:
        "Unsettled provider records; confirmed receipts are available through the receipts API",
    };
  }
  async disputeService(owner: Address, id: Hex) {
    const entry = (await this.chain.settlement(id, true)) as {
      settlement: { provider: Address };
    };
    const s = (await this.store.list(this.config.chainId, owner)).find(
      (s) => s.provider === entry.settlement.provider.toLowerCase(),
    );
    return { service: s ? this.view(s) : null };
  }
  async disputeAction(owner: Address, id: Hex, input: Record<string, unknown>) {
    const entry = (await this.chain.settlement(id, true)) as {
      vault: Address;
      negotiated: boolean;
      settlement: { provider: Address };
      dispute: { resolved: boolean };
    };
    const s = (await this.store.list(this.config.chainId, owner)).find(
      (s) => s.provider === entry.settlement.provider.toLowerCase(),
    );
    if (!s)
      fail(
        403,
        "FORBIDDEN",
        "Only the hosted provider owner may sign this action",
      );
    if (entry.dispute.resolved)
      fail(409, "DISPUTE_RESOLVED", "Dispute is already resolved");
    let name: string, args: unknown[];
    switch (input.action) {
      case "accept":
        name = "acceptDispute";
        args = [id];
        break;
      case "respond":
        name = "respondToDispute";
        args = [id, hex(input.evidenceHash, 32)];
        break;
      case "propose":
        if (!entry.negotiated)
          fail(400, "LEGACY_DISPUTE", "This case has no negotiation proposals");
        name = "proposeResolution";
        if (typeof input.returnBond !== "boolean")
          fail(400, "INVALID_INPUT", "Choose bond treatment");
        args = [
          id,
          uint(input.refund),
          input.returnBond,
          hex(input.evidenceHash, 32),
        ];
        break;
      case "agree":
        if (!entry.negotiated)
          fail(400, "LEGACY_DISPUTE", "This case has no negotiation proposals");
        name = "acceptResolution";
        args = [id, hex(input.proposalHash, 32)];
        break;
      case "escalate":
        if (!entry.negotiated)
          fail(400, "LEGACY_DISPUTE", "This case has no escalation");
        name = "escalateDispute";
        args = [id];
        break;
      default:
        fail(400, "INVALID_ACTION", "Choose a supported provider action");
    }
    return this.exclusive(s, async (sending) => {
      const receipt = await this.write(
        s,
        entry.vault,
        entry.negotiated ? negotiationAbi : vaultAbi,
        name,
        args,
        sending,
      );
      return { transactionHash: receipt.transactionHash };
    });
  }
  async serve(id: string, req: Request) {
    const s = await this.get(id);
    if (req.method === "GET")
      return Response.json({
        name: s.name,
        description: managedTemplates.find((t) => t.id === s.kind)?.description,
        method: "POST",
        example: s.kind === "http-proxy" ? (this.upstream(s).method === "GET" ? { query: {} } : {}) : managedTemplates.find((t) => t.id === s.kind)?.example,
        requestFormat: s.kind === "http-proxy" ? (this.upstream(s).method === "GET" ? "POST {query: {key: value}}; values are forwarded as upstream query parameters" : "POST your upstream JSON request body unchanged") : "POST {text: string}",
        billing: "Each accepted voucher pays for one request attempt, including upstream errors. Signed receipts record the actual response status. Refunds use the dispute process; they are not automatic.",
        priceUsdcBaseUnits: s.price,
        token: this.token,
        provider: s.provider,
        operator: "Sluice",
        state: s.state,
        payment: "HTTP 402 + AgentPay signed voucher; signed receipt returned",
        x402: {
          endpoint: this.base + "/x402/" + s.id,
          version: 2,
          scheme: "batch-settlement",
          responseDelivery: "The JSON result is returned in the paid HTTP response body only after payment is accepted.",
        },
      });
    if (req.method !== "POST")
      return Response.json(
        { error: "Use POST for paid calls; GET shows documentation" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    if (s.state !== "active" || s.worker_error)
      fail(
        503,
        "SERVICE_UNAVAILABLE",
        "This hosted API is paused or its settlement worker needs attention",
      );
    if (!s.last_worker_at || Date.now() - Date.parse(s.last_worker_at) > 180000)
      fail(
        503,
        "WORKER_UNAVAILABLE",
        "The hosted settlement worker is not ready",
      );
    const input = await body(req.clone());
    const upstream = s.kind === "http-proxy" ? this.upstream(s) : null;
    if (upstream) gatewayInput(upstream, input);
    else runManagedTool(s.kind, input);
    if (
      (await this.client.getBalance({ address: address(s.provider) })) <
      parseEther("0.01")
    )
      fail(
        503,
        "PROVIDER_GAS_REQUIRED",
        "Provider needs gas before accepting more paid calls",
      );
    const registered = (await this.chain.provider(address(s.provider))) as {
      entry: { active: boolean };
    };
    if (!registered.entry.active)
      fail(503, "PROVIDER_INACTIVE", "Provider is not active");
    return this.payments(s).wrap((_request, context) =>
      upstream ? callUpstream(upstream, input, "sluice-" + context.voucherHash) : Response.json(runManagedTool(s.kind, input)),
    )(req);
  }
  async serveX402(id: string, req: Request) {
    const s = await this.get(id);
    if (req.method === "GET")
      return Response.json({
        name: s.name,
        method: "POST",
        protocol: "x402 v2",
        scheme: "batch-settlement",
        network: `eip155:${this.config.chainId}`,
        token: this.token,
        priceUsdcBaseUnits: s.price,
        result: "Returned as the paid HTTP response body after the voucher is committed.",
        safety: "No successful upstream result is released when payment verification or commitment fails.",
      });
    if (req.method !== "POST")
      return Response.json(
        { error: "Use POST for paid x402 calls; GET shows documentation" },
        { status: 405, headers: { Allow: "GET, POST" } },
      );
    if (s.state !== "active" || s.worker_error)
      fail(503, "SERVICE_UNAVAILABLE", "This hosted API is not accepting paid calls");
    const input = await body(req.clone());
    const upstream = s.kind === "http-proxy" ? this.upstream(s) : null;
    if (upstream) gatewayInput(upstream, input);
    else runManagedTool(s.kind, input);
    if ((await this.client.getBalance({ address: address(s.provider) })) < parseEther("0.01"))
      fail(503, "PROVIDER_GAS_REQUIRED", "Provider needs gas before accepting more paid calls");
    const registered = (await this.chain.provider(address(s.provider))) as { entry: { active: boolean } };
    if (!registered.entry.active)
      fail(503, "PROVIDER_INACTIVE", "Provider is not active");

    // One persistent provider lease prevents x402 facilitator transactions from
    // racing AgentPay settlement or a second backend process using the same key.
    return this.exclusive(s, async () =>
      (await this.x402(s)).handle(req, input, () =>
        upstream
          ? callUpstream(upstream, input, "sluice-x402-" + randomUUID())
          : Promise.resolve(Response.json(runManagedTool(s.kind, input))),
      ),
    );
  }
  async tick() {
    if (this.closing) return;
    this.ready();
    for (const s of await this.store.list(this.config.chainId)) {
      if (this.closing) break;
      if (s.state === "draft" || s.worker_error || this.busy.has(s.id))
        continue;
      try {
        const pending = await this.providers.pending(undefined, s.provider);
        const x402 = await this.x402(s);
        const x402Pending = await x402.hasClaimableVouchers();
        if (!pending.length && !x402Pending) {
          await this.store.update(s.id, {
            last_worker_at: new Date().toISOString(),
          });
          continue;
        }
        await this.exclusive(s, async (sending) => {
          sending();
          const hashes = [
            ...(pending.length ? await this.payments(s).settle() : []),
            ...(x402Pending ? await x402.claimAndSettle() : []),
          ];
          await this.store.update(s.id, {
            last_worker_at: new Date().toISOString(),
            ...(hashes.length ? { last_settlement_tx: hashes.at(-1) } : {}),
          });
        });
      } catch (error) {
        if (
          ["PROVIDER_BUSY", "PROVIDER_LOCKED"].includes(
            apiError(error)?.code || "",
          )
        )
          continue;
        await this.store.update(s.id, {
          worker_error:
            "Settlement is blocked. An operator must inspect the provider lease, gas and pending vouchers.",
        });
      }
    }
  }
  start() {
    let running = false;
    const run = () => {
      if (running || this.closing) return;
      running = true;
      const task = this.tick()
        .catch(() => {})
        .finally(() => {
          running = false;
          this.tasks.delete(task);
        });
      this.tasks.add(task);
    };
    const timer = setInterval(run, 60000);
    run();
    return async () => {
      this.closing = true;
      clearInterval(timer);
      await Promise.allSettled(this.tasks);
    };
  }
}
