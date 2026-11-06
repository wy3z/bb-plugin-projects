import { useCallback, useEffect, useMemo, useState } from "react";
import {
  experimental_useRpcKeyedQuery,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import {
  GIT_PLUGIN,
  STATUSES,
  TASKS_PLUGIN,
  gitContract,
  gitStatusSchema,
  tasksContract,
  type Label,
  type Project,
  type PullRequest,
  type Status,
  type Task,
  type TaskThread,
} from "./contracts";

const REFRESH_MS = 15_000;

function useTick(ms: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), ms);
    return () => window.clearInterval(timer);
  }, [ms]);
  return tick;
}

export function useProjects(): { projects: Project[]; loading: boolean } {
  const query = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listProjects",
    input: {},
  });
  return { projects: query.data?.projects ?? [], loading: query.data === undefined && !query.error };
}

export interface ProjectData {
  tasks: Task[];
  labels: ReadonlyMap<string, Label>;
  activeThreads: ReadonlyMap<string, TaskThread[]>;
  loading: boolean;
  error: string | null;
}

export function useProjectData(projectId: string | null): ProjectData {
  const enabled = projectId !== null;
  const input = { projectId: projectId ?? "" };
  const tasks = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listAllTasks", input, enabled });
  const labels = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listLabels", input, enabled });
  const meta = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listTaskCardMeta", input, enabled });
  return useMemo(() => {
    const labelMap = new Map((labels.data?.labels ?? []).map((label) => [label.id, label]));
    const active = new Map((meta.data?.cards ?? []).map((card) => [card.taskId, card.activeThreads]));
    const error = tasks.error ? String((tasks.error as { message?: string }).message ?? tasks.error) : null;
    return {
      tasks: (tasks.data?.tasks ?? []).filter((task) => task.parentTaskId === null),
      labels: labelMap,
      activeThreads: active,
      loading: enabled && tasks.data === undefined && !tasks.error,
      error,
    };
  }, [tasks.data, tasks.error, labels.data, meta.data, enabled]);
}

export function useTaskThreads(taskId: string, enabled: boolean): TaskThread[] {
  const query = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listTaskThreads",
    input: { taskId },
    enabled,
  });
  return query.data?.taskThreads ?? [];
}

export function useTaskPullRequests(taskId: string, enabled: boolean): PullRequest[] {
  const query = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listTaskPullRequests",
    input: { taskId },
    enabled,
  });
  return query.data?.pullRequests ?? [];
}

export function usePresets() {
  const query = experimental_useRpcQuery({ pluginId: TASKS_PLUGIN, contract: tasksContract, method: "listPresets", input: null });
  return query.data?.presets ?? [];
}

export interface ThreadInfo {
  id: string;
  title: string;
  environmentId: string | null;
  isWorktree: boolean;
  projectId: string;
  working: boolean;
  needsInput: boolean;
  createdAt: number;
}

const ACTIVE = new Set(["active", "provisioning", "starting", "waiting-for-host"]);

export function useThreadIndex(): ReadonlyMap<string, ThreadInfo> {
  const { threads } = experimental_useSidebarThreads();
  return useMemo(
    () =>
      new Map(
        threads.map((thread) => [
          thread.id,
          {
            id: thread.id,
            title: thread.displayTitle,
            environmentId: thread.environment?.id ?? null,
            isWorktree: thread.environment?.isWorktree === true,
            projectId: thread.projectId,
            working:
              ACTIVE.has(thread.runtimeStatus) ||
              thread.activity.backgroundAgents + thread.activity.backgroundCommands + thread.activity.workflows > 0,
            needsInput: thread.hasPendingInteraction || thread.indicator === "waiting-for-input",
            createdAt: thread.createdAt,
          },
        ]),
      ),
    [threads],
  );
}

export interface ChangeStats {
  insertions: number;
  deletions: number;
  files: number;
}

export function useChangeStats(environmentIds: readonly string[]): ReadonlyMap<string, ChangeStats> {
  const query = experimental_useRpcKeyedQuery({
    pluginId: GIT_PLUGIN,
    contract: gitContract,
    method: "status",
    keys: [...environmentIds],
    enabled: environmentIds.length > 0,
  });
  return useMemo(() => {
    const map = new Map<string, ChangeStats>();
    for (const id of environmentIds) {
      const parsed = gitStatusSchema.safeParse(query.data?.[id]);
      if (!parsed.success) continue;
      const { workingTree, mergeBase } = parsed.data.workspace;
      const base = mergeBase ?? { insertions: 0, deletions: 0, fileCount: 0 };
      const stats = {
        insertions: workingTree.insertions + base.insertions,
        deletions: workingTree.deletions + base.deletions,
        files: Math.max(workingTree.fileCount, base.fileCount),
      };
      if (stats.insertions + stats.deletions + stats.files > 0) map.set(id, stats);
    }
    return map;
  }, [query.data, environmentIds]);
}

export function useNow(): number {
  const tick = useTick(REFRESH_MS);
  return useMemo(() => Date.now(), [tick]);
}

export type MoveTask = (task: Task, status: Status, beforeTaskId: string | null, afterTaskId: string | null) => void;

export function useBoardMoves(tasks: readonly Task[]) {
  const sdk = useSdk();
  const [overrides, setOverrides] = useState<ReadonlyMap<string, { status: Status; position: number }>>(new Map());
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setOverrides((current) => {
      if (current.size === 0) return current;
      const next = new Map(current);
      for (const task of tasks) {
        const pending = next.get(task.id);
        if (pending && pending.status === task.status) next.delete(task.id);
      }
      return next.size === current.size ? current : next;
    });
  }, [tasks]);

  const merged = useMemo(
    () =>
      tasks.map((task) => {
        const pending = overrides.get(task.id);
        return pending ? { ...task, status: pending.status, position: pending.position } : task;
      }),
    [tasks, overrides],
  );

  const move: MoveTask = useCallback(
    (task, status, beforeTaskId, afterTaskId) => {
      const position = (() => {
        const byId = new Map(merged.map((item) => [item.id, item.position]));
        const before = beforeTaskId ? byId.get(beforeTaskId) : undefined;
        const after = afterTaskId ? byId.get(afterTaskId) : undefined;
        if (before !== undefined && after !== undefined) return (before + after) / 2;
        if (after !== undefined) return after - 1;
        if (before !== undefined) return before + 1;
        return task.position;
      })();
      setOverrides((current) => new Map(current).set(task.id, { status, position }));
      setError(null);
      sdk.plugins
        .callRpc({
          pluginId: TASKS_PLUGIN,
          method: "boardMove",
          input: { taskId: task.id, status, beforeTaskId, afterTaskId },
          outputSchema: tasksContract.boardMove.output,
        })
        .then((result) => {
          if (!result.ok) throw new Error(result.error.message);
        })
        .catch((reason: unknown) => {
          setOverrides((current) => {
            const next = new Map(current);
            next.delete(task.id);
            return next;
          });
          setError(reason instanceof Error ? reason.message : "Couldn't move the task");
        });
    },
    [merged, sdk],
  );

  return { tasks: merged, move, error, clearError: () => setError(null) };
}

export function byStatus(tasks: readonly Task[]): Record<Status, Task[]> {
  const groups = Object.fromEntries(STATUSES.map((status) => [status, [] as Task[]])) as Record<Status, Task[]>;
  for (const task of tasks) groups[task.status].push(task);
  for (const status of STATUSES) groups[status].sort((left, right) => left.position - right.position);
  return groups;
}
