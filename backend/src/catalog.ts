import { fail } from "./errors";
import type { Config } from "./config";
export type AgentProfile = {
  chain_id: number;
  wallet: string;
  owner: string;
  name: string;
  purpose: string;
  updated_at: string;
};
export type ApiListing = {
  chain_id: number;
  provider: string;
  slug: string;
  name: string;
  description: string;
  category: string;
  endpoint: string;
  method: "GET" | "POST";
  docs_url: string;
  price: string;
  published: boolean;
  updated_at: string;
};
export interface CatalogStore {
  agent(chain: number, wallet: string): Promise<AgentProfile | null>;
  saveAgent(value: AgentProfile): Promise<void>;
  list(
    chain: number,
    limit: number,
    offset: number,
    options?: { provider?: string; q?: string; category?: string },
  ): Promise<ApiListing[]>;
  listing(
    chain: number,
    provider: string,
    slug: string,
  ): Promise<ApiListing | null>;
  saveListing(value: ApiListing): Promise<void>;
}
export class SupabaseCatalogStore implements CatalogStore {
  constructor(
    private config: Pick<Config, "supabaseUrl" | "supabaseKey">,
    private transport: typeof fetch = fetch,
  ) {}
  private async request(path: string, value?: unknown): Promise<unknown> {
    if (!this.config.supabaseUrl || !this.config.supabaseKey)
      fail(
        503,
        "DATABASE_NOT_CONFIGURED",
        "Configure Supabase before saving profiles or publishing APIs",
      );
    let response: Response;
    try {
      response = await this.transport(
        this.config.supabaseUrl + "/rest/v1/" + path,
        {
          method: value === undefined ? "GET" : "POST",
          headers: {
            apikey: this.config.supabaseKey,
            Authorization: "Bearer " + this.config.supabaseKey,
            "Content-Type": "application/json",
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: value === undefined ? undefined : JSON.stringify(value),
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      fail(
        503,
        "CATALOG_UNAVAILABLE",
        "Catalog storage is unavailable. Retry shortly.",
      );
    }
    if (!response.ok)
      fail(
        503,
        "CATALOG_UNAVAILABLE",
        "Catalog storage is unavailable. Apply migration 202610290003_directory_agents.sql if setup is incomplete.",
      );
    const body = await response.text();
    return body ? JSON.parse(body) : null;
  }
  async agent(chain: number, wallet: string) {
    const rows = (await this.request(
      "api_agent_profiles?chain_id=eq." +
        chain +
        "&wallet=eq." +
        wallet.toLowerCase() +
        "&select=*&limit=1",
    )) as AgentProfile[];
    return rows[0] || null;
  }
  async saveAgent(value: AgentProfile) {
    await this.request("api_agent_profiles?on_conflict=chain_id,wallet", value);
  }
  async list(
    chain: number,
    limit: number,
    offset: number,
    options: { provider?: string; q?: string; category?: string } = {},
  ) {
    return (await this.request(
      "api_api_listings?chain_id=eq." +
        chain +
        "&select=*&order=updated_at.desc,provider.asc,slug.asc&limit=" +
        limit +
        "&offset=" +
        offset +
        (options.provider
          ? "&provider=eq." + options.provider.toLowerCase()
          : "&published=eq.true") +
        (options.q
          ? "&name=ilike.*" + encodeURIComponent(options.q) + "*"
          : "") +
        (options.category
          ? "&category=eq." + encodeURIComponent(options.category)
          : ""),
    )) as ApiListing[];
  }
  async listing(chain: number, provider: string, slug: string) {
    const rows = (await this.request(
      "api_api_listings?chain_id=eq." +
        chain +
        "&provider=eq." +
        provider.toLowerCase() +
        "&slug=eq." +
        encodeURIComponent(slug) +
        "&published=eq.true&select=*&limit=1",
    )) as ApiListing[];
    return rows[0] || null;
  }
  async saveListing(value: ApiListing) {
    await this.request(
      "api_api_listings?on_conflict=chain_id,provider,slug",
      value,
    );
  }
}
export function shortText(
  value: unknown,
  label: string,
  max: number,
  optional = false,
) {
  if (
    typeof value !== "string" ||
    value.trim().length > max ||
    (!optional && !value.trim())
  )
    fail(
      400,
      "INVALID_INPUT",
      label + " is required and must be at most " + max + " characters",
    );
  return value.trim();
}
export function httpsUrl(value: unknown, label: string, optional = false) {
  const text = shortText(value, label, 2048, optional);
  if (!text && optional) return "";
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    fail(400, "INVALID_URL", label + " must be a valid HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  )
    fail(
      400,
      "INVALID_URL",
      label + " must use HTTPS without credentials or a fragment",
    );
  return parsed.toString();
}
