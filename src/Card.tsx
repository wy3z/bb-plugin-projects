import { useEffect, useRef, useState, type DragEvent } from "react";
import { experimental_Icon as Icon, useBbNavigate, useSdk } from "@get-bb/plugin-sdk/app";
import {
  PULL_REQUESTS_PLUGIN,
  TASKS_PLUGIN,
  gitActionsContract,
  tasksContract,
  type Label,
  type Preset,
  type PullRequest,
  type Task,
  type TaskThread,
} from "./contracts";
import { useChangeStats, useTaskPullRequests, useTaskThreads, type ThreadInfo } from "./data";
import { Dot, PriorityGlyph, StatusGlyph, formatElapsed } from "./glyphs";
import { openInTasks } from "./TaskDetail";

const PR_ICON: Record<PullRequest["state"], string> = {
  open: "GitPullRequest",
  draft: "GitPullRequestDraft",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

export function renderTitle(title: string) {
  return title.split(/(`[^`]+`)/g).map((part, index) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? <code key={index}>{part.slice(1, -1)}</code> : part,
  );
}

type Flash = { tone: "good" | "bad" | "busy"; text: string } | null;

export interface CardContext {
  labels: ReadonlyMap<string, Label>;
  threads: ReadonlyMap<string, ThreadInfo>;
  presets: readonly Preset[];
  targetEnvironmentId: string | null;
  now: number;
  selectedId?: string | null;
  onSelect?: (task: Task) => void;
}

function pickWorker(taskThreads: readonly TaskThread[], index: ReadonlyMap<string, ThreadInfo>) {
  const live = taskThreads
    .map((link) => ({ link, info: index.get(link.threadId) ?? null }))
    .sort((left, right) => Date.parse(right.link.attachedAt) - Date.parse(left.link.attachedAt));
  const working = live.find((item) => item.info?.working || item.link.liveStatus === "working" || item.link.liveStatus === "starting");
  const input = live.find((item) => item.info?.needsInput);
  return { latest: live[0] ?? null, working: working ?? null, input: input ?? null, count: live.length };
}

export function TaskCard({
  task,
  activeThreads,
  ctx,
  layout,
  dragging,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  activeThreads: readonly TaskThread[];
  ctx: CardContext;
  layout: "board" | "row";
  dragging: boolean;
  onDragStart?: (event: DragEvent, task: Task) => void;
  onDragEnd?: () => void;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const wantsThreads = task.status !== "backlog" || activeThreads.length > 0;
  const taskThreads = useTaskThreads(task.id, wantsThreads);
  const links = taskThreads.length > 0 ? taskThreads : activeThreads;
  const worker = pickWorker(links, ctx.threads);
  const pullRequests = useTaskPullRequests(task.id, links.length > 0);
  const workerEnv = worker.latest?.info?.isWorktree ? worker.latest.info.environmentId : null;
  const changes = useChangeStats(workerEnv ? [workerEnv] : []).get(workerEnv ?? "") ?? null;
  const openPr = pullRequests.find((pr) => pr.state === "open" || pr.state === "draft") ?? null;
  const [menu, setMenu] = useState(false);
  const [flash, setFlash] = useState<Flash>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", escape, true);
    };
  }, [menu]);

  useEffect(() => {
    if (flash === null || flash.tone === "busy") return;
    const timer = window.setTimeout(() => setFlash(null), 6000);
    return () => window.clearTimeout(timer);
  }, [flash]);

  const openTask = () => (ctx.onSelect ? ctx.onSelect(task) : openInTasks(task.key));
  const primaryThreadId = (worker.input ?? worker.working ?? worker.latest)?.link.threadId ?? null;
  const openThread = (split: boolean) => {
    if (primaryThreadId) navigate.toThread(primaryThreadId, split ? { split: true } : undefined);
  };
  const openPrimary = (split: boolean) => (primaryThreadId ? openThread(split) : openTask());

  const run = async (label: string, action: () => Promise<{ ok: boolean; text: string }>) => {
    setMenu(false);
    setFlash({ tone: "busy", text: label });
    try {
      const result = await action();
      setFlash({ tone: result.ok ? "good" : "bad", text: result.text });
    } catch (error) {
      setFlash({ tone: "bad", text: error instanceof Error ? error.message : "Something went wrong" });
    }
  };

  const delegate = (preset: Preset) =>
    run(`Starting ${preset.name}…`, async () => {
      const result = await sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN,
        method: "delegate",
        input: { taskId: task.id, presetId: preset.id },
        outputSchema: tasksContract.delegate.output,
      });
      return { ok: true, text: result.threadId ? `Delegated to ${preset.name}` : "Delegated" };
    });

  const applyLocally = () =>
    workerEnv && ctx.targetEnvironmentId
      ? run("Applying…", async () => {
          const result = await sdk.plugins.callRpc({
            pluginId: PULL_REQUESTS_PLUGIN,
            method: "gitApplyLocally",
            input: { sourceEnvironmentId: workerEnv, targetEnvironmentId: ctx.targetEnvironmentId! },
            outputSchema: gitActionsContract.gitApplyLocally.output,
          });
          return result.ok
            ? { ok: true, text: `Applied ${result.files ?? 0} ${result.files === 1 ? "file" : "files"}` }
            : { ok: false, text: result.error ?? "Apply failed" };
        })
      : undefined;

  const createPr = () =>
    workerEnv
      ? run("Creating pull request…", async () => {
          const result = await sdk.plugins.callRpc({
            pluginId: PULL_REQUESTS_PLUGIN,
            method: "gitCreatePullRequest",
            input: { environmentId: workerEnv },
            outputSchema: gitActionsContract.gitCreatePullRequest.output,
          });
          return result.ok
            ? { ok: true, text: result.existed ? "Pull request already open" : "Opened pull request" }
            : { ok: false, text: result.error ?? "Couldn't create the pull request" };
        })
      : undefined;

  const labels = task.labelIds.map((id) => ctx.labels.get(id)).filter((label): label is Label => label !== undefined);
  const agentLine = worker.input
    ? { tone: "input" as const, text: "Needs input" }
    : worker.working
      ? {
          tone: "working" as const,
          text: `Working · ${worker.working.link.presetName} · ${formatElapsed(worker.working.link.attachedAt, ctx.now)}`,
        }
      : worker.latest
        ? {
            tone: worker.latest.link.liveStatus === "failed" ? ("failed" as const) : ("idle" as const),
            text: `${worker.latest.link.liveStatus === "failed" ? "Failed" : "Worked"} · ${worker.count} ${worker.count === 1 ? "agent" : "agents"}`,
          }
        : null;

  return (
    <article
      className="bbp-card"
      data-layout={layout}
      data-status={task.status}
      data-dragging={dragging || undefined}
      data-selected={ctx.selectedId === task.id || undefined}
      data-working={agentLine?.tone === "working" || undefined}
      draggable={layout === "board"}
      tabIndex={0}
      aria-label={`${task.key} ${task.title}`}
      title={primaryThreadId ? "Open the agent's thread (Ctrl-click for a split)" : "Open the task"}
      onDragStart={(event) => onDragStart?.(event, task)}
      onDragEnd={() => onDragEnd?.()}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("button, a, [data-menu]")) return;
        openPrimary(event.metaKey || event.ctrlKey || event.altKey);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") openPrimary(event.metaKey || event.ctrlKey);
      }}
    >
      <header className="bbp-card__head">
        {layout === "row" ? <StatusGlyph status={task.status} /> : null}
        <span className="bbp-card__key">{task.key}</span>
        {labels.map((label) => (
          <span className="bbp-label" key={label.id} style={{ ["--bbp-label" as string]: label.color }}>
            {label.name}
          </span>
        ))}
        <PriorityGlyph priority={task.priority} />
        <div className="bbp-card__tools" data-menu="" ref={menuRef} data-open={menu || undefined}>
          {worker.latest ? (
            <button type="button" className="bbp-icon-button" title="Open agent (Ctrl-click for a split)" aria-label="Open agent" onClick={(event) => openThread(event.ctrlKey || event.metaKey)}>
              <Icon name="ArrowUpRight" />
            </button>
          ) : null}
          <button type="button" className="bbp-icon-button" aria-label="Task actions" aria-expanded={menu} onClick={() => setMenu((open) => !open)}>
            <Icon name="MoreHorizontal" />
          </button>
          {menu ? (
            <div className="bbp-menu" role="menu">
              <div className="bbp-menu__label">Delegate to</div>
              {ctx.presets.length === 0 ? (
                <div className="bbp-menu__empty">No presets yet. Add one in Tasks.</div>
              ) : (
                ctx.presets.map((preset) => (
                  <button type="button" role="menuitem" className="bbp-menu__item" key={preset.id} onClick={() => void delegate(preset)}>
                    <Icon name="Play" />
                    <span>{preset.name}</span>
                  </button>
                ))
              )}
              {workerEnv ? <div className="bbp-menu__sep" /> : null}
              {workerEnv && ctx.targetEnvironmentId ? (
                <button type="button" role="menuitem" className="bbp-menu__item" onClick={() => void applyLocally()}>
                  <Icon name="Download" />
                  <span>Apply locally</span>
                </button>
              ) : null}
              {workerEnv && !openPr ? (
                <button type="button" role="menuitem" className="bbp-menu__item" onClick={() => void createPr()}>
                  <Icon name="GitPullRequest" />
                  <span>Create PR</span>
                </button>
              ) : null}
              <div className="bbp-menu__sep" />
              {ctx.onSelect ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bbp-menu__item"
                  onClick={() => {
                    setMenu(false);
                    ctx.onSelect?.(task);
                  }}
                >
                  <Icon name="Eye" />
                  <span>Details</span>
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="bbp-menu__item"
                onClick={() => {
                  setMenu(false);
                  openInTasks(task.key);
                }}
              >
                <Icon name="ExternalLink" />
                <span>Open in Tasks</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>
      <div className="bbp-card__title">{renderTitle(task.title)}</div>
      {agentLine || pullRequests.length > 0 || changes || flash ? (
        <footer className="bbp-card__foot">
          {flash ? (
            <span className="bbp-flash" data-tone={flash.tone} key={flash.text}>
              {flash.tone === "busy" ? <Dot tone="working" /> : <Icon name={flash.tone === "good" ? "CircleCheck" : "CircleX"} />}
              <span>{flash.text}</span>
            </span>
          ) : agentLine ? (
            <span className="bbp-agent" data-tone={agentLine.tone}>
              <Dot tone={agentLine.tone} />
              <span className="bbp-agent__text" data-shimmer={agentLine.tone === "working" || undefined}>
                {agentLine.text}
              </span>
            </span>
          ) : null}
          <span className="bbp-card__chips">
            {changes ? (
              <button
                type="button"
                className="bbp-chip"
                title={`${changes.files} changed ${changes.files === 1 ? "file" : "files"} in the agent's worktree`}
                onClick={() => openThread(true)}
              >
                <span className="bbp-diff" data-sign="plus">+{changes.insertions}</span>
                <span className="bbp-diff" data-sign="minus">−{changes.deletions}</span>
              </button>
            ) : null}
            {pullRequests.slice(0, 2).map((pr) => (
              <a
                className="bbp-chip"
                data-pr={pr.state}
                key={pr.url}
                href={pr.url}
                target="_blank"
                rel="noreferrer"
                title={`${pr.title} (${pr.state})`}
              >
                <Icon name={PR_ICON[pr.state]} />#{pr.number}
              </a>
            ))}
          </span>
        </footer>
      ) : null}
    </article>
  );
}
