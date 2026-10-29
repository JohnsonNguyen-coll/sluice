import { beforeAll, afterAll, test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { createHash } from "node:crypto";
import type { Address } from "viem";
import { createApi } from "../src/api";
import { loadConfig } from "../src/config";
import { RpcGateway } from "../src/chain";
import { SupabaseStore } from "../src/store";
import {
  SupabaseCatalogStore,
  type CatalogStore,
  type AgentProfile,
  type ApiListing,
} from "../src/catalog";
const owner = ("0x" + "11".repeat(20)) as Address,
  other = ("0x" + "22".repeat(20)) as Address,
  wallet = ("0x" + "33".repeat(20)) as Address;
const token = "a".repeat(64),
  otherToken = "b".repeat(64),
  hash = (s: string) => createHash("sha256").update(s).digest("hex");
let db: PGlite,
  currentOwner = owner,
  active = true,
  api: ReturnType<typeof createApi>;
const config = loadConfig({ AUTH_ORIGIN: "http://127.0.0.1:3010" });
class AuthStore extends SupabaseStore {
  async session(key: string) {
    return key === hash(token)
      ? owner
      : key === hash(otherToken)
        ? other
        : null;
  }
  async receipts() {
    return [];
  }
}
class Chain extends RpcGateway {
  async wallet() {
    return {
      address: wallet,
      version: 3 as const,
      owner: currentOwner,
      agentSigner: other,
      paused: false,
      factory: owner,
      blockNumber: 1n,
    };
  }
  async provider(at: Address) {
    return {
      address: at,
      entry: {
        active,
        disputeWindow: 3600,
        metadataHash: "0x" + "00".repeat(32),
      },
    };
  }
}
const catalog: CatalogStore = {
  async agent(chain, wallet) {
    return (
      (
        await db.query<AgentProfile>(
          "select * from api_agent_profiles where chain_id=$1 and wallet=$2",
          [chain, wallet.toLowerCase()],
        )
      ).rows[0] || null
    );
  },
  async saveAgent(p) {
    await db.query(
      "insert into api_agent_profiles values($1,$2,$3,$4,$5,$6) on conflict(chain_id,wallet) do update set owner=excluded.owner,name=excluded.name,purpose=excluded.purpose,updated_at=excluded.updated_at",
      [p.chain_id, p.wallet, p.owner, p.name, p.purpose, p.updated_at],
    );
  },
  async list(chain, limit, offset, opt = {}) {
    return (
      await db.query<ApiListing>(
        "select * from api_api_listings where chain_id=$1 and ($2::text is null and published or provider=$2) and ($3::text is null or name ilike $3) and ($4::text is null or category=$4) order by updated_at desc,provider,slug limit $5 offset $6",
        [
          chain,
          opt.provider?.toLowerCase() || null,
          opt.q ? "%" + opt.q + "%" : null,
          opt.category || null,
          limit,
          offset,
        ],
      )
    ).rows;
  },
  async listing(chain, provider, slug) {
    return (
      (
        await db.query<ApiListing>(
          "select * from api_api_listings where chain_id=$1 and provider=$2 and slug=$3 and published",
          [chain, provider.toLowerCase(), slug],
        )
      ).rows[0] || null
    );
  },
  async saveListing(p) {
    await db.query(
      "insert into api_api_listings values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(chain_id,provider,slug) do update set name=excluded.name,description=excluded.description,endpoint=excluded.endpoint,published=excluded.published,price=excluded.price",
      [
        p.chain_id,
        p.provider,
        p.slug,
        p.name,
        p.description,
        p.category,
        p.endpoint,
        p.method,
        p.docs_url,
        p.price,
        p.published,
        p.updated_at,
      ],
    );
  },
};
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  bearer?: string,
) =>
  api(
    new Request("http://localhost:3001" + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(bearer ? { Authorization: "Bearer " + bearer } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }),
    crypto.randomUUID(),
  );
