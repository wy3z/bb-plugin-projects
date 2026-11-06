import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  experimental_Icon as Icon,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  useBbContext,
  useBbNavigate,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { projectsContract } from "./meta";

const STORE_KEY = "bb-projects:tabs";
const HOST_ATTR = "data-bb-projects-tabs";
const HEADER_SELECTOR = "header:has([data-thread-header-workflow-actions])";

type TabStore = Record<string, string[]>;

function readStore(): TabStore {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") as TabStore;
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
let snapshot = readStore();

function writeStore(next: TabStore) {
  snapshot = next;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(next));
  } catch {
    void 0;
  }
  for (const listener of listeners) listener();
}

function useTabStore(): TabStore {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

function findHeaderSlot(): HTMLElement | null {
  const headers = [...document.querySelectorAll<HTMLElement>(HEADER_SELECTOR)];
  const single = headers.length === 1;
  for (const header of headers) {
    if (!single && !header.querySelector("[data-pane-header-focus-tab]") && !header.querySelector(".bbp-tabs-host")) continue;
    const slot = header.querySelector<HTMLElement>('[data-testid="app-page-header-content-row"] > div > div');
    if (slot) return slot;
  }
  return null;
}

function useHeaderHost(active: boolean, threadId: string | null): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) {
      setHost(null);
      return;
    }
    let current: HTMLElement | null = null;
    const attach = () => {
      const slot = findHeaderSlot();
      if (current && slot && current.parentElement === slot && slot.firstElementChild === current) return;
      current?.remove();
      current = null;
      if (!slot) {
        setHost(null);
        return;
      }
      const node = document.createElement("div");
      node.className = "bbp-tabs-host";
      slot.prepend(node);
      slot.closest("header")?.setAttribute(HOST_ATTR, "");
      current = node;
      setHost(node);
    };
    attach();
    const observer = new MutationObserver(() => attach());
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      current?.closest("header")?.removeAttribute(HOST_ATTR);
      current?.remove();
      setHost(null);
    };
  }, [active, threadId]);

  return host;
}

const WORKING = new Set(["runtime", "workflow", "background-agent", "background-command", "goal", "plan-mode", "working-draft"]);

function TabStatus({ thread }: { thread: PluginSidebarThread | undefined }) {
  if (!thread) return null;
  const { indicator } = thread;
  if (WORKING.has(indicator)) return <Icon name="Loading" className="bbp-tabs__spin size-3" aria-label="Working" />;
  if (indicator === "waiting-for-input") return <span className="bbp-tabs__dot" data-tone="input" aria-label="Needs your input" />;
  if (indicator === "unread-error" || indicator === "queued-failed") return <span className="bbp-tabs__dot" data-tone="failed" aria-label="Failed" />;
  if (thread.isUnread) return <span className="bbp-tabs__dot" data-tone="unread" aria-label="Unread" />;
  return null;
}

export function ManagerTabs() {
  const { threadId } = useBbContext();
  const navigate = useBbNavigate();
  const { threads } = experimental_useSidebarThreads();
  const leads = experimental_useRpcQuery({ contract: projectsContract, method: "listLeads", input: {} });
  const store = useTabStore();

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

  useEffect(() => {
    if (!leadId || !threadId || threadId === leadId) return;
    const open = snapshot[leadId] ?? [];
    if (open.includes(threadId)) return;
    writeStore({ ...snapshot, [leadId]: [...open, threadId] });
  }, [leadId, threadId]);

  const close = useCallback(
    (id: string) => {
      if (!leadId) return;
      const index = tabs.indexOf(id);
      writeStore({ ...snapshot, [leadId]: (snapshot[leadId] ?? []).filter((item) => item !== id) });
      if (id === threadId) navigate.toThread(tabs[index - 1] ?? leadId);
    },
    [leadId, navigate, tabs, threadId],
  );

  const host = useHeaderHost(leadId !== null, threadId);
  if (!host || !leadId) return null;

  return createPortal(
    <div className="bbp-tabs" role="tablist" aria-label="Project threads">
      {tabs.map((id) => {
        const thread = byId.get(id);
        const selected = id === threadId;
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
                if (!selected) navigate.toThread(id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1 && !isLead) {
                  event.preventDefault();
                  close(id);
                }
              }}
            >
              {isLead ? <Icon name={"bb-projects:project" as "Layers"} className="bbp-tabs__icon size-3.5" /> : null}
              <span className="bbp-tabs__text">{thread?.displayTitle ?? "Thread"}</span>
              <TabStatus thread={thread} />
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
    host,
  );
}
