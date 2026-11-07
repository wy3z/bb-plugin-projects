import { z } from "zod";

export const SEARCH_LIMIT_PER_GROUP = "50";

const searchGroupSchema = z
  .object({
    total: z.number(),
    results: z.array(
      z
        .object({
          thread: z.object({ id: z.string() }).passthrough(),
          matches: z.array(z.object({ sourceKind: z.string(), text: z.string() }).passthrough()),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const searchResponseSchema = z.object({ active: searchGroupSchema, archived: searchGroupSchema }).passthrough();

export const queueResponseSchema = z.array(
  z
    .object({
      id: z.string(),
      state: z.string(),
      content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
      waitingOn: z.object({ kind: z.string() }).passthrough().nullable().optional(),
      failureReason: z.string().nullable().optional(),
    })
    .passthrough(),
);

export type Sighting =
  | { kind: "landed" }
  | { kind: "queued"; queuedId: string; state: string }
  | { kind: "stranded"; queuedId: string; reason: string }
  | { kind: "absent" };

export type ProbeApi = {
  queued: (threadId: string) => Promise<unknown>;
  search: (query: string, limitPerGroup: string) => Promise<unknown>;
};

export class ProbeShapeError extends Error {
  constructor(what: string, issues: z.ZodError) {
    super(`unexpected ${what} response shape (${issues.issues.map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`).slice(0, 3).join("; ")})`);
    this.name = "ProbeShapeError";
  }
}

export function searchToken(requestId: string): string {
  const token = requestId.slice(requestId.indexOf("_") + 1);
  if (!/^[\p{L}\p{N}]+$/u.test(token)) throw new Error(`Request id ${requestId} has no single search token.`);
  return token;
}

export function readQueue(threadId: string, requestId: string, raw: unknown): Sighting | null {
  const parsed = queueResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProbeShapeError("queued messages", parsed.error);
  const row = parsed.data.find((item) => item.content.some((part) => part.type === "text" && (part.text ?? "").includes(requestId)));
  if (!row) return null;
  if (row.state === "failed_exhausted") return { kind: "stranded", queuedId: row.id, reason: `BB stopped retrying it in ${threadId}'s queue${row.failureReason ? `: ${row.failureReason}` : ""}` };
  if (row.waitingOn?.kind === "superseded") return { kind: "stranded", queuedId: row.id, reason: `it was superseded in ${threadId}'s queue and BB will not send it` };
  return { kind: "queued", queuedId: row.id, state: row.state };
}

export function readSearch(threadId: string, raw: unknown): boolean {
  const parsed = searchResponseSchema.safeParse(raw);
  if (!parsed.success) throw new ProbeShapeError("thread search", parsed.error);
  return [parsed.data.active, parsed.data.archived].some((group) => group.results.some((result) => result.thread.id === threadId && result.matches.length > 0));
}

export async function sight(api: ProbeApi, threadId: string, requestId: string): Promise<Sighting> {
  const inQueue = readQueue(threadId, requestId, await api.queued(threadId));
  if (inQueue) return inQueue;
  return readSearch(threadId, await api.search(searchToken(requestId), SEARCH_LIMIT_PER_GROUP)) ? { kind: "landed" } : { kind: "absent" };
}
