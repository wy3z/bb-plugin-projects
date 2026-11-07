import { cliCommand, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { InboxItem, ProjectMeta } from "./meta";
import type { Project } from "./contracts";
import { cleanConsumer, cleanKey, createMailbox, MIGRATIONS, REPLY_KINDS, REPLY_TEXT_MAX, REQUEST_TEXT_MAX, type AckResult, type Reply, type Request, type SqlDb } from "./mailbox";
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

  function replyView(reply: Reply, consumer: string | null = null) {
    const request = reply.inReplyTo ? mailbox.getRequest(reply.inReplyTo) : null;
    return {
      id: reply.id,
      project: reply.prefix,
      leadThreadId: reply.leadThreadId,
      inReplyTo: reply.inReplyTo,
      request: request ? { id: request.id, source: request.source, ref: request.ref, key: request.key, createdAt: iso(request.createdAt) } : null,
      audience: reply.audience,
      kind: reply.kind,
      author: reply.author,
      text: reply.text,
      createdAt: iso(reply.createdAt),
      ackedAt: iso(reply.ackedAt),
      ...(consumer ? {} : { recipients: mailbox.recipients(reply.id).map((recipient) => ({ consumer: recipient.consumer, ackedAt: iso(recipient.ackedAt) })) }),
    };
  }

  function consumerOption(raw: string | undefined, required: true): string;
  function consumerOption(raw: string | undefined, required: false): string | null;
  function consumerOption(raw: string | undefined, required: boolean): string | null {
    if (raw === undefined || raw.trim() === "") {
      if (required) throw new PluginCliError("Say which agent system you are with --as, such as --as grok-bot. Use the same name you send requests with.");
      return null;
    }
    const name = cleanConsumer(raw);
    if (name !== raw.trim()) throw new PluginCliError("Agent names are 1-40 letters, digits, dots, dashes, underscores or @.");
    return name;
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
      summary: "Hand the project lead a request from an agent system (Grok Bot, dots, a routine, a person); saved first, delivered when the lead can take it",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "message", description: "What happened and what you want; the lead triages it onto the board", variadic: true, required: true },
      ],
      options: {
        as: { type: "string", description: "Your agent system's name, such as grok-bot or dots; the lead's answer goes only to you (default: outer-loop)" },
        source: { type: "string", description: "Older name for --as" },
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
        const as = consumerOption(input.options.as, false);
        const legacy = consumerOption(input.options.source, false);
        if (as && legacy && as !== legacy) throw new PluginCliError("--as and --source name different senders; use --as only.");
        const { request, duplicate, dedupedBy } = mailbox.enqueue({
          projectId: project.id,
          prefix: project.prefix,
          source: cleanSource(as ?? legacy),
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
      summary: "Project lead only: answer the agent that sent a request, or tell every agent following the project; saved until each acknowledges it",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "message", description: "What the sender needs to know; no secrets, no worker chatter", variadic: true, required: true },
      ],
      options: {
        to: { type: "string", description: "The request id this answers (req_...); the reply goes only to the agent that sent it" },
        for: { type: "string", description: "Without --to: send news to one agent system (see bb projects consumers); otherwise every agent following the project gets it" },
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
        const audience = consumerOption(input.options.for, false);
        if (to) {
          const request = mailbox.getRequest(to);
          if (!request || request.projectId !== project.id) throw new PluginCliError(`No ${project.prefix} request ${to}. See bb projects requests ${project.prefix}.`);
          if (audience && audience !== request.source) throw new PluginCliError(`Request ${to} came from ${request.source}; a reply to it goes to ${request.source}. Drop --for.`);
        } else if (audience && !mailbox.hasConsumer(project.id, audience)) {
          throw new PluginCliError(`No agent called ${audience} follows ${project.prefix}. See bb projects consumers ${project.prefix}.`);
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
          audience: to ? null : audience,
          kind: input.options.kind ?? (to ? "result" : "update"),
          author: meta.leadThreadId,
          text,
          key,
        });
        poke.wake?.();
        return {
          exitCode: 0,
          stdout: input.options.json ? JSON.stringify({ ...replyView(reply), duplicate }) + "\n" : `${duplicate ? "Already saved" : "Saved"} reply ${reply.id}${to ? ` to ${to}` : ""} for ${reply.audience ?? "every agent following " + project.prefix}.\n`,
        };
      },
    }),
    replies: cliCommand({
      summary: "Read the lead's replies meant for your agent system, oldest first; unacknowledged only unless --all. Without --as, an overview of every agent's replies",
      positionals: [{ name: "project", description: "Tracker project prefix; omit for every project you follow" }],
      options: {
        as: { type: "string", description: "Your agent system's name, such as grok-bot or dots; naming a project also follows it, so its news reaches you from now on" },
        all: { type: "boolean", description: "Include replies already acknowledged" },
        after: { type: "string", description: "Only replies after this reply id" },
        limit: { type: "integer", min: 1, max: 200, description: "At most this many (default 50)" },
        json,
      },
      async run(input) {
        const project = input.positionals.project ? await deps.resolveProject(input.positionals.project) : null;
        const consumer = consumerOption(input.options.as, false);
        if (project && consumer) mailbox.touchConsumer(project.id, consumer);
        const after = input.options.after ? mailbox.getReply(input.options.after.trim()) : null;
        if (input.options.after && !after) throw new PluginCliError(`No reply ${input.options.after}.`);
        const replies = mailbox.listReplies({ projectId: project?.id ?? null, consumer, includeAcked: input.options.all, limit: input.options.limit ?? 50, afterSeq: after?.seq ?? 0 });
        const counts = mailbox.pendingCounts(consumer);
        const pending = project ? (counts[project.prefix] ?? 0) : Object.values(counts).reduce((total, count) => total + count, 0);
        if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ as: consumer, pending, replies: replies.map((reply) => replyView(reply, consumer)) }) + "\n" };
        const lines = replies.map(
          (reply) =>
            `${reply.id} [${reply.kind}] ${reply.prefix}${reply.inReplyTo ? ` re ${reply.inReplyTo}` : ""}${consumer ? "" : ` for ${reply.audience ?? "everyone"}`}${reply.ackedAt ? " (acked)" : ""}\n  ${reply.text.replace(/\n/g, "\n  ")}`,
        );
        return { exitCode: 0, stdout: (lines.length ? lines.join("\n") : "No replies waiting.") + "\n" };
      },
    }),
    ack: cliCommand({
      summary: "Acknowledge replies your agent system has handled, by id; safe to repeat. Other agents still see their copy",
      positionals: [
        { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
        { name: "ids", description: "Reply ids (rep_...)", variadic: true, required: true },
      ],
      options: { as: { type: "string", description: "Your agent system's name (required), the same one you read replies with" }, json },
      async run(input, ctx) {
        const project = await deps.resolveProject(input.positionals.project);
        const meta = await deps.readMeta(project.id);
        if (ctx.threadId && ctx.threadId === meta.leadThreadId) throw new PluginCliError(`The ${project.prefix} lead cannot acknowledge its own replies; the agent that reads them does that once it has handled them.`);
        const consumer = consumerOption(input.options.as, true);
        const ids = (input.positionals.ids ?? []).map((id) => id.trim()).filter(Boolean);
        if (!ids.length) throw new PluginCliError("Give at least one reply id.");
        if (ids.length > 200) throw new PluginCliError("Acknowledge at most 200 replies at a time.");
        const result: AckResult = mailbox.ack(project.id, consumer, ids);
        const problems = [...result.unknown, ...result.otherProject, ...result.notYours];
        return {
          exitCode: problems.length ? 1 : 0,
          stdout: input.options.json
            ? JSON.stringify({ as: consumer, ...result }) + "\n"
            : `Acknowledged ${result.acked.length}${result.alreadyAcked.length ? `, ${result.alreadyAcked.length} already` : ""}${result.unknown.length ? `; unknown: ${result.unknown.join(", ")}` : ""}${result.otherProject.length ? `; not ${project.prefix} replies: ${result.otherProject.join(", ")}` : ""}${result.notYours.length ? `; not for ${consumer}: ${result.notYours.join(", ")}` : ""}.\n`,
        };
      },
    }),
    consumers: cliCommand({
      summary: "List the agent systems following a project's lead (anyone that sent it a request or read its replies); --forget removes one and clears what it was owed",
      positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
      options: { forget: { type: "string", description: "Agent name to stop following this project, such as a mistyped --as" }, json },
      async run(input, ctx) {
        const project = await deps.resolveProject(input.positionals.project);
        const forget = consumerOption(input.options.forget, false);
        let forgotten: { forgotten: boolean; acked: number } | null = null;
        if (forget) {
          const meta = await deps.readMeta(project.id);
          if (ctx.threadId && ctx.threadId === meta.leadThreadId) throw new PluginCliError(`The ${project.prefix} lead cannot remove the agents it answers.`);
          forgotten = mailbox.forgetConsumer(project.id, forget);
          if (!forgotten.forgotten) throw new PluginCliError(`No agent called ${forget} follows ${project.prefix}.`);
        }
        const pending = mailbox.pendingByConsumer();
        const list = mailbox.consumers(project.id).map((consumer) => ({
          name: consumer.name,
          since: iso(consumer.firstSeen),
          lastSeen: iso(consumer.lastSeen),
          repliesPending: pending[consumer.name]?.[project.prefix] ?? 0,
        }));
        if (input.options.json) return { exitCode: 0, stdout: JSON.stringify({ project: project.prefix, consumers: list, ...(forgotten ? { forgot: forget, cleared: forgotten.acked } : {}) }) + "\n" };
        const lines = [
          ...(forgotten ? [`Forgot ${forget}; cleared ${forgotten.acked} replies it was owed.`] : []),
          ...(list.length ? list.map((consumer) => `${consumer.name}: ${consumer.repliesPending} waiting, last seen ${consumer.lastSeen}`) : [`No agents follow ${project.prefix} yet.`]),
        ];
        return { exitCode: 0, stdout: lines.join("\n") + "\n" };
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
      summary: "List the requests agent systems sent a project lead and whether each was delivered",
      positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
      options: {
        as: { type: "string", description: "Only requests this agent system sent" },
        limit: { type: "integer", min: 1, max: 200, description: "At most this many, newest first (default 20)" },
        json,
      },
      async run(input) {
        const project = await deps.resolveProject(input.positionals.project);
        const requests = mailbox.listRequests(project.id, input.options.limit ?? 20, consumerOption(input.options.as, false));
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
          consumers: mailbox.pendingByConsumer(),
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
