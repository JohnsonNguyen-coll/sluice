import type { IncomingMessage, ServerResponse } from "node:http";
import {
  PaymentProvider,
  type PaymentContext,
  type ProviderOptions,
} from "./provider";
declare global {
  namespace Express {
    interface Request {
      agentpay: PaymentContext;
      rawBody?: Uint8Array;
    }
  }
}
type RequestLike = IncomingMessage & {
  originalUrl?: string;
  rawBody?: Uint8Array;
  agentpay?: PaymentContext;
};
/** Use express.json({verify(req,_res,bytes){req.rawBody=bytes}}) before this middleware. Buffered responses only. */
export function agentpay(options: ProviderOptions) {
  const controller = new PaymentProvider(options);
  const middleware = (
    req: RequestLike,
    res: ServerResponse,
    next: (error?: unknown) => void,
  ) => {
    const method = req.method || "GET";
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !req.rawBody) {
      res.writeHead(400);
      res.end("Raw body capture is required for paid requests");
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined)
        headers.set(name, Array.isArray(value) ? value.join(",") : value);
    }
    const request = new Request(
      "http://provider.local" + (req.originalUrl || req.url || "/"),
      {
        method,
        headers,
        ...(!["GET", "HEAD"].includes(method)
          ? { body: Buffer.from(req.rawBody || []) }
          : {}),
      },
    );
    const originalWrite = res.write.bind(res),
      originalEnd = res.end.bind(res),
      originalWriteHead = res.writeHead.bind(res);
    const wrapped = controller.wrap(
      (_request, context) =>
        new Promise<Response>((resolve, reject) => {
          req.agentpay = context;
          const chunks: Buffer[] = [];
          let size = 0;
          res.writeHead = ((status: number, ..._args: unknown[]) => {
            res.statusCode = status;
            return res;
          }) as typeof res.writeHead;
          res.write = ((
            chunk: unknown,
            encodingOrCallback?: unknown,
            callback?: () => void,
          ) => {
            const bytes = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(
                  String(chunk),
                  typeof encodingOrCallback === "string"
                    ? (encodingOrCallback as BufferEncoding)
                    : "utf8",
                );
            size += bytes.length;
            if (size > 1024 * 1024) {
              reject(Error("Paid response exceeds 1 MiB"));
              return false;
            }
            chunks.push(bytes);
            if (typeof encodingOrCallback === "function") encodingOrCallback();
            callback?.();
            return true;
          }) as typeof res.write;
          res.end = ((chunk?: unknown, ..._args: unknown[]) => {
            if (chunk !== undefined) res.write(chunk);
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(res.getHeaders())) {
              if (value !== undefined)
                responseHeaders.set(
                  name,
                  Array.isArray(value) ? value.join(",") : String(value),
                );
            }
            resolve(
              new Response(
                res.statusCode === 204 || res.statusCode === 304
                  ? null
                  : Buffer.concat(chunks),
                { status: res.statusCode, headers: responseHeaders },
              ),
            );
            return res;
          }) as typeof res.end;
          try {
            next();
          } catch (error) {
            reject(error);
          }
        }),
    );
    void wrapped(request)
      .then(async (response) => {
        res.write = originalWrite;
        res.end = originalEnd;
        res.writeHead = originalWriteHead;
        res.statusCode = response.status;
        for (const name of res.getHeaderNames()) res.removeHeader(name);
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.end(Buffer.from(await response.arrayBuffer()));
      })
      .catch(() => {
        res.write = originalWrite;
        res.end = originalEnd;
        res.writeHead = originalWriteHead;
        res.statusCode = 503;
        res.end("Payment service unavailable");
      });
  };
  return Object.assign(middleware, { controller });
}
