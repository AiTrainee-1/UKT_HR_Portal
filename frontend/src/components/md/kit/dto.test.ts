import { describe, expect, it } from "vitest";
import { kpiDelta, kpiValueText, sortInsights, toInsight } from "./dto";

describe("toInsight", () => {
  it("turns a page id into a link with the page's title", () => {
    const insight = toInsight({
      id: "payroll.jump",
      severity: "warning",
      title: "Payroll up 18%",
      page: "payroll",
      ask: "Why?",
    });
    expect(insight.page).toEqual({ path: "/md/payroll", label: "Payroll Analysis" });
    expect(insight.ask).toBe("Why?");
  });

  it("leaves the link out for an unknown or missing page", () => {
    expect(toInsight({ id: "a", severity: "info", title: "x", page: "nowhere" }).page).toBeUndefined();
    expect(toInsight({ id: "b", severity: "info", title: "x", page: null }).page).toBeUndefined();
  });
});

describe("sortInsights", () => {
  it("puts the most severe first and keeps the server's order within a severity", () => {
    const sorted = sortInsights([
      { id: "1", severity: "info" as const },
      { id: "2", severity: "critical" as const },
      { id: "3", severity: "good" as const },
      { id: "4", severity: "critical" as const },
      { id: "5", severity: "warning" as const },
    ]);
    expect(sorted.map((i) => i.id)).toEqual(["2", "4", "5", "1", "3"]);
  });
});

describe("kpiValueText", () => {
  it("formats by the declared format", () => {
    expect(kpiValueText({ value: 91.84, format: "pct" })).toBe("91.8%");
    expect(kpiValueText({ value: 1240000, format: "inr_compact" })).toBe("₹12.4 L");
    expect(kpiValueText({ value: 1240000, format: "inr" })).toBe("₹12,40,000");
    expect(kpiValueText({ value: 125, format: "minutes" })).toBe("2h 05m");
    expect(kpiValueText({ value: 1234, format: "number" })).toBe("1,234");
    expect(kpiValueText({ value: 12.5, format: "number" })).toBe("12.5");
    expect(kpiValueText({ value: "Stable", format: "text" })).toBe("Stable");
  });

  it("shows a dash for no data and passes through what is not a number", () => {
    expect(kpiValueText({ value: null, format: "pct" })).toBe("—");
    expect(kpiValueText({ value: "n/a", format: "pct" })).toBe("n/a");
  });
});

describe("kpiDelta", () => {
  it("is nothing without a change", () => {
    expect(kpiDelta({ format: "pct", delta: null })).toBeNull();
    expect(kpiDelta({ format: "pct", delta: { abs: null, pct: null, good: "up" } })).toBeNull();
  });

  it("shows percentage points for a percentage and colours by the good direction", () => {
    expect(kpiDelta({ format: "pct", delta: { abs: 2.34, pct: 2.5, good: "up" } })).toEqual({
      text: "+2.3 pts",
      tone: "good",
      direction: "up",
    });
    expect(kpiDelta({ format: "pct", delta: { abs: 2.34, pct: 2.5, good: "down" } })?.tone).toBe("bad");
  });

  it("shows a percent change for other figures, falling back to the absolute change", () => {
    expect(kpiDelta({ format: "inr_compact", delta: { abs: -50000, pct: -4.2, good: "down" } })).toEqual({
      text: "-4.2%",
      tone: "good",
      direction: "down",
    });
    expect(kpiDelta({ format: "inr_compact", delta: { abs: 250000, pct: null, good: null } })).toEqual({
      text: "₹2.5 L",
      tone: "neutral",
      direction: "up",
    });
    expect(kpiDelta({ format: "minutes", delta: { abs: 12, pct: null, good: "down" } })).toEqual({
      text: "+12m",
      tone: "bad",
      direction: "up",
    });
    expect(kpiDelta({ format: "number", delta: { abs: 0, pct: null, good: "up" } })).toEqual({
      text: "0",
      tone: "neutral",
      direction: "flat",
    });
    expect(kpiDelta({ format: "number", delta: { abs: 1.5, pct: null, good: null } })?.text).toBe("+1.5");
  });
});
