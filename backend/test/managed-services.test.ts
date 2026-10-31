import { test, expect } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID, createHash } from "node:crypto";
import type { Address, PublicClient } from "viem";
import { MemoryProviderStore } from "@sluice/middleware";
import { ManagedHost } from "../src/managed-host";
import {
  type ManagedStore,
  type ManagedService,
  SupabaseManagedStore,
} from "../src/managed-store";
import {
  encryptSigner,
  decryptSigner,
  runManagedTool,
} from "../src/managed-tools";
import { loadConfig } from "../src/config";
import { RpcGateway } from "../src/chain";
import { SupabaseStore } from "../src/store";
import { SupabaseCatalogStore } from "../src/catalog";
import { createApi } from "../src/api";
import { fail } from "../src/errors";
const owner = ("0x" + "11".repeat(20)) as Address,
  other = ("0x" + "22".repeat(20)) as Address;
class MemoryManaged implements ManagedStore {
  rows = new Map<string, ManagedService>();
  leases = new Map<string, string>();
  async list(chain: number, owner?: string) {
    return [...this.rows.values()]
      .filter(
        (s) =>
          s.chain_id === chain && (!owner || s.owner === owner.toLowerCase()),
      )
      .map((s) => structuredClone(s));
  }
  async get(id: string) {
    return structuredClone(this.rows.get(id) || null);
  }
  async insert(s: ManagedService) {
    this.rows.set(s.id, structuredClone(s));
  }
  async update(id: string, value: Partial<ManagedService>) {
    Object.assign(this.rows.get(id)!, value);
  }
  async lock(id: string, holder: string) {
    const existing = this.leases.get(id);
    if (existing && existing !== holder) return false;
    this.leases.set(id, holder);
    return true;
  }
  async unlock(id: string, holder: string) {
    if (this.leases.get(id) === holder) this.leases.delete(id);
  }
}
function setup() {
  const config = loadConfig({
      SUPABASE_URL: "https://storage.example",
      SUPABASE_SERVICE_ROLE_KEY: "test-only",
    }),
    store = new MemoryManaged(),
    catalog = new (class extends SupabaseCatalogStore {
      async saveListing() {}
    })(config),
    chain = new (class extends RpcGateway {
      async provider(at: Address) {
        return {
          address: at,
          entry: { active: true, payoutAddress: owner, disputeWindow: 3600 },
        };
      }
      async authorizeEvidence() {
        fail(403, "FORBIDDEN", "Not a direct dispute party");
      }
      async settlement(id: `0x${string}`) {
        return {
          id,
          vault: config.disputeVault!,
          negotiated: true,
          settlement: {
            wallet: other,
            arbiter: other,
            provider: [...store.rows.values()][0]?.provider as Address,
          },
          dispute: { openedAt: 1n, resolved: false },
          negotiation: undefined,
        };
      }
    })(config);
  const client = {
    getBalance: async () => 10n ** 18n,
  } as unknown as PublicClient;
  const host = new ManagedHost(
    config,
    store,
    catalog,
    chain,
    { MANAGED_PROVIDER_ENCRYPTION_KEY: "aa".repeat(32) },
    new MemoryProviderStore(),
    client,
  );
  return { host, store, config, chain, catalog };
}
const input = {
  name: "Useful text analysis",
  slug: "text-analysis",
  kind: "text-analysis",
  priceUsdc: "0.01",
  published: false,
  acceptHostedCustody: true,
};
test("provider encryption is randomized, authenticated and bound to chain/service/owner", () => {
  const key = Buffer.alloc(32, 7),
    secret = ("0x" + "33".repeat(32)) as `0x${string}`,
    first = encryptSigner(secret, "chain:service:owner", key),
    second = encryptSigner(secret, "chain:service:owner", key);
  expect(first).not.toBe(second);
  expect(first).not.toContain(secret);
  expect(decryptSigner(first, "chain:service:owner", key)).toBe(secret);
  expect(() => decryptSigner(first, "other-owner", key)).toThrow();
  expect(() =>
    decryptSigner(first, "chain:service:owner", Buffer.alloc(32, 8)),
  ).toThrow();
  expect(() =>
    decryptSigner(first.slice(0, -8), "chain:service:owner", key),
  ).toThrow();
});
test("hosted tools compute real text metrics and validate JSON without executing its content", () => {
  expect(
    runManagedTool("text-analysis", { text: "Hello world.\nNext sentence!" }),
  ).toMatchObject({ words: 4, sentences: 2, lines: 2 });
  expect(runManagedTool("text-analysis", { text: "😀" })).toMatchObject({
    characters: 1,
    utf8Bytes: 4,
  });
  expect(
    runManagedTool("json-validation", { text: '{"__proto__":{"admin":true}}' }),
  ).toMatchObject({ valid: true, type: "object", properties: 1 });
  expect(runManagedTool("json-validation", { text: "[1,2]" })).toMatchObject({
    valid: true,
    type: "array",
    items: 2,
  });
  expect(runManagedTool("json-validation", { text: "{invalid" })).toEqual({
    valid: false,
    error: "Invalid JSON syntax",
  });
  expect(() =>
    runManagedTool("text-analysis", { text: "x".repeat(24001) }),
  ).toThrow();
});
test("creation requires custody consent, enforces pricing and does not expose provider keys", async () => {
  const { host, store } = setup();
  await expect(
    host.create(owner, { ...input, acceptHostedCustody: false }),
  ).rejects.toThrow();
  await expect(
    host.create(owner, { ...input, priceUsdc: "0" }),
  ).rejects.toThrow();
  await expect(
    host.create(owner, { ...input, priceUsdc: "1.000001" }),
  ).rejects.toThrow();
  await expect(
    host.create(owner, { ...input, published: true }),
  ).rejects.toThrow("HTTPS");
  const result = (await host.create(owner, input)) as {
    service: { id: string; provider: string };
  };
  expect(result.service.provider).not.toBe(owner.toLowerCase());
  expect(JSON.stringify(result)).not.toContain("ciphertext");
  const row = (await store.get(result.service.id))!;
  expect(row.signer_ciphertext.startsWith("v1.")).toBe(true);
  expect(row.owner).toBe(owner.toLowerCase());
  expect(await host.ownsProvider(other, row.provider as Address)).toBe(false);
  expect(await host.ownsProvider(owner, row.provider as Address)).toBe(true);
});
test("ownership checks run before activation, pausing and receipt reads", async () => {
  const { host, store } = setup();
  const result = (await host.create(owner, input)) as {
    service: { id: string };
  };
  await expect(host.activate(other, result.service.id)).rejects.toThrow(
    "owner",
  );
  await expect(host.pause(other, result.service.id)).rejects.toThrow("owner");
  await expect(host.receiptList(other, result.service.id)).rejects.toThrow(
    "owner",
  );
  expect((await store.get(result.service.id))!.state).toBe("draft");
});
test("paid routes reject paused services and invalid input; valid unpaid calls receive 402", async () => {
  const { host, store } = setup();
  const { service } = (await host.create(owner, input)) as {
    service: { id: string };
  };
  const request = (text: unknown) =>
    new Request("http://127.0.0.1:3001/hosted/" + service.id, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  await expect(host.serve(service.id, request("Hello"))).rejects.toThrow(
    "paused",
  );
  await store.update(service.id, {
    state: "active",
    last_worker_at: new Date().toISOString(),
  });
  const response = await host.serve(service.id, request("Hello"));
  expect(response.status).toBe(402);
  expect((await response.json()).price).toBe("10000");
  await expect(host.serve(service.id, request(42))).rejects.toThrow("text");
  await store.update(service.id, { last_worker_at: new Date(0).toISOString() });
  await expect(host.serve(service.id, request("Hello"))).rejects.toThrow(
    "worker",
  );
});
test("managed API routes require SIWE sessions and only delegate evidence access to the matching hosted owner", async () => {
  const { host, store, chain, config, catalog } = setup();
  const { service } = (await host.create(owner, input)) as {
    service: { id: string };
  };
  const ownerToken = "a".repeat(64),
    otherToken = "b".repeat(64),
    digest = (v: string) => createHash("sha256").update(v).digest("hex");
  const auth = new (class extends SupabaseStore {
    async session(hash: string) {
      return hash === digest(ownerToken)
        ? owner
        : hash === digest(otherToken)
          ? other
          : null;
    }
    async evidence() {
      return [];
    }
    async receipts() {
      return [];
    }
  })(config);
  const api = createApi(config, auth, chain, Date.now, catalog, host);
  const request = (
    path: string,
    token?: string,
    method = "GET",
    value?: unknown,
  ) =>
    api(
      new Request("http://localhost" + path, {
        method,
        headers: {
          ...(token ? { Authorization: "Bearer " + token } : {}),
          ...(value ? { "Content-Type": "application/json" } : {}),
        },
        body: value ? JSON.stringify(value) : undefined,
      }),
    );
  expect((await request("/managed-services")).status).toBe(401);
  expect(
    (
      await request(
        "/managed-services/" + service.id + "/activate",
        otherToken,
        "POST",
      )
    ).status,
  ).toBe(403);
  expect(
    (await (await request("/managed-services", otherToken)).json()).items,
  ).toEqual([]);
  const id = "0x" + "ab".repeat(32);
  expect(
    (await request("/disputes/" + id + "/evidence", ownerToken)).status,
  ).toBe(200);
  expect(
    (await request("/disputes/" + id + "/evidence", otherToken)).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/receipts?provider=" + [...store.rows.values()][0].provider,
        otherToken,
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await request(
        "/disputes/" + id + "/managed-provider",
        ownerToken,
        "POST",
        { action: "arbiterDecide" },
      )
    ).status,
  ).toBe(400);
});
test("Supabase managed transport never follows redirects or exposes upstream credentials", async () => {
  let redirect: unknown;
  const store = new SupabaseManagedStore(
    { supabaseUrl: "https://storage.example", supabaseKey: "secret-test-key" },
    (async (_url: unknown, options?: RequestInit) => {
      redirect = options?.redirect;
      return new Response("secret upstream diagnostics", { status: 500 });
    }) as typeof fetch,
  );
  await expect(store.list(5042002)).rejects.toThrow("migration");
  expect(redirect).toBe("error");
});
test("database leases are exclusive and browser roles cannot read encrypted signers or sign through RPCs", async () => {
  const db = new PGlite();
  try {
    await db.exec(
      "create role anon; create role authenticated; create role service_role bypassrls;",
    );
    await db.exec(
      await Bun.file(
        new URL(
          "../supabase/migrations/202610300004_managed_services.sql",
          import.meta.url,
        ),
      ).text(),
    );
    await db.exec(await Bun.file(new URL("../supabase/migrations/202610300006_api_gateway.sql", import.meta.url)).text());
    const id = randomUUID(),
      a = randomUUID(),
      b = randomUUID();
    await db.query(
      "insert into api_managed_services(id,chain_id,owner,provider,slug,name,kind,price,signer_ciphertext) values($1,5042002,$2,$3,$4,$5,$6,$7,$8)",
      [id, owner, other, "tool", "Tool", "text-analysis", "10000", "encrypted"],
    );
    await db.exec("set role service_role");
    expect(
      (
        await db.query<{ ok: boolean }>("select api_managed_lock($1,$2) ok", [
          id,
          a,
        ])
      ).rows[0].ok,
    ).toBe(true);
    expect(
      (
        await db.query<{ ok: boolean }>("select api_managed_lock($1,$2) ok", [
          id,
          b,
        ])
      ).rows[0].ok,
    ).toBe(false);
    await db.query("select api_managed_unlock($1,$2)", [id, b]);
    expect(
      (
        await db.query<{ ok: boolean }>("select api_managed_lock($1,$2) ok", [
          id,
          b,
        ])
      ).rows[0].ok,
    ).toBe(false);
    await db.query("select api_managed_unlock($1,$2)", [id, a]);
    expect(
      (
        await db.query<{ ok: boolean }>("select api_managed_lock($1,$2) ok", [
          id,
          b,
        ])
      ).rows[0].ok,
    ).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      await db.exec("reset role; set role " + role);
      await expect(
        db.query("select signer_ciphertext, upstream_ciphertext from api_managed_services"),
      ).rejects.toThrow("permission denied");
      await expect(
        db.query("select api_managed_lock($1,$2)", [id, a]),
      ).rejects.toThrow("permission denied");
    }
  } finally {
    await db.close();
  }
}, 30000);


