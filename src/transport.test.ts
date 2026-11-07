import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { checkWakeConfig, httpTransport, type WakeBody } from "./transport";

type Seen = { headers: IncomingMessage["headers"]; body: string; path: string };

let server: Server;
let base = "";
const seen: Seen[] = [];
let respond: (path: string) => { status: number; headers?: Record<string, string>; delayMs?: number } = () => ({ status: 202 });

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ headers: req.headers, body, path: req.url ?? "" });
      const answer = respond(req.url ?? "");
      setTimeout(() => {
        res.writeHead(answer.status, answer.headers ?? {});
        res.end("receiver body that must not be logged");
      }, answer.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const body: WakeBody = {
  type: "bb.projects.replies-pending",
  version: 1,
  wake: 3,
  pending: 2,
  projects: { PIXEL: 2 },
  newestReplyId: "rep_1",
  at: "2026-11-07T10:00:00.000Z",
};

describe("webhook transport against a local receiver", () => {
  it("POSTs the wake-up JSON with the configured auth header", async () => {
    respond = () => ({ status: 202 });
    seen.length = 0;
    await httpTransport({ enabled: true, url: `${base}/hook`, headerName: "X-Test-Auth", headerValue: "local-test-value" })(body);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/hook");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");
    expect(seen[0]!.headers["x-test-auth"]).toBe("local-test-value");
    expect(JSON.parse(seen[0]!.body)).toEqual(body);
  });

  it("treats non-2xx as a failure without echoing the URL, header or receiver body", async () => {
    respond = () => ({ status: 401 });
    const send = httpTransport({ enabled: true, url: `${base}/hook?token=abc`, headerName: "X-Test-Auth", headerValue: "local-test-value" });
    const error = await send(body).then(
      () => null,
      (cause: Error) => cause,
    );
    expect(error?.message).toBe("webhook answered HTTP 401");
    expect(error?.message).not.toContain("abc");
    expect(error?.message).not.toContain("local-test-value");
    expect(error?.message).not.toContain("receiver body");
  });

  it("does not follow redirects, so the auth header never goes to another host", async () => {
    respond = (path) => (path === "/hook" ? { status: 307, headers: { location: `${base}/elsewhere` } } : { status: 200 });
    seen.length = 0;
    await expect(httpTransport({ enabled: true, url: `${base}/hook`, headerName: "X-Test-Auth", headerValue: "v" })(body)).rejects.toThrow("HTTP 307");
    expect(seen.map((entry) => entry.path)).toEqual(["/hook"]);
  });

  it("times out a receiver that hangs", async () => {
    respond = () => ({ status: 200, delayMs: 500 });
    await expect(httpTransport({ enabled: true, url: `${base}/slow`, headerName: null, headerValue: null }, fetch, 50)(body)).rejects.toThrow("timed out");
  });

  it("reports an unreachable receiver as a plain failure", async () => {
    await expect(httpTransport({ enabled: true, url: "http://127.0.0.1:9/none", headerName: null, headerValue: null })(body)).rejects.toThrow("webhook request failed");
  });
});

describe("webhook configuration", () => {
  const config = (url: string | null, headerName: string | null = null, headerValue: string | null = null) => ({ enabled: true, url, headerName, headerValue });

  it("requires https except for a loopback test receiver", () => {
    expect(() => checkWakeConfig(config("http://example.com/hook"))).toThrow("https");
    expect(() => checkWakeConfig(config("https://example.com/hook"))).not.toThrow();
    expect(() => checkWakeConfig(config("http://localhost:8080/hook"))).not.toThrow();
  });

  it("rejects missing URLs, credentials in the URL, and half-set or unsafe headers", () => {
    expect(() => checkWakeConfig(config(null))).toThrow("No webhook URL");
    expect(() => checkWakeConfig(config("https://user:pass@example.com/"))).toThrow("auth header setting");
    expect(() => checkWakeConfig(config("https://example.com/", "X-Auth", null))).toThrow("both");
    expect(() => checkWakeConfig(config("https://example.com/", null, "v"))).toThrow("both");
    expect(() => checkWakeConfig(config("https://example.com/", "Host", "v"))).toThrow("not allowed");
    expect(() => checkWakeConfig(config("https://example.com/", "X Bad", "v"))).toThrow("not allowed");
    expect(() => checkWakeConfig(config("https://example.com/", "X-Auth", "a\r\nInjected: 1"))).toThrow("line breaks");
  });
});
