import { useEffect, useState } from "react";
import {
  Markdown,
  experimental_Icon as Icon,
  experimental_useRpcQuery,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { STATUSES, TASKS_PLUGIN, tasksContract, type Preset, type PullRequest, type Status, type Task } from "./contracts";
import { renderTitle, type CardContext } from "./Card";
import { useTaskPullRequests, useTaskThreads } from "./data";
import { Dot, PriorityGlyph, STATUS_LABEL, StatusGlyph, formatElapsed } from "./glyphs";

const PR_ICON: Record<PullRequest["state"], string> = {
  open: "GitPullRequest",
  draft: "GitPullRequestDraft",
  merged: "GitMerge",
  closed: "GitPullRequestClosed",
};

export function openInTasks(key: string) {
  window.history.pushState(window.history.state, "", `/plugins/tasks/tasks/task/${encodeURIComponent(key)}`);
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

export function TaskDetail({
  task,
  ctx,
  onClose,
  onStatus,
  compact,
  projectName,
}: {
  task: Task;
  ctx: CardContext;
  compact: boolean;
  projectName: string;
  onClose: () => void;
  onStatus: (task: Task, status: Status) => void;
}) {
  const navigate = useBbNavigate();
  const sdk = useSdk();
  const threads = useTaskThreads(task.id, true);
  const pullRequests = useTaskPullRequests(task.id, true);
  const comments = experimental_useRpcQuery({
    pluginId: TASKS_PLUGIN,
    contract: tasksContract,
    method: "listComments",
    input: { taskId: task.id },
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: "good" | "bad"; text: string } | null>(null);
  const labels = task.labelIds.map((id) => ctx.labels.get(id)).filter((label) => label !== undefined);
  const recent = (comments.data?.comments ?? []).slice(-5).reverse();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(event.target as HTMLElement).closest("input, textarea, select")) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => setNote(null), [task.id]);

  const delegate = async (preset: Preset) => {
    setBusy(preset.id);
    setNote(null);
    try {
      const result = await sdk.plugins.callRpc({
        pluginId: TASKS_PLUGIN,
        method: "delegate",
        input: { taskId: task.id, presetId: preset.id },
        outputSchema: tasksContract.delegate.output,
      });
      setNote({ tone: "good", text: `Delegated to ${preset.name}` });
      if (result.threadId) navigate.toThread(result.threadId, { split: true });
    } catch (error) {
      setNote({ tone: "bad", text: error instanceof Error ? error.message : "Couldn't delegate" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <aside className="bbp-detail" aria-label={`${task.key} details`} key={task.id}>
      <header className="bbp-detail__head">
        {compact ? (
          <button type="button" className="bbp-back" onClick={onClose} title="Back (Esc)">
            <Icon name="ChevronLeft" />
            <span>{projectName}</span>
          </button>
        ) : null}
        <span className="bbp-card__key">{task.key}</span>
        <PriorityGlyph priority={task.priority} />
        <span className="bbp-detail__spacer" />
        <button type="button" className="bbp-icon-button" title="Open in Tasks" aria-label="Open in Tasks" onClick={() => openInTasks(task.key)}>
          <Icon name="ExternalLink" />
        </button>
        {compact ? null : (
          <button type="button" className="bbp-icon-button" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <Icon name="X" />
          </button>
        )}
      </header>
      <h2 className="bbp-detail__title">{renderTitle(task.title)}</h2>
      <div className="bbp-detail__props">
        <label className="bbp-detail__status">
          <StatusGlyph status={task.status} />
          <select value={task.status} aria-label="Status" onChange={(event) => onStatus(task, event.currentTarget.value as Status)}>
            {STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status]}
              </option>
            ))}
          </select>
        </label>
        {labels.map((label) => (
          <span className="bbp-label" key={label!.id} style={{ ["--bbp-label" as string]: label!.color }}>
            {label!.name}
          </span>
        ))}
      </div>

      <div className="bbp-detail__body">
        <section className="bbp-detail__section">
          {task.description.trim() ? (
            <div className="bbp-detail__markdown">
              <Markdown content={task.description} />
            </div>
          ) : (
            <p className="bbp-detail__muted">No description.</p>
          )}
        </section>

        <section className="bbp-detail__section">
          <h3>Agents</h3>
          {threads.length === 0 ? (
            <p className="bbp-detail__muted">No agent has worked on this yet.</p>
          ) : (
            threads.map((link) => {
              const info = ctx.threads.get(link.threadId);
              const tone = info?.needsInput ? "input" : info?.working || link.liveStatus === "working" ? "working" : link.liveStatus === "failed" ? "failed" : "idle";
              return (
                <button
                  type="button"
                  key={link.threadId}
                  className="bbp-detail__row"
                  onClick={(event) => navigate.toThread(link.threadId, event.ctrlKey || event.metaKey ? { split: true } : undefined)}
                >
                  <Dot tone={tone} />
                  <span className="bbp-detail__row-title">{info?.title ?? link.title}</span>
                  <span className="bbp-detail__row-meta">
                    {link.presetName} · {formatElapsed(link.attachedAt, ctx.now)}
                  </span>
                </button>
              );
            })
          )}
        </section>

        {pullRequests.length > 0 ? (
          <section className="bbp-detail__section">
            <h3>Pull requests</h3>
            {pullRequests.map((pr) => (
              <a key={pr.url} className="bbp-detail__row" href={pr.url} target="_blank" rel="noreferrer" data-pr={pr.state}>
                <Icon name={PR_ICON[pr.state]} />
                <span className="bbp-detail__row-title">{pr.title}</span>
                <span className="bbp-detail__row-meta">#{pr.number}</span>
              </a>
            ))}
          </section>
        ) : null}

        {recent.length > 0 ? (
          <section className="bbp-detail__section">
            <h3>Recent activity</h3>
            {recent.map((comment) => (
              <div key={comment.id} className="bbp-detail__comment" data-kind={comment.kind}>
                <div className="bbp-detail__comment-head">
                  <span>{comment.authorName}</span>
                  <span className="bbp-detail__row-meta">{formatElapsed(comment.createdAt, ctx.now)}</span>
                </div>
                <div className="bbp-detail__markdown">
                  <Markdown content={comment.body} />
                </div>
              </div>
            ))}
          </section>
        ) : null}
      </div>

      <footer className="bbp-detail__foot">
        {note ? (
          <span className="bbp-flash" data-tone={note.tone}>
            <Icon name={note.tone === "good" ? "CircleCheck" : "CircleX"} />
            <span>{note.text}</span>
          </span>
        ) : (
          <span className="bbp-detail__muted">Delegate</span>
        )}
        <div className="bbp-detail__presets">
          {ctx.presets.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="bbp-text-button"
              data-variant={ctx.presets[0]?.id === preset.id ? "primary" : undefined}
              disabled={busy !== null}
              onClick={() => void delegate(preset)}
            >
              {busy === preset.id ? "Starting…" : preset.name}
            </button>
          ))}
        </div>
      </footer>
    </aside>
  );
}
