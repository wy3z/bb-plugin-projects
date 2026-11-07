import { afterEach, describe, expect, it } from "vitest";
import { setSystemTime } from "bun:test";
import plugin from "../server";
import { fakeBb } from "../test/fake-bb";
import { tempDbPath } from "../test/harness";

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function boot(opts: Parameters<typeof fakeBb>[0] = {}) {
  const fake = fakeBb(opts);
  plugin(fake.bb as never);
  return fake;
}

async function runService(fake: ReturnType<typeof fakeBb>, name: string, during?: () => Promise<void>) {
  const controller = new AbortController();
  const running = Promise.resolve(fake.services.get(name)!.start(controller.signal));
  await settle();
  if (during) {
    await during();
    await settle();
  }
  controller.abort();
  await running;
}

afterEach(() => setSystemTime());

describe("Grok Bot to project PM and back", () => {
  it("send, dedupe a retry, lead replies, consumer reads and acks", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    fake.addThread("thr_worker", { parentThreadId: "thr_lead1" });
    expect((await fake.run(["lead", "PIXEL"], "thr_lead1")).exitCode).toBe(0);

    const first = (await fake.run(["send", "PIXEL", "Login", "500s", "on", "Samsung", "--source", "grok-bot", "--ref", "https://slack.test/p1", "--key", "slack:C1:1.0001", "--json"])).json();
    expect(first).toMatchObject({ state: "delivered", delivery: "sent", deliveredTo: "thr_lead1", duplicate: false, source: "grok-bot", key: "slack:C1:1.0001" });
    const retry = (await fake.run(["send", "PIXEL", "Login 500s on Samsung (retry)", "--key", "slack:C1:1.0001", "--json"])).json();
    expect(retry).toMatchObject({ id: first.id, duplicate: true });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text).toContain(`--to ${first.id}`);

    const fromWorker = await fake.run(["reply", "PIXEL", "I", "finished", "a", "subtask", "--to", first.id], "thr_worker");
    expect(fromWorker.exitCode).not.toBe(0);
    expect(fromWorker.stderr ?? fromWorker.stdout).toContain("Only the PIXEL lead");
    const fromNowhere = await fake.run(["reply", "PIXEL", "hello"]);
    expect(fromNowhere.exitCode).not.toBe(0);

    const answer = (await fake.run(["reply", "PIXEL", "Fixed", "in", "PR", "#12;", "needs", "James", "to", "merge", "--to", first.id, "--json"], "thr_lead1")).json();
    expect(answer).toMatchObject({ kind: "result", inReplyTo: first.id, leadThreadId: "thr_lead1", duplicate: false });
    const again = (await fake.run(["reply", "PIXEL", "Fixed", "in", "PR", "#12;", "needs", "James", "to", "merge", "--to", first.id, "--json"], "thr_lead1")).json();
    expect(again).toMatchObject({ id: answer.id, duplicate: true });
    const blocker = (await fake.run(["reply", "PIXEL", "CI", "is", "red", "on", "main", "--kind", "blocker", "--json"], "thr_lead1")).json();

    const pending = (await fake.run(["replies", "--json"])).json();
    expect(pending.pending).toBe(2);
    expect(pending.replies.map((reply: { id: string }) => reply.id)).toEqual([answer.id, blocker.id]);
    expect(pending.replies[0]).toMatchObject({
      project: "PIXEL",
      inReplyTo: first.id,
      request: { id: first.id, source: "grok-bot", ref: "https://slack.test/p1", key: "slack:C1:1.0001" },
      text: "Fixed in PR #12; needs James to merge",
    });
    expect((await fake.run(["replies", "--after", answer.id, "--json"])).json().replies.map((reply: { id: string }) => reply.id)).toEqual([blocker.id]);

    const acked = await fake.run(["ack", answer.id, "--json"]);
    expect(acked.exitCode).toBe(0);
    expect(acked.json()).toEqual({ acked: [answer.id], alreadyAcked: [], unknown: [] });
    expect((await fake.run(["ack", answer.id, "--json"])).json().alreadyAcked).toEqual([answer.id]);
    expect((await fake.run(["ack", "rep_unknown"])).exitCode).toBe(1);
    expect((await fake.run(["replies", "PIXEL", "--json"])).json().replies.map((reply: { id: string }) => reply.id)).toEqual([blocker.id]);
    expect((await fake.run(["replies", "OTHER", "--json"])).json()).toEqual({ pending: 0, replies: [] });
  });

  it("a lead cannot answer another project's request", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    fake.addThread("thr_other");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["lead", "OTHER"], "thr_other");
    const theirs = (await fake.run(["send", "OTHER", "hi", "--json"])).json();
    const result = await fake.run(["reply", "PIXEL", "mine", "now", "--to", theirs.id], "thr_lead1");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr ?? result.stdout).toContain(`No PIXEL request ${theirs.id}`);
  });

  it("a request to an archived lead is held across a restart and delivered to the next lead", async () => {
    const dbPath = tempDbPath();
    const kv = new Map<string, unknown>();
    const before = boot({ dbPath, kv });
    before.addThread("thr_old", { archivedAt: 1 });
    await before.run(["lead", "PIXEL", "--thread", "thr_old"]);
    const held = (await before.run(["send", "PIXEL", "anyone", "there?", "--key", "k1", "--json"])).json();
    expect(held.state).toBe("held");
    expect((await before.run(["replies", "--json"])).json().replies[0]).toMatchObject({ kind: "notice", inReplyTo: held.id });
    expect((await before.run(["status", "PIXEL", "--json"])).json()).toMatchObject({ leadStatus: "archived", messages: { requestsHeld: 1, repliesPending: 1 } });
    before.db.close();

    const after = boot({ dbPath, kv });
    after.addThread("thr_old", { archivedAt: 1 });
    after.addThread("thr_new");
    await runService(after, "pm-mailbox", async () => {
      await after.run(["lead", "PIXEL", "--thread", "thr_new"]);
    });
    expect(after.sent.map((item) => item.threadId)).toEqual(["thr_new"]);
    expect((await after.run(["requests", "PIXEL", "--json"])).json().requests[0]).toMatchObject({ id: held.id, state: "delivered", deliveredTo: "thr_new" });
    expect((await after.run(["send", "PIXEL", "anyone there?", "--key", "k1", "--json"])).json()).toMatchObject({ id: held.id, duplicate: true });
    expect(after.sent).toHaveLength(1);
  });

  it("imports the old key-value inbox as history without redelivering it", async () => {
    const kv = new Map<string, unknown>([
      [
        "inbox:proj_pixel",
        [
          { at: "2026-11-07T09:00:00.000Z", source: "grok-bot", text: "old one", ref: null, delivery: "sent" },
          { at: "2026-11-07T08:00:00.000Z", source: "grok-bot", text: "old failed", ref: null, delivery: "failed" },
        ],
      ],
    ]);
    const fake = boot({ kv });
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await runService(fake, "pm-mailbox");
    await runService(fake, "pm-mailbox");
    const requests = (await fake.run(["requests", "PIXEL", "--json"])).json().requests;
    expect(requests.map((request: { state: string }) => request.state)).toEqual(["delivered", "abandoned"]);
    expect(fake.sent).toHaveLength(0);
    expect(kv.has("inbox:proj_pixel")).toBe(true);
    const inbox = (await fake.rpc().listInbox!({ projectId: "proj_pixel" })) as { items: { delivery: string }[] };
    expect(inbox.items.map((item) => item.delivery)).toEqual(["sent", "failed"]);
  });

  it("concurrent meta writes do not lose a lead change", async () => {
    const fake = boot();
    fake.faults.kvSetDelayMs = 10;
    await Promise.all([
      fake.rpc().setLoop!({ projectId: "proj_pixel", sweepMinutes: 120 }),
      fake.rpc().setLead!({ projectId: "proj_pixel", threadId: "thr_b" }),
      fake.rpc().setFocus!({ projectId: "proj_pixel", focus: "ship it" }),
    ]);
    expect(fake.kv.get("meta:proj_pixel")).toMatchObject({ sweepMinutes: 120, leadThreadId: "thr_b", focus: "ship it" });
  });
});

