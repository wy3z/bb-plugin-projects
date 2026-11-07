import { createHash, randomBytes } from "node:crypto";

export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
}

export const MIGRATIONS = [
  `CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    prefix TEXT NOT NULL,
    source TEXT NOT NULL,
    text TEXT NOT NULL,
    ref TEXT,
    idem_key TEXT,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    lease_until INTEGER,
    target_thread_id TEXT,
    delivered_at INTEGER,
    delivery TEXT,
    last_error TEXT
  );
  CREATE UNIQUE INDEX requests_idem ON requests(project_id, idem_key) WHERE idem_key IS NOT NULL;
  CREATE INDEX requests_due ON requests(state, next_attempt_at);
  CREATE INDEX requests_project ON requests(project_id, created_at);
  CREATE TABLE replies (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    prefix TEXT NOT NULL,
    lead_thread_id TEXT,
    in_reply_to TEXT,
    kind TEXT NOT NULL,
    author TEXT NOT NULL,
    text TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    acked_at INTEGER
  );
  CREATE UNIQUE INDEX replies_idem ON replies(project_id, idem_key);
  CREATE INDEX replies_pending ON replies(acked_at, seq);
  CREATE TABLE wake (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    wanted INTEGER NOT NULL DEFAULT 0,
    sent INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    lease_until INTEGER,
    last_sent_at INTEGER,
    last_error TEXT
  );
  INSERT INTO wake (id) VALUES (1);`,
  `ALTER TABLE requests ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE requests ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE requests ADD COLUMN confirmed_at INTEGER;
  ALTER TABLE requests ADD COLUMN checked_at INTEGER;
  ALTER TABLE requests ADD COLUMN check_misses INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE requests ADD COLUMN failed_at INTEGER;
  UPDATE requests SET confirmed_at = COALESCE(delivered_at, created_at) WHERE state = 'delivered';
  CREATE INDEX requests_unconfirmed ON requests(state, confirmed_at, checked_at);`,
];

export const REQUEST_TEXT_MAX = 8000;
export const REPLY_TEXT_MAX = 4000;
export const KEY_MAX = 200;
export const REPLY_KINDS = ["result", "question", "blocker", "update"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number] | "notice" | "failure";
export type RequestState = "pending" | "delivering" | "delivered" | "held" | "abandoned" | "failed";

export const CONTENT_DEDUPE_MS = 10 * 60_000;
export const MAX_FAILURES = 10;
export const CHECK_EVERY_MS = 2 * 60_000;
export const MISSES_BEFORE_FAILING = 2;
export const RETENTION_MS = 90 * 24 * 60 * 60_000;
export const LEASE_MS = 5 * 60_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 15 * 60_000;
export const HOLD_RECHECK_MS = 5 * 60_000;

export type Request = {
  id: string;
  projectId: string;
  prefix: string;
  source: string;
  text: string;
  ref: string | null;
  key: string | null;
  createdAt: number;
  state: RequestState;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | null;
  targetThreadId: string | null;
  deliveredAt: number | null;
  delivery: "sent" | "queued" | "recovered" | null;
  lastError: string | null;
  failures: number;
  generation: number;
  confirmedAt: number | null;
  checkedAt: number | null;
  checkMisses: number;
  failedAt: number | null;
};

export type Reply = {
  seq: number;
  id: string;
  projectId: string;
  prefix: string;
  leadThreadId: string | null;
  inReplyTo: string | null;
  kind: ReplyKind;
  author: string;
  text: string;
  createdAt: number;
  ackedAt: number | null;
};

export type Wake = {
  wanted: number;
  sent: number;
  attempts: number;
  nextAttemptAt: number;
  leaseUntil: number | null;
  lastSentAt: number | null;
  lastError: string | null;
};

type Row = Record<string, unknown>;

