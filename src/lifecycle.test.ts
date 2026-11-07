import { describe, expect, it } from "vitest";
import { Clock, openDb, pixel, tempDbPath, world } from "../test/harness";
import { backoffMs, CHECK_EVERY_MS, MAX_FAILURES, RETENTION_MS } from "./mailbox";

const ask = (text: string, key: string | null = null) => ({ ...pixel, source: "grok-bot", text, ref: null, key });

async function failUntilTerminal(w: ReturnType<typeof world>, clock: Clock, id: string) {
  for (let i = 0; i < MAX_FAILURES + 2 && w.mailbox.getRequest(id)!.state !== "failed"; i++) {
    clock.advance(backoffMs(MAX_FAILURES));
    await w.courier.tick();
  }
}

describe("queued deliveries are confirmed, not assumed", () => {
  it("a request queued behind a busy lead is confirmed once it dispatches", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.busy.add("thr_lead1");
    const { request } = w.mailbox.enqueue(ask("queue me"));
    expect((await w.courier.deliver(request.id))!).toMatchObject({ state: "delivered", delivery: "queued", confirmedAt: null });
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)!.confirmedAt).toBeNull();
    w.dispatch("thr_lead1");
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)!.confirmedAt).not.toBeNull();
    expect(w.sent).toHaveLength(1);
  });

  it("a request still queued on a lead that gets archived moves to the next lead, and the stale copy is removed", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.busy.add("thr_lead1");
    const { request } = w.mailbox.enqueue(ask("stuck behind archive"));
    await w.courier.deliver(request.id);
    w.threads.set("thr_lead1", "archived");
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)!.state).toBe("held");
    expect(w.queues.get("thr_lead1")).toEqual([]);
    expect(w.mailbox.listReplies({}).map((reply) => reply.kind)).toEqual(["notice"]);

    w.leads.set(pixel.projectId, "thr_lead2");
    w.threads.set("thr_lead2", "ok");
    w.mailbox.releaseHeld(pixel.projectId);
    await w.courier.tick();
    expect(w.sent.map((item) => item.threadId)).toEqual(["thr_lead1", "thr_lead2"]);
    expect(w.sent[1]!.text).toContain("Redelivery");
    expect(w.mailbox.getRequest(request.id)).toMatchObject({ state: "delivered", delivery: "sent", targetThreadId: "thr_lead2" });
  });

  it("a queued copy BB gave up on is reported as failed, then an explicit retry replaces it once", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.busy.add("thr_lead1");
    const { request } = w.mailbox.enqueue(ask("will strand"));
    await w.courier.deliver(request.id);
    w.queues.get("thr_lead1")![0]!.state = "failed_exhausted";
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)!.state).toBe("failed");
    const report = w.mailbox.listReplies({}).find((reply) => reply.kind === "failure")!;
    expect(report.inReplyTo).toBe(request.id);
    expect(report.text).toContain(`bb projects retry PIXEL ${request.id}`);
    clock.advance(24 * 60 * 60_000);
    await w.courier.tick();
    expect(w.sent).toHaveLength(1);

    w.busy.delete("thr_lead1");
    const retried = await w.courier.retry(pixel.projectId, request.id);
    expect(retried.outcome).toBe("requeued");
    expect(retried.request).toMatchObject({ state: "delivered", delivery: "sent" });
    expect(w.queues.get("thr_lead1")).toEqual([]);
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1]!.text).toContain("Redelivery");
  });

  it("a queued copy that vanishes without dispatching is reported after two checks and not silently resent", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.busy.add("thr_lead1");
    const { request } = w.mailbox.enqueue(ask("deleted by someone"));
    await w.courier.deliver(request.id);
    w.queues.set("thr_lead1", []);
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)).toMatchObject({ state: "delivered", checkMisses: 1 });
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)!.state).toBe("failed");
    expect(w.mailbox.listReplies({}).filter((reply) => reply.kind === "failure")).toHaveLength(1);
    expect(w.sent).toHaveLength(1);
  });

  it("after a crash mid-send, a copy still waiting in the lead's queue is adopted, not resent", async () => {
    const path = tempDbPath();
    const clock = new Clock();
    const crashedDb = openDb(path);
    const crashed = world(crashedDb, clock);
    const { request } = crashed.mailbox.enqueue(ask("queued just before the crash"));
    crashed.mailbox.claim(request.id);
    crashed.mailbox.setTarget(request.id, "thr_lead1");
    crashedDb.close();

    const restarted = world(openDb(path), clock);
    restarted.queues.set("thr_lead1", [{ id: "qm_9", text: `[Outer loop · grok-bot] PIXEL\nRequest ${request.id}.`, state: "queued" }]);
    clock.advance(5 * 60_000 + 1);
    await restarted.courier.tick();
    expect(restarted.sent).toHaveLength(0);
    expect(restarted.mailbox.getRequest(request.id)).toMatchObject({ state: "delivered", delivery: "queued" });
  });

  it("matches the real search response shape during recovery", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.faults.captured = true;
    const { request } = w.mailbox.enqueue(ask("captured shape"));
    w.mailbox.claim(request.id);
    w.mailbox.setTarget(request.id, "thr_lead1");
    w.landedIn("thr_lead1", `[Outer loop · grok-bot] PIXEL\nRequest ${request.id}.`);
    clock.advance(5 * 60_000 + 1);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)).toMatchObject({ state: "delivered", delivery: "recovered" });
    expect(w.sent).toHaveLength(0);
  });
});

