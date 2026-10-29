import express from "express";
import { createServer } from "node:http";
import { agentpay } from "../src/express";
import type { ProviderOptions } from "../src/provider";
export async function expressHarness(options: ProviderOptions) {
  const app = express(),
    middleware = agentpay(options);
  let calls = 0;
  app.use(
    express.json({
      verify(req, _res, bytes) {
        (req as typeof req & { rawBody: Uint8Array }).rawBody = bytes;
      },
    }),
  );
  app.post("/express-answer", middleware, (req, res) => {
    calls++;
    res.json({ answer: 42, paid: String(req.agentpay.paid), call: calls });
  });
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Express listener unavailable");
  return {
    url: "http://127.0.0.1:" + address.port + "/express-answer",
    controller: middleware.controller,
    calls: () => calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
