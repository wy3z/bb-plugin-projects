import { useEffect, useState } from "react";
import { experimental_Icon as Icon, experimental_useRpcQuery, useRpc } from "@get-bb/plugin-sdk/app";
import { shortAgo } from "@wy3z/bb-suite/time";
import { NOTES_MAX, SWEEP_CHOICES, projectsContract, type ProjectMeta } from "./meta";

type LoopChange = { sweepMinutes?: number | null; sweepWorkingHours?: boolean; followPrs?: boolean };

function sweepLabel(minutes: number | null): string {
  if (minutes === null) return "Off";
  return minutes % 60 === 0 ? `Every ${minutes / 60}h` : `Every ${minutes}m`;
}

function summary(meta: ProjectMeta, inbox: number): string {
  const parts = [meta.sweepMinutes === null ? "No sweep" : `Sweep ${sweepLabel(meta.sweepMinutes).toLowerCase()}`];
  if (meta.followPrs) parts.push("follows PRs");
  if (inbox) parts.push(`${inbox} from outer loop`);
  return parts.join(" · ");
}

function Notes({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof projectsContract>();
  const notes = experimental_useRpcQuery({ contract: projectsContract, method: "getNotes", input: { projectId } });
  const saved = notes.data?.text ?? "";
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(saved), [saved]);
  const dirty = draft !== saved;
  return (
    <div className="bbp-loop__block">
      <div className="bbp-loop__label">
        Memory
        <span className="bbp-loop__hint">The lead reads this every session and adds what it learns.</span>
      </div>
      <textarea
        className="bbp-loop__notes"
        rows={5}
        maxLength={NOTES_MAX}
        value={draft}
        placeholder="Conventions, preferences and gotchas for this project"
        onChange={(event) => setDraft(event.currentTarget.value)}
      />
      {dirty ? (
        <div className="bbp-focus__actions">
          <span className="bbp-focus__spacer" />
          <button type="button" className="bbp-text-button" disabled={saving} onClick={() => setDraft(saved)}>
            Discard
          </button>
          <button
            type="button"
            className="bbp-text-button"
            data-variant="primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void rpc.call("setNotes", { projectId, text: draft }).finally(() => setSaving(false));
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function LoopCard({
  projectId,
  meta,
  onChange,
  defaultOpen = false,
}: {
  projectId: string;
  meta: ProjectMeta | null;
  onChange: (change: LoopChange) => Promise<unknown>;
  defaultOpen?: boolean;
}) {
  const inbox = experimental_useRpcQuery({ contract: projectsContract, method: "listInbox", input: { projectId } });
  const [open, setOpen] = useState(defaultOpen);
  if (meta === null || !meta.leadThreadId) return null;
  const items = inbox.data?.items ?? [];
  const now = Date.now();

  return (
    <section className="bbp-loop" data-open={open || undefined}>
      <button type="button" className="bbp-loop__head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="RotateCcw" />
        <span className="bbp-focus__eyebrow">Loop</span>
        <span className="bbp-loop__summary">{summary(meta, items.length)}</span>
        <Icon name={open ? "ChevronUp" : "ChevronDown"} />
      </button>
      {open ? (
        <div className="bbp-loop__body">
          <div className="bbp-loop__row">
            <span className="bbp-loop__label">Sweep the board</span>
            <select
              className="bbp-loop__select"
              value={meta.sweepMinutes ?? ""}
              onChange={(event) => void onChange({ sweepMinutes: event.currentTarget.value ? Number(event.currentTarget.value) : null })}
            >
              {SWEEP_CHOICES.map((minutes) => (
                <option key={minutes ?? "off"} value={minutes ?? ""}>
                  {sweepLabel(minutes)}
                </option>
              ))}
              {meta.sweepMinutes !== null && !(SWEEP_CHOICES as readonly (number | null)[]).includes(meta.sweepMinutes) ? (
                <option value={meta.sweepMinutes}>{sweepLabel(meta.sweepMinutes)}</option>
              ) : null}
            </select>
          </div>
          {meta.sweepMinutes !== null ? (
            <label className="bbp-loop__row bbp-loop__check">
              <input type="checkbox" checked={meta.sweepWorkingHours} onChange={(event) => void onChange({ sweepWorkingHours: event.currentTarget.checked })} />
              <span>Weekdays 08:00–19:00 only</span>
              {meta.sweepLastAt ? <span className="bbp-loop__hint">last {shortAgo(Date.parse(meta.sweepLastAt), now)}</span> : null}
            </label>
          ) : null}
          <label className="bbp-loop__row bbp-loop__check">
            <input type="checkbox" checked={meta.followPrs} onChange={(event) => void onChange({ followPrs: event.currentTarget.checked })} />
            <span>Follow every PR its workers open</span>
          </label>
          <Notes projectId={projectId} />
          <div className="bbp-loop__block">
            <div className="bbp-loop__label">
              From the outer loop
              <span className="bbp-loop__hint">
                <code>bb projects send</code>, from Grok Bot over bb MCP or any routine
              </span>
            </div>
            {items.length === 0 ? (
              <p className="bbp-loop__empty">Nothing yet.</p>
            ) : (
              <ul className="bbp-loop__inbox">
                {items.slice(0, 6).map((item) => (
                  <li key={item.at} data-delivery={item.delivery}>
                    <span className="bbp-loop__source">{item.source}</span>
                    <span className="bbp-loop__text" title={item.text}>
                      {item.text}
                    </span>
                    {item.ref ? (
                      <a className="bbp-loop__ref" href={item.ref} target="_blank" rel="noreferrer" aria-label="Open the origin">
                        <Icon name="ExternalLink" />
                      </a>
                    ) : null}
                    <span className="bbp-loop__hint">{item.delivery === "failed" ? "failed" : shortAgo(Date.parse(item.at), now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}
