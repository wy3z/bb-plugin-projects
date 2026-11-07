export type WakeConfig = {
  enabled: boolean;
  url: string | null;
  headerName: string | null;
  headerValue: string | null;
};

export type WakeBody = {
  type: "bb.projects.replies-pending";
  version: 1;
  wake: number;
  pending: number;
  projects: Record<string, number>;
  consumers: Record<string, Record<string, number>>;
  newestReplyId: string | null;
  at: string;
};

export type WakeTransport = (body: WakeBody) => Promise<void>;

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "content-type", "transfer-encoding", "connection"]);

export class WakeConfigError extends Error {}

export function checkWakeConfig(config: WakeConfig): { url: URL; headers: Record<string, string> } {
  if (!config.url) throw new WakeConfigError("No webhook URL is configured.");
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new WakeConfigError("The webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new WakeConfigError("The webhook URL must use https (plain http is allowed only for a loopback test receiver).");
  }
  if (url.username || url.password) throw new WakeConfigError("Put credentials in the auth header setting, not in the URL.");
  const headers: Record<string, string> = { "content-type": "application/json" };
  const name = config.headerName?.trim() || null;
  const value = config.headerValue ?? null;
  if (name || value) {
    if (!name || !value) throw new WakeConfigError("Set both the auth header name and its secret value, or neither.");
    if (!HEADER_NAME.test(name) || FORBIDDEN_HEADERS.has(name.toLowerCase())) throw new WakeConfigError("The auth header name is not allowed.");
    if (/[\r\n]/.test(value)) throw new WakeConfigError("The auth header value cannot contain line breaks.");
    headers[name] = value;
  }
  return { url, headers };
}

export function httpTransport(config: WakeConfig, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): WakeTransport {
  const { url, headers } = checkWakeConfig(config);
  return async (body) => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const name = cause instanceof Error ? cause.name : "Error";
      throw new Error(name === "TimeoutError" ? `webhook timed out after ${timeoutMs}ms` : `webhook request failed (${name})`);
    }
    await response.body?.cancel().catch(() => undefined);
    if (response.status < 200 || response.status >= 300) throw new Error(`webhook answered HTTP ${response.status}`);
  };
}
