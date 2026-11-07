import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { NOTES_MAX, type InboxItem, type ProjectMeta, type ProjectNotes } from "./meta";

const INBOX_LIMIT = 30;
const FOLLOW_EVERY_MS = 5 * 60_000;
const TICK_MS = 60_000;
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

export function inboxPrompt(prefix: string, source: string, text: string, ref: string | null): string {
  return [`[Outer loop · ${source}] ${prefix}`, "", text.trim(), ...(ref ? ["", `Ref: ${ref}`] : [])].join("\n");
}

export function createLoop(bb: BbPluginApi, deps: LoopDeps) {
  const notesKey = (projectId: string) => `notes:${projectId}`;
  const inboxKey = (projectId: string) => `inbox:${projectId}`;
  const followedKey = (projectId: string) => `followed:${projectId}`;

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

  async function readInbox(projectId: string): Promise<InboxItem[]> {
    return (await bb.storage.kv.get<InboxItem[]>(inboxKey(projectId))) ?? [];
  }

  async function deliver(threadId: string, text: string): Promise<"sent" | "queued"> {
    const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
    return sent.delivery === "queued" ? "queued" : "sent";
  }

  async function send(lead: Lead, source: string, text: string, ref: string | null): Promise<InboxItem> {
    if (!lead.meta.leadThreadId) throw new Error(`${lead.prefix} has no project lead. Set one with bb projects lead ${lead.prefix}.`);
    let delivery: InboxItem["delivery"] = "failed";
    try {
      delivery = await deliver(lead.meta.leadThreadId, inboxPrompt(lead.prefix, source, text, ref));
    } finally {
      const item: InboxItem = { at: new Date().toISOString(), source, text: text.trim().slice(0, 2000), ref, delivery };
      await bb.storage.kv.set(inboxKey(lead.projectId), [item, ...(await readInbox(lead.projectId))].slice(0, INBOX_LIMIT));
      bb.rpc.experimental_invalidate([`inbox:${lead.projectId}`]);
    }
    return (await readInbox(lead.projectId))[0]!;
  }

  async function leadIsBusy(threadId: string): Promise<boolean> {
    const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
    if (!thread) return true;
    return thread.archivedAt !== null || thread.runtime.displayStatus !== "idle" || thread.queuedWork !== "none" || thread.hasPendingInteraction;
  }

  async function sweep(lead: Lead, now: Date) {
    const threadId = lead.meta.leadThreadId!;
    if (await leadIsBusy(threadId)) return;
    await deps.writeMeta(lead.projectId, { sweepLastAt: now.toISOString() });
    await deliver(threadId, sweepPrompt(lead.prefix));
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
    const seen = new Set((await bb.storage.kv.get<string[]>(followedKey(lead.projectId))) ?? []);
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
    await bb.storage.kv.set(followedKey(lead.projectId), [...seen].slice(-2000));
  }

  const lastFollow = new Map<string, number>();

  async function tick() {
    const now = new Date();
    for (const lead of await deps.leads()) {
      if (!lead.meta.leadThreadId) continue;
      try {
        if (sweepDue(lead.meta, now)) await sweep(lead, now);
      } catch (cause) {
        bb.log.warn(`Sweep for ${lead.prefix} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (!lead.meta.followPrs || now.getTime() - (lastFollow.get(lead.projectId) ?? 0) < FOLLOW_EVERY_MS) continue;
      lastFollow.set(lead.projectId, now.getTime());
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
        await tick();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TICK_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  });

  return { readNotes, writeNotes, readInbox, send };
}