describe("bounded failure", () => {
  it("a permanently failing send stops after a bounded number of attempts with one durable report", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.faults.send = 1_000;
    const { request } = w.mailbox.enqueue(ask("never lands"));
    await w.courier.deliver(request.id);
    await failUntilTerminal(w, clock, request.id);
    const row = w.mailbox.getRequest(request.id)!;
    expect(row).toMatchObject({ state: "failed", failures: MAX_FAILURES });
    expect(row.lastError).toContain("send failed");
    const attempts = row.attempts;
    clock.advance(7 * 24 * 60 * 60_000);
    await w.courier.tick();
    expect(w.mailbox.getRequest(request.id)!.attempts).toBe(attempts);
    const reports = w.mailbox.listReplies({}).filter((reply) => reply.kind === "failure");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.text).toContain("did not reach the PIXEL lead");
  });

  it("the failure report survives a failing webhook and a restart, and stays until acknowledged", async () => {
    const path = tempDbPath();
    const clock = new Clock();
    const db = openDb(path);
    const w = world(db, clock);
    w.faults.send = 1_000;
    w.faults.wake = 1_000;
    const { request } = w.mailbox.enqueue(ask("doomed"));
    await w.courier.deliver(request.id);
    await failUntilTerminal(w, clock, request.id);
    expect(w.wakes).toHaveLength(0);
    expect(w.mailbox.wake().lastError).toContain("503");
    db.close();

    const after = world(openDb(path), clock);
    const reports = after.mailbox.listReplies({}).filter((reply) => reply.kind === "failure");
    expect(reports).toHaveLength(1);
    clock.advance(60 * 60_000);
    await after.courier.tick();
    expect(after.wakes).toHaveLength(1);
    expect(after.wakes[0]!.pending).toBe(1);
  });

  it("a transient failure that recovers resets the failure count", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.faults.send = MAX_FAILURES - 1;
    const { request } = w.mailbox.enqueue(ask("eventually"));
    await w.courier.deliver(request.id);
    for (let i = 0; i < MAX_FAILURES && w.mailbox.getRequest(request.id)!.state !== "delivered"; i++) {
      clock.advance(backoffMs(MAX_FAILURES));
      await w.courier.tick();
    }
    expect(w.mailbox.getRequest(request.id)).toMatchObject({ state: "delivered", failures: 0 });
    expect(w.mailbox.listReplies({}).filter((reply) => reply.kind === "failure")).toHaveLength(0);
  });

  it("retry after restart delivers a failed request once, and a second failure is reported again", async () => {
    const path = tempDbPath();
    const clock = new Clock();
    const db = openDb(path);
    const w = world(db, clock);
    w.faults.send = MAX_FAILURES;
    const { request } = w.mailbox.enqueue(ask("retry me"));
    await w.courier.deliver(request.id);
    await failUntilTerminal(w, clock, request.id);
    db.close();

    const after = world(openDb(path), clock);
    expect((await after.courier.retry(pixel.projectId, request.id)).request).toMatchObject({ state: "delivered", generation: 1 });
    expect(after.sent).toHaveLength(1);
    expect(after.sent[0]!.text).toContain("Redelivery");
    expect((await after.courier.retry(pixel.projectId, request.id)).outcome).toBe("not-retryable");
    expect((await after.courier.retry("proj_other", request.id)).outcome).toBe("unknown");

    const second = after.mailbox.enqueue(ask("fails twice")).request;
    after.faults.send = 1_000;
    await after.courier.deliver(second.id);
    await failUntilTerminal(after, clock, second.id);
    await after.courier.retry(pixel.projectId, second.id);
    await failUntilTerminal(after, clock, second.id);
    expect(after.mailbox.listReplies({}).filter((reply) => reply.kind === "failure" && reply.inReplyTo === second.id)).toHaveLength(2);
  });

  it("a search response that changes shape during recovery ends in a report, not a duplicate or an endless retry", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.faults.shape = "search";
    const { request } = w.mailbox.enqueue(ask("shape drift"));
    w.mailbox.claim(request.id);
    w.mailbox.setTarget(request.id, "thr_lead1");
    clock.advance(5 * 60_000 + 1);
    await failUntilTerminal(w, clock, request.id);
    expect(w.sent).toHaveLength(0);
    expect(w.mailbox.getRequest(request.id)!.lastError).toContain("unexpected thread search response shape");
    expect(w.mailbox.listReplies({}).filter((reply) => reply.kind === "failure")).toHaveLength(1);
  });

  it("a hidden lead holds requests with a notice, because search cannot see hidden threads", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.threads.set("thr_lead1", "hidden");
    const { request } = w.mailbox.enqueue(ask("hidden lead"));
    await w.courier.deliver(request.id);
    expect(w.mailbox.getRequest(request.id)!.state).toBe("held");
    expect(w.mailbox.listReplies({})[0]!.text).toContain("is hidden");
    expect(w.sent).toHaveLength(0);
  });
});

