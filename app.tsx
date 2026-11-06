import "./app.css";
import { useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  type ExperimentalThreadTabProps,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import { ProjectView } from "./src/ProjectView";
import { useProjects } from "./src/data";
import type { Project } from "./src/contracts";
import { projectsContract } from "./src/meta";

const PROJECT_ICON = "bb-projects:project";
const PROJECT_TAB = { id: "manager-project", context: { kind: "thread" }, availability: "fixed" } as const;

function ProjectIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8.5 8V6.5a2.5 2.5 0 0 1 2.5-2.5h6.5a2.5 2.5 0 0 1 2.5 2.5V13a2.5 2.5 0 0 1-2.5 2.5H16" />
      <rect x="4" y="8.5" width="12" height="11.5" rx="2.5" />
    </svg>
  );
}

function useManagedProject(threadId: string): { project: Project | null; projects: Project[] } {
  const { projects } = useProjects();
  const leads = experimental_useRpcQuery({ contract: projectsContract, method: "listLeads", input: {} });
  const project = useMemo(() => {
    const lead = leads.data?.leads.find((item) => item.threadId === threadId);
    return lead ? projects.find((item) => item.id === lead.projectId) ?? null : null;
  }, [leads.data, projects, threadId]);
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
    return <div className="bbp-empty">This thread isn't managing a project.</div>;
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
  app.experimental_icons.register({ name: PROJECT_ICON, component: ProjectIcon });
  app.slots.navPanel({
    id: "projects",
    title: "Projects",
    icon: PROJECT_ICON as "Layers",
    path: "projects",
    component: ProjectsPage,
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
