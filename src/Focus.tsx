import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { META_CHANGED, projectsContract, type ProjectMeta } from "./meta";

export function useProjectMeta(projectId: string) {
  const rpc = useRpc<typeof projectsContract>();
  const [meta, setMeta] = useState<ProjectMeta | null>(null);
  const load = useCallback(() => {
    rpc.call("getMeta", { projectId }).then(setMeta, () =>
      setMeta({ focus: null, focusUpdatedAt: null, leadThreadId: null, sweepMinutes: null, sweepWorkingHours: true, sweepLastAt: null, followPrs: false }),
    );
  }, [rpc, projectId]);
  useEffect(load, [load]);
  useRealtime(META_CHANGED, (payload) => {
    if ((payload as { projectId?: string } | null)?.projectId === projectId) load();
  });
  const setLoop = (change: { sweepMinutes?: number | null; sweepWorkingHours?: boolean; followPrs?: boolean }) =>
    rpc.call("setLoop", { projectId, ...change }).then(setMeta);
  return { meta, setLoop };
}
