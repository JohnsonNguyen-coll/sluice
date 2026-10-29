import { test, expect } from "bun:test";
import { assistantConfig, analyzeDispute } from "../src/dispute-assistant";
const env = {
  DISPUTE_AI_API_KEY: "test-only-key",
  DISPUTE_AI_MODEL: "test-only-model",
  DISPUTE_AI_BASE_URL: "https://models.example/v1",
};
test("missing model configuration never invents an AI recommendation", async () => {
  expect(assistantConfig({}).available).toBe(false);
  await expect(
    analyzeDispute({ settlement: {}, evidence: [] }, {}),
  ).rejects.toThrow("not configured");
});
test("advisory model receives only selected evidence and returns a bounded non-binding result", async () => {
  let seen: any;
  const transport = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen = JSON.parse(String(init?.body));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: "Insufficient evidence",
              refundBasisPoints: null,
              reasons: ["Evidence ID a is incomplete"],
              missingEvidence: ["Provider response"],
            }),
          },
        },
      ],
    });
  }) as unknown as typeof fetch;
  const report = await analyzeDispute(
    {
      settlement: { amount: "10" },
      evidence: [{ id: "a", content: "Untrusted claim text" }],
    },
    env,
    transport,
  );
  expect(report.binding).toBe(false);
  expect(report.refundBasisPoints).toBeNull();
  expect(report.inputHash).toMatch(/^0x[0-9a-f]{64}$/);
  expect(seen.stream).toBe(false);
  expect(seen.messages[0].content).toContain("UNTRUSTED DATA");
  expect(JSON.stringify(seen)).not.toContain("test-only-key");
});
test("malformed and out-of-range model output cannot become a proposal", async () => {
  for (const content of [
    "not JSON",
    JSON.stringify({
      summary: "pay",
      refundBasisPoints: 10001,
      reasons: [],
      missingEvidence: [],
    }),
  ]) {
    const transport = (async () =>
      Response.json({
        choices: [{ message: { content } }],
      })) as unknown as typeof fetch;
    await expect(
      analyzeDispute({ settlement: {}, evidence: [] }, env, transport),
    ).rejects.toThrow();
  }
});
test("model credentials are not included in upstream error responses", async () => {
  await expect(
    analyzeDispute(
      { settlement: {}, evidence: [] },
      env,
      (async () =>
        new Response("private upstream details", {
          status: 401,
        })) as unknown as typeof fetch,
    ),
  ).rejects.toThrow("check server-side API credentials");
});
