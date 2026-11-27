import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { LeaveChip } from "./LeaveChip";
import { leaveChipOf, leaveDaysText, leaveFlagOf, leaveFlagged } from "./leave";

// The leave check on every Settlement request (owner 2026-11-26): orange for exactly 3 days of leave in the 1st-20th, red
// for more, nothing (or a quiet grey figure) below that; in words as well as colour.

const check = (days: number, flag?: "ok" | "warning" | "critical") => ({
  month: 11,
  year: 2026,
  throughDay: 20,
  days,
  flag: flag ?? leaveFlagOf(days),
  warningAt: 3,
});

describe("the leave check", () => {
  it("flags exactly 3 days as a warning and more as critical, like the server", () => {
    expect(leaveFlagOf(2.5)).toBe("ok");
    expect(leaveFlagOf(3)).toBe("warning");
    expect(leaveFlagOf(3.5)).toBe("critical");
  });

  it("reads '3 days leave' in orange and 'N days leave' in red, with words for a screen reader", () => {
    expect(leaveChipOf(check(3))).toMatchObject({
      flag: "warning",
      tone: "caution",
      text: "3 days leave",
      srPrefix: "Leave warning:",
    });
    expect(leaveChipOf(check(4.5))).toMatchObject({
      flag: "critical",
      tone: "danger",
      text: "4.5 days leave",
      srPrefix: "Leave critical:",
    });
    expect(leaveChipOf(check(4.5))!.title).toBe(
      "Critical: 4.5 days of leave (absent or on leave) in 1st-20th November 2026, more than 3 days.",
    );
    expect(leaveChipOf(check(1))).toMatchObject({ flag: "ok", tone: "neutral", text: "1 day" });
    expect(leaveDaysText(0)).toBe("0 days");
  });

  it("follows the server's flag and is null-safe", () => {
    expect(leaveChipOf(check(2, "critical"))!.flag).toBe("critical");
    expect(leaveChipOf(null)).toBeNull();
    expect(leaveChipOf(undefined)).toBeNull();
    expect(leaveFlagged(check(3))).toBe(true);
    expect(leaveFlagged(check(2))).toBe(false);
    expect(leaveFlagged(null)).toBe(false);
  });

  it("draws a chip only for a flag, unless the figure is asked for too", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (props: Parameters<typeof LeaveChip>[0]) => {
      act(() => root.render(createElement(LeaveChip, props)));
      return host.querySelector('[data-testid="chip"]');
    };
    const warning = render({ check: check(3), testId: "chip" });
    expect(warning?.getAttribute("data-flag")).toBe("warning");
    expect(warning?.textContent).toBe("Leave warning: 3 days leave");
    expect(warning?.getAttribute("title")).toContain("Warning: 3 days");
    expect(render({ check: check(6), testId: "chip" })?.textContent).toBe("Leave critical: 6 days leave");
    expect(render({ check: check(2), testId: "chip" })).toBeNull();
    expect(render({ check: check(2), testId: "chip", showOk: true })?.textContent).toBe("Leave: 2 days");
    expect(render({ check: null, testId: "chip", showOk: true })).toBeNull();
    act(() => root.unmount());
  });
});
