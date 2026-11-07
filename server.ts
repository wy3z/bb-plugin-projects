import { z } from "zod";
import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { META_CHANGED, projectsContract, type ProjectMeta } from "./src/meta";
import { createLoop } from "./src/outer-loop";
import { createMessaging } from "./src/messaging";
import { STATUSES, TASKS_PLUGIN, tasksContract, type Project, type Status, type Task } from "./src/contracts";

const STATUS_WORD: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Queued",
  in_progress: "In progress",
  in_review: "For review",
  done: "Done",
  canceled: "Canceled",
};

export default function plugin(bb: BbPluginApi) {
  const key = (projectId: string) => `meta:${projectId}`;

  async function readMeta(projectId: string): Promise<ProjectMeta> {
    const stored = await bb.storage.kv.get<ProjectMeta>(key(projectId));
    return {
      focus: stored?.focus ?? null,
      focusUpdatedAt: stored?.focusUpdatedAt ?? null,
      leadThreadId: stored?.leadThreadId ?? null,
      sweepMinutes: stored?.sweepMinutes ?? null,
      sweepWorkingHours: stored?.sweepWorkingHours ?? true,
      sweepLastAt: stored?.sweepLastAt ?? null,
      followPrs: stored?.followPrs ?? false,
    };
  }

  async function quietLead(threadId: string): Promise<void> {
    try {
      const listed = await bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "threadNotifications.list",
        input: { threadIds: [threadId] },
        outputSchema: z.object({ threads: z.record(z.string(), z.object({ own: z.string() }).passthrough()) }),
      });
      const own = listed.threads[threadId]?.own;
      if (own && own !== "inherit") return;
      await bb.sdk.plugins.callRpc({
        pluginId: "push-notifications",
        method: "threadNotifications.set",
        input: { threadId, level: "input-only" },
        outputSchema: z.unknown(),
      });
    } catch (cause) {
      bb.log.warn(`Could not set the lead's notification level: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  const metaWrites = new Map<string, Promise<unknown>>();

  function writeMeta(projectId: string, change: Partial<ProjectMeta>): Promise<ProjectMeta> {
    const previous = metaWrites.get(projectId) ?? Promise.resolve();
    const run = previous.then(() => applyMeta(projectId, change));
    metaWrites.set(projectId, run.catch(() => undefined));
    return run;
  }

  async function applyMeta(projectId: string, change: Partial<ProjectMeta>): Promise<ProjectMeta> {
    const before = await readMeta(projectId);
    const next = { ...before, ...change };
    await bb.storage.kv.set(key(projectId), next);
    if (change.leadThreadId) void quietLead(change.leadThreadId);
    if ("leadThreadId" in change && change.leadThreadId !== before.leadThreadId) messaging.leadChanged(projectId);
    bb.realtime.publish(META_CHANGED, { projectId });
    bb.rpc.experimental_invalidate(["leads", `meta:${projectId}`]);
    return next;
  }

  async function projects(): Promise<Project[]> {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN,
      method: "listProjects",
      input: {},
      outputSchema: tasksContract.listProjects.output,
    });
    return result.projects;
  }

  async function resolveProject(ref: string): Promise<Project> {
    const all = await projects();
    const upper = ref.toUpperCase();
    const found = all.find((project) => project.prefix === upper || project.id === ref || project.name.toLowerCase() === ref.toLowerCase());
    if (!found) throw new PluginCliError(`No tracker project "${ref}". Known: ${all.map((project) => project.prefix).join(", ") || "none"}`);
    return found;
  }

  async function tasksOf(projectId: string): Promise<Task[]> {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN,
      method: "listAllTasks",
      input: { projectId },
      outputSchema: tasksContract.listAllTasks.output,
    });
    return result.tasks.filter((task) => task.parentTaskId === null);
  }

  async function activeThreads(projectId: string) {
    const result = await bb.sdk.plugins.callRpc({
      pluginId: TASKS_PLUGIN,
      method: "listTaskCardMeta",
      input: { projectId },
      outputSchema: tasksContract.listTaskCardMeta.output,
    });
    return new Map(result.cards.map((card) => [card.taskId, card.activeThreads]));
  }

  void (async () => {
    for (const storageKey of await bb.storage.kv.list("meta:")) {
      const stored = await bb.storage.kv.get<ProjectMeta>(storageKey);
      if (stored?.leadThreadId) await quietLead(stored.leadThreadId);
    }
  })().catch(() => undefined);

  async function leadsWithMeta() {
    const all = await projects();
    const out = [];
    for (const project of all) {
      const meta = await readMeta(project.id);
      if (meta.leadThreadId) out.push({ projectId: project.id, prefix: project.prefix, meta });
    }
    return out;
  }

  const loop = createLoop(bb, { leads: leadsWithMeta, writeMeta });
  const messaging = createMessaging(bb, { resolveProject, projects, readMeta });

  function parseEvery(raw: string): number | null {
    if (/^(off|none|0)$/i.test(raw)) return null;
    const match = /^(\d+)\s*(m|min|h|hr)?$/i.exec(raw.trim());
    if (!match) throw new PluginCliError(`Use a duration such as 90m or 2h, or off. Got "${raw}".`);
    const minutes = Number(match[1]) * (/^h/i.test(match[2] ?? "m") ? 60 : 1);
    if (minutes < 30 || minutes > 1440) throw new PluginCliError("Sweep interval must be between 30m and 24h.");
    return minutes;
  }

  function describeLoop(meta: ProjectMeta): string[] {
    const every = meta.sweepMinutes === null ? "off" : meta.sweepMinutes % 60 === 0 ? `every ${meta.sweepMinutes / 60}h` : `every ${meta.sweepMinutes}m`;
    return [
      `Sweep: ${every}${meta.sweepMinutes !== null && meta.sweepWorkingHours ? " (weekdays 08:00-19:00)" : ""}${meta.sweepLastAt ? `, last ${meta.sweepLastAt}` : ""}`,
      `Follow PRs: ${meta.followPrs ? "on" : "off"}`,
    ];
  }

  bb.rpc.register(projectsContract, {
    getMeta: ({ projectId }) => readMeta(projectId),
    listLeads: async () => {
      const keys = await bb.storage.kv.list("meta:");
      const leads: { projectId: string; threadId: string; focus: string | null }[] = [];
      for (const storageKey of keys) {
        const stored = await bb.storage.kv.get<ProjectMeta>(storageKey);
        if (stored?.leadThreadId) leads.push({ projectId: storageKey.slice("meta:".length), threadId: stored.leadThreadId, focus: stored.focus ?? null });
      }
      return { leads };
    },
    setFocus: ({ projectId, focus }) => writeMeta(projectId, { focus: focus?.trim() || null, focusUpdatedAt: new Date().toISOString() }),
    setLead: ({ projectId, threadId }) => writeMeta(projectId, { leadThreadId: threadId }),
    setLoop: ({ projectId, ...change }) =>
      writeMeta(projectId, Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) as Partial<ProjectMeta>),
    getNotes: ({ projectId }) => loop.readNotes(projectId),
    setNotes: ({ projectId, text }) => loop.writeNotes(projectId, text),
    listInbox: async ({ projectId }) => ({ items: messaging.inboxItems(projectId) }),
  });

  const json = { type: "boolean", description: "Emit JSON" } as const;

  bb.cli.register(
    defineCli({
      name: "projects",
      summary: "Project boards over BB Tasks: focus, project lead and status summaries",
      commands: {
        status: cliCommand({
          summary: "Summarise a tracker project's board: counts per column, work in flight, and the focus",
          positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
          options: { json },
          async run(input) {
            const project = await resolveProject(input.positionals.project);
            const [tasks, active, meta] = await Promise.all([tasksOf(project.id), activeThreads(project.id), readMeta(project.id)]);
            const counts = Object.fromEntries(STATUSES.map((status) => [status, tasks.filter((task) => task.status === status).length]));
            const inFlight = tasks
              .filter((task) => task.status === "in_progress" || task.status === "in_review" || active.has(task.id))
              .map((task) => ({
                key: task.key,
                title: task.title,
                status: task.status,
                agents: (active.get(task.id) ?? []).map((thread) => ({ threadId: thread.threadId, preset: thread.presetName, status: thread.liveStatus })),
              }));
            const needsYou = tasks.filter((task) => task.status === "in_review").map((task) => ({ key: task.key, title: task.title }));
            const leadStatus = meta.leadThreadId ? await loop.leadStatus(meta.leadThreadId).catch(() => "unknown" as const) : null;
            const requests = messaging.mailbox.requestCounts(project.id);
            const repliesPending = messaging.mailbox.pendingCounts()[project.prefix] ?? 0;
            if (input.options.json) {
              return {
                exitCode: 0,
                stdout:
                  JSON.stringify({
                    project: project.prefix,
                    focus: meta.focus,
                    leadThreadId: meta.leadThreadId,
                    leadStatus,
                    counts,
                    inFlight,
                    needsYou,
                    loop: { sweepMinutes: meta.sweepMinutes, sweepWorkingHours: meta.sweepWorkingHours, sweepLastAt: meta.sweepLastAt, followPrs: meta.followPrs },
                    messages: {
                      requestsWaiting: requests.pending + requests.delivering + requests.held,
                      requestsHeld: requests.held,
                      requestsFailed: requests.failed,
                      requestsAwaitingDispatch: messaging.mailbox.unconfirmedCount(project.id),
                      repliesPending,
                    },
                  }) + "\n",
              };
            }
            const lines = [
              `${project.name} (${project.prefix})`,
              meta.focus ? `Focus: ${meta.focus}` : "Focus: none set",
              ...(leadStatus === "missing" || leadStatus === "archived" ? [`Lead: ${meta.leadThreadId} is ${leadStatus}`] : []),
              ...(requests.held ? [`${requests.held} outer-loop request${requests.held === 1 ? "" : "s"} waiting for a lead`] : []),
              ...(requests.failed ? [`${requests.failed} outer-loop request${requests.failed === 1 ? "" : "s"} failed; see bb projects requests ${project.prefix}`] : []),
              STATUSES.filter((status) => counts[status]! > 0).map((status) => `${STATUS_WORD[status]} ${counts[status]}`).join(" · "),
              "",
              inFlight.length === 0 ? "Nothing in progress or for review." : "In flight:",
              ...inFlight.map(
                (task) =>
                  `- ${task.key} [${STATUS_WORD[task.status]}] ${task.title}${task.agents.length ? ` (${task.agents.map((agent) => `${agent.preset}: ${agent.status}`).join(", ")})` : ""}`,
              ),
            ];
            return { exitCode: 0, stdout: lines.join("\n") + "\n" };
          },
        }),
        focus: cliCommand({
          summary: "Show, set or clear the project's focus line, shown as a card at the top of the board",
          positionals: [
            { name: "project", description: "Tracker project prefix, such as PIXEL", required: true },
            { name: "text", description: "New focus, one or two sentences; omit to show the current one", variadic: true },
          ],
          options: { clear: { type: "boolean", description: "Remove the focus" }, json },
          async run(input) {
            const project = await resolveProject(input.positionals.project);
            const text = (input.positionals.text ?? []).join(" ").trim();
            const meta = input.options.clear
              ? await writeMeta(project.id, { focus: null, focusUpdatedAt: new Date().toISOString() })
              : text
                ? await writeMeta(project.id, { focus: text, focusUpdatedAt: new Date().toISOString() })
                : await readMeta(project.id);
            return {
              exitCode: 0,
              stdout: input.options.json ? JSON.stringify(meta) + "\n" : `${meta.focus ?? "No focus set."}\n`,
            };
          },
        }),
        ...messaging.commands,
        notes: cliCommand({
          summary: "Show or change the project's memory: conventions, preferences and gotchas the lead reads every session",
          positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
          options: {
            append: { type: "string", description: "Add a line or paragraph to the end" },
            set: { type: "string", description: "Replace the notes entirely" },
            json,
          },
          async run(input) {
            const project = await resolveProject(input.positionals.project);
            let notes = await loop.readNotes(project.id);
            if (input.options.set !== undefined) notes = await loop.writeNotes(project.id, input.options.set.trim());
            else if (input.options.append?.trim()) {
              notes = await loop.writeNotes(project.id, [notes.text.trimEnd(), input.options.append.trim()].filter(Boolean).join("\n"));
            }
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(notes) + "\n" : `${notes.text || "No notes yet."}\n` };
          },
        }),
        loop: cliCommand({
          summary: "Show or set the lead's triggers: a scheduled board sweep and following every PR its workers open",
          positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
          options: {
            sweep: { type: "string", description: "Sweep interval such as 2h or 90m (30m-24h), or off" },
            "any-hours": { type: "boolean", description: "Sweep around the clock, not only weekdays 08:00-19:00" },
            "working-hours": { type: "boolean", description: "Sweep only weekdays 08:00-19:00 (the default)" },
            "follow-prs": { type: "string", description: "on or off: subscribe the lead to every PR linked to its worker threads" },
            json,
          },
          async run(input) {
            const project = await resolveProject(input.positionals.project);
            const change: Partial<ProjectMeta> = {};
            if (input.options.sweep !== undefined) change.sweepMinutes = parseEvery(input.options.sweep);
            if (input.options["any-hours"]) change.sweepWorkingHours = false;
            if (input.options["working-hours"]) change.sweepWorkingHours = true;
            const follow = input.options["follow-prs"];
            if (follow !== undefined) {
              if (!/^(on|off)$/i.test(follow)) throw new PluginCliError("Use --follow-prs on or --follow-prs off.");
              change.followPrs = /^on$/i.test(follow);
            }
            const meta = Object.keys(change).length ? await writeMeta(project.id, change) : await readMeta(project.id);
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(meta) + "\n" : describeLoop(meta).join("\n") + "\n" };
          },
        }),
        lead: cliCommand({
          summary: "Show or set the project's lead thread (defaults to the thread running the command)",
          positionals: [{ name: "project", description: "Tracker project prefix, such as PIXEL", required: true }],
          options: {
            thread: { type: "string", description: "Thread id to make the lead; defaults to the current thread" },
            show: { type: "boolean", description: "Only show the current lead" },
            json,
          },
          async run(input, ctx) {
            const project = await resolveProject(input.positionals.project);
            if (input.options.show) {
              const meta = await readMeta(project.id);
              return { exitCode: 0, stdout: input.options.json ? JSON.stringify(meta) + "\n" : `${meta.leadThreadId ?? "No lead set."}\n` };
            }
            const threadId = input.options.thread ?? ctx.threadId ?? null;
            if (!threadId) throw new PluginCliError("Run this inside a thread, or pass --thread <id>.");
            const meta = await writeMeta(project.id, { leadThreadId: threadId });
            return { exitCode: 0, stdout: input.options.json ? JSON.stringify(meta) + "\n" : `Lead for ${project.prefix} is ${threadId}\n` };
          },
        }),
      },
    }),
  );
}
