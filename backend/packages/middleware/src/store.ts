import type { PolicyAuthorization, SignedReceipt, SignedVoucher } from "@sluice/sdk";
export type StoredResponse = {
  status: number;
  headers: [string, string][];
  body: string;
};
export type ReceiptCommitment = {
  root: string;
  proof: string[];
  settlementId: string;
  settlementNonce: string;
  transactionHash: string;
};
export type ProviderRecord = {
  id: string;
  channel: string;
  voucher: SignedVoucher;
  policyAuthorization?: PolicyAuthorization;
  receipt?: SignedReceipt;
  response?: StoredResponse;
  settledTx?: string;
  commitment?: ReceiptCommitment;
};
export interface ProviderStore {
  get(id: string): Promise<ProviderRecord | null>;
  accept(
    record: ProviderRecord,
    base: { nonce: string; amount: string },
    price: string,
  ): Promise<"created" | "duplicate" | "stale">;
  complete(
    id: string,
    receipt: SignedReceipt | undefined,
    response: StoredResponse,
  ): Promise<void>;
  pending(channel?: string, provider?: string): Promise<ProviderRecord[]>;
  markSettled(
    ids: string[],
    tx: string,
    commitments?: Record<string, ReceiptCommitment>,
  ): Promise<void>;
}
export class MemoryProviderStore implements ProviderStore {
  private records = new Map<string, ProviderRecord>();
  private heads = new Map<string, { nonce: bigint; amount: bigint }>();
  async get(id: string) {
    return structuredClone(this.records.get(id) || null);
  }
  async accept(
    record: ProviderRecord,
    base: { nonce: string; amount: string },
    price: string,
  ): Promise<"created" | "duplicate" | "stale"> {
    if (this.records.has(record.id)) return "duplicate";
    const stored = this.heads.get(record.channel);
    const head =
      stored && stored.amount > BigInt(base.amount)
        ? stored
        : { nonce: BigInt(base.nonce), amount: BigInt(base.amount) };
    if (
      BigInt(record.voucher.nonce) <= head.nonce ||
      BigInt(record.voucher.cumulativeAmount) !== head.amount + BigInt(price)
    )
      return "stale";
    this.heads.set(record.channel, {
      nonce: BigInt(record.voucher.nonce),
      amount: BigInt(record.voucher.cumulativeAmount),
    });
    this.records.set(record.id, structuredClone(record));
    return "created";
  }
  async complete(
    id: string,
    receipt: SignedReceipt | undefined,
    response: StoredResponse,
  ) {
    const record = this.records.get(id);
    if (!record) throw Error("Unknown provider record");
    record.receipt = structuredClone(receipt);
    record.response = structuredClone(response);
  }
  async pending(channel?: string, provider?: string) {
    return structuredClone(
      [...this.records.values()].filter(
        (r) =>
          !r.settledTx &&
          r.response &&
          (!channel || channel === r.channel) &&
          (!provider ||
            r.voucher.provider.toLowerCase() === provider.toLowerCase()),
      ),
    );
  }
  async markSettled(
    ids: string[],
    tx: string,
    commitments?: Record<string, ReceiptCommitment>,
  ) {
    for (const id of ids) {
      const record = this.records.get(id);
      if (record) {
        record.settledTx = tx;
        record.commitment = commitments?.[id];
      }
    }
  }
}
export class SupabaseProviderStore implements ProviderStore {
  constructor(
    private url: string,
    private key: string,
    private transport: typeof fetch = fetch,
  ) {
    const u = new URL(url);
    if (
      u.protocol !== "https:" &&
      !(
        u.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(u.hostname)
      )
    )
      throw Error("Supabase requires HTTPS");
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash)
      throw Error("Invalid Supabase URL");
  }
  private async request(path: string, method = "GET", body?: unknown) {
    let response: Response;
    try {
      response = await this.transport(
        this.url.replace(/\/$/, "") + "/rest/v1/" + path,
        {
          method,
          headers: {
            apikey: this.key,
            Authorization: "Bearer " + this.key,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      throw Error("Provider persistence unavailable");
    }
    if (!response.ok)
      throw Error(
        "Provider persistence failed; check configuration and migrations",
      );
    return response.status === 204 ? null : response.json();
  }
  async get(id: string) {
    const rows = await this.request(
      "api_provider_records?id=eq." +
        encodeURIComponent(id) +
        "&select=payload&limit=1",
    );
    return (rows[0]?.payload as ProviderRecord) || null;
  }
  async accept(
    record: ProviderRecord,
    base: { nonce: string; amount: string },
    price: string,
  ) {
    return (await this.request("rpc/api_provider_accept", "POST", {
      p_record: record,
      p_base_nonce: base.nonce,
      p_base_amount: base.amount,
      p_price: price,
    })) as "created" | "duplicate" | "stale";
  }
  async complete(
    id: string,
    receipt: SignedReceipt | undefined,
    response: StoredResponse,
  ) {
    await this.request("rpc/api_provider_complete", "POST", {
      p_id: id,
      p_receipt: receipt || null,
      p_response: response,
    });
  }
  async pending(channel?: string, provider?: string) {
    const rows = await this.request(
      "api_provider_records?select=payload&settled_tx=is.null&completed=eq.true&order=created_at.asc&limit=1000" +
        (channel ? "&channel=eq." + encodeURIComponent(channel) : "") +
        (provider
          ? "&payload->voucher->>provider=ilike." + encodeURIComponent(provider)
          : ""),
    );
    return rows.map(
      (r: { payload: ProviderRecord }) => r.payload,
    ) as ProviderRecord[];
  }
  async markSettled(
    ids: string[],
    tx: string,
    commitments: Record<string, ReceiptCommitment> = {},
  ) {
    await this.request("rpc/api_provider_settled", "POST", {
      p_ids: ids,
      p_tx: tx,
      p_commitments: commitments,
    });
  }
}
