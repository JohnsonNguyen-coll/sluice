import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { fail } from "./errors";

export type Upstream = {
  url: string;
  method: "GET" | "POST";
  auth: "none" | "bearer" | "header";
  header: string;
  secret: string;
};
export function upstreamConfig(input: Record<string, unknown>): Upstream {
  let url: URL;
  try { url = new URL(String(input.upstreamUrl)); }
  catch { fail(400, "INVALID_UPSTREAM", "Enter a public HTTPS endpoint"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") ||
      url.username || url.password || url.search || url.hash ||
      isIP(url.hostname.replace(/^\[|\]$/g, "")) ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) ||
      !url.hostname.includes(".") || url.hostname.length > 253 || url.href.length > 2048)
    fail(400, "INVALID_UPSTREAM", "Use an HTTPS domain on port 443, without credentials, query parameters or fragments");
  if (!["GET", "POST"].includes(String(input.upstreamMethod)))
    fail(400, "INVALID_UPSTREAM", "Choose GET or POST");
  if (!["none", "bearer", "header"].includes(String(input.upstreamAuth)))
    fail(400, "INVALID_UPSTREAM", "Choose an authentication method");
  const auth = input.upstreamAuth as Upstream["auth"];
  const header = auth === "bearer" ? "authorization" : auth === "header" ? String(input.upstreamHeader || "").toLowerCase() : "";
  if (auth === "header" && (!/^(x-[a-z0-9-]{1,60}|api-key)$/.test(header) || header.startsWith("x-forwarded-") || header.startsWith("x-agentpay-") || header === "x-http-method-override"))
    fail(400, "INVALID_UPSTREAM", "Use a dedicated API key header such as x-api-key or api-key");
  const secret = auth === "none" ? "" : String(input.upstreamKey || "");
  if (auth !== "none" && (!secret || secret.length > 4096 || /[^\x21-\x7e]/.test(secret)))
    fail(400, "INVALID_UPSTREAM", "Enter a valid API key without spaces or control characters");
  return { url: url.href, method: input.upstreamMethod as Upstream["method"], auth, header, secret };
}
export function sealUpstream(value: Upstream, context: string, key: Buffer) {
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from("upstream:" + context));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}
export function openUpstream(value: string, context: string, key: Buffer): Upstream {
  try {
    const [version, iv, tag, data, ...extra] = value.split(".");
    if (version !== "v1" || extra.length) throw Error();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from("upstream:" + context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8")) as Upstream;
    return upstreamConfig({ upstreamUrl: parsed.url, upstreamMethod: parsed.method, upstreamAuth: parsed.auth, upstreamHeader: parsed.header, upstreamKey: parsed.secret });
  } catch { fail(503, "UPSTREAM_UNAVAILABLE", "The upstream configuration could not be unlocked"); }
}

// Deliberately IPv4-only egress. Resolve afresh and pin a public address for
// each request; TLS still validates the original hostname. Never follow redirects.
export function publicIPv4(ip: string) {
  if (isIP(ip) !== 4) return false;
  const [a,b,c] = ip.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113));
}
type Resolver = (hostname: string) => Promise<string[]>;
export type UpstreamReply = { status: number; contentType: string; bytes: Buffer };
export type GatewayTransport = (url: URL, ip: string, method: string, headers: Record<string,string>, payload?: string) => Promise<UpstreamReply>;
const resolve: Resolver = async hostname => (await lookup(hostname, { family: 4, all: true })).map(r => r.address);
const transport: GatewayTransport = (url, ip, method, headers, payload) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, {
    method, headers, agent: false, family: 4,
    lookup: (_hostname, options, callback) => {
      if (typeof options === "object" && options.all) callback(null, [{ address: ip, family: 4 }]);
      else callback(null, ip, 4);
    },
  }, res => {
    const chunks: Buffer[] = []; let size = 0;
    res.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1024 * 1024) { res.destroy(); req.destroy(Error("Response limit")); return; }
      chunks.push(chunk);
    });
    res.on("error", reject);
    res.on("end", () => resolve({ status: res.statusCode || 502, contentType: String(res.headers["content-type"] || ""), bytes: Buffer.concat(chunks) }));
  });
  const timer = setTimeout(() => req.destroy(Error("Upstream timeout")), 15000);
  req.on("close", () => clearTimeout(timer));
  req.on("error", reject);
  req.end(payload);
});
export function gatewayInput(config: Upstream, input: Record<string,unknown>) {
  const url = new URL(config.url);
  if (Buffer.byteLength(JSON.stringify(input)) > 24000) fail(413, "INPUT_TOO_LARGE", "Request exceeds 24 KiB");
  if (config.method === "GET") {
    if (Object.keys(input).some(k => k !== "query") || (input.query !== undefined && (!input.query || typeof input.query !== "object" || Array.isArray(input.query))))
      fail(400, "INVALID_QUERY", "GET APIs accept a JSON object with a query object");
    for (const [key, value] of Object.entries((input.query || {}) as Record<string,unknown>)) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || !["string", "number", "boolean"].includes(typeof value))
        fail(400, "INVALID_QUERY", "Query values must be strings, numbers or booleans");
      url.searchParams.set(key, String(value));
    }
    if (url.href.length > 8000) fail(400, "INVALID_QUERY", "Query is too long");
  }
  return { url, payload: config.method === "POST" ? JSON.stringify(input) : undefined };
}
export async function callUpstream(config: Upstream, input: Record<string,unknown>, idempotencyKey: string,
  resolver: Resolver = resolve, send: GatewayTransport = transport): Promise<Response> {
  const { url, payload } = gatewayInput(config, input);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const addresses = await Promise.race([
      resolver(url.hostname),
      new Promise<string[]>((_, reject) => { timer = setTimeout(() => reject(Error("DNS timeout")), 5000); }),
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(ip => !publicIPv4(ip))) throw Error("Blocked destination");
    const headers: Record<string,string> = { accept: "application/json", "accept-encoding": "identity", "user-agent": "Sluice-Gateway/1", "idempotency-key": idempotencyKey };
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (config.auth !== "none") headers[config.header] = (config.auth === "bearer" ? "Bearer " : "") + config.secret;
    const result = await send(url, addresses[0], config.method, headers, payload);
    // Never return upstream error bodies, headers/cookies, redirects or credentials.
    if (result.status < 200 || result.status >= 300)
      return Response.json({ error: "UPSTREAM_REJECTED", message: "The upstream API did not return a successful response", upstreamStatus: result.status }, { status: result.status >= 400 && result.status <= 599 && result.status !== 402 ? result.status : 502 });
    if (result.bytes.length > 1024 * 1024 || !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(result.contentType)) throw Error("Unsupported response");
    const text = result.bytes.toString("utf8");
    if (config.secret && (text.includes(config.secret) || text.includes(encodeURIComponent(config.secret)))) throw Error("Credential reflection");
    JSON.parse(text);
    return new Response(text, { status: result.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "UPSTREAM_UNAVAILABLE", message: "The upstream request failed, timed out or returned an unsupported response. It was not retried." }, { status: 502 });
  }
}
