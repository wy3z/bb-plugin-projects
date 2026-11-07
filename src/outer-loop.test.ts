import { describe, expect, it } from "vitest";
import { inboxPrompt, inWorkingHours, sweepDue, sweepPrompt } from "./outer-loop";
import type { ProjectMeta } from "./meta";

const base: ProjectMeta = {
  focus: null,
  focusUpdatedAt: null,
  leadThreadId: "thr_lead",
  sweepMinutes: 120,
  sweepWorkingHours: true,
  sweepLastAt: null,
  followPrs: false,
};

const tuesday = (hour: number, minute = 0) => new Date(2026, 10, 10, hour, minute);

describe("inWorkingHours", () => {
  it("covers weekdays from 08:00 to before 19:00", () => {
    expect(inWorkingHours(tuesday(8))).toBe(true);
    expect(inWorkingHours(tuesday(18, 59))).toBe(true);
    expect(inWorkingHours(tuesday(7, 59))).toBe(false);
    expect(inWorkingHours(tuesday(19))).toBe(false);
    expect(inWorkingHours(new Date(2026, 10, 8, 12))).toBe(false);
  });
});

describe("sweepDue", () => {
  it("is due on the first run and again once the interval has passed", () => {
    expect(sweepDue(base, tuesday(10))).toBe(true);
    const ran = { ...base, sweepLastAt: tuesday(10).toISOString() };
    expect(sweepDue(ran, tuesday(11, 59))).toBe(false);
    expect(sweepDue(ran, tuesday(12))).toBe(true);
  });

  it("never runs when off, without a lead, or outside working hours", () => {
    expect(sweepDue({ ...base, sweepMinutes: null }, tuesday(10))).toBe(false);
    expect(sweepDue({ ...base, leadThreadId: null }, tuesday(10))).toBe(false);
    expect(sweepDue(base, tuesday(22))).toBe(false);
    expect(sweepDue({ ...base, sweepWorkingHours: false }, tuesday(22))).toBe(true);
  });
});

describe("prompts", () => {
  it("label the sweep and the outer-loop source for the lead", () => {
    expect(sweepPrompt("PIXEL").split("\n")[0]).toBe("[Scheduled sweep] PIXEL");
    expect(inboxPrompt("PIXEL", "grok-bot", "  Login 500s on Samsung ", "https://x.test/1")).toBe(
      "[Outer loop · grok-bot] PIXEL\n\nLogin 500s on Samsung\n\nRef: https://x.test/1",
    );
    expect(inboxPrompt("PIXEL", "grok-bot", "No ref", null)).not.toContain("Ref:");
  });
});
