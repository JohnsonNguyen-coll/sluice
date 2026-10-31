import { test, expect } from "bun:test";
import { upstreamConfig, sealUpstream, openUpstream, publicIPv4, gatewayInput, callUpstream, type GatewayTransport } from "../src/api-gateway";

const config = () => upstreamConfig({ upstreamUrl: "https://api.example.com/v1/answer", upstreamMethod: "POST", upstreamAuth: "bearer", upstreamKey: "test-only-private-key" });
const publicDns = async () => ["8.8.8.8"];
const ok: GatewayTransport = async () => ({status:200, contentType:"application/json; charset=utf-8", bytes:Buffer.from('{"answer":42}')});

test("upstream keys use authenticated encryption bound to service identity", () => {
  const key = Buffer.alloc(32, 12), value = config();
  const sealed = sealUpstream(value, "chain:service:owner:provider", key);
  expect(sealed).not.toContain(value.secret);
  expect(openUpstream(sealed, "chain:service:owner:provider", key)).toEqual(value);
  expect(() => openUpstream(sealed, "other-service", key)).toThrow();
  expect(() => openUpstream(sealed.slice(0,-3), "chain:service:owner:provider", key)).toThrow();
  expect(sealUpstream(value, "chain:service:owner:provider", key)).not.toBe(sealed);
});
test("configuration rejects credentials in URLs, IPs, query keys and header injection", () => {
  for (const url of ["http://api.example.com", "https://127.1", "https://2130706433", "https://[::1]", "https://localhost", "https://user:key@api.example.com", "https://api.example.com:8443", "https://api.example.com?key=secret", "https://api.example.com#key"])
    expect(() => upstreamConfig({upstreamUrl:url, upstreamMethod:"POST",upstreamAuth:"none"})).toThrow();
  for (const header of ["host", "cookie", "authorization", "x-forwarded-host", "x-agentpay-voucher", "x-api-key\r\nHost"])
    expect(() => upstreamConfig({upstreamUrl:"https://api.example.com",upstreamMethod:"POST",upstreamAuth:"header",upstreamHeader:header,upstreamKey:"key"})).toThrow();
  expect(() => upstreamConfig({upstreamUrl:"https://api.example.com",upstreamMethod:"POST",upstreamAuth:"bearer",upstreamKey:"key\r\nInjected:yes"})).toThrow();
});
test("SSRF blocks reserved addresses and mixed DNS answers before sending a key", async () => {
  let calls=0;
  const send: GatewayTransport = async (...args) => {calls++; return ok(...args);};
  for (const ip of ["0.0.0.0","10.1.2.3","127.0.0.1","169.254.169.254","172.16.2.1","172.31.0.1","192.168.1.1","100.100.100.200","192.0.0.9","192.0.2.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","255.255.255.255","::ffff:127.0.0.1","::1"]) {
    expect(publicIPv4(ip)).toBe(false);
    expect((await callUpstream(config(),{},"id",async()=>["8.8.8.8",ip],send)).status).toBe(502);
  }
  expect(calls).toBe(0);
});
test("request forwards JSON with only configured auth and a fixed idempotency key", async () => {
  const c = config(); let calls=0;
  const response = await callUpstream(c, {prompt:"hello", nested:{model:"my-model"}}, "voucher-hash", publicDns, async(url, ip, method, headers, payload) => {
    calls++;
    expect(url.href).toBe(c.url); expect(ip).toBe("8.8.8.8"); expect(method).toBe("POST");
    expect(headers.authorization).toBe("Bearer " + c.secret);
    expect(headers["idempotency-key"]).toBe("voucher-hash");
    expect(headers.cookie).toBeUndefined(); expect(headers["x-agentpay-voucher"]).toBeUndefined();
    expect(JSON.parse(payload!)).toEqual({prompt:"hello",nested:{model:"my-model"}});
    return {status:201,contentType:"application/json",bytes:Buffer.from('{"answer":"hello"}')};
  });
  expect(calls).toBe(1);expect(response.status).toBe(201);expect(await response.json()).toEqual({answer:"hello"});
  expect([...response.headers.keys()]).toEqual(["cache-control","content-type"]);
});
test("GET query is encoded and never changes the configured path or sends a body", async () => {
  const c = {...config(),method:"GET" as const,auth:"header" as const,header:"x-api-key"};
  await callUpstream(c,{query:{q:"hello & admin=true",page:2}},"id",publicDns,async(url,_ip,method,headers,payload)=>{
    expect(url.pathname).toBe("/v1/answer");expect(url.searchParams.get("q")).toBe("hello & admin=true");
    expect(url.searchParams.has("admin")).toBe(false);expect(method).toBe("GET");expect(payload).toBeUndefined();
    expect(headers["x-api-key"]).toBe(c.secret);expect(headers.authorization).toBeUndefined();
    return ok(url,_ip,method,headers,payload);
  });
  expect(()=>gatewayInput(c,{url:"https://evil.example"})).toThrow();
  expect(()=>gatewayInput(c,{query:{nested:{a:1}}})).toThrow();
  expect(()=>gatewayInput(config(),{data:"a".repeat(24001)})).toThrow();
});
test("redirects, errors, non-JSON, oversized and reflected secrets never pass through or retry", async () => {
  for (const result of [
    {status:302,contentType:"text/html",bytes:Buffer.from("secret redirect")},
    {status:401,contentType:"application/json",bytes:Buffer.from('{"key":"test-only-private-key"}')},
    {status:402,contentType:"application/json",bytes:Buffer.from("upstream bill")},
    {status:200,contentType:"text/event-stream",bytes:Buffer.from("stream")},
    {status:200,contentType:"application/json",bytes:Buffer.from('{"key":"test-only-private-key"}')},
    {status:200,contentType:"application/json",bytes:Buffer.from("invalid JSON")},
    {status:200,contentType:"application/json",bytes:Buffer.alloc(1048577)},
  ]) {
    let calls=0;
    const response=await callUpstream(config(),{},"id",publicDns,async()=>{calls++;return result;});
    expect(response.ok).toBe(false);expect(response.status).not.toBe(402);expect(await response.text()).not.toContain("test-only-private-key");expect(calls).toBe(1);
  }
  const failed=await callUpstream(config(),{},"id",publicDns,async()=>{throw Error("private timeout details");});
  expect(failed.status).toBe(502);expect(await failed.text()).not.toContain("private timeout details");
});
