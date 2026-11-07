import { useCallback, useEffect, useRef, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { META_CHANGED, projectsContract, type ProjectMeta } from "./meta";
import type { ThreadInfo } from "./data";

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
  const setFocus = (focus: string | null) => rpc.call("setFocus", { projectId, focus }).then(setMeta);
  const setLoop = (change: { sweepMinutes?: number | null; sweepWorkingHours?: boolean; followPrs?: boolean }) =>
    rpc.call("setLoop", { projectId, ...change }).then(setMeta);
  return { meta, setFocus, setLoop };
}

export function LeadLink({ threadId, threads }: { threadId: string | null; threads: ReadonlyMap<string, ThreadInfo> }) {
  const navigate = useBbNavigate();
  if (!threadId) return null;
  const lead = threads.get(threadId);
  return (
    <button type="button" className="bbp-lead" title="Open the project lead" onClick={() => navigate.toThread(threadId)}>
      {lead?.working ? <span className="bbp-dot" data-tone="working" aria-hidden="true" /> : null}
      <span>Lead: {lead?.title ?? threadId}</span>
    </button>
  );
}

export function FocusCard({ meta, onSave }: { meta: ProjectMeta | null; onSave: (focus: string | null) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  if (meta === null) return null;
  const save = async (value: string | null) => {
    setSaving(true);
    try {
      await onSave(value);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  if (!editing && !meta.focus) {
    return (
      <button
        type="button"
        className="bbp-focus-add"
        onClick={() => {
          setDraft("");
          setEditing(true);
        }}
      >
        <Icon name="Target" />
        Set a focus
      </button>
    );
  }

  return (
    <section className="bbp-focus" data-editing={editing || undefined}>
      <header className="bbp-focus__head">
        <span className="bbp-focus__eyebrow">Focus</span>
        {editing ? null : (
          <button
            type="button"
            className="bbp-icon-button"
            aria-label="Edit focus"
            onClick={() => {
              setDraft(meta.focus ?? "");
              setEditing(true);
            }}
          >
            <Icon name="Edit" />
          </button>
        )}
      </header>
      {editing ? (
        <>
          <textarea
            ref={ref}
            className="bbp-focus__input"
            rows={2}
            value={draft}
            maxLength={600}
            placeholder="What matters most right now, in a sentence or two"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save(draft.trim() || null);
            }}
          />
          <div className="bbp-focus__actions">
            {meta.focus ? (
              <button type="button" className="bbp-text-button" disabled={saving} onClick={() => void save(null)}>
                Clear
              </button>
            ) : null}
            <span className="bbp-focus__spacer" />
            <button type="button" className="bbp-text-button" disabled={saving} onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="bbp-text-button" data-variant="primary" disabled={saving} onClick={() => void save(draft.trim() || null)}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </>
      ) : (
        <p className="bbp-focus__text">{meta.focus}</p>
      )}
    </section>
  );
}
