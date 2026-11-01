import { afterAll, beforeAll, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";

let db: PGlite;
const address = (byte: string) => "0x" + byte.repeat(40);
const hash = (byte: string) => "0x" + byte.repeat(64);
const args = [
  hash("a"), hash("b"), 5042002, address("c"), address("d"), address("e"),
  "10000", 20758, 1793530000, null, "10000", "20000", "5000",
];
const query = `select * from public.reserve_policy_authorization(
  $1::text,$2::text,$3::integer,$4::text,$5::text,$6::text,$7::text,
  $8::bigint,$9::bigint,$10::text,$11::text,$12::text,$13::text)`;

beforeAll(async () => {
  db = new PGlite();
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const migration of ["202610310007_policy_reservations", "202610310008_policy_chain_spend", "202610310009_policy_ticket_reconciliation"]) {
    const file = `../supabase/migrations/${migration}.sql`;
    await db.exec(await Bun.file(new URL(file, import.meta.url)).text());
  }
  await db.exec(await Bun.file(new URL("../supabase/migrations/202611010010_policy_reservation_ambiguity.sql", import.meta.url)).text());
  await db.exec("set role service_role");
}, 30000);
afterAll(async () => { await db?.close(); });

test("policy reservation RPC enforces available daily allowance and exact replay", async () => {
  const first = await db.query(query, args);
  expect(first.rows).toHaveLength(1);
  const repeated = await db.query(query, args);
  expect(repeated.rows).toHaveLength(1);
  await db.exec("reset role");
  const total = await db.query<{ reserved_usd_e6: string }>("select reserved_usd_e6 from public.policy_daily_reservations");
  await db.exec("set role service_role");
  expect(String(total.rows[0].reserved_usd_e6)).toBe("10000");
  await expect(db.query(query, [hash("f"), ...args.slice(1)])).rejects.toThrow("DAILY_POLICY_EXCEEDED");
});