const listing = {
  slug: "real-api",
  name: "Research API",
  description: "Test-only provider listing in an isolated test database.",
  category: "Search",
  endpoint: "https://provider.example/search",
  method: "GET",
  docsUrl: "https://provider.example/docs",
  priceUsdc: "0.012345",
  published: true,
};
beforeAll(async () => {
  db = new PGlite();
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;",
  );
  await db.exec(
    await Bun.file(
      new URL(
        "../supabase/migrations/202610290003_directory_agents.sql",
        import.meta.url,
      ),
    ).text(),
  );
  await db.exec("set role service_role");
  api = createApi(
    config,
    new AuthStore({}),
    new Chain(config),
    Date.now,
    catalog,
  );
}, 30000);
afterAll(async () => {
  await db.close();
});
test("directory binds the publisher to the signed-in actor, uses exact USDC units and exposes declared pricing", async () => {
  expect((await request("/directory", "POST", listing)).status).toBe(401);
  const created = await request(
    "/directory",
    "POST",
    { ...listing, provider: other },
    token,
  );
  expect(created.status).toBe(201);
  const value = (await created.json()).listing;
  expect(value.provider).toBe(owner);
  expect(value.price).toBe("12345");
  expect(value.providerStatus).toBe("active");
  expect(value.priceSource).toContain("provider-declared");
  const res = await request("/directory?q=Research&category=Search");
  expect((await res.json()).items).toHaveLength(1);
  expect((await request("/directory/" + owner + "/real-api")).status).toBe(200);
});
test("drafts stay private, updates are actor-scoped and on-chain inactivity blocks publication", async () => {
  expect(
    (
      await request(
        "/directory",
        "POST",
        { ...listing, slug: "draft", published: false },
        otherToken,
      )
    ).status,
  ).toBe(201);
  expect((await request("/directory/" + other + "/draft")).status).toBe(404);
  const mine = (
    await (
      await request("/directory/mine", "GET", undefined, otherToken)
    ).json()
  ).items;
  expect(mine).toHaveLength(1);
  expect(mine[0].provider).toBe(other);
  active = false;
  expect(
    (
      await request(
        "/directory",
        "POST",
        { ...listing, slug: "blocked" },
        token,
      )
    ).status,
  ).toBe(403);
  const publicRows = (await (await request("/directory")).json()).items;
  expect(publicRows[0].providerStatus).toBe("inactive");
  active = true;
});
test("invalid prices, credential URLs, unsafe schemes and query-filter syntax are rejected", async () => {
  for (const priceUsdc of ["0", "-1", "1e2", "0.0000001", "9".repeat(60)])
    expect(
      (await request("/directory", "POST", { ...listing, priceUsdc }, token))
        .status,
    ).toBe(400);
  for (const endpoint of [
    "javascript:alert(1)",
    "http://provider.example",
    "https://user:secret@provider.example",
  ])
    expect(
      (await request("/directory", "POST", { ...listing, endpoint }, token))
        .status,
    ).toBe(400);
  expect(
    (
      await request(
        "/directory?q=" + encodeURIComponent("a),published.eq.false"),
      )
    ).status,
  ).toBe(400);
  expect((await request("/directory?category=unknown")).status).toBe(400);
});
test("agent labels persist privately and current ownership is rechecked after transfer", async () => {
  const path = "/wallets/" + wallet + "/profile";
  expect((await request(path)).status).toBe(401);
  expect((await request(path, "GET", undefined, otherToken)).status).toBe(403);
  expect(
    (
      await request(
        path,
        "POST",
        { name: "Research assistant", purpose: "Reads API data" },
        token,
      )
    ).status,
  ).toBe(200);
  const saved = await (await request(path, "GET", undefined, token)).json();
  expect(saved.profile.name).toBe("Research assistant");
  expect(saved.lastPayment).toBeNull();
  expect(saved.agentRuntimeStatus).toBe("unknown");
  currentOwner = other;
  expect((await request(path, "GET", undefined, token)).status).toBe(403);
  expect(
    (await (await request(path, "GET", undefined, otherToken)).json()).profile,
  ).toBeNull();
  expect(
    (
      await request(
        path,
        "POST",
        { name: "New owner agent", purpose: "" },
        otherToken,
      )
    ).status,
  ).toBe(200);
  expect(
    (await (await request(path, "GET", undefined, otherToken)).json()).profile
      .name,
  ).toBe("New owner agent");
  currentOwner = owner;
});
test("new storage rejects browser roles and enforces database constraints", async () => {
  for (const role of ["anon", "authenticated"]) {
    await db.exec("set role " + role);
    await expect(db.query("select * from api_agent_profiles")).rejects.toThrow(
      "permission denied",
    );
    await expect(db.query("select * from api_api_listings")).rejects.toThrow(
      "permission denied",
    );
  }
  await db.exec("set role service_role");
  await expect(
    catalog.saveAgent({
      chain_id: config.chainId,
      wallet,
      owner,
      name: "",
      purpose: "",
      updated_at: new Date().toISOString(),
    }),
  ).rejects.toThrow();
});
test("Supabase catalog transport fails closed and never follows provider endpoints", async () => {
  let seen = "";
  const transport = (async (url: RequestInfo | URL) => {
    seen = String(url);
    return new Response("[]");
  }) as typeof fetch;
  await new SupabaseCatalogStore(
    {
      supabaseUrl: "https://project.supabase.co",
      supabaseKey: "private-test-key",
    },
    transport,
  ).list(config.chainId, 12, 0, { q: "Research" });
  expect(seen).toStartWith(
    "https://project.supabase.co/rest/v1/api_api_listings?",
  );
  expect(seen).toContain("published=eq.true");
  await expect(
    new SupabaseCatalogStore({}).list(config.chainId, 12, 0),
  ).rejects.toThrow("Configure Supabase");
});
