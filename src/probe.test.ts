import { describe, expect, it } from "vitest";
import { isRelay, ProbeShapeError, readQueue, readSearch, searchToken, sight, SEARCH_LIMIT_PER_GROUP, type ProbeApi } from "./probe";
import { capturedSearch, typedQueued, typedRelayEvent, typedSearch } from "./probe.fixtures";
import { newId } from "./mailbox";
import { requestPrompt } from "./courier";

const SERVER_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const SERVER_LIMIT_MAX = 50;
const id = "req_0123456789abcdef0123";
const relay = requestPrompt({ id, prefix: "PIXEL", source: "grok-bot", text: "Login 500s", ref: null }, false);

function api(opts: { queue?: unknown; search?: unknown; events?: Record<number, unknown> }): ProbeApi & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    queued: async () => (asked.push("queue"), opts.queue ?? typedQueued("thr_lead1", [])),
    search: async (query, limit) => (asked.push(`search ${query} ${limit}`), opts.search ?? typedSearch([])),
    event: async (_threadId, seq) => (asked.push(`event ${seq}`), opts.events?.[seq] ?? []),
  };
}

describe("thread search contract", () => {
  it("returns the sequence of user messages in the right thread only, active or archived", () => {
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_lead1", text: `Request ${id} from grok-bot.`, seq: 40 }]))).toEqual([40]);
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_lead1", archived: true, text: `Request ${id}`, seq: 41 }]))).toEqual([41]);
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_worker", text: `brief mentions ${id}` }]))).toEqual([]);
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_lead1", text: `I replied to ${id}`, kind: "assistant_message" }]))).toEqual([]);
    expect(readSearch("thr_lead1", typedSearch([]))).toEqual([]);
  });

  it("accepts the response exactly as the installed BB returned it (captured read-only, content replaced)", () => {
    expect(readSearch("thr_lead1", capturedSearch("thr_lead1", "…replied to 0123456789abcdef0123 with the result"))).toEqual([]);
    expect(readSearch("thr_lead1", capturedSearch("thr_lead1", "[Outer loop · grok-bot] PIXEL Request …", "user_message", 8831))).toEqual([8831]);
  });

  it("fails loudly on a changed response shape instead of guessing", () => {
    expect(() => readSearch("thr_lead1", { results: [] })).toThrow(ProbeShapeError);
    expect(() => readSearch("thr_lead1", { active: { results: [{ thread: {}, matches: [] }] }, archived: { total: 0, results: [] } })).toThrow(/thread search response shape/);
    expect(() => isRelay(id, 1, { events: [] })).toThrow(/thread event response shape/);
  });

  it("queries one token the server tokenizer keeps whole, within the server's limit", async () => {
    for (let i = 0; i < 50; i++) {
      const request = newId("req");
      const token = searchToken(request);
      expect([...token.matchAll(SERVER_TOKEN_PATTERN)].map((match) => match[0])).toEqual([token]);
      expect([...request.matchAll(SERVER_TOKEN_PATTERN)].map((match) => match[0])).toEqual(["req", token]);
    }
    expect(Number(SEARCH_LIMIT_PER_GROUP)).toBeLessThanOrEqual(SERVER_LIMIT_MAX);
    const probe = api({});
    await sight(probe, "thr_lead1", id);
    expect(probe.asked).toEqual(["queue", "search 0123456789abcdef0123 50"]);
  });
});

describe("only the relay message itself counts as delivered", () => {
  const hit = (seq: number) => typedSearch([{ threadId: "thr_lead1", text: `…${id}…`, seq }]);

  it("a relay event with the header and the request's marker is delivered", async () => {
    expect(await sight(api({ search: hit(7), events: { 7: typedRelayEvent("thr_lead1", 7, relay) } }), "thr_lead1", id)).toEqual({ kind: "landed" });
  });

  it("an assistant mentioning the id, a worker's message, a pasted copy or another request is not", async () => {
    expect(await sight(api({ search: typedSearch([{ threadId: "thr_lead1", text: `answered ${id}`, kind: "assistant_message", seq: 7 }]) }), "thr_lead1", id)).toEqual({ kind: "absent" });
    expect(await sight(api({ search: hit(7), events: { 7: typedRelayEvent("thr_lead1", 7, relay, "thr_worker") } }), "thr_lead1", id)).toEqual({ kind: "absent" });
    expect(await sight(api({ search: hit(7), events: { 7: typedRelayEvent("thr_lead1", 7, `Can you check ${id}? It says Request ${id} from grok-bot.`) } }), "thr_lead1", id)).toEqual({ kind: "absent" });
    const other = requestPrompt({ id: "req_ffffffffffffffffffff", prefix: "PIXEL", source: "grok-bot", text: `see also ${id}`, ref: null }, false);
    expect(await sight(api({ search: hit(7), events: { 7: typedRelayEvent("thr_lead1", 7, other) } }), "thr_lead1", id)).toEqual({ kind: "absent" });
    expect(await sight(api({ search: hit(7), events: { 8: typedRelayEvent("thr_lead1", 8, relay) } }), "thr_lead1", id)).toEqual({ kind: "absent" });
  });
});

describe("queued messages contract", () => {
  const row = (state: Parameters<typeof typedQueued>[1][number]["state"], extra: Partial<Parameters<typeof typedQueued>[1][number]> = {}) =>
    typedQueued("thr_lead1", [{ id: "qm_1", text: relay, state, ...extra }]);

  it("treats live rows as still queued", () => {
    for (const state of ["queued", "claimed", "waiting", "scheduled", "failed_retrying"] as const) {
      expect(readQueue("thr_lead1", id, row(state))).toEqual({ kind: "queued", queuedId: "qm_1", state });
    }
  });

  it("treats rows BB will never send as stranded", () => {
    expect(readQueue("thr_lead1", id, row("failed_exhausted", { failureReason: "provider unavailable" }))).toMatchObject({ kind: "stranded", queuedId: "qm_1" });
    expect(readQueue("thr_lead1", id, row("waiting", { waitingOn: { kind: "superseded" } as never }))).toMatchObject({ kind: "stranded" });
  });

  it("ignores other messages, including a queued worker note that quotes the id, and rejects a changed shape", () => {
    expect(readQueue("thr_lead1", "req_ffffffffffffffffffff", row("queued"))).toBeNull();
    expect(readQueue("thr_lead1", id, typedQueued("thr_lead1", [{ id: "qm_2", text: `worker: done with ${id}`, state: "queued" }]))).toBeNull();
    expect(() => readQueue("thr_lead1", id, { rows: [] })).toThrow(ProbeShapeError);
  });

  it("checks the queue before search, so a row mid-dispatch is never reported absent", async () => {
    const probe = api({ queue: row("claimed") });
    expect((await sight(probe, "thr_lead1", id)).kind).toBe("queued");
    expect(probe.asked).toEqual(["queue"]);
  });
});