describe("dedupe and retention", () => {
  it("content dedupe without a key covers quick retries only, and says so", () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    w.mailbox.enqueue(ask("same"));
    expect(w.mailbox.enqueue(ask("same"))).toMatchObject({ duplicate: true, dedupedBy: "content" });
    clock.advance(9 * 60_000);
    expect(w.mailbox.enqueue(ask("same")).duplicate).toBe(true);
    clock.advance(60_000 + 1);
    expect(w.mailbox.enqueue(ask("same"))).toMatchObject({ duplicate: false, dedupedBy: null });
    expect(w.mailbox.enqueue(ask("same", "k-1"))).toMatchObject({ duplicate: false });
    expect(w.mailbox.enqueue(ask("same", "k-1"))).toMatchObject({ duplicate: true, dedupedBy: "key" });
  });

  it("prunes old handled history and keeps anything still owed to someone", async () => {
    const clock = new Clock();
    const w = world(openDb(), clock);
    const done = w.mailbox.enqueue(ask("done")).request;
    await w.courier.deliver(done.id);
    const ackedReply = w.mailbox.addReply({ ...pixel, leadThreadId: "thr_lead1", inReplyTo: done.id, kind: "result", author: "thr_lead1", text: "ok", key: null }).reply;
    w.mailbox.ack(pixel.projectId, [ackedReply.id]);
    const owed = w.mailbox.enqueue(ask("owed")).request;
    await w.courier.deliver(owed.id);
    const unacked = w.mailbox.addReply({ ...pixel, leadThreadId: "thr_lead1", inReplyTo: owed.id, kind: "question", author: "thr_lead1", text: "which?", key: null }).reply;
    w.leads.set(pixel.projectId, null);
    const waiting = w.mailbox.enqueue(ask("still waiting")).request;
    await w.courier.deliver(waiting.id);

    clock.advance(RETENTION_MS + 1);
    expect(w.mailbox.prune()).toEqual({ requests: 1, replies: 1 });
    expect(w.mailbox.getRequest(done.id)).toBeNull();
    expect(w.mailbox.getReply(ackedReply.id)).toBeNull();
    expect(w.mailbox.getRequest(owed.id)).not.toBeNull();
    expect(w.mailbox.getReply(unacked.id)).not.toBeNull();
    expect(w.mailbox.getRequest(waiting.id)!.state).toBe("held");
  });
});

describe("upgrade from the first schema", () => {
  it("adds the new columns in place and treats earlier deliveries as confirmed", async () => {
    const { Database } = await import("bun:sqlite");
    const { migrate } = await import("../test/harness");
    const { MIGRATIONS, createMailbox } = await import("./mailbox");
    const path = tempDbPath();
    const old = new Database(path);
    migrate(old as never, MIGRATIONS.slice(0, 1));
    old
      .prepare("INSERT INTO requests (id, project_id, prefix, source, text, ref, idem_key, content_hash, created_at, state, next_attempt_at, delivered_at, delivery, target_thread_id) VALUES ('req_aaaaaaaaaaaaaaaaaaaa', 'proj_pixel', 'PIXEL', 'grok-bot', 'old', NULL, 'k', 'h', 1, 'delivered', 1, 5, 'queued', 'thr_lead1')")
      .run();
    old.close();
    const clock = new Clock();
    const db = openDb(path);
    const w = world(db, clock);
    expect(createMailbox(() => db, clock.now).getRequest("req_aaaaaaaaaaaaaaaaaaaa")).toMatchObject({ state: "delivered", confirmedAt: 5, failures: 0, generation: 0 });
    clock.advance(CHECK_EVERY_MS);
    await w.courier.tick();
    expect(w.mailbox.listReplies({})).toHaveLength(0);
  });
});
