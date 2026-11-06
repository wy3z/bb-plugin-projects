import { cliCommand, defineCli, PluginCliError, type BbPluginApi } from "@get-bb/plugin-sdk";
import { META_CHANGED, projectsContract, type ProjectMeta } from "./src/meta";
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
    return { focus: stored?.focus ?? null, focusUpdatedAt: stored?.focusUpdatedAt ?? null, leadThreadId: stored?.leadThreadId ?? null };
  }

  async function writeMeta(projectId: string, change: Partial<ProjectMeta>): Promise<ProjectMeta> {
    const next = { ...(await readMeta(projectId)), ...change };
    await bb.storage.kv.set(key(projectId), next);
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
            if (input.options.json) {
              return { exitCode: 0, stdout: JSON.stringify({ project: project.prefix, focus: meta.focus, leadThreadId: meta.leadThreadId, counts, inFlight }) + "\n" };
            }
            const lines = [
              `${project.name} (${project.prefix})`,
              meta.focus ? `Focus: ${meta.focus}` : "Focus: none set",
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
