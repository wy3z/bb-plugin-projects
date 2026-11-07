import { useEffect } from "react";
import { experimental_useAppPanel, experimental_usePanelTabs, experimental_useRpcQuery } from "@get-bb/plugin-sdk/app";
import { projectsContract } from "./meta";

export const PROJECT_TAB = { id: "manager-project", context: { kind: "thread" }, availability: "fixed" } as const;

const SWITCHED_KEY = "bb-projects:lead-panel:";

function switchedAlready(threadId: string): boolean {
  try {
    return sessionStorage.getItem(SWITCHED_KEY + threadId) === "1";
  } catch {
    return true;
  }
}

function markSwitched(threadId: string) {
  try {
    sessionStorage.setItem(SWITCHED_KEY + threadId, "1");
  } catch {
    return;
  }
}

export function useIsLeadThread({ threadId }: { threadId: string }): boolean {
  const leads = experimental_useRpcQuery({ contract: projectsContract, method: "listLeads", input: {} });
  return (leads.data?.leads ?? []).some((lead) => lead.threadId === threadId);
}

export function LeadPanelDefault({ threadId }: { threadId: string }) {
  const panel = experimental_useAppPanel();
  const tabs = experimental_usePanelTabs();
  const selected = tabs.tabs.find((tab) => tab.key === tabs.selectedKey) ?? null;
  const onInfo = selected === null || selected.detail.kind === "info";
  const hasProjectTab = tabs.tabs.some((tab) => tab.detail.kind === "plugin" && tab.detail.tab.id === PROJECT_TAB.id);

  useEffect(() => {
    if (!tabs.open || !onInfo || switchedAlready(threadId)) return;
    if (panel.openTab({ tab: PROJECT_TAB })) markSwitched(threadId);
  }, [threadId, tabs.open, onInfo, hasProjectTab, panel]);

  return null;
}
