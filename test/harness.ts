import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMailbox, MIGRATIONS, type SqlDb } from "../src/mailbox";
import { createCourier, type CourierDeps, type LeadState } from "../src/courier";
import type { WakeBody } from "../src/transport";

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

export function world(db: SqlDb, clock: Clock) {
  const leads = new Map<string, string | null>([["proj_pixel", "thr_lead1"]]);
  const threads = new Map<string, LeadState>([["thr_lead1", "ok"]]);
  const sent: Sent[] = [];
  const wakes: WakeBody[] = [];
  const logs: string[] = [];
  const faults = { send: 0, leadOf: 0, probe: 0, wake: 0, sendHangs: null as null | Promise<void> };
  const landed = new Set<string>();
  let transportOn = true;

  const mailbox = createMailbox(() => db, clock.now);
  const deps: CourierDeps = {
    mailbox,
    leadOf: async (projectId) => {
      if (faults.leadOf > 0) {
        faults.leadOf--;
        throw new Error("tasks rpc unavailable");
      }
      return leads.get(projectId) ?? null;
    },
    leadState: async (threadId) => threads.get(threadId) ?? "missing",
    sendToThread: async (threadId, text) => {
      if (faults.sendHangs) await faults.sendHangs;
      if (faults.send > 0) {
        faults.send--;
        throw new Error("thread send rejected");
      }
      sent.push({ threadId, text });
      const id = /Request (req_[0-9a-f]+)/.exec(text)?.[1];
      if (id) landed.add(`${threadId}:${id}`);
      return "sent";
    },
    alreadyDelivered: async (threadId, requestId) => {
      if (faults.probe > 0) {
        faults.probe--;
        throw new Error("search unavailable");
      }
      return landed.has(`${threadId}:${requestId}`);
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
    sent,
    wakes,
    logs,
    faults,
    landed,
    setTransport(on: boolean) {
      transportOn = on;
    },
  };
}

export const pixel = { projectId: "proj_pixel", prefix: "PIXEL" };
