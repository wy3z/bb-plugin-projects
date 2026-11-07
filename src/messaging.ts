import { cliCommand, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { InboxItem, ProjectMeta } from "./meta";
import type { Project } from "./contracts";
import { cleanKey, createMailbox, MIGRATIONS, REPLY_KINDS, REPLY_TEXT_MAX, REQUEST_TEXT_MAX, type Reply, type Request, type SqlDb } from "./mailbox";
import { cleanRef, cleanSource, createCourier, type LeadState } from "./courier";
import { httpTransport } from "./transport";
import { sight } from "./probe";
import { sleep } from "./sleep";

const TICK_MS = 5_000;

type Deps = {
  resolveProject: (ref: string) => Promise<Project>;
  projects: () => Promise<Project[]>;
  readMeta: (projectId: string) => Promise<ProjectMeta>;
};

const json = { type: "boolean", description: "Emit JSON" } as const;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

export function createMessaging(bb: BbPluginApi, deps: Deps) {
  const settings = bb.settings.define({
    wakeEnabled: {
      type: "boolean",
      label: "Wake the outer loop by webhook",
      description: "POST a wake-up (counts and ids only, never message text) when a project lead replies. Off until the receiver's contract is confirmed.",
      default: false,
    },
    wakeUrl: { type: "string", label: "Webhook URL", description: "https only; http is accepted for a loopback test receiver.", secret: true },
    wakeHeaderName: { type: "string", label: "Auth header name", description: "Exactly as the receiver documents it. Leave empty if it needs none.", default: "" },
    wakeHeaderValue: { type: "string", label: "Auth header value", secret: true },
    wakeRemindMinutes: { type: "number", label: "Remind every (minutes)", description: "Wake again while replies stay unacknowledged.", default: 60 },
  });

  let migrated = false;
  const db = (): SqlDb => {
    const handle = bb.storage.database() as unknown as SqlDb;
    if (!migrated) {
      bb.storage.migrate(handle as never, MIGRATIONS);
      migrated = true;
    }
    return handle;
  };
  const mailbox = createMailbox(db);
  const poke: { wake: (() => void) | null } = { wake: null };

  async function leadState(threadId: string): Promise<LeadState> {
    const [thread] = await bb.sdk.threads.list({ threadIds: [threadId], includeHidden: true });
    if (!thread) return "missing";
    if (thread.archivedAt !== null && thread.archivedAt !== undefined) return "archived";
    return (thread as { visibility?: string }).visibility === "hidden" ? "hidden" : "ok";
  }

  const probeApi = {
    queued: (threadId: string) => bb.sdk.threads.queuedMessages.list({ threadId }) as Promise<unknown>,
    search: (query: string, limitPerGroup: string) => bb.sdk.threads.search({ query, limitPerGroup }) as Promise<unknown>,
  };

  const courier = createCourier({
    mailbox,
    leadOf: async (projectId) => (await deps.readMeta(projectId)).leadThreadId,
    leadState,
    sendToThread: async (threadId, text) => {
      const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] });
      return sent.delivery === "queued" ? "queued" : "sent";
    },
    sight: (threadId, requestId) => sight(probeApi, threadId, requestId),
    dropQueued: async (threadId, queuedId) => {
      await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: queuedId });
    },
    transport: async () => {
      const values = await settings.get();
      if (!values.wakeEnabled) return null;
      return httpTransport({ enabled: true, url: values.wakeUrl ?? null, headerName: values.wakeHeaderName || null, headerValue: values.wakeHeaderValue ?? null });
    },
    remindMs: async () => Math.max(15, Number((await settings.get()).wakeRemindMinutes) || 60) * 60_000,
    log: bb.log,
    changed: (projectId) => bb.rpc.experimental_invalidate(projectId ? [`inbox:${projectId}`] : ["leads"]),
  });

  async function importLegacy() {
    const keys = await bb.storage.kv.list("inbox:");
    if (!keys.length) return;
    const byId = new Map((await deps.projects()).map((project) => [project.id, project.prefix]));
    for (const key of keys) {
      const projectId = key.slice("inbox:".length);
      const items = (await bb.storage.kv.get<InboxItem[]>(key)) ?? [];
      const added = mailbox.importLegacy(projectId, byId.get(projectId) ?? projectId, items);
      if (added) bb.log.info(`Imported ${added} earlier outer-loop messages for ${byId.get(projectId) ?? projectId}; they are history and are not redelivered.`);
    }
  }

  bb.background.service("pm-mailbox", {
    async start(signal) {
      await importLegacy().catch((cause) => bb.log.warn(`Importing the earlier outer-loop inbox failed: ${cause instanceof Error ? cause.message : String(cause)}`));
      while (!signal.aborted) {
        await courier.tick();
        await sleep(TICK_MS, signal, poke);
      }
    },
  });

  function leadChanged(projectId: string) {
    mailbox.releaseHeld(projectId);
    poke.wake?.();
  }

  function inboxItems(projectId: string): InboxItem[] {
    return mailbox.listRequests(projectId, 30).map((request) => ({
      at: new Date(request.createdAt).toISOString(),
      source: request.source,
      text: request.text.slice(0, 2000),
      ref: request.ref,
      delivery:
        request.state === "delivered"
          ? request.delivery === "queued"
            ? "queued"
            : "sent"
          : request.state === "held" || request.state === "abandoned" || request.state === "failed" || request.lastError
            ? "failed"
            : "queued",
    }));
  }

  function requestView(request: Request) {
    return {
      id: request.id,
      project: request.prefix,
      source: request.source,
      ref: request.ref,
      key: request.key,
      createdAt: iso(request.createdAt),
      state: request.state,
      delivery: request.delivery,
      deliveredTo: request.state === "delivered" ? request.targetThreadId : null,
      deliveredAt: iso(request.deliveredAt),
      attempts: request.attempts,
      nextAttemptAt: request.state === "pending" || request.state === "held" ? iso(request.nextAttemptAt) : null,
      lastError: request.lastError,
      failures: request.failures,
      confirmedAt: iso(request.confirmedAt),
      failedAt: iso(request.failedAt),
    };
  }

  function replyView(reply: Reply) {
    const request = reply.inReplyTo ? mailbox.getRequest(reply.inReplyTo) : null;
    return {
      id: reply.id,
      project: reply.prefix,
      leadThreadId: reply.leadThreadId,
      inReplyTo: reply.inReplyTo,
      request: request ? { id: request.id, source: request.source, ref: request.ref, key: request.key, createdAt: iso(request.createdAt) } : null,
      kind: reply.kind,
      author: reply.author,
      text: reply.text,
      createdAt: iso(reply.createdAt),
      ackedAt: iso(reply.ackedAt),
    };
  }

  function sendLine(request: Request, duplicate: boolean, prefix: string): string {
    const tag = duplicate ? "Already have this request" : "Request saved";
    const where =
      request.state === "delivered"
        ? `${request.delivery === "queued" ? "queued for" : "sent to"} the ${prefix} lead (${request.targetThreadId})`
        : request.state === "held"
          ? `waiting: ${request.lastError}`
          : request.state === "failed"
            ? `failed: ${request.lastError}`
          : `delivery will be retried${request.lastError ? ` (${request.lastError})` : ""}`;
    return `${tag} as ${request.id}: ${where}.\n`;
  }

  const commands = {
    send: cliCommand({
      summary: "Hand the project lead a request from an outer loop (Grok Bot, a routine, a person); saved first, delivered when the lead can take it",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "message", description: "What happened and what you want; the lead triages it onto the board", variadic: true, required: true },
      ],
      options: {
        source: { type: "string", description: "Who is sending, shown to the lead (default: outer-loop)" },
        ref: { type: "string", description: "Link to the origin: a Slack message, issue, PR or post" },
        key: { type: "string", description: "Idempotency key; resending the same key returns the first request instead of a new one" },
        json,
      },
      async run(input) {
        const project = await deps.resolveProject(input.positionals.project);
        const text = (input.positionals.message ?? []).join(" ").trim();
        if (!text) throw new PluginCliError("Say what the lead should know or do.");
        if (text.length > REQUEST_TEXT_MAX) throw new PluginCliError(`Requests are limited to ${REQUEST_TEXT_MAX} characters.`);
        let key: string | null;
        try {
          key = cleanKey(input.options.key);
        } catch (cause) {
          throw new PluginCliError(cause instanceof Error ? cause.message : String(cause));
        }
        const { request, duplicate, dedupedBy } = mailbox.enqueue({
          projectId: project.id,
          prefix: project.prefix,
          source: cleanSource(input.options.source),
          text,
          ref: cleanRef(input.options.ref),
          key,
        });
        const current = duplicate ? request : ((await courier.deliver(request.id)) ?? request);
        bb.rpc.experimental_invalidate([`inbox:${project.id}`]);
        return {
          exitCode: 0,
          stdout: input.options.json
            ? JSON.stringify({ ...requestView(current), duplicate, dedupedBy }) + "\n"
            : sendLine(current, duplicate, project.prefix) + (dedupedBy === "content" ? "Identical text from this source arrived in the last 10 minutes, so it was not sent again. Pass a new --key to send a deliberate repeat.\n" : ""),
        };
      },
    }),
    reply: cliCommand({
      summary: "Project lead only: send the outer loop a result, question or blocker, saved until it is acknowledged",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "message", description: "What the sender needs to know; no secrets, no worker chatter", variadic: true, required: true },
      ],
      options: {
        to: { type: "string", description: "The request id this answers (req_...); omit for news the sender did not ask for" },
        kind: { type: "enum", values: REPLY_KINDS, description: "result, question, blocker or update (default: result with --to, otherwise update)" },
        key: { type: "string", description: "Idempotency key; by default an identical reply to the same request is not saved twice" },
        json,
      },
      async run(input, ctx) {
        const project = await deps.resolveProject(input.positionals.project);
        const meta = await deps.readMeta(project.id);
        if (!meta.leadThreadId) throw new PluginCliError(`${project.prefix} has no project lead.`);
        if (!ctx.threadId || ctx.threadId !== meta.leadThreadId) {
          throw new PluginCliError(`Only the ${project.prefix} lead (${meta.leadThreadId}) can reply to the outer loop. Workers report to their lead instead.`);
        }
        const text = (input.positionals.message ?? []).join(" ").trim();
        if (!text) throw new PluginCliError("Say what the sender needs to know.");
        if (text.length > REPLY_TEXT_MAX) throw new PluginCliError(`Replies are limited to ${REPLY_TEXT_MAX} characters.`);
        const to = input.options.to?.trim() || null;
        if (to) {
          const request = mailbox.getRequest(to);
          if (!request || request.projectId !== project.id) throw new PluginCliError(`No ${project.prefix} request ${to}. See bb projects requests ${project.prefix}.`);
        }
        let key: string | null;
        try {
          key = cleanKey(input.options.key);
        } catch (cause) {
          throw new PluginCliError(cause instanceof Error ? cause.message : String(cause));
        }
        const { reply, duplicate } = mailbox.addReply({
          projectId: project.id,
          prefix: project.prefix,
          leadThreadId: meta.leadThreadId,
          inReplyTo: to,
          kind: input.options.kind ?? (to ? "result" : "update"),
          author: meta.leadThreadId,
          text,
          key,
        });
        poke.wake?.();
        return {
          exitCode: 0,
          stdout: input.options.json ? JSON.stringify({ ...replyView(reply), duplicate }) + "\n" : `${duplicate ? "Already saved" : "Saved"} reply ${reply.id}${to ? ` to ${to}` : ""}.\n`,
        };
      },
    }),
    replies: cliCommand({
      summary: "Read the project leads' replies to the outer loop, oldest first; unacknowledged only unless --all",
      positionals: [{ name: "project", description: "Tracker project prefix; omit for every project" }],
      options: {
        all: { type: "boolean", description: "Include replies already acknowledged" },
        after: { type: "string", description: "Only replies after this reply id" },
        limit: { type: "integer", min: 1, max: 200, description: "At most this many (default 50)" },
        json,
      },
      async run(input) {
        const project = input.positionals.project ? await deps.resolveProject(input.positionals.project) : null;
        const after = input.options.after ? mailbox.getReply(input.options.after.trim()) : null;
        if (input.options.after && !after) throw new PluginCliError(`No reply ${input.options.after}.`);
        const replies = mailbox.listReplies({ projectId: project?.id ?? null, includeAcked: input.options.all, limit: input.options.limit ?? 50, afterSeq: after?.seq ?? 0 });
        const counts = mailbox.pendingCounts();
        const pending = project ? (counts[project.prefix] ?? 0) : Object.values(counts).reduce((total, count) => total + count, 0);
        if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ pending, replies: replies.map(replyView) }) + "\n" };
        const lines = replies.map((reply) => `${reply.id} [${reply.kind}] ${reply.prefix}${reply.inReplyTo ? ` re ${reply.inReplyTo}` : ""}${reply.ackedAt ? " (acked)" : ""}\n  ${reply.text.replace(/\n/g, "\n  ")}`);
        return { exitCode: 0, stdout: (lines.length ? lines.join("\n") : "No replies waiting.") + "\n" };
      },
    }),
    ack: cliCommand({
      summary: "Acknowledge a project's replies the outer loop has handled, by id; safe to repeat",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "ids", description: "Reply ids (rep_...)", variadic: true, required: true },
      ],
      options: { json },
      async run(input, ctx) {
        const project = await deps.resolveProject(input.positionals.project);
        const meta = await deps.readMeta(project.id);
        if (ctx.threadId && ctx.threadId === meta.leadThreadId) throw new PluginCliError(`The ${project.prefix} lead cannot acknowledge its own replies; the outer loop does that once it has handled them.`);
        const ids = (input.positionals.ids ?? []).map((id) => id.trim()).filter(Boolean);
        if (!ids.length) throw new PluginCliError("Give at least one reply id.");
        if (ids.length > 200) throw new PluginCliError("Acknowledge at most 200 replies at a time.");
        const result = mailbox.ack(project.id, ids);
        const problems = [...result.unknown, ...result.otherProject];
        return {
          exitCode: problems.length ? 1 : 0,
          stdout: input.options.json
            ? JSON.stringify(result) + "\n"
            : `Acknowledged ${result.acked.length}${result.alreadyAcked.length ? `, ${result.alreadyAcked.length} already` : ""}${result.unknown.length ? `; unknown: ${result.unknown.join(", ")}` : ""}${result.otherProject.length ? `; not ${project.prefix} replies: ${result.otherProject.join(", ")}` : ""}.\n`,
        };
      },
    }),
    retry: cliCommand({
      summary: "Retry a request that failed or is held, now; it is checked against the lead's thread first so it is not delivered twice",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "id", description: "Request id (req_...)", required: true },
      ],
      options: { json },
      async run(input) {
        const project = await deps.resolveProject(input.positionals.project);
        const id = input.positionals.id.trim();
        const result = await courier.retry(project.id, id);
        if (result.outcome === "unknown") throw new PluginCliError(`No ${project.prefix} request ${id}.`);
        if (result.outcome === "not-retryable") throw new PluginCliError(`Request ${id} is ${result.request!.state}; only failed, held or pending requests can be retried.`);
        bb.rpc.experimental_invalidate([`inbox:${project.id}`]);
        const view = requestView(result.request!);
        return { exitCode: 0, stdout: input.options.json ? JSON.stringify(view) + "\n" : sendLine(result.request!, false, project.prefix).replace("Request saved", "Retried") };
      },
    }),
    requests: cliCommand({
      summary: "List the outer loop's requests to a project lead and whether each was delivered",
      positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
      options: { limit: { type: "integer", min: 1, max: 200, description: "At most this many, newest first (default 20)" }, json },
      async run(input) {
        const project = await deps.resolveProject(input.positionals.project);
        const requests = mailbox.listRequests(project.id, input.options.limit ?? 20);
        if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ requests: requests.map(requestView) }) + "\n" };
        const lines = requests.map((request) => `${request.id} ${request.state}${request.delivery ? `/${request.delivery}` : ""} from ${request.source}: ${request.text.split("\n")[0]!.slice(0, 80)}`);
        return { exitCode: 0, stdout: (lines.length ? lines.join("\n") : "No requests yet.") + "\n" };
      },
    }),
    notify: cliCommand({
      summary: "Show the webhook wake-up state; --test sends one wake-up to the configured receiver now",
      options: { test: { type: "boolean", description: "Send a wake-up now (contacts the configured receiver)" }, json },
      async run(input) {
        const values = await settings.get();
        if (input.options.test) {
          if (!values.wakeEnabled) throw new PluginCliError("Webhook wake-up is off. Turn it on in the Projects plugin settings first.");
          mailbox.wantWake();
        }
        const outcome = input.options.test ? await courier.notify(true) : null;
        const wake = mailbox.wake();
        const view = {
          enabled: values.wakeEnabled,
          configured: Boolean(values.wakeUrl),
          authHeader: values.wakeHeaderName || null,
          configError: courier.wakeConfigError(),
          pending: mailbox.pendingCounts(),
          wake: { wanted: wake.wanted, sent: wake.sent, attempts: wake.attempts, lastSentAt: iso(wake.lastSentAt), nextAttemptAt: wake.wanted > wake.sent ? iso(wake.nextAttemptAt) : null, lastError: wake.lastError },
          ...(outcome ? { test: outcome } : {}),
        };
        if (input.options.json) return { exitCode: outcome === "failed" ? 1 : 0, stdout: JSON.stringify(view) + "\n" };
        const lines = [
          `Webhook wake-up: ${view.enabled ? "on" : "off"}${view.configured ? "" : ", no URL set"}${view.configError ? ` (${view.configError})` : ""}`,
          `Last sent: ${view.wake.lastSentAt ?? "never"}${view.wake.lastError ? `, last error: ${view.wake.lastError}` : ""}`,
          ...(outcome ? [`Test: ${outcome}`] : []),
        ];
        return { exitCode: outcome === "failed" ? 1 : 0, stdout: lines.join("\n") + "\n" };
      },
    }),
  };

  return { mailbox, courier, commands, inboxItems, leadChanged, leadState };
}
