import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  ThreadChat,
  useBbContext,
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { projectsContract } from "./meta";

const STORE_KEY = "bb-projects:tabs";
const HOST_ATTR = "data-bb-projects-tabs";
const CHAT_ATTR = "data-bb-projects-chat";
const HEADER_SELECTOR = "header:has([data-thread-header-workflow-actions])";

type TabStore = Record<string, string[]>;

function readStore(): TabStore {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as TabStore;
  } catch {
    return {};
  }
}

function createStore<T>(initial: T, persist?: (value: T) => void) {
  const listeners = new Set<() => void>();
  let value = initial;
  return {
    get: () => value,
    set(next: T) {
      value = next;
      persist?.(next);
      for (const listener of listeners) listener();
    },
    use(): T {
      return useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => value,
      );
    },
  };
}

const tabStore = createStore<TabStore>(readStore(), (next) => {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    void 0;
  }
});

const viewStore = createStore<Record<string, string>>({});

function setView(leadId: string, id: string | null) {
  const next = { ...viewStore.get() };
  if (id) next[leadId] = id;
  else delete next[leadId];
  viewStore.set(next);
}

function findHeader(): HTMLElement | null {
  const headers = [...document.querySelectorAll<HTMLElement>(HEADER_SELECTOR)];
  if (headers.length === 1) return headers[0]!;
  return headers.find((header) => header.querySelector("[data-pane-header-focus-tab]") || header.querySelector(".bbp-tabs-host")) ?? null;
}

function useMountedHost(active: boolean, key: string, locate: () => HTMLElement | null, mount: (slot: HTMLElement, node: HTMLElement) => void, className: string, attr: string) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      setHost(null);
      return;
    }
    let current: HTMLElement | null = null;
    let marked: HTMLElement | null = null;
    const attach = () => {
      const slot = locate();
      if (current && slot && current.parentElement === slot) return;
      current?.remove();
      marked?.removeAttribute(attr);
      current = null;
      marked = null;
      if (!slot) {
        setHost(null);
        return;
      }
      const node = document.createElement("div");
      node.className = className;
      mount(slot, node);
      marked = slot.closest<HTMLElement>("header") ?? slot;
      marked.setAttribute(attr, "");
      current = node;
      setHost(node);
    };
    attach();
    const observer = new MutationObserver(() => attach());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      marked?.removeAttribute(attr);
      current?.remove();
      setHost(null);
    };
  }, [active, key]);

  return host;
}

function locateTabSlot(): HTMLElement | null {
  return findHeader()?.querySelector<HTMLElement>('[data-testid="app-page-header-content-row"] > div > div') ?? null;
}

function locateThreadWindow(): HTMLElement | null {
  const header = findHeader();
  const pane = header?.closest<HTMLElement>("[data-split-pane-id]") ?? document;
  return pane.querySelector<HTMLElement>("[data-thread-window]");
}

const WORKING = new Set(["runtime", "workflow", "background-agent", "background-command", "goal", "plan-mode", "working-draft"]);

function TabStatus({ thread }: { thread: PluginSidebarThread | undefined }) {
  if (!thread) return <span className="bbp-tabs__dot" data-tone="idle" aria-label="Idle" />;
  const { indicator } = thread;
  if (WORKING.has(indicator)) return <span className="bbs-live-orb" role="img" aria-label="Working" />;
  if (indicator === "waiting-for-input") return <span className="bbp-tabs__dot" data-tone="input" aria-label="Needs your input" />;
  if (indicator === "unread-error" || indicator === "queued-failed") return <span className="bbp-tabs__dot" data-tone="failed" aria-label="Failed" />;
  if (thread.isUnread) return <span className="bbp-tabs__dot" data-tone="unread" aria-label="Unread" />;
  return <span className="bbp-tabs__dot" data-tone="idle" aria-label="Idle" />;
}

