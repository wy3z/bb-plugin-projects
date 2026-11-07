import "@wy3z/bb-suite/tokens.css";
import "./app.css";
import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  experimental_useSidebarThreads,
  type ExperimentalThreadTabProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { ProjectView } from "./src/ProjectView";
import { ManagerTabs } from "./src/ManagerTabs";
import { LeadPanelDefault, PROJECT_TAB, useIsLeadThread } from "./src/LeadPanel";
import { useProjects } from "./src/data";
import type { Project } from "./src/contracts";
import { projectsContract } from "./src/meta";
import { ProjectGlyph } from "./src/glyphs";

const PROJECT_ICON = "bb-projects:project";

function useManagedProject(threadId: string): { project: Project | null; projects: Project[] } {
  const { projects } = useProjects();
  const leads = experimental_useRpcQuery({ contract: projectsContract, method: "listLeads", input: {} });
  const { threads } = experimental_useSidebarThreads();
  const project = useMemo(() => {
    const byLead = new Map((leads.data?.leads ?? []).map((item) => [item.threadId, item.projectId]));
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    const seen = new Set<string>();
    let cursor: string | null = threadId;
    while (cursor && !seen.has(cursor)) {
      const projectId = byLead.get(cursor);
      if (projectId) return projects.find((item) => item.id === projectId) ?? null;
      seen.add(cursor);
      cursor = byId.get(cursor)?.parentThreadId ?? null;
    }
    return null;
  }, [leads.data, projects, threadId, threads]);
  return { project, projects };
}
const LAST_KEY = "bb-projects:last";

function ProjectsPage({ subPath }: PluginNavPanelProps) {
  const { projects, loading } = useProjects();
  const [selected, setSelected] = useState<string | null>(() => {
    const fromPath = subPath.split("/").filter(Boolean)[0];
    if (fromPath) return fromPath;
    try {
      return localStorage.getItem(LAST_KEY);
    } catch {
      return null;
    }
  });
  const fromPath = decodeURIComponent(subPath.split("/").filter(Boolean)[0] ?? "");
  useEffect(() => {
    if (fromPath) setSelected(fromPath);
  }, [fromPath]);
  const projectId = projects.some((project) => project.id === selected) ? selected : projects[0]?.id ?? null;

  useEffect(() => {
    if (!projectId) return;
    try {
      localStorage.setItem(LAST_KEY, projectId);
    } catch {
      return;
    }
  }, [projectId]);

  if (loading) return <div className="bbp-page bbp-empty">Loading…</div>;
  if (!projectId) {
    return (
      <div className="bbp-page bbp-empty">
        No tracker projects yet. Create one with <code>bb tasks project create</code> and link it to a BB project.
      </div>
    );
  }
  return (
    <div className="bbp-page">
      <ProjectView projects={projects} projectId={projectId} onProjectChange={setSelected} compact={false} />
    </div>
  );
}

function ProjectTab({ threadId }: ExperimentalThreadTabProps) {
  const { project, projects } = useManagedProject(threadId);
  if (!project) {
    return <div className="bbp-empty">This thread isn't part of a project.</div>;
  }
  return (
    <div className="bbp-tab">
      <ProjectView projects={projects} projectId={project.id} compact />
    </div>
  );
}

function useProjectTabVisible({ threadId }: ExperimentalThreadTabProps): boolean {
  return useManagedProject(threadId).project !== null;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: PROJECT_ICON, component: ProjectGlyph });
  app.slots.navPanel({
    id: "projects",
    title: "Projects",
    icon: PROJECT_ICON as "Layers",
    path: "projects",
    component: ProjectsPage,
  });
  app.slots.experimental_appOverlay({ id: "manager-tabs", component: ManagerTabs });
  app.slots.experimental_threadContextSegment({
    id: "lead-panel",
    title: "Project board",
    group: "zz-projects",
    summary: LeadPanelDefault,
    useVisible: useIsLeadThread,
  });
  app.slots.experimental_tab({
    ...PROJECT_TAB,
    title: "Project",
    tooltip: "Project board",
    icon: PROJECT_ICON as "Layers",
    layout: "flush",
    component: ProjectTab,
    useVisible: useProjectTabVisible,
  });
});
