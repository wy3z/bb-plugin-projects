import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { NOTES_MAX, type ProjectMeta, type ProjectNotes } from "./meta";
import { sleep } from "./sleep";

const FOLLOW_EVERY_MS = 5 * 60_000;
const TICK_MS = 60_000;
const SWEEP_RETRY_MS = 5 * 60_000;
const FAMILY_DEPTH = 4;
const PULL_REQUESTS = "pull-requests";

type Lead = { projectId: string; prefix: string; meta: ProjectMeta };

type LoopDeps = {
  leads: () => Promise<Lead[]>;
  writeMeta: (projectId: string, change: Partial<ProjectMeta>) => Promise<ProjectMeta>;
};

export function inWorkingHours(date: Date): boolean {
  const day = date.getDay();
  const hour = date.getHours();
  return day >= 1 && day <= 5 && hour >= 8 && hour < 19;
}

export function sweepDue(meta: ProjectMeta, now: Date): boolean {
  if (!meta.leadThreadId || meta.sweepMinutes === null) return false;
  if (meta.sweepWorkingHours && !inWorkingHours(now)) return false;
  const last = meta.sweepLastAt ? Date.parse(meta.sweepLastAt) : 0;
  return now.getTime() - last >= meta.sweepMinutes * 60_000;
}

export function sweepPrompt(prefix: string): string {
  return [
    `[Scheduled sweep] ${prefix}`,
    "",
    `Sweep the ${prefix} board: workers that stalled or failed, pull requests waiting on review, failing checks or conflicts, and cards in the wrong column. Fix what you can now.`,
    "Notify me only if something needs me or finished. Otherwise end with one line saying the board is clean.",
  ].join("\n");
}

export type LeadStatus = "idle" | "busy" | "missing" | "archived";

export function leadStatusOf(thread: { archivedAt: unknown; runtime: { displayStatus: string }; queuedWork: string; hasPendingInteraction: boolean } | undefined): LeadStatus {
  if (!thread) return "missing";
  if (thread.archivedAt !== null && thread.archivedAt !== undefined) return "archived";
  return thread.runtime.displayStatus !== "idle" || thread.queuedWork !== "none" || thread.hasPendingInteraction ? "busy" : "idle";
}

export function createLoop(bb: BbPluginApi, deps: LoopDeps) {
  const notesKey = (projectId: string) => `notes:${projectId}`;
  const followedKey = (projectId: string, leadId: string) => `followed:${projectId}:${leadId}`;

  async function readNotes(projectId: string): Promise<ProjectNotes> {
    const stored = await bb.storage.kv.get<ProjectNotes>(notesKey(projectId));
    return { text: stored?.text ?? "", updatedAt: stored?.updatedAt ?? null };
  }

  async function writeNotes(projectId: string, text: string): Promise<ProjectNotes> {
    if (text.length > NOTES_MAX) throw new Error(`Project notes are limited to ${NOTES_MAX} characters.`);
    const next = { text, updatedAt: new Date().toISOString() };
    await bb.storage.kv.set(notesKey(projectId), next);
    bb.rpc.experimental_invalidate([`notes:${projectId}`]);
    return next;
  }

  async function deliver(threadId: string, text: string): Promise<"sent" | "queued"> {
    const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    return sent.delivery === "queued" ? "queued" : "sent";
  }

  async function leadStatus(threadId: string): Promise<LeadStatus> {
    const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
    return leadStatusOf(thread);
  }

  const sweepRetryAt = new Map<string, number>();
  const reported = new Map<string, LeadStatus>();

  async function sweep(lead: Lead, now: Date) {
    const threadId = lead.meta.leadThreadId!;
    if ((sweepRetryAt.get(lead.projectId) ?? 0) > now.getTime()) return;
    const status = await leadStatus(threadId);
    const reportKey = `${lead.projectId}:${threadId}`;
    if (status === "missing" || status === "archived") {
      if (reported.get(reportKey) !== status) bb.log.warn(`Sweep for ${lead.prefix} skipped: the lead thread ${threadId} is ${status}.`);
      reported.set(reportKey, status);
      return;
    }
    reported.delete(reportKey);
    if (status === "busy") return;
    try {
      await deliver(threadId, sweepPrompt(lead.prefix));
    } catch (cause) {
      sweepRetryAt.set(lead.projectId, now.getTime() + SWEEP_RETRY_MS);
      throw cause;
    }
    sweepRetryAt.delete(lead.projectId);
    await deps.writeMeta(lead.projectId, { sweepLastAt: now.toISOString() });
  }

  async function family(rootId: string): Promise<string[]> {
    const found: string[] = [];
    let frontier = [rootId];
    for (let depth = 0; depth < FAMILY_DEPTH && frontier.length; depth++) {
      const next: string[] = [];
      for (const parentThreadId of frontier) {
        const threads = await bb.sdk.threads.list({ parentThreadId, includeHidden: true });
        for (const thread of threads) {
          found.push(thread.id);
          next.push(thread.id);
        }
      }
      frontier = next;
    }
    return found;
  }

  async function follow(lead: Lead) {
    const leadId = lead.meta.leadThreadId!;
    const seen = new Set((await bb.storage.kv.get<string[]>(followedKey(lead.projectId, leadId))) ?? []);
    const fresh = new Set<string>();
    for (const threadId of await family(leadId)) {
      const { urls } = await bb.sdk.plugins.callRpc({
        pluginId: PULL_REQUESTS,
        method: "linked_list",
        input: { threadId },
        outputSchema: z.object({ urls: z.array(z.string()) }),
      });
      for (const url of urls) if (!seen.has(url.toLowerCase())) fresh.add(url);
    }
    if (!fresh.size) return;
    const urls = [...fresh].slice(0, 50);
    await bb.sdk.plugins.callRpc({
      pluginId: PULL_REQUESTS,
      method: "subscribe",
      input: { threadId: leadId, urls },
      outputSchema: z.unknown(),
    });
    for (const url of urls) seen.add(url.toLowerCase());
    await bb.storage.kv.set(followedKey(lead.projectId, leadId), [...seen].slice(-2000));
  }

  const lastFollow = new Map<string, number>();

  async function tick() {
    const now = new Date();
    let leads: Lead[];
    try {
      leads = await deps.leads();
    } catch (cause) {
      bb.log.warn(`Outer loop could not list project leads: ${cause instanceof Error ? cause.message : String(cause)}`);
      return;
    }
    for (const lead of leads) {
      if (!lead.meta.leadThreadId) continue;
      try {
        if (sweepDue(lead.meta, now)) await sweep(lead, now);
      } catch (cause) {
        bb.log.warn(`Sweep for ${lead.prefix} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      const followKey = `${lead.projectId}:${lead.meta.leadThreadId}`;
      if (!lead.meta.followPrs || now.getTime() - (lastFollow.get(followKey) ?? 0) < FOLLOW_EVERY_MS) continue;
      lastFollow.set(followKey, now.getTime());
      try {
        await follow(lead);
      } catch (cause) {
        bb.log.warn(`Following ${lead.prefix} pull requests failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }

  bb.background.service("outer-loop", {
    async start(signal) {
      while (!signal.aborted) {
        await tick().catch((cause) => bb.log.warn(`Outer loop tick failed: ${cause instanceof Error ? cause.message : String(cause)}`));
        await sleep(TICK_MS, signal);
      }
    },
  });

  return { readNotes, writeNotes, leadStatus };
}
