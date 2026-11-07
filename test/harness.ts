import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailbox, MIGRATIONS, type SqlDb } from "../src/mailbox";
import { createCourier, type CourierDeps, type LeadState } from "../src/courier";
import type { WakeBody } from "../src/transport";
import { sight, type ProbeApi } from "../src/probe";
import { capturedSearch, typedQueued, typedRelayEvent, typedSearch } from "../src/probe.fixtures";

export type TestDb = SqlDb & { close(): void };

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "bbp-mailbox-")), "data.db");
}

export function migrate(db: SqlDb, statements: string[] = MIGRATIONS): void {
  db.exec("CREATE TABLE IF NOT EXISTS _bb_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set((db.prepare("SELECT id FROM _bb_migrations").all() as { id: number }[]).map((row) => row.id));
  db.transaction(() => {
    statements.forEach((statement, index) => {
      if (applied.has(index)) return;
      db.exec(statement);
      db.prepare("INSERT INTO _bb_migrations (id, applied_at) VALUES (?, ?)").run(index, Date.now());
    });
  })();
}

export function openDb(path = ":memory:"): TestDb {
  const db = new Database(path) as unknown as TestDb;
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export class Clock {
  constructor(public t = Date.UTC(2026, 10, 10, 10)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

export type Sent = { threadId: string; text: string };
type QueueRow = { id: string; text: string; state: "queued" | "claimed" | "waiting" | "failed_exhausted" | "failed_retrying" | "scheduled"; waitingOn?: { kind: "superseded" } | { kind: "thread-busy" } | null };

export function world(db: SqlDb, clock: Clock) {
  const leads = new Map<string, string | null>([["proj_pixel", "thr_lead1"]]);
  const threads = new Map<string, LeadState>([["thr_lead1", "ok"]]);
  const busy = new Set<string>();
  const queues = new Map<string, QueueRow[]>();
  const timeline = new Map<string, { text: string; sender: string | null }[]>();
  const sent: Sent[] = [];
  const wakes: WakeBody[] = [];
  const logs: string[] = [];
  const faults = { send: 0, leadOf: 0, probe: 0, wake: 0, drop: 0, sendHangs: null as null | Promise<void>, shape: null as null | "search" | "queue", captured: false, dropDispatches: 0, leadState: 0 };
  let transportOn = true;
  let queuedSeq = 0;

  const landedIn = (threadId: string, text: string, sender: string | null = null) => timeline.set(threadId, [...(timeline.get(threadId) ?? []), { text, sender }]);
  const dispatch = (threadId: string) => {
    const rows = queues.get(threadId) ?? [];
    queues.set(threadId, rows.filter((row) => row.state === "failed_exhausted" || row.waitingOn?.kind === "superseded"));
    for (const row of rows) if (row.state !== "failed_exhausted" && row.waitingOn?.kind !== "superseded") landedIn(threadId, row.text);
  };

  const probeApi: ProbeApi = {
    queued: async (threadId) => {
      if ((threads.get(threadId) ?? "missing") === "missing") throw new Error(`HTTP 404: thread ${threadId} not found`);
      if (faults.probe > 0) {
        faults.probe--;
        throw new Error("queue list unavailable");
      }
      if (faults.shape === "queue") return { rows: queues.get(threadId) ?? [] };
      return typedQueued(threadId, queues.get(threadId) ?? []);
    },
    search: async (query, limitPerGroup) => {
      if (limitPerGroup !== "50") throw new Error(`limitPerGroup must be at most 50, got ${limitPerGroup}`);
      if (faults.shape === "search") return { results: [] };
      const hits = [...timeline.entries()].flatMap(([threadId, items]) => {
        const seq = items.findIndex((item) => item.text.includes(query));
        return seq < 0 ? [] : [{ threadId, archived: threads.get(threadId) === "archived", text: items[seq]!.text.slice(0, 160), seq: seq + 1 }];
      });
      if (faults.captured && hits[0]) return capturedSearch(hits[0].threadId, hits[0].text, "user_message", hits[0].seq);
      return typedSearch(hits.filter((hit) => threads.get(hit.threadId) !== "hidden"));
    },
    event: async (threadId, seq) => {
      const item = timeline.get(threadId)?.[seq - 1];
      return item ? typedRelayEvent(threadId, seq, item.text, item.sender) : [];
    },
  };

  const mailbox = createMailbox(() => db, clock.now);
  mailbox.touchConsumer("proj_pixel", "grok-bot");
  const deps: CourierDeps = {
    mailbox,
    leadOf: async (projectId) => {
      if (faults.leadOf > 0) {
        faults.leadOf--;
        throw new Error("tasks rpc unavailable");
      }
      return leads.get(projectId) ?? null;
    },
    leadState: async (threadId) => {
      if (faults.leadState > 0) {
        faults.leadState--;
        throw new Error("threads.list failed");
      }
      return threads.get(threadId) ?? "missing";
    },
    sendToThread: async (threadId, text) => {
      if (faults.sendHangs) await faults.sendHangs;
      if (faults.send > 0) {
        faults.send--;
        throw new Error("thread send rejected");
      }
      sent.push({ threadId, text });
      if (busy.has(threadId)) {
        queues.set(threadId, [...(queues.get(threadId) ?? []), { id: `qm_${++queuedSeq}`, text, state: "queued", waitingOn: { kind: "thread-busy" } }]);
        return "queued";
      }
      landedIn(threadId, text);
      return "sent";
    },
    sight: (threadId, requestId) => sight(probeApi, threadId, requestId),
    dropQueued: async (threadId, queuedId) => {
      if (faults.dropDispatches > 0) {
        faults.dropDispatches--;
        dispatch(threadId);
        throw new Error("queued message not found");
      }
      if (faults.drop > 0) {
        faults.drop--;
        throw new Error("queue delete failed");
      }
      queues.set(threadId, (queues.get(threadId) ?? []).filter((row) => row.id !== queuedId));
    },
    transport: async () =>
      transportOn
        ? async (body) => {
            if (faults.wake > 0) {
              faults.wake--;
              throw new Error("webhook answered HTTP 503");
            }
            wakes.push(body);
          }
        : null,
    remindMs: async () => 60 * 60_000,
    log: { warn: (message) => logs.push(`warn ${message}`), info: (message) => logs.push(`info ${message}`) },
    clock: clock.now,
  };
  const courier = createCourier(deps);
  return {
    mailbox,
    courier,
    deps,
    leads,
    threads,
    busy,
    queues,
    timeline,
    dispatch,
    landedIn,
    sent,
    wakes,
    logs,
    faults,
    setTransport(on: boolean) {
      transportOn = on;
    },
  };
}

export const pixel = { projectId: "proj_pixel", prefix: "PIXEL" };