describe("outer loop reliability", () => {
  it("a failing leads lookup is logged and the loop keeps running", async () => {
    const fake = boot();
    fake.faults.listProjects = 1;
    await runService(fake, "outer-loop");
    expect(fake.logs.some((line) => line.includes("could not list project leads"))).toBe(true);
  });

  it("an archived or missing lead is reported once, not silently treated as busy", async () => {
    const fake = boot();
    fake.addThread("thr_lead1", { archivedAt: 1 });
    await fake.run(["lead", "PIXEL", "--thread", "thr_lead1"]);
    await fake.run(["loop", "PIXEL", "--sweep", "1h", "--any-hours"]);
    await runService(fake, "outer-loop");
    await runService(fake, "outer-loop");
    expect(fake.logs.filter((line) => line.includes("Sweep for PIXEL skipped: the lead thread thr_lead1 is archived"))).toHaveLength(1);
    expect(fake.sent).toHaveLength(0);
  });

  it("a failed sweep delivery is retried after minutes, not a full interval, and only then recorded", async () => {
    const start = new Date("2026-11-10T10:00:00Z");
    setSystemTime(start);
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["loop", "PIXEL", "--sweep", "8h", "--any-hours"]);
    fake.faults.send = 1;
    await runService(fake, "outer-loop");
    expect(fake.sent).toHaveLength(0);
    expect((fake.kv.get("meta:proj_pixel") as { sweepLastAt: string | null }).sweepLastAt).toBeNull();
    await runService(fake, "outer-loop");
    expect(fake.sent).toHaveLength(0);
    setSystemTime(new Date(start.getTime() + 5 * 60_000));
    await runService(fake, "outer-loop");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.text.startsWith("[Scheduled sweep] PIXEL")).toBe(true);
    expect((fake.kv.get("meta:proj_pixel") as { sweepLastAt: string }).sweepLastAt).toBe(new Date(start.getTime() + 5 * 60_000).toISOString());
  });

  it("following PRs resubscribes the new lead after a lead change", async () => {
    const fake = boot();
    fake.addThread("thr_a");
    fake.addThread("thr_a_worker", { parentThreadId: "thr_a" });
    fake.addThread("thr_b");
    fake.addThread("thr_b_worker", { parentThreadId: "thr_b" });
    fake.linked.set("thr_a_worker", ["https://github.com/o/r/pull/1"]);
    fake.linked.set("thr_b_worker", ["https://github.com/o/r/pull/1"]);
    await fake.run(["lead", "PIXEL", "--thread", "thr_a"]);
    await fake.run(["loop", "PIXEL", "--follow-prs", "on"]);
    await runService(fake, "outer-loop");
    await fake.run(["lead", "PIXEL", "--thread", "thr_b"]);
    await runService(fake, "outer-loop");
    expect(fake.subscribed).toEqual([
      { threadId: "thr_a", urls: ["https://github.com/o/r/pull/1"] },
      { threadId: "thr_b", urls: ["https://github.com/o/r/pull/1"] },
    ]);
  });
});