test("gateway onboarding encrypts keys, gates activation and scopes credential rotation to owner", async () => {
  const {host,store}=setup();
  const data={...input,kind:"http-proxy",upstreamUrl:"https://api.example.com/v1/run",upstreamMethod:"POST",upstreamAuth:"bearer",upstreamKey:"gateway-test-secret",acceptUpstreamRights:true,acceptAttemptBilling:true};
  await expect(host.create(owner,{...data,acceptAttemptBilling:false})).rejects.toThrow();
  const {service}=await host.create(owner,data) as {service:{id:string;connection:{hasKey:boolean}}};
  expect(service.connection.hasKey).toBe(true);
  expect(JSON.stringify(service)).not.toContain("gateway-test-secret");
  const record=(await store.get(service.id))!;
  expect(record.upstream_ciphertext).toStartWith("v1.");
  expect(record.upstream_ciphertext).not.toContain("gateway-test-secret");
  await expect(host.activate(owner,service.id)).rejects.toThrow("connection check");
  await expect(host.testConnection(other,service.id,{confirm:true,payload:{}})).rejects.toThrow("owner");
  await expect(host.testConnection(owner,service.id,{confirm:false,payload:{}})).rejects.toThrow("Confirm");
  await expect(host.updateConnection(other,service.id,{upstreamKey:"new-key"})).rejects.toThrow("owner");
  await store.update(service.id,{upstream_tested_at:new Date().toISOString()});
  await host.updateConnection(owner,service.id,{upstreamKey:"new-test-key"});
  expect((await store.get(service.id))!.upstream_tested_at).toBeNull();
  expect(store.leases.size).toBe(0);
  await store.update(service.id,{state:"active",last_worker_at:new Date().toISOString()});
  await expect(host.updateConnection(owner,service.id,{upstreamKey:"another-key"})).rejects.toThrow("Pause");
  const url="http://localhost/hosted/"+service.id;
  const docs=await (await host.serve(service.id,new Request(url))).text();
  expect(docs).not.toContain("new-test-key");expect(docs).not.toContain("api.example.com");
  const unpaid=await host.serve(service.id,new Request(url,{method:"POST",headers:{"Content-Type":"application/json"},body:'{"prompt":"hello"}'}));
  expect(unpaid.status).toBe(402);
});