const num = (value: unknown): number => Number(value);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const strOrNull = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function toRequest(row: Row): Request {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    prefix: String(row.prefix),
    source: String(row.source),
    text: String(row.text),
    ref: strOrNull(row.ref),
    key: strOrNull(row.idem_key),
    createdAt: num(row.created_at),
    state: row.state as RequestState,
    attempts: num(row.attempts),
    nextAttemptAt: num(row.next_attempt_at),
    leaseUntil: numOrNull(row.lease_until),
    targetThreadId: strOrNull(row.target_thread_id),
    deliveredAt: numOrNull(row.delivered_at),
    delivery: strOrNull(row.delivery) as Request["delivery"],
    lastError: strOrNull(row.last_error),
    failures: num(row.failures ?? 0),
    generation: num(row.generation ?? 0),
    confirmedAt: numOrNull(row.confirmed_at),
    checkedAt: numOrNull(row.checked_at),
    checkMisses: num(row.check_misses ?? 0),
    failedAt: numOrNull(row.failed_at),
  };
}

function toReply(row: Row): Reply {
  return {
    seq: num(row.seq),
    id: String(row.id),
    projectId: String(row.project_id),
    prefix: String(row.prefix),
    leadThreadId: strOrNull(row.lead_thread_id),
    inReplyTo: strOrNull(row.in_reply_to),
    kind: row.kind as ReplyKind,
    author: String(row.author),
    text: String(row.text),
    createdAt: num(row.created_at),
    ackedAt: numOrNull(row.acked_at),
  };
}

function toWake(row: Row): Wake {
  return {
    wanted: num(row.wanted),
    sent: num(row.sent),
    attempts: num(row.attempts),
    nextAttemptAt: num(row.next_attempt_at),
    leaseUntil: numOrNull(row.lease_until),
    lastSentAt: numOrNull(row.last_sent_at),
    lastError: strOrNull(row.last_error),
  };
}

