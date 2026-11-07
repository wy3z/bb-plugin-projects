import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Project, Status, Task } from "./contracts";
import { TaskCard, type CardContext } from "./Card";
import { byStatus, useBoardMoves, useNow, usePresets, useProjectData, useThreadIndex, type MoveTask } from "./data";
import { FilterIcon, ProjectGlyph, STATUS_LABEL, StatusGlyph } from "./glyphs";
import { FocusCard, LeadLink, useProjectMeta } from "./Focus";
import { LoopCard } from "./Loop";
import { TaskDetail } from "./TaskDetail";
import { usePopover } from "./usePopover";

type View = "board" | "list";

const BOARD_COLUMNS: Status[] = ["backlog", "todo", "in_progress", "in_review", "done"];
const LIST_ORDER: Status[] = ["in_progress", "in_review", "todo", "backlog", "done"];

const VIEW_KEY = "bb-projects:view";
const CANCELED_KEY = "bb-projects:show-canceled";

function readView(fallback: View): View {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return value === "board" || value === "list" ? value : fallback;
  } catch {
    return fallback;
  }
}

function useCheckoutEnvironment(project: Project | null, threads: ReturnType<typeof useThreadIndex>): string | null {
  return useMemo(() => {
    if (!project?.linkedBbProjectId) return null;
    const counts = new Map<string, number>();
    for (const thread of threads.values()) {
      if (thread.projectId !== project.linkedBbProjectId || thread.isWorktree || !thread.environmentId) continue;
      counts.set(thread.environmentId, (counts.get(thread.environmentId) ?? 0) + 1);
    }
    let best: string | null = null;
    let most = 0;
    for (const [id, count] of counts) {
      if (count > most) {
        best = id;
        most = count;
      }
    }
    return best;
  }, [project, threads]);
}

function matches(task: Task, query: string): boolean {
  if (query === "") return true;
  const needle = query.toLowerCase();
  return task.title.toLowerCase().includes(needle) || task.key.toLowerCase().includes(needle);
}

