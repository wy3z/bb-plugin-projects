import type { BbPluginApi } from "@get-bb/plugin-sdk";

type SearchResult = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["search"]>>;
type QueueResult = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["queuedMessages"]["list"]>>;
type QueuedRow = QueueResult[number];
type SearchThread = SearchResult["active"]["results"][number]["thread"];
type EventsResult = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>;

export const capturedThread = {
  id: "thr_lead1",
  projectId: "proj_bb",
  environmentId: "env_1",
  providerId: "claude-code",
  title: "Lead for PIXEL",
  titleFallback: "Lead for PIXEL",
  sectionId: null,
  status: "active",
  parentThreadId: null,
  sourceThreadId: null,
  lifecycleOwnerThreadId: null,
  originKind: null,
  originPluginId: null,
  visibility: "visible",
  parentNotifications: "auto",
  archivedAt: null,
  pinnedAt: null,
  deletedAt: null,
  lastReadAt: 1794000000000,
  latestAttentionAt: 1794000000000,
  createdAt: 1794000000000,
  updatedAt: 1794000000000,
  activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
  queuedWork: "none",
  pinSortKey: null,
  environmentBranchName: "main",
  environmentHostId: "host_1",
  environmentName: null,
  environmentPath: "/work/pixel",
  environmentProviderId: "project-checkout",
  environmentIsWorktree: false,
  environmentWorkspaceDisplayKind: "other",
  hasPendingInteraction: false,
  runtime: { displayStatus: "active" },
} as const;

const typedThread = (id: string, archivedAt: number | null = null): SearchThread => ({
  ...capturedThread,
  id,
  archivedAt,
});

export function typedSearch(hits: { threadId: string; archived?: boolean; text: string; seq?: number; kind?: "user_message" | "assistant_message" }[]): SearchResult {
  const group = (archived: boolean) => {
    const results = hits
      .filter((hit) => Boolean(hit.archived) === archived)
      .map((hit) => ({
        thread: typedThread(hit.threadId, archived ? 1794000000000 : null),
        matches: [{ sourceKind: hit.kind ?? ("user_message" as const), sourceSeq: hit.seq ?? 12, text: hit.text, highlightRanges: [{ start: 9, end: 29 }] }],
      }));
    return { total: results.length, results };
  };
  return { active: group(false), archived: group(true) };
}

export function capturedSearch(threadId: string, text: string, sourceKind = "assistant_message", sourceSeq = 1370): unknown {
  return {
    active: {
      total: 1,
      results: [{ thread: { ...capturedThread, id: threadId }, matches: [{ highlightRanges: [{ start: 9, end: 16 }], sourceKind, sourceSeq, text }] }],
    },
    archived: { total: 0, results: [] },
  };
}

export function typedQueued(threadId: string, rows: { id: string; text: string; state: QueuedRow["state"]; waitingOn?: QueuedRow["waitingOn"]; failureReason?: string | null }[]): QueueResult {
  return rows.map((row) => ({
    content: [{ type: "text" as const, text: row.text, mentions: [] }],
    createdAt: 1794000000000,
    editable: true,
    failureReason: row.failureReason ?? null,
    groupWithNext: false,
    id: row.id,
    initiator: "user" as const,
    model: "claude-opus-5-5",
    origin: "plugin" as const,
    originPluginId: "projects",
    payload: { kind: "inline" as const },
    permissionMode: "auto" as const,
    reasoningLevel: "high",
    sendAt: null,
    senderThreadId: null,
    serviceTier: "default",
    state: row.state,
    systemNotice: null,
    threadId,
    updatedAt: 1794000000000,
    waitingOn: row.waitingOn ?? null,
  }));
}

export function typedRelayEvent(threadId: string, seq: number, text: string, senderThreadId: string | null = null): EventsResult {
  return [
    {
      id: `evt_${seq}`,
      scope: { kind: "thread" },
      threadId,
      seq,
      createdAt: 1794042959805,
      type: "client/turn/requested",
      data: {
        direction: "outbound",
        requestId: "creq_632246xiie",
        source: "tell",
        initiator: "user",
        senderThreadId,
        systemMessageKind: "unlabeled",
        systemMessageSubject: null,
        input: [{ type: "text", text, mentions: [] }],
        target: { kind: "new-turn" },
        request: { method: "turn/start", params: {} },
        execution: { model: "claude-opus-5-5", serviceTier: "default", reasoningLevel: "medium", permissionMode: "full", source: "client/turn/requested" },
      },
    },
  ] satisfies EventsResult;
}