export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export function newId(prefix: "req" | "rep"): string {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

export function sha(...parts: (string | null)[]): string {
  return createHash("sha256").update(parts.map((part) => part ?? "\u0000").join("\u0001")).digest("hex");
}

export function cleanKey(raw: string | null | undefined): string | null {
  const key = raw?.trim() ?? "";
  if (!key) return null;
  if (key.length > KEY_MAX || /[\u0000-\u001f]/.test(key)) throw new Error(`Idempotency keys are 1-${KEY_MAX} printable characters.`);
  return key;
}

export type EnqueueInput = { projectId: string; prefix: string; source: string; text: string; ref: string | null; key: string | null };
export type ReplyInput = {
  projectId: string;
  prefix: string;
  leadThreadId: string | null;
  inReplyTo: string | null;
  kind: ReplyKind;
  author: string;
  text: string;
  key: string | null;
};

export function createMailbox(db: () => SqlDb, clock: () => number = Date.now) {
  const getRequest = (id: string): Request | null => {
    const row = db().prepare("SELECT * FROM requests WHERE id = ?").get(id) as Row | null | undefined;
    return row ? toRequest(row) : null;
  };

  const getReply = (id: string): Reply | null => {
    const row = db().prepare("SELECT * FROM replies WHERE id = ?").get(id) as Row | null | undefined;
    return row ? toReply(row) : null;
  };

  function enqueue(input: EnqueueInput): { request: Request; duplicate: boolean; dedupedBy: "key" | "content" | null } {
    const now = clock();
    const hash = sha(input.source, input.text, input.ref);
    return db().transaction(() => {
      const existing = (
        input.key
          ? db().prepare("SELECT * FROM requests WHERE project_id = ? AND idem_key = ?").get(input.projectId, input.key)
          : db()
              .prepare("SELECT * FROM requests WHERE project_id = ? AND idem_key IS NULL AND content_hash = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 1")
              .get(input.projectId, hash, now - CONTENT_DEDUPE_MS)
      ) as Row | null | undefined;
      if (existing) return { request: toRequest(existing), duplicate: true, dedupedBy: input.key ? ("key" as const) : ("content" as const) };
      const id = newId("req");
      db()
        .prepare(
          "INSERT INTO requests (id, project_id, prefix, source, text, ref, idem_key, content_hash, created_at, state, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        )
        .run(id, input.projectId, input.prefix, input.source, input.text, input.ref, input.key, hash, now, now);
      return { request: getRequest(id)!, duplicate: false, dedupedBy: null };
    })();
  }

  function claim(id: string, leaseMs = LEASE_MS): Request | null {
    const now = clock();
    const changed = db()
      .prepare(
        "UPDATE requests SET state = 'delivering', attempts = attempts + 1, lease_until = ? WHERE id = ? AND state IN ('pending', 'held') AND next_attempt_at <= ?",
      )
      .run(now + leaseMs, id, now).changes;
    return Number(changed) === 1 ? getRequest(id) : null;
  }

  function dueRequestIds(limit = 20): string[] {
    const rows = db()
      .prepare("SELECT id FROM requests WHERE state IN ('pending', 'held') AND next_attempt_at <= ? ORDER BY created_at LIMIT ?")
      .all(clock(), limit) as Row[];
    return rows.map((row) => String(row.id));
  }

  function expiredLeases(): Request[] {
    const rows = db().prepare("SELECT * FROM requests WHERE state = 'delivering' AND lease_until < ? ORDER BY created_at").all(clock()) as Row[];
    return rows.map(toRequest);
  }

  function setTarget(id: string, threadId: string): void {
    db().prepare("UPDATE requests SET target_thread_id = ? WHERE id = ? AND state = 'delivering'").run(threadId, id);
  }

  function markDelivered(id: string, delivery: "sent" | "queued" | "recovered"): void {
    const now = clock();
    db()
      .prepare(
        "UPDATE requests SET state = 'delivered', delivery = ?, delivered_at = ?, confirmed_at = ?, checked_at = NULL, check_misses = 0, failures = 0, lease_until = NULL, last_error = NULL WHERE id = ? AND state = 'delivering'",
      )
      .run(delivery, now, delivery === "queued" ? null : now, id);
  }

  function failRequest(id: string, reason: string): boolean {
    return db().transaction(() => {
      const row = getRequest(id);
      if (!row || (row.state !== "delivering" && row.state !== "delivered" && row.state !== "pending")) return false;
      const now = clock();
      db()
        .prepare("UPDATE requests SET state = 'failed', failed_at = ?, lease_until = NULL, last_error = ? WHERE id = ?")
        .run(now, reason.slice(0, 300), id);
      addReply({
        projectId: row.projectId,
        prefix: row.prefix,
        leadThreadId: row.targetThreadId,
        inReplyTo: row.id,
        kind: "failure",
        author: "projects",
        text: `Request ${row.id} did not reach the ${row.prefix} lead: ${reason.slice(0, 300)}. It will not be retried automatically. Retry it with: bb projects retry ${row.prefix} ${row.id}`,
        key: `failed:${row.id}:${row.generation}`,
      });
      return true;
    })();
  }

  function markRetry(id: string, error: string): "retry" | "failed" | "gone" {
    const row = getRequest(id);
    if (!row || row.state !== "delivering") return "gone";
    const failures = row.failures + 1;
    if (failures >= MAX_FAILURES) {
      db().prepare("UPDATE requests SET failures = ? WHERE id = ?").run(failures, id);
      failRequest(id, `${failures} attempts failed, last: ${error}`);
      return "failed";
    }
    db()
      .prepare("UPDATE requests SET state = 'pending', failures = ?, next_attempt_at = ?, lease_until = NULL, last_error = ? WHERE id = ? AND state = 'delivering'")
      .run(failures, clock() + backoffMs(failures), error.slice(0, 300), id);
    return "retry";
  }

  function unconfirmedDue(limit = 20): Request[] {
    const rows = db()
      .prepare("SELECT * FROM requests WHERE state = 'delivered' AND confirmed_at IS NULL AND (checked_at IS NULL OR checked_at <= ?) ORDER BY delivered_at LIMIT ?")
      .all(clock() - CHECK_EVERY_MS, limit) as Row[];
    return rows.map(toRequest);
  }

  function confirm(id: string): void {
    db().prepare("UPDATE requests SET confirmed_at = ?, checked_at = ?, check_misses = 0, failures = 0, last_error = NULL WHERE id = ? AND state = 'delivered'").run(clock(), clock(), id);
  }

  function stillQueued(id: string): void {
    db().prepare("UPDATE requests SET checked_at = ?, check_misses = 0, failures = 0, last_error = NULL WHERE id = ? AND state = 'delivered'").run(clock(), id);
  }

  function checkMissed(id: string, reason: string): "waiting" | "failed" {
    const row = getRequest(id);
    if (!row || row.state !== "delivered") return "waiting";
    const misses = row.checkMisses + 1;
    if (misses >= MISSES_BEFORE_FAILING) {
      db().prepare("UPDATE requests SET check_misses = ? WHERE id = ?").run(misses, id);
      failRequest(id, reason);
      return "failed";
    }
    db().prepare("UPDATE requests SET check_misses = ?, checked_at = ?, last_error = ? WHERE id = ? AND state = 'delivered'").run(misses, clock(), reason.slice(0, 300), id);
    return "waiting";
  }

  function checkFailed(id: string, error: string): "waiting" | "failed" {
    const row = getRequest(id);
    if (!row || row.state !== "delivered") return "waiting";
    const failures = row.failures + 1;
    if (failures >= MAX_FAILURES) {
      db().prepare("UPDATE requests SET failures = ? WHERE id = ?").run(failures, id);
      failRequest(id, `could not confirm the queued delivery after ${failures} checks, last: ${error}`);
      return "failed";
    }
    db().prepare("UPDATE requests SET failures = ?, checked_at = ?, last_error = ? WHERE id = ? AND state = 'delivered'").run(failures, clock(), error.slice(0, 300), id);
    return "waiting";
  }

  function reopen(id: string, reason: string): boolean {
    return (
      Number(
        db()
          .prepare(
            "UPDATE requests SET state = 'pending', delivery = NULL, delivered_at = NULL, confirmed_at = NULL, checked_at = NULL, check_misses = 0, next_attempt_at = ?, last_error = ? WHERE id = ? AND state = 'delivered' AND confirmed_at IS NULL",
          )
          .run(clock(), reason.slice(0, 300), id).changes,
      ) === 1
    );
  }

  function retry(projectId: string, id: string): { outcome: "requeued" | "unknown" | "not-retryable"; request: Request | null } {
    return db().transaction(() => {
      const row = getRequest(id);
      if (!row || row.projectId !== projectId) return { outcome: "unknown" as const, request: null };
      if (row.state !== "failed" && row.state !== "held" && row.state !== "pending") return { outcome: "not-retryable" as const, request: row };
      db()
        .prepare(
          "UPDATE requests SET state = 'pending', failures = 0, check_misses = 0, failed_at = NULL, delivery = NULL, delivered_at = NULL, confirmed_at = NULL, checked_at = NULL, next_attempt_at = ?, generation = generation + 1, last_error = NULL WHERE id = ?",
        )
        .run(clock(), id);
      return { outcome: "requeued" as const, request: getRequest(id) };
    })();
  }

  function prune(retentionMs = RETENTION_MS): { requests: number; replies: number } {
    const cutoff = clock() - retentionMs;
    return db().transaction(() => {
      const replies = Number(db().prepare("DELETE FROM replies WHERE acked_at IS NOT NULL AND acked_at < ?").run(cutoff).changes);
      const requests = Number(
        db()
          .prepare(
            "DELETE FROM requests WHERE created_at < ? AND (state IN ('abandoned', 'failed') OR (state = 'delivered' AND confirmed_at IS NOT NULL)) AND id NOT IN (SELECT in_reply_to FROM replies WHERE in_reply_to IS NOT NULL AND acked_at IS NULL)",
          )
          .run(cutoff).changes,
      );
      return { requests, replies };
    })();
  }

  function markHeld(id: string, reason: string): boolean {
    const row = getRequest(id);
    if (!row || row.state !== "delivering") return false;
    db()
      .prepare("UPDATE requests SET state = 'held', next_attempt_at = ?, lease_until = NULL, last_error = ? WHERE id = ? AND state = 'delivering'")
      .run(clock() + HOLD_RECHECK_MS, reason, id);
    return true;
  }

  function requeue(id: string): boolean {
    const now = clock();
    return Number(
      db().prepare("UPDATE requests SET state = 'pending', lease_until = NULL, next_attempt_at = ? WHERE id = ? AND state = 'delivering' AND lease_until < ?").run(now, id, now).changes,
    ) === 1;
  }

  function extendLease(id: string, leaseMs = LEASE_MS): void {
    db().prepare("UPDATE requests SET lease_until = ? WHERE id = ? AND state = 'delivering'").run(clock() + leaseMs, id);
  }

  function releaseHeld(projectId: string): number {
    const now = clock();
    return Number(
      db().prepare("UPDATE requests SET next_attempt_at = ? WHERE project_id = ? AND state IN ('held', 'pending') AND next_attempt_at > ?").run(now, projectId, now).changes,
    );
  }

  function listRequests(projectId: string, limit = 30): Request[] {
    const rows = db().prepare("SELECT * FROM requests WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(projectId, limit) as Row[];
    return rows.map(toRequest);
  }

  function unconfirmedCount(projectId: string): number {
    return num((db().prepare("SELECT COUNT(*) AS n FROM requests WHERE project_id = ? AND state = 'delivered' AND confirmed_at IS NULL").get(projectId) as Row).n);
  }

  function requestCounts(projectId: string): Record<RequestState, number> {
    const rows = db().prepare("SELECT state, COUNT(*) AS n FROM requests WHERE project_id = ? GROUP BY state").all(projectId) as Row[];
    const counts: Record<RequestState, number> = { pending: 0, delivering: 0, delivered: 0, held: 0, abandoned: 0, failed: 0 };
    for (const row of rows) counts[row.state as RequestState] = num(row.n);
    return counts;
  }

  function addReply(input: ReplyInput): { reply: Reply; duplicate: boolean } {
    const key = input.key ?? sha(input.leadThreadId, input.inReplyTo, input.kind, input.text);
    return db().transaction(() => {
      const existing = db().prepare("SELECT * FROM replies WHERE project_id = ? AND idem_key = ?").get(input.projectId, key) as Row | null | undefined;
      if (existing) return { reply: toReply(existing), duplicate: true };
      const id = newId("rep");
      db()
        .prepare(
          "INSERT INTO replies (id, project_id, prefix, lead_thread_id, in_reply_to, kind, author, text, idem_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(id, input.projectId, input.prefix, input.leadThreadId, input.inReplyTo, input.kind, input.author, input.text, key, clock());
      db().prepare("UPDATE wake SET wanted = wanted + 1, next_attempt_at = MIN(next_attempt_at, ?) WHERE id = 1").run(clock());
      return { reply: getReply(id)!, duplicate: false };
    })();
  }

  function listReplies(opts: { projectId?: string | null; includeAcked?: boolean; limit?: number; afterSeq?: number; newestFirst?: boolean }): Reply[] {
    const where = ["seq > ?"];
    const params: unknown[] = [opts.afterSeq ?? 0];
    if (!opts.includeAcked) where.push("acked_at IS NULL");
    if (opts.projectId) {
      where.push("project_id = ?");
      params.push(opts.projectId);
    }
    params.push(Math.max(1, Math.min(opts.limit ?? 50, 200)));
    const rows = db().prepare(`SELECT * FROM replies WHERE ${where.join(" AND ")} ORDER BY seq ${opts.newestFirst ? "DESC" : "ASC"} LIMIT ?`).all(...params) as Row[];
    return rows.map(toReply);
  }

  function pendingCounts(): Record<string, number> {
    const rows = db().prepare("SELECT prefix, COUNT(*) AS n FROM replies WHERE acked_at IS NULL GROUP BY prefix").all() as Row[];
    return Object.fromEntries(rows.map((row) => [String(row.prefix), num(row.n)]));
  }

  function ack(projectId: string, ids: string[]): { acked: string[]; alreadyAcked: string[]; unknown: string[]; otherProject: string[] } {
    const out = { acked: [] as string[], alreadyAcked: [] as string[], unknown: [] as string[], otherProject: [] as string[] };
    db().transaction(() => {
      const now = clock();
      for (const id of [...new Set(ids)]) {
        const row = getReply(id);
        if (!row) out.unknown.push(id);
        else if (row.projectId !== projectId) out.otherProject.push(id);
        else if (row.ackedAt !== null) out.alreadyAcked.push(id);
        else {
          db().prepare("UPDATE replies SET acked_at = ? WHERE id = ? AND acked_at IS NULL").run(now, id);
          out.acked.push(id);
        }
      }
    })();
    return out;
  }

  function wake(): Wake {
    return toWake(db().prepare("SELECT * FROM wake WHERE id = 1").get() as Row);
  }

  function claimWake(leaseMs = 60_000): Wake | null {
    const now = clock();
    const changed = db()
      .prepare("UPDATE wake SET lease_until = ?, attempts = attempts + 1 WHERE id = 1 AND wanted > sent AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until < ?)")
      .run(now + leaseMs, now, now).changes;
    return Number(changed) === 1 ? wake() : null;
  }

  function wakeSent(version: number): void {
    db()
      .prepare("UPDATE wake SET sent = MAX(sent, ?), attempts = 0, lease_until = NULL, last_sent_at = ?, last_error = NULL, next_attempt_at = 0 WHERE id = 1")
      .run(version, clock());
  }

  function wakeFailed(error: string): void {
    const current = wake();
    db()
      .prepare("UPDATE wake SET lease_until = NULL, last_error = ?, next_attempt_at = ? WHERE id = 1")
      .run(error.slice(0, 300), clock() + backoffMs(current.attempts) * 2);
  }

  function wantWake(): void {
    db().prepare("UPDATE wake SET wanted = wanted + 1, next_attempt_at = MIN(next_attempt_at, ?) WHERE id = 1").run(clock());
  }

  function importLegacy(projectId: string, prefix: string, items: { at: string; source: string; text: string; ref: string | null; delivery: string }[]): number {
    let added = 0;
    db().transaction(() => {
      for (const item of items) {
        const at = Date.parse(item.at) || 0;
        const id = `req_legacy_${sha(projectId, item.at, item.text).slice(0, 20)}`;
        const delivered = item.delivery === "sent" || item.delivery === "queued";
        added += Number(
          db()
            .prepare(
              "INSERT OR IGNORE INTO requests (id, project_id, prefix, source, text, ref, idem_key, content_hash, created_at, state, next_attempt_at, delivered_at, delivery, last_error, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .run(id, projectId, prefix, item.source, item.text, item.ref, sha(item.source, item.text, item.ref), at, delivered ? "delivered" : "abandoned", at, delivered ? at : null, delivered ? item.delivery : null, delivered ? null : "legacy: delivery failed, not retried", delivered ? at : null)
            .changes,
        );
      }
    })();
    return added;
  }

  return {
    getRequest,
    getReply,
    enqueue,
    claim,
    dueRequestIds,
    expiredLeases,
    setTarget,
    markDelivered,
    markRetry,
    failRequest,
    unconfirmedDue,
    confirm,
    stillQueued,
    checkMissed,
    checkFailed,
    reopen,
    retry,
    prune,
    unconfirmedCount,
    markHeld,
    requeue,
    extendLease,
    releaseHeld,
    listRequests,
    requestCounts,
    addReply,
    listReplies,
    pendingCounts,
    ack,
    wake,
    claimWake,
    wakeSent,
    wakeFailed,
    wantWake,
    importLegacy,
  };
}

export type Mailbox = ReturnType<typeof createMailbox>;