export function ProjectView({
  projects,
  projectId,
  onProjectChange,
  compact,
}: {
  projects: readonly Project[];
  projectId: string;
  onProjectChange?: (projectId: string) => void;
  compact: boolean;
}) {
  const project = projects.find((item) => item.id === projectId) ?? null;
  const data = useProjectData(projectId);
  const { tasks, move, error, clearError } = useBoardMoves(data.tasks);
  const threads = useThreadIndex();
  const presets = usePresets();
  const now = useNow();
  const targetEnvironmentId = useCheckoutEnvironment(project, threads);
  const { meta, setFocus, setLoop } = useProjectMeta(projectId);
  const [view, setView] = useState<View>(() => (compact ? "list" : readView("board")));
  const [query, setQuery] = useState("");
  const [showCanceled, setShowCanceled] = useState(() => {
    try {
      return localStorage.getItem(CANCELED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const visible = useMemo(() => tasks.filter((task) => matches(task, query.trim())), [tasks, query]);
  const groups = useMemo(() => byStatus(visible), [visible]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const ctx: CardContext = {
    labels: data.labels,
    threads,
    presets,
    targetEnvironmentId,
    now,
    selectedId,
    onSelect: (task) => setSelectedId((current) => (current === task.id ? null : task.id)),
  };

  const changeView = (next: View) => {
    setView(next);
    if (!compact) {
      try {
        localStorage.setItem(VIEW_KEY, next);
      } catch {
        return;
      }
    }
  };

  return (
    <div className="bbp-project" data-compact={compact || undefined}>
      <div className="bbp-toolbar">
        <div className="bbp-toolbar__title">
          <span className="bbp-toolbar__icon" aria-hidden="true">
            <ProjectGlyph />
          </span>
          {projects.length > 1 && onProjectChange ? (
            <label className="bbp-select">
              <select value={projectId} onChange={(event) => onProjectChange(event.currentTarget.value)} aria-label="Project">
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <Icon name="ChevronDown" />
            </label>
          ) : (
            <span className="bbp-toolbar__name">{project?.name ?? "Project"}</span>
          )}
        </div>
        <div className="bbp-toolbar__actions">
          <LeadLink threadId={meta?.leadThreadId ?? null} threads={threads} />
          <SearchControl query={query} onChange={setQuery} />
          <FilterMenu
            showCanceled={showCanceled}
            onShowCanceled={(value) => {
              setShowCanceled(value);
              try {
                localStorage.setItem(CANCELED_KEY, value ? "1" : "0");
              } catch {
                return;
              }
            }}
          />
          <ProjectMenu focus={meta?.focus ?? null}>
            <FocusCard meta={meta} onSave={setFocus} />
            <LoopCard projectId={projectId} meta={meta} onChange={setLoop} defaultOpen />
          </ProjectMenu>
          <div className="bbp-segmented" role="radiogroup" aria-label="View">
            <button type="button" role="radio" aria-checked={view === "list"} onClick={() => changeView("list")}>
              List
            </button>
            <button type="button" role="radio" aria-checked={view === "board"} onClick={() => changeView("board")}>
              Board
            </button>
          </div>
        </div>
      </div>
      {error ? (
        <div className="bbp-error" role="alert">
          <Icon name="AlertTriangle" />
          <span>{error}</span>
          <button type="button" className="bbp-icon-button" aria-label="Dismiss" onClick={clearError}>
            <Icon name="X" />
          </button>
        </div>
      ) : null}
      {data.loading ? (
        <div className="bbp-empty">Loading…</div>
      ) : data.error ? (
        <div className="bbp-empty">Couldn't load tasks: {data.error}</div>
      ) : tasks.length === 0 ? (
        <div className="bbp-empty">No tasks yet. Create one in Tasks, or ask the project lead to plan some.</div>
      ) : (
        <div className="bbp-split" data-detail={selected ? "" : undefined}>
          {compact && selected ? null : view === "board" ? (
            <Board groups={groups} columns={showCanceled ? [...BOARD_COLUMNS, "canceled"] : BOARD_COLUMNS} activeThreads={data.activeThreads} ctx={ctx} move={move} />
          ) : (
            <List groups={groups} order={showCanceled ? [...LIST_ORDER, "canceled"] : LIST_ORDER} activeThreads={data.activeThreads} ctx={ctx} />
          )}
          {selected ? (
            <TaskDetail
              task={selected}
              ctx={ctx}
              onClose={() => setSelectedId(null)}
              compact={compact}
              projectName={project?.name ?? "Project"}
              onStatus={(task, status) => move(task, status, null, null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function SearchControl({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const shown = open || query !== "";
  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  if (!shown) {
    return (
      <button type="button" className="bbp-toggle" title="Search tasks" aria-label="Search tasks" onClick={() => setOpen(true)}>
        <Icon name="Search" />
      </button>
    );
  }
  return (
    <label className="bbp-search">
      <Icon name="Search" />
      <input
        ref={input}
        value={query}
        placeholder="Search tasks"
        aria-label="Search tasks"
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={() => {
          if (query === "") setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          onChange("");
          setOpen(false);
        }}
      />
    </label>
  );
}

function FilterMenu({ showCanceled, onShowCanceled }: { showCanceled: boolean; onShowCanceled: (value: boolean) => void }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="bbp-anchor" ref={ref}>
      <button
        type="button"
        className="bbp-toggle"
        title="Filter"
        aria-label="Filter"
        aria-expanded={open}
        data-active={showCanceled || undefined}
        onClick={() => setOpen(!open)}
      >
        <FilterIcon />
      </button>
      {open ? (
        <div className="bbp-menu" role="menu">
          <label className="bbp-menu__item bbp-menu__check">
            <StatusGlyph status="canceled" />
            <span>Show canceled</span>
            <input type="checkbox" checked={showCanceled} onChange={(event) => onShowCanceled(event.currentTarget.checked)} />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function ProjectMenu({ focus, children }: { focus: string | null; children: ReactNode }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="bbp-anchor" ref={ref}>
      <button
        type="button"
        className="bbp-toggle"
        title={focus ? `Focus: ${focus}` : "Focus, loop and memory"}
        aria-label="Focus, loop and memory"
        aria-expanded={open}
        aria-pressed={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name="Target" />
      </button>
      {open ? <div className="bbp-popover">{children}</div> : null}
    </div>
  );
}

function Board({
  groups,
  columns,
  activeThreads,
  ctx,
  move,
}: {
  groups: Record<Status, Task[]>;
  columns: Status[];
  activeThreads: ReturnType<typeof useProjectData>["activeThreads"];
  ctx: CardContext;
  move: MoveTask;
}) {
  const [drag, setDrag] = useState<Task | null>(null);
  const [drop, setDrop] = useState<{ status: Status; index: number } | null>(null);
  const columnRefs = useRef(new Map<Status, HTMLDivElement>());

  useEffect(() => {
    if (drag === null) setDrop(null);
  }, [drag]);

  const dropIndex = (status: Status, clientY: number, draggedId: string | undefined = drag?.id): number => {
    const list = columnRefs.current.get(status);
    if (!list) return 0;
    const cards = [...list.querySelectorAll<HTMLElement>("[data-card-id]")].filter((el) => el.dataset.cardId !== draggedId);
    const index = cards.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return clientY < rect.top + rect.height / 2;
    });
    return index === -1 ? cards.length : index;
  };

  const onDrop = (event: DragEvent, status: Status) => {
    const key = event.dataTransfer.getData("text/plain");
    const dragged = drag ?? Object.values(groups).flat().find((task) => task.key === key) ?? null;
    setDrag(null);
    setDrop(null);
    if (!dragged) return;
    const index = dropIndex(status, event.clientY, dragged.id);
    const ids = groups[status].map((task) => task.id).filter((id) => id !== dragged.id);
    const beforeTaskId = ids[index - 1] ?? null;
    const afterTaskId = ids[index] ?? null;
    const unchanged = dragged.status === status && groups[status].findIndex((task) => task.id === dragged.id) === index;
    if (!unchanged) move(dragged, status, beforeTaskId, afterTaskId);
  };

  return (
    <div className="bbp-board">
      {columns.map((status) => {
        const tasks = groups[status];
        const target = drop?.status === status;
        return (
          <section
            key={status}
            className="bbp-column"
            data-status={status}
            data-drop={target || undefined}
            onDragOver={(event: DragEvent) => {
              if (!drag && !event.dataTransfer.types.includes("text/plain")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const index = dropIndex(status, event.clientY);
              if (drop?.status !== status || drop.index !== index) setDrop({ status, index });
            }}
            onDragLeave={(event) => {
              if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node)) {
                setDrop((current) => (current?.status === status ? null : current));
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              onDrop(event, status);
            }}
          >
            <header className="bbp-column__head">
              <StatusGlyph status={status} />
              <span className="bbp-column__title">{STATUS_LABEL[status]}</span>
              <span className="bbp-column__count">{tasks.length}</span>
            </header>
            <div
              className="bbp-column__cards"
              ref={(el) => {
                if (el) columnRefs.current.set(status, el);
                else columnRefs.current.delete(status);
              }}
            >
              {(() => {
                let slot = 0;
                return tasks.map((task) => {
                  const isDragged = task.id === drag?.id;
                  const here = !isDragged ? slot++ : -1;
                  return (
                    <div key={task.id} className="bbp-slot" data-card-id={task.id}>
                      {target && !isDragged && drop.index === here ? <div className="bbp-drop-line" /> : null}
                      <TaskCard
                        task={task}
                        activeThreads={activeThreads.get(task.id) ?? []}
                        ctx={ctx}
                        layout="board"
                        dragging={isDragged}
                        onDragStart={(event, dragged) => {
                          event.dataTransfer.effectAllowed = "move";
                          event.dataTransfer.setData("text/plain", dragged.key);
                          window.requestAnimationFrame(() => setDrag(dragged));
                        }}
                        onDragEnd={() => setDrag(null)}
                      />
                    </div>
                  );
                });
              })()}
              {target && drop.index >= tasks.filter((task) => task.id !== drag?.id).length ? <div className="bbp-drop-line" /> : null}
              {tasks.length === 0 && !target ? <div className="bbp-column__empty">Nothing here</div> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function List({
  groups,
  order,
  activeThreads,
  ctx,
}: {
  groups: Record<Status, Task[]>;
  order: Status[];
  activeThreads: ReturnType<typeof useProjectData>["activeThreads"];
  ctx: CardContext;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<Status>>(() => new Set<Status>(["backlog", "canceled"]));
  return (
    <div className="bbp-list">
      {order.map((status) => {
        const tasks = groups[status];
        if (tasks.length === 0) return null;
        const closed = collapsed.has(status);
        return (
          <section key={status} className="bbp-group" data-status={status}>
            <button
              type="button"
              className="bbp-group__head"
              aria-expanded={!closed}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(status)) next.delete(status);
                  else next.add(status);
                  return next;
                })
              }
            >
              <Icon name="ChevronDown" />
              <StatusGlyph status={status} />
              <span className="bbp-column__title">{STATUS_LABEL[status]}</span>
              <span className="bbp-column__count">{tasks.length}</span>
            </button>
            {closed ? null : (
              <div className="bbp-group__rows">
                {tasks.map((task) => (
                  <TaskCard key={task.id} task={task} activeThreads={activeThreads.get(task.id) ?? []} ctx={ctx} layout="row" dragging={false} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
