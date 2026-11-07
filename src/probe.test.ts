import { describe, expect, it } from "vitest";
import { ProbeShapeError, readQueue, readSearch, searchToken, sight, SEARCH_LIMIT_PER_GROUP } from "./probe";
import { capturedSearch, typedQueued, typedSearch } from "./probe.fixtures";
import { newId } from "./mailbox";

const SERVER_TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;
const SERVER_LIMIT_MAX = 50;
const id = "req_0123456789abcdef0123";

describe("thread search contract", () => {
  it("finds a delivery in the active or archived group of the right thread only", () => {
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_lead1", text: `Request ${id}.` }]))).toBe(true);
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_lead1", archived: true, text: `Request ${id}.` }]))).toBe(true);
    expect(readSearch("thr_lead1", typedSearch([{ threadId: "thr_worker", text: `brief mentions ${id}` }]))).toBe(false);
    expect(readSearch("thr_lead1", typedSearch([]))).toBe(false);
  });

  it("accepts the response exactly as the installed BB returned it (captured read-only, content replaced)", () => {
    expect(readSearch("thr_lead1", capturedSearch("thr_lead1", "…replied to 0123456789abcdef0123 with the result"))).toBe(true);
  });

  it("fails loudly on a changed response shape instead of guessing", () => {
    expect(() => readSearch("thr_lead1", { results: [] })).toThrow(ProbeShapeError);
    expect(() => readSearch("thr_lead1", { active: { results: [{ thread: {}, matches: [] }] }, archived: { total: 0, results: [] } })).toThrow(/thread search response shape/);
  });

  it("queries one token the server tokenizer keeps whole, within the server's limit", async () => {
    for (let i = 0; i < 50; i++) {
      const request = newId("req");
      const token = searchToken(request);
      expect([...token.matchAll(SERVER_TOKEN_PATTERN)].map((match) => match[0])).toEqual([token]);
      expect([...request.matchAll(SERVER_TOKEN_PATTERN)].map((match) => match[0])).toEqual(["req", token]);
    }
    expect(Number(SEARCH_LIMIT_PER_GROUP)).toBeLessThanOrEqual(SERVER_LIMIT_MAX);
    const asked: string[][] = [];
    await sight({ queued: async () => typedQueued("thr_lead1", []), search: async (query, limit) => (asked.push([query, limit]), typedSearch([])) }, "thr_lead1", id);
    expect(asked).toEqual([["0123456789abcdef0123", "50"]]);
  });
});

describe("queued messages contract", () => {
  const row = (state: Parameters<typeof typedQueued>[1][number]["state"], extra: Partial<Parameters<typeof typedQueued>[1][number]> = {}) =>
    typedQueued("thr_lead1", [{ id: "qm_1", text: `[Outer loop · grok-bot] PIXEL\nRequest ${id}.`, state, ...extra }]);

  it("treats live rows as still queued", () => {
    for (const state of ["queued", "claimed", "waiting", "scheduled", "failed_retrying"] as const) {
      expect(readQueue("thr_lead1", id, row(state))).toEqual({ kind: "queued", queuedId: "qm_1", state });
    }
  });

  it("treats rows BB will never send as stranded", () => {
    expect(readQueue("thr_lead1", id, row("failed_exhausted", { failureReason: "provider unavailable" }))).toMatchObject({ kind: "stranded", queuedId: "qm_1" });
    expect(readQueue("thr_lead1", id, row("waiting", { waitingOn: { kind: "superseded" } as never }))).toMatchObject({ kind: "stranded" });
  });

  it("ignores other messages and rejects a changed shape", () => {
    expect(readQueue("thr_lead1", "req_ffffffffffffffffffff", row("queued"))).toBeNull();
    expect(() => readQueue("thr_lead1", id, { rows: [] })).toThrow(ProbeShapeError);
  });

  it("checks the queue before search, so a row mid-dispatch is never reported absent", async () => {
    const order: string[] = [];
    const seen = await sight(
      {
        queued: async () => (order.push("queue"), row("claimed")),
        search: async () => (order.push("search"), typedSearch([])),
      },
      "thr_lead1",
      id,
    );
    expect(seen.kind).toBe("queued");
    expect(order).toEqual(["queue"]);
  });
});
