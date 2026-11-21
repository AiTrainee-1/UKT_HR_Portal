import { describe, expect, it } from "vitest";
import { anyOf, deltaOf, forWhom, inWhen, previousText, top, trendRows } from "./logic";
import type { TrendPoint } from "./types";

const metric = (value: number | null, previous: number | null) => ({
  value,
  previous,
  change: value != null && previous != null ? { abs: value - previous, pct: null } : null,
});

describe("gate insights logic", () => {
  it("colours a change by whether it is good news", () => {
    expect(deltaOf(metric(12, 10), false)).toEqual({ text: "+2", tone: "bad", direction: "up" });
    expect(deltaOf(metric(8, 10), false)).toEqual({ text: "-2", tone: "good", direction: "down" });
    expect(deltaOf(metric(12, 10), null)).toEqual({ text: "+2", tone: "neutral", direction: "up" });
    expect(deltaOf(metric(10, 10), true)).toEqual({ text: "0", tone: "neutral", direction: "flat" });
    expect(deltaOf(metric(75, 62.5), true, "pct")).toEqual({ text: "+12.5 pts", tone: "good", direction: "up" });
    expect(deltaOf(metric(95, 30), false, "minutes")).toEqual({ text: "+1h 05m", tone: "bad", direction: "up" });
    expect(deltaOf(metric(null, 3), true)).toBeNull();
    expect(deltaOf(undefined, true)).toBeNull();
  });

  it("says the previous figure", () => {
    expect(previousText(metric(5, 1234))).toBe("1,234 the period before");
    expect(previousText(metric(5, 40.5), "pct")).toBe("40.5% the period before");
    expect(previousText(metric(5, 75), "minutes")).toBe("1h 15m the period before");
    expect(previousText(metric(5, null))).toBeUndefined();
  });

  it("turns the trend into chart rows", () => {
    const points: TrendPoint[] = [
      {
        key: "2026-11-02",
        start: "2026-11-02",
        end: "2026-11-02",
        days: 1,
        visits: 3,
        passes: 2,
        left: 2,
        returned: 1,
        minutesOut: 95,
        gateFormExits: 0,
      },
      {
        key: "2026-11-03",
        start: "2026-11-03",
        end: "2026-11-03",
        days: 1,
        visits: 0,
        passes: 0,
        left: 0,
        returned: 0,
        minutesOut: 0,
        gateFormExits: 0,
      },
    ];
    expect(trendRows(points)[0]).toEqual({
      date: "2026-11-02",
      visits: 3,
      passes: 2,
      left: 2,
      returned: 1,
      hoursOut: 1.6,
    });
    expect(anyOf(points, "passes")).toBe(true);
    expect(anyOf(points, "gateFormExits")).toBe(false);
  });

  it("words the period and the scope for a question", () => {
    expect(inWhen("Nov 2026 (so far)")).toBe("in Nov 2026 (so far)");
    expect(inWhen("Last 30 days")).toBe("in the last 30 days");
    expect(inWhen("Today")).toBe("today");
    expect(forWhom("Unit 1 · Stitching · staff and production", false)).toBe(
      " for Unit 1 · Stitching · staff and production",
    );
    expect(forWhom("All units", true)).toBe("");
  });

  it("keeps the top of a ranked list", () => {
    expect(top([{ n: 1 }, { n: 5 }, { n: null }, { n: 3 }], (r) => r.n, 2)).toEqual([{ n: 5 }, { n: 3 }]);
  });
});
