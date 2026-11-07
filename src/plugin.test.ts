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

    const pending = (await fake.run(["replies", "--as", "grok-bot", "--json"])).json();
    expect(pending.pending).toBe(2);
    expect(pending.replies.map((reply: { id: string }) => reply.id)).toEqual([answer.id, blocker.id]);
    expect(pending.replies[0]).toMatchObject({
      project: "PIXEL",
      inReplyTo: first.id,
      request: { id: first.id, source: "grok-bot", ref: "https://slack.test/p1", key: "slack:C1:1.0001" },
      text: "Fixed in PR #12; needs James to merge",
    });
    expect((await fake.run(["replies", "--as", "grok-bot", "--after", answer.id, "--json"])).json().replies.map((reply: { id: string }) => reply.id)).toEqual([blocker.id]);

    const unnamed = await fake.run(["ack", "PIXEL", answer.id]);
    expect(unnamed.exitCode).not.toBe(0);
    expect(unnamed.stderr ?? unnamed.stdout).toContain("--as");
    const acked = await fake.run(["ack", "PIXEL", answer.id, "--as", "grok-bot", "--json"]);
    expect(acked.exitCode).toBe(0);
    expect(acked.json()).toEqual({ as: "grok-bot", acked: [answer.id], alreadyAcked: [], unknown: [], otherProject: [], notYours: [] });
    expect((await fake.run(["ack", "PIXEL", answer.id, "--as", "grok-bot", "--json"])).json().alreadyAcked).toEqual([answer.id]);
    expect((await fake.run(["ack", "PIXEL", "rep_unknown", "--as", "grok-bot"])).exitCode).toBe(1);
    expect((await fake.run(["replies", "PIXEL", "--as", "grok-bot", "--json"])).json().replies.map((reply: { id: string }) => reply.id)).toEqual([blocker.id]);
    expect((await fake.run(["replies", "OTHER", "--as", "grok-bot", "--json"])).json()).toEqual({ as: "grok-bot", pending: 0, replies: [] });
  });

  it("ack is scoped to the project and refused from the lead thread", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    fake.addThread("thr_other");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["lead", "OTHER"], "thr_other");
    await fake.run(["replies", "PIXEL", "--as", "grok-bot"]);
    await fake.run(["replies", "OTHER", "--as", "grok-bot"]);
    const mine = (await fake.run(["reply", "PIXEL", "pixel news", "--json"], "thr_lead1")).json();
    const theirs = (await fake.run(["reply", "OTHER", "other news", "--json"], "thr_other")).json();
    const byLead = await fake.run(["ack", "PIXEL", mine.id, "--as", "grok-bot"], "thr_lead1");
    expect(byLead.exitCode).not.toBe(0);
    expect(byLead.stderr ?? byLead.stdout).toContain("cannot acknowledge its own replies");
    const crossed = await fake.run(["ack", "PIXEL", mine.id, theirs.id, "--as", "grok-bot", "--json"]);
    expect(crossed.exitCode).toBe(1);
    expect(crossed.json()).toEqual({ as: "grok-bot", acked: [mine.id], alreadyAcked: [], unknown: [], otherProject: [theirs.id], notYours: [] });
    expect((await fake.run(["replies", "OTHER", "--as", "grok-bot", "--json"])).json().pending).toBe(1);
  });

  it("send reports a content dedupe, and retry redelivers a failed request through the CLI", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    fake.faults.send = 1_000;
    const first = (await fake.run(["send", "PIXEL", "flaky", "lead", "--json"])).json();
    const repeat = await fake.run(["send", "PIXEL", "flaky", "lead"]);
    expect(repeat.stdout).toContain("Pass a new --key");
    expect((await fake.run(["send", "PIXEL", "flaky", "lead", "--json"])).json()).toMatchObject({ id: first.id, duplicate: true, dedupedBy: "content" });
    const notYet = await fake.run(["retry", "PIXEL", "req_00000000000000000000"]);
    expect(notYet.exitCode).not.toBe(0);
    fake.faults.send = 0;
    const retried = (await fake.run(["retry", "PIXEL", first.id, "--json"])).json();
    expect(retried).toMatchObject({ id: first.id, state: "delivered", delivery: "sent" });
    const again = await fake.run(["retry", "PIXEL", first.id]);
    expect(again.stderr ?? again.stdout).toContain("only failed, held or pending");
    expect(fake.sent).toHaveLength(1);
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

  it("a hidden lead thread holds requests with a notice instead of sending unverifiable deliveries", async () => {
    const fake = boot();
    fake.addThread("thr_hidden", { visibility: "hidden" });
    await fake.run(["lead", "PIXEL", "--thread", "thr_hidden"]);
    const held = (await fake.run(["send", "PIXEL", "hello", "--json"])).json();
    expect(held.state).toBe("held");
    expect((await fake.run(["replies", "--json"])).json().replies[0].text).toContain("is hidden");
    expect(fake.sent).toHaveLength(0);
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

describe("any agent system", () => {
  const ids = (out: { json(): { replies: { id: string }[] } }) => out.json().replies.map((reply) => reply.id);

  it("routes each answer to the agent that asked, shares project news, and keeps acks per agent", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    const fromGrok = (await fake.run(["send", "PIXEL", "Samsung", "login", "500s", "--as", "grok-bot", "--json"])).json();
    const fromDots = (await fake.run(["send", "PIXEL", "Renew", "the", "TLS", "cert", "--as", "dots", "--json"])).json();
    expect([fromGrok.source, fromDots.source]).toEqual(["grok-bot", "dots"]);
    expect(fake.sent[1]!.text).toContain("it goes only to dots");

    const toGrok = (await fake.run(["reply", "PIXEL", "login", "fixed", "--to", fromGrok.id, "--json"], "thr_lead1")).json();
    const toDots = (await fake.run(["reply", "PIXEL", "cert", "renewed", "--to", fromDots.id, "--json"], "thr_lead1")).json();
    const news = (await fake.run(["reply", "PIXEL", "release", "cut", "--json"], "thr_lead1")).json();
    const dotsOnly = (await fake.run(["reply", "PIXEL", "rotate", "your", "key", "--for", "dots", "--json"], "thr_lead1")).json();
    expect([toGrok.audience, toDots.audience, news.audience, dotsOnly.audience]).toEqual(["grok-bot", "dots", null, "dots"]);

    expect(ids(await fake.run(["replies", "PIXEL", "--as", "grok-bot", "--json"]))).toEqual([toGrok.id, news.id]);
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "dots", "--json"]))).toEqual([toDots.id, news.id, dotsOnly.id]);

    const stolen = await fake.run(["ack", "PIXEL", toGrok.id, "--as", "dots", "--json"]);
    expect(stolen.exitCode).toBe(1);
    expect(stolen.json().notYours).toEqual([toGrok.id]);
    expect((await fake.run(["ack", "PIXEL", news.id, toGrok.id, "--as", "grok-bot", "--json"])).json().acked).toEqual([news.id, toGrok.id]);
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "grok-bot", "--json"]))).toEqual([]);
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "dots", "--json"]))).toEqual([toDots.id, news.id, dotsOnly.id]);

    const overview = (await fake.run(["replies", "PIXEL", "--json"])).json();
    expect(overview.replies.map((reply: { id: string }) => reply.id)).toEqual([toDots.id, news.id, dotsOnly.id]);
    expect(overview.replies[1].recipients).toEqual([
      { consumer: "grok-bot", ackedAt: expect.any(String) },
      { consumer: "dots", ackedAt: null },
    ]);
    expect((await fake.run(["requests", "PIXEL", "--as", "dots", "--json"])).json().requests.map((request: { id: string }) => request.id)).toEqual([fromDots.id]);
  });

  it("identical news for two different agents is two replies, and each agent gets its own", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["send", "PIXEL", "hello", "--as", "grok-bot"]);
    await fake.run(["send", "PIXEL", "hi", "--as", "dots"]);
    const forGrok = (await fake.run(["reply", "PIXEL", "rotate", "the", "key", "--for", "grok-bot", "--json"], "thr_lead1")).json();
    const forDots = (await fake.run(["reply", "PIXEL", "rotate", "the", "key", "--for", "dots", "--json"], "thr_lead1")).json();
    expect(forDots.id).not.toBe(forGrok.id);
    expect(forDots).toMatchObject({ audience: "dots", duplicate: false });
    expect((await fake.run(["reply", "PIXEL", "rotate", "the", "key", "--for", "dots", "--json"], "thr_lead1")).json()).toMatchObject({ id: forDots.id, duplicate: true });
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "dots", "--json"]))).toEqual([forDots.id]);
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "grok-bot", "--json"]))).toEqual([forGrok.id]);
  });

  it("a lead that handed over can still answer requests that were delivered to it, but nothing else", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    fake.addThread("thr_lead2");
    fake.addThread("thr_worker", { parentThreadId: "thr_lead1" });
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    const mine = (await fake.run(["send", "PIXEL", "old", "work", "--as", "grok-bot", "--json"])).json();
    expect(mine.deliveredTo).toBe("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead2");
    const theirs = (await fake.run(["send", "PIXEL", "new", "work", "--as", "grok-bot", "--json"])).json();
    expect(theirs.deliveredTo).toBe("thr_lead2");

    const answered = await fake.run(["reply", "PIXEL", "done", "--to", mine.id, "--json"], "thr_lead1");
    expect(answered.exitCode).toBe(0);
    expect(answered.json()).toMatchObject({ inReplyTo: mine.id, leadThreadId: "thr_lead1", author: "thr_lead1", audience: "grok-bot" });
    expect((await fake.run(["reply", "PIXEL", "not", "mine", "--to", theirs.id], "thr_lead1")).exitCode).not.toBe(0);
    expect((await fake.run(["reply", "PIXEL", "news"], "thr_lead1")).exitCode).not.toBe(0);
    expect((await fake.run(["reply", "PIXEL", "done", "--to", mine.id], "thr_worker")).exitCode).not.toBe(0);
    expect((await fake.run(["reply", "PIXEL", "also", "--to", mine.id], "thr_lead2")).exitCode).toBe(0);
  });

  it("an agent that only reads follows from then on, and a mistyped name can be forgotten", async () => {
    const fake = boot();
    fake.addThread("thr_lead1");
    await fake.run(["lead", "PIXEL"], "thr_lead1");
    await fake.run(["send", "PIXEL", "hello", "--as", "grok-bot"]);
    const before = (await fake.run(["reply", "PIXEL", "old", "news", "--json"], "thr_lead1")).json();
    setSystemTime(new Date(Date.now() + 1_000));
    const nobody = await fake.run(["reply", "PIXEL", "psst", "--for", "dots"], "thr_lead1");
    expect(nobody.exitCode).not.toBe(0);
    expect(nobody.stderr ?? nobody.stdout).toContain("No agent called dots");

    expect(ids(await fake.run(["replies", "PIXEL", "--as", "dots", "--json"]))).toEqual([]);
    setSystemTime(new Date(Date.now() + 1_000));
    const after = (await fake.run(["reply", "PIXEL", "new", "news", "--json"], "thr_lead1")).json();
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "dots", "--json"]))).toEqual([after.id]);
    expect(ids(await fake.run(["replies", "PIXEL", "--as", "grok-bot", "--json"]))).toEqual([before.id, after.id]);

    setSystemTime(new Date(Date.now() + 1_000));
    await fake.run(["replies", "PIXEL", "--as", "grokbot"]);
    const listed = (await fake.run(["consumers", "PIXEL", "--json"])).json();
    expect(listed.consumers.map((consumer: { name: string; repliesPending: number }) => [consumer.name, consumer.repliesPending])).toEqual([
      ["grok-bot", 2],
      ["dots", 1],
      ["grokbot", 0],
    ]);
    expect((await fake.run(["consumers", "PIXEL", "--forget", "grokbot"], "thr_lead1")).exitCode).not.toBe(0);
    const forgot = (await fake.run(["consumers", "PIXEL", "--forget", "dots", "--json"])).json();
    expect(forgot).toMatchObject({ forgot: "dots", cleared: 1 });
    expect(forgot.consumers.map((consumer: { name: string }) => consumer.name)).toEqual(["grok-bot", "grokbot"]);
    expect((await fake.run(["consumers", "PIXEL", "--forget", "dots"])).exitCode).not.toBe(0);
    expect((await fake.run(["send", "PIXEL", "x", "--as", "bad name!"])).exitCode).not.toBe(0);
    expect((await fake.run(["send", "PIXEL", "x", "--as", "dots", "--source", "grok-bot"])).exitCode).not.toBe(0);
    const unknownTo = await fake.run(["reply", "PIXEL", "x", "--to", (await fake.run(["requests", "PIXEL", "--json"])).json().requests[0].id, "--for", "dots"], "thr_lead1");
    expect(unknownTo.stderr ?? unknownTo.stdout).toContain("Drop --for");
  });
});
