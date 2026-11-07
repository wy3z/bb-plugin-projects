import { Database } from "bun:sqlite";
import { migrate } from "./harness";

type Thread = {
  id: string;
  visibility?: "visible" | "hidden";
  parentThreadId: string | null;
  archivedAt: number | null;
  runtime: { displayStatus: string };
  queuedWork: string;
  hasPendingInteraction: boolean;
};

type Cli = { run(argv: string[], ctx: { threadId?: string }): Promise<{ exitCode: number; stdout?: string; stderr?: string }> };

export function fakeBb(opts: { dbPath?: string; kv?: Map<string, unknown>; settings?: Record<string, unknown> } = {}) {
  const kv = opts.kv ?? new Map<string, unknown>();
  const db = new Database(opts.dbPath ?? ":memory:");
  const threads = new Map<string, Thread>();
  const sent: { threadId: string; text: string }[] = [];
  const subscribed: { threadId: string; urls: string[] }[] = [];
  const linked = new Map<string, string[]>();
  const services = new Map<string, { start(signal: AbortSignal): Promise<void> | void }>();
  const logs: string[] = [];
  const faults = { listProjects: 0, threadsList: 0, send: 0, kvSetDelayMs: 0 };
  const settings = { wakeEnabled: false, wakeHeaderName: "", wakeRemindMinutes: 60, ...opts.settings };
  let cli: Cli | null = null;
  let rpc: Record<string, (input: unknown) => Promise<unknown>> = {};

  const addThread = (id: string, patch: Partial<Thread> = {}) =>
    threads.set(id, { id, parentThreadId: null, archivedAt: null, runtime: { displayStatus: "idle" }, queuedWork: "none", hasPendingInteraction: false, ...patch });

  const bb = {
    log: {
      debug: () => undefined,
      info: (message: string) => logs.push(`info ${message}`),
      warn: (message: string) => logs.push(`warn ${message}`),
      error: (message: string) => logs.push(`error ${message}`),
    },
    storage: {
      kv: {
        get: async (key: string) => structuredClone(kv.get(key)),
        set: async (key: string, value: unknown) => {
          if (faults.kvSetDelayMs) await new Promise((resolve) => setTimeout(resolve, faults.kvSetDelayMs));
          kv.set(key, structuredClone(value));
        },
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix = "") => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
      database: () => db,
      migrate: (handle: never, statements: string[]) => migrate(handle, statements),
    },
    settings: { define: () => ({ get: async () => ({ ...settings }), experimental_set: async () => ({}), onChange: () => undefined }) },
    realtime: { publish: () => undefined },
    rpc: {
      experimental_invalidate: () => undefined,
      register: (_contract: unknown, handlers: typeof rpc) => {
        rpc = handlers;
      },
    },
    background: { service: (name: string, service: { start(signal: AbortSignal): Promise<void> | void }) => services.set(name, service) },
    cli: {
      register: (registration: Cli) => {
        cli = registration;
      },
    },
    sdk: {
      plugins: {
        callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: Record<string, unknown> }) => {
          if (pluginId === "tasks" && method === "listProjects") {
            if (faults.listProjects > 0) {
              faults.listProjects--;
              throw new Error("tasks plugin is reloading");
            }
            return { projects: [{ id: "proj_pixel", name: "Pixel", prefix: "PIXEL", color: "blue", linkedBbProjectId: null }, { id: "proj_other", name: "Other", prefix: "OTHER", color: "red", linkedBbProjectId: null }] };
          }
          if (pluginId === "tasks" && method === "listAllTasks") return { tasks: [] };
          if (pluginId === "tasks" && method === "listTaskCardMeta") return { cards: [] };
          if (pluginId === "pull-requests" && method === "linked_list") return { urls: linked.get(String(input.threadId)) ?? [] };
          if (pluginId === "pull-requests" && method === "subscribe") {
            subscribed.push({ threadId: String(input.threadId), urls: input.urls as string[] });
            return {};
          }
          throw new Error(`no fake for ${pluginId}.${method}`);
        },
      },
      threads: {
        list: async (args: { threadIds?: string[]; parentThreadId?: string }) => {
          if (faults.threadsList > 0) {
            faults.threadsList--;
            throw new Error("threads.list failed");
          }
          const all = [...threads.values()];
          if (args.threadIds) return all.filter((thread) => args.threadIds!.includes(thread.id));
          if (args.parentThreadId) return all.filter((thread) => thread.parentThreadId === args.parentThreadId);
          return all;
        },
        send: async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
          if (faults.send > 0) {
            faults.send--;
            throw new Error("send failed");
          }
          sent.push({ threadId, text: input[0]!.text });
          return { ok: true, delivery: "sent" };
        },
        queuedMessages: { list: async () => [], delete: async () => ({}) },
        search: async ({ query }: { query: string }) => {
          const results = [...threads.keys()]
            .map((id) => ({ thread: { id }, matches: sent.filter((item) => item.threadId === id && item.text.includes(query)).slice(0, 1).map((item) => ({ sourceKind: "user_message", text: item.text.slice(0, 160) })) }))
            .filter((result) => result.matches.length);
          return { active: { total: results.length, results }, archived: { total: 0, results: [] } };
        },
      },
    },
  };

  async function run(argv: string[], threadId?: string) {
    const result = await cli!.run(argv, threadId ? { threadId } : {});
    return { ...result, json: () => JSON.parse(result.stdout ?? "null") };
  }

  return { bb, db, kv, threads, sent, subscribed, linked, services, logs, faults, settings, addThread, run, rpc: () => rpc };
}