export function ManagerTabs() {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const { threads } = experimental_useSidebarThreads();
  const leads = experimental_useRpcQuery({ contract: projectsContract, method: "listLeads", input: {} });
  const store = tabStore.use();
  const views = viewStore.use();

  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const leadIds = useMemo(() => new Set((leads.data?.leads ?? []).map((lead) => lead.threadId)), [leads.data]);

  const leadId = useMemo(() => {
    let cursor = threadId ? byId.get(threadId) : undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      if (leadIds.has(cursor.id)) return cursor.id;
      seen.add(cursor.id);
      cursor = cursor.parentThreadId ? byId.get(cursor.parentThreadId) : undefined;
    }
    return null;
  }, [byId, leadIds, threadId]);

  const tabs = useMemo(() => {
    if (!leadId) return [];
    const open = (store[leadId] ?? []).filter((id) => id !== leadId && byId.has(id));
    return [leadId, ...open];
  }, [byId, leadId, store]);

  const onLead = leadId !== null && threadId === leadId;
  const overlayId = onLead && views[leadId] && tabs.includes(views[leadId]!) ? views[leadId]! : null;
  const selectedId = overlayId ?? threadId;

  useEffect(() => {
    if (!leadId || !threadId || threadId === leadId) return;
    const open = tabStore.get()[leadId] ?? [];
    if (!open.includes(threadId)) tabStore.set({ ...tabStore.get(), [leadId]: [...open, threadId] });
  }, [leadId, threadId]);

  const select = useCallback(
    (id: string) => {
      if (!leadId) return;
      setView(leadId, id === leadId ? null : id);
      if (!onLead) navigate.toThread(leadId);
    },
    [leadId, navigate, onLead],
  );

  const close = useCallback(
    (id: string) => {
      if (!leadId) return;
      const index = tabs.indexOf(id);
      tabStore.set({ ...tabStore.get(), [leadId]: (tabStore.get()[leadId] ?? []).filter((item) => item !== id) });
      if (id === selectedId) select(tabs[index - 1] ?? leadId);
    },
    [leadId, select, selectedId, tabs],
  );

  const tabHost = useMountedHost(leadId !== null, `${leadId}:${threadId}`, locateTabSlot, (slot, node) => slot.prepend(node), "bbp-tabs-host", HOST_ATTR);
  const chatHost = useMountedHost(overlayId !== null, `${leadId}:${threadId}`, locateThreadWindow, (slot, node) => slot.append(node), "bbp-chat-host", CHAT_ATTR);

  if (!tabHost || !leadId) return null;

  return (
    <>
      {createPortal(
        <div className="bbp-tabs" role="tablist" aria-label="Project threads">
          {tabs.map((id) => {
            const thread = byId.get(id);
            const selected = id === selectedId;
            const isLead = id === leadId;
            return (
              <div key={id} className="bbp-tabs__tab" data-selected={selected || undefined} data-lead={isLead || undefined}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  className="bbp-tabs__label"
                  title={thread?.displayTitle}
                  onClick={() => {
                    if (!selected) select(id);
                  }}
                  onAuxClick={(event) => {
                    if (event.button === 1 && !isLead) {
                      event.preventDefault();
                      close(id);
                    }
                  }}
                >
                  <TabStatus thread={thread} />
                  {isLead ? <Icon name={"bb-projects:project" as "Layers"} className="bbp-tabs__icon size-3.5" /> : null}
                  <span className="bbp-tabs__text">{thread?.displayTitle ?? "Thread"}</span>
                </button>
                {isLead ? null : (
                  <button type="button" className="bbp-tabs__close" aria-label={`Close ${thread?.displayTitle ?? "tab"}`} onClick={() => close(id)}>
                    <Icon name="X" className="size-3" />
                  </button>
                )}
              </div>
            );
          })}
        </div>,
        tabHost,
      )}
      {chatHost && overlayId ? createPortal(<ThreadChat key={overlayId} threadId={overlayId} variant="full" />, chatHost) : null}
    </>
  );
}
