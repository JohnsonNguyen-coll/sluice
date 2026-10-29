import { test, expect, afterAll } from "bun:test";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { FileAgentStore } from "../src/file-store";
const path = resolve(
  import.meta.dir,
  "../../../../.tools",
  crypto.randomUUID() + ".agentpay-state.json",
);
afterAll(async () => {
  try {
    await unlink(path);
  } catch {}
});
test("durable stores serialize competing reservations and survive a new store instance", async () => {
  const first = new FileAgentStore(path),
    second = new FileAgentStore(path),
    next = { nonce: "1", cumulativeAmount: "100" };
  const result = await Promise.all([
    first.reserve("channel", null, next),
    second.reserve("channel", null, next),
  ]);
  expect(result.filter(Boolean)).toHaveLength(1);
  expect(await new FileAgentStore(path).channel("channel")).toEqual(next);
});
