import type { Config } from "./config";
import { fail } from "./errors";
export type ManagedService = {
  id: string;
  chain_id: number;
  owner: string;
  provider: string;
  slug: string;
  name: string;
  kind: "text-analysis" | "json-validation" | "http-proxy";
  upstream_ciphertext?: string | null;
  upstream_tested_at?: string | null;
  price: string;
  signer_ciphertext: string;
  state: "draft" | "active" | "paused";
  published: boolean;
  registration_tx?: string | null;
  last_settlement_tx?: string | null;
  last_worker_at?: string | null;
  worker_error?: string | null;
  created_at?: string;
};
export interface ManagedStore {
  list(chain: number, owner?: string): Promise<ManagedService[]>;
  get(id: string): Promise<ManagedService | null>;
  insert(service: ManagedService): Promise<void>;
  update(id: string, values: Partial<ManagedService>): Promise<void>;
  lock(id: string, holder: string): Promise<boolean>;
  unlock(id: string, holder: string): Promise<void>;
}
export class SupabaseManagedStore implements ManagedStore {
  constructor(
    private config: Pick<Config, "supabaseUrl" | "supabaseKey">,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(
    path: string,
    method = "GET",
    data?: unknown,
  ): Promise<unknown> {
    if (!this.config.supabaseUrl || !this.config.supabaseKey)
      fail(
        503,
        "MANAGED_STORAGE_UNAVAILABLE",
        "Configure Supabase and apply the managed-services migration",
      );
    let response: Response;
    try {
      response = await this.transport(
        this.config.supabaseUrl + "/rest/v1/" + path,
        {
          method,
          headers: {
            apikey: this.config.supabaseKey,
            Authorization: "Bearer " + this.config.supabaseKey,
            "Content-Type": "application/json",
            Prefer: "return=minimal",
          },
          body: data === undefined ? undefined : JSON.stringify(data),
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      fail(
        503,
        "MANAGED_STORAGE_UNAVAILABLE",
        "Hosted API storage is unavailable",
      );
    }
    if (!response.ok)
      fail(
        response.status === 409 ? 409 : 503,
        "MANAGED_STORAGE_UNAVAILABLE",
        response.status === 409
          ? "That API URL name is already in use"
          : "Apply migration 202610300004_managed_services.sql and retry",
      );
    const source = await response.text();
    return source ? JSON.parse(source) : null;
  }
  async list(chain: number, owner?: string) {
    return (await this.request(
      "api_managed_services?chain_id=eq." +
        chain +
        (owner ? "&owner=eq." + encodeURIComponent(owner.toLowerCase()) : "") +
        "&order=created_at.desc&limit=100",
    )) as ManagedService[];
  }
  async get(id: string) {
    const rows = (await this.request(
      "api_managed_services?id=eq." + encodeURIComponent(id) + "&limit=1",
    )) as ManagedService[];
    return rows[0] || null;
  }
  async insert(service: ManagedService) {
    await this.request("api_managed_services", "POST", service);
  }
  async update(id: string, values: Partial<ManagedService>) {
    await this.request(
      "api_managed_services?id=eq." + encodeURIComponent(id),
      "PATCH",
      values,
    );
  }
  async lock(id: string, holder: string) {
    return (
      (await this.request("rpc/api_managed_lock", "POST", {
        p_id: id,
        p_holder: holder,
      })) === true
    );
  }
  async unlock(id: string, holder: string) {
    await this.request("rpc/api_managed_unlock", "POST", {
      p_id: id,
      p_holder: holder,
    });
  }
}
