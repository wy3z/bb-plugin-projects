import { shortAge } from "@wy3z/bb-suite/time";
import type { Priority, Status } from "./contracts";

export const STATUS_LABEL: Record<Status, string> = {
  backlog: "Backlog",
  todo: "Queued",
  in_progress: "In Progress",
  in_review: "For Review",
  done: "Done",
  canceled: "Canceled",
};

const RING: Record<Status, number> = {
  backlog: 0,
  todo: 0,
  in_progress: 0.5,
  in_review: 0.75,
  done: 1,
  canceled: 0,
};

export function StatusGlyph({ status }: { status: Status }) {
  const fill = RING[status];
  const r = 3.2;
  const c = 2 * Math.PI * r;
  return (
    <svg className="bbp-status" data-status={status} viewBox="0 0 14 14" aria-hidden="true" focusable="false">
      <circle
        cx="7"
        cy="7"
        r="5.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeDasharray={status === "backlog" ? "1.6 1.9" : undefined}
      />
      {status === "done" ? (
        <>
          <circle cx="7" cy="7" r="5.6" fill="currentColor" />
          <path d="m4.6 7.1 1.7 1.7 3.2-3.4" fill="none" stroke="var(--bbp-glyph-ink)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      ) : status === "canceled" ? (
        <>
          <circle cx="7" cy="7" r="5.6" fill="currentColor" />
          <path d="m5 5 4 4m0-4-4 4" fill="none" stroke="var(--bbp-glyph-ink)" strokeWidth="1.5" strokeLinecap="round" />
        </>
      ) : fill > 0 ? (
        <circle
          cx="7"
          cy="7"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={r * 2}
          strokeDasharray={`${c * fill} ${c}`}
          transform="rotate(-90 7 7)"
        />
      ) : null}
    </svg>
  );
}

export function PriorityGlyph({ priority }: { priority: Priority }) {
  if (priority === "none") return null;
  if (priority === "urgent") {
    return (
      <svg className="bbp-priority" data-priority="urgent" viewBox="0 0 14 14" aria-label="Urgent" role="img">
        <rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor" />
        <path d="M7 4v3.6" stroke="var(--bbp-glyph-ink)" strokeWidth="1.6" strokeLinecap="round" />
        <circle cx="7" cy="9.9" r="0.95" fill="var(--bbp-glyph-ink)" />
      </svg>
    );
  }
  const bars = priority === "high" ? 3 : priority === "medium" ? 2 : 1;
  return (
    <svg className="bbp-priority" data-priority={priority} viewBox="0 0 14 14" aria-label={`${priority} priority`} role="img">
      {[0, 1, 2].map((index) => (
        <rect
          key={index}
          x={2 + index * 3.6}
          y={9.5 - index * 2.8}
          width="2.4"
          height={2.5 + index * 2.8}
          rx="0.8"
          fill="currentColor"
          opacity={index < bars ? 1 : 0.28}
        />
      ))}
    </svg>
  );
}

export function Dot({ tone }: { tone: "working" | "input" | "failed" | "idle" }) {
  if (tone === "working") return <span className="bbs-live-orb" aria-hidden="true" />;
  return <span className="bbp-dot" data-tone={tone} aria-hidden="true" />;
}

export function formatElapsed(fromIso: string | number, now: number): string {
  return shortAge(fromIso, now);
}

export function ProjectGlyph({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
      <path d="M8.5 7.5v8" />
      <path d="M12 7.5v4" />
      <path d="M15.5 7.5v6" />
    </svg>
  );
}

export function FilterIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true" focusable="false">
      <path d="M2.5 4.5h11" />
      <path d="M4.5 8h7" />
      <path d="M6.5 11.5h3" />
    </svg>
  );
}
