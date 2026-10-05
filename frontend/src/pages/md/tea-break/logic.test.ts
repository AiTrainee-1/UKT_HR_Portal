import { describe, expect, it } from "vitest";
import { EVERYONE, type ScopeChoice } from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import * as fx from "./fixtures";
import {
  NONE_KEY,
  askQuestions,
  assistantSummary,
  deltaChip,
  focusScope,
  hasMeasuredBreaks,
  heatmapCaption,
  heatmapMatrix,
  kpiTiles,
  offenderSub,
  participationText,
  periodText,
  previousText,
  ruleLegend,
  ruleUpdatedText,
  scopeText,
  trendRows,
  visibleSlots,
  worstCase,
} from "./logic";
import type { TeaHeatmap, TeaTrend } from "./types";

describe("deltaChip", () => {
  it("colours a change by whether it is good news", () => {
    expect(deltaChip({ abs: 8.3, pct: 16.6 }, "pts", "down")).toEqual({
      text: "+8.3 pts",
      tone: "bad",
      direction: "up",
    });
    expect(deltaChip({ abs: -8.3, pct: -16.6 }, "pts", "down")).toEqual({
      text: "-8.3 pts",
      tone: "good",
      direction: "down",
    });
    expect(deltaChip({ abs: -8.3, pct: -16.6 }, "pts", "up")).toEqual({
      text: "-8.3 pts",
      tone: "bad",
      direction: "down",
    });
    expect(deltaChip({ abs: 1.4, pct: 6.7 }, "min", "down")).toEqual({
      text: "+1.4 min",
      tone: "bad",
      direction: "up",
    });
  });

  it("shows a percent change for counts and money-like figures, and stays neutral when there is no good side", () => {
    expect(deltaChip({ abs: 20, pct: 250 }, "pct", "none")).toEqual({
      text: "+250%",
      tone: "neutral",
      direction: "up",
    });
    expect(deltaChip({ abs: 140, pct: 233.3 }, "pct", "down")).toEqual({
      text: "+233.3%",
      tone: "bad",
      direction: "up",
    });
    // the previous figure was 0, so there is no percentage: the absolute change is all there is
    expect(deltaChip({ abs: 20, pct: null }, "pct", "down")).toEqual({ text: "+20", tone: "bad", direction: "up" });
  });

  it("shows a change that rounds to nothing as flat, not as a tiny arrow", () => {
    expect(deltaChip({ abs: 0.02, pct: 0.04 }, "pts", "down")).toEqual({
      text: "0 pts",
      tone: "neutral",
      direction: "flat",
    });
    expect(deltaChip({ abs: 0, pct: 0 }, "pct", "down")).toEqual({ text: "0%", tone: "neutral", direction: "flat" });
    expect(deltaChip({ abs: 0, pct: null }, "min", "down")).toEqual({
      text: "0 min",
      tone: "neutral",
      direction: "flat",
    });
  });

  it("has nothing to show without a comparison", () => {
    expect(deltaChip(null, "pts", "down")).toBeNull();
    expect(deltaChip(undefined, "pts", "down")).toBeNull();
  });
});

describe("kpiTiles", () => {
  const tiles = (trend?: TeaTrend) =>
    Object.fromEntries(kpiTiles(fx.summary, trend, fx.offenders).map((t) => [t.id, t]));

  it("builds the six tiles from the summary", () => {
    const t = tiles();
    expect(Object.keys(t)).toEqual(["breaks", "average", "overrun", "lost", "within", "repeat"]);
    expect([t.breaks.value, t.breaks.sub]).toEqual(["28", "6 employees"]);
    expect([t.average.value, t.average.sub]).toEqual(["22.2 min", "Allowed: 15 min"]);
    expect([t.overrun.value, t.overrun.sub]).toEqual(["58.3%", "14 of 24 breaks ran over"]);
    expect([t.lost.value, t.lost.sub]).toEqual(["3h 20m", "≈ 3.3 hours across 14 overruns"]);
    expect([t.within.value, t.within.sub]).toEqual(["41.7%", "10 of 24 breaks"]);
    expect([t.repeat.value, t.repeat.sub]).toEqual(["2", "3+ overruns each · 75% of lost time"]);
  });

  it("colours each change by which way is good news", () => {
    const t = tiles();
    expect(t.breaks.delta).toEqual({ text: "+250%", tone: "neutral", direction: "up" }); // more breaks is neither good nor bad
    expect(t.average.delta?.tone).toBe("bad"); // longer breaks
    expect(t.overrun.delta).toEqual({ text: "+8.3 pts", tone: "bad", direction: "up" });
    expect(t.lost.delta).toEqual({ text: "+233.3%", tone: "bad", direction: "up" });
    expect(t.within.delta).toEqual({ text: "-8.3 pts", tone: "bad", direction: "down" }); // compliance falling is bad
    expect(t.repeat.delta).toBeNull();
  });

  it("says which response explains each figure", () => {
    const t = tiles();
    expect(t.repeat.source).toBe("offenders");
    expect(t.overrun.source).toBe("summary");
    expect(t.overrun.provenanceIds).toEqual(["tea-overrun"]);
    expect(t.repeat.provenanceIds).toEqual(["tea-repeat"]);
  });

  it("draws sparklines from the trend", () => {
    const t = tiles(fx.trend);
    expect(t.breaks.spark).toHaveLength(14);
    expect(t.overrun.spark?.slice(0, 3)).toEqual([0, 40, 75]);
    expect(t.lost.spark?.[8]).toBeNull(); // a day with no measured breaks is a gap, not a zero
    expect(t.average.spark).toBeUndefined();
    expect(tiles().overrun.spark).toBeUndefined(); // until the trend has arrived
  });

  it("writes dashes, not zeros, where there is no data", () => {
    const t = Object.fromEntries(kpiTiles(fx.emptySummary, undefined, undefined).map((x) => [x.id, x]));
    expect(t.breaks.value).toBe("0");
    expect([t.average.value, t.overrun.value, t.lost.value, t.within.value]).toEqual(["—", "—", "—", "—"]);
    expect(t.overrun.sub).toBe("No measured breaks");
    expect(t.lost.sub).toBe("No measured breaks");
    expect(t.repeat.value).toBe("—"); // the offenders list has not arrived
    expect(t.repeat.sub).toBeUndefined();
  });

  it("says plainly when nothing ran over", () => {
    const calm = {
      ...fx.summary,
      metrics: { ...fx.summary.metrics, overruns: { value: 0, previous: 2, change: { abs: -2, pct: -100 } } },
      hoursLost: 0,
    };
    const t = Object.fromEntries(kpiTiles(calm, undefined, fx.emptyOffenders).map((x) => [x.id, x]));
    expect(t.lost.sub).toBe("No overruns");
    expect(t.repeat.sub).toBe("3+ overruns each"); // no share to quote when nobody is a repeat overrunner
  });

  it("uses the singular for one employee or one overrun", () => {
    const one = {
      ...fx.summary,
      metrics: {
        ...fx.summary.metrics,
        employees: { value: 1, previous: 1, change: null },
        overruns: { value: 1, previous: 0, change: null },
      },
      hoursLost: 0.1,
    };
    const t = Object.fromEntries(kpiTiles(one).map((x) => [x.id, x]));
    expect(t.breaks.sub).toBe("1 employee");
    expect(t.lost.sub).toBe("≈ 0.1 hours across 1 overrun");
  });
});

describe("trend", () => {
  it("gives the chart the moving average for days but not for weeks", () => {
    expect(trendRows(fx.trend)[1]).toEqual({ date: "2026-09-02", minutesLost: 8, overrunPct: 40, average: 40 });
    const weekly: TeaTrend = { ...fx.trend, granularity: "week" };
    expect(trendRows(weekly).every((r) => r.average === null)).toBe(true);
  });

  it("knows when there is nothing to chart", () => {
    expect(hasMeasuredBreaks(fx.trend)).toBe(true);
    expect(hasMeasuredBreaks(fx.emptyTrend)).toBe(false);
  });
});

describe("focusScope", () => {
  const org: MdOrg = {
    branches: [
      { id: 1, name: "Unit 1" },
      { id: 2, name: "Unit 2" },
    ],
    departments: [
      { id: 10, name: "Stitching", branchId: 1, branchName: "Unit 1", employees: 4 },
      { id: 11, name: "Cutting", branchId: 1, branchName: "Unit 1", employees: 2 },
      { id: 12, name: "Packing", branchId: 2, branchName: "Unit 2", employees: 3 },
    ],
  };
  const row = (key: string, label = key) => ({ key, label });

  it("narrows to a department by its name (it covers every unit that has one)", () => {
    expect(focusScope(EVERYONE, "department", row("Stitching"), org)).toEqual({ ...EVERYONE, department: "Stitching" });
    expect(focusScope({ ...EVERYONE, type: "staff" }, "department", row("Cutting"), org)).toEqual({
      branch: "",
      department: "Cutting",
      type: "staff",
    });
  });

  it("narrows to staff or production", () => {
    expect(focusScope(EVERYONE, "type", row("production", "Production"), org)).toEqual({
      ...EVERYONE,
      type: "production",
    });
    expect(focusScope(EVERYONE, "type", row("contractor"), org)).toBeNull();
  });

  it("narrows to a unit by its id, dropping a department the unit does not have", () => {
    expect(focusScope(EVERYONE, "unit", row("Unit 2"), org)).toEqual({ ...EVERYONE, branch: "2" });
    const inStitching: ScopeChoice = { ...EVERYONE, department: "Stitching" };
    expect(focusScope(inStitching, "unit", row("Unit 1"), org)).toEqual({
      branch: "1",
      department: "Stitching",
      type: "",
    });
    expect(focusScope(inStitching, "unit", row("Unit 2"), org)).toEqual({ branch: "2", department: "", type: "" });
  });

  it("does nothing when there is nothing to narrow to", () => {
    expect(focusScope(EVERYONE, "department", row(NONE_KEY, "No department"), org)).toBeNull();
    expect(focusScope({ ...EVERYONE, department: "Stitching" }, "department", row("Stitching"), org)).toBeNull();
    expect(focusScope({ ...EVERYONE, type: "staff" }, "type", row("staff", "Staff"), org)).toBeNull();
    expect(focusScope({ ...EVERYONE, branch: "1" }, "unit", row("Unit 1"), org)).toBeNull();
    expect(focusScope(EVERYONE, "unit", row("Nowhere"), org)).toBeNull();
    expect(focusScope(EVERYONE, "unit", row("Unit 1"), undefined)).toBeNull(); // the unit list has not loaded
    expect(focusScope(EVERYONE, "shift", row("3", "Evening"), org)).toBeNull(); // a shift is not a filter
  });
});

describe("participationText", () => {
  it("says how many people a group has and how many of them scan, and how many people a shift covers", () => {
    expect(participationText(fx.departments.rows[0])).toBe("2 employees · 100% scan"); // the leaver's breaks do not count
    expect(participationText(fx.departments.rows[3])).toBe("1 employee · 0% scan"); // nobody there scans
    expect(participationText({ ...fx.departments.rows[0], participationPct: null })).toBe("2 employees");
    expect(participationText({ ...fx.departments.rows[0], headcount: 0 })).toBeNull();
    expect(participationText(fx.shifts.rows[0])).toBe("2 people");
    expect(participationText({ ...fx.shifts.rows[0], employees: 1 })).toBe("1 person");
  });
});

describe("heat map", () => {
  const heat = (overrides: Partial<TeaHeatmap>): TeaHeatmap => ({ ...fx.heatmap, ...overrides });

  it("lays weekdays down and half hours across, a dot where there is nothing", () => {
    const m = heatmapMatrix(fx.heatmap, "breaks");
    expect(m.rows).toHaveLength(7);
    expect(m.cols[0]).toBe("10:00");
    expect(m.cols).toHaveLength(13);
    expect(m.values[2][0]).toBe(4); // Wednesday 10:00
    expect(m.values[2][1]).toBe(1); // Wednesday 10:30
    expect(m.values[0][0]).toBeNull(); // Monday: no breaks
    const rate = heatmapMatrix(fx.heatmap, "rate");
    expect(rate.values[5][0]).toBe(66.7); // Saturday 10:00 has enough breaks for a rate
    expect(rate.values[3][0]).toBeNull(); // Thursday 10:00 has 4 measured breaks: too few, the server sent no rate
  });

  it("draws only the chosen columns", () => {
    const m = heatmapMatrix(fx.heatmap, "breaks", fx.heatmap.slots.slice(1, 3));
    expect(m.cols).toEqual(["10:30", "11:00"]);
    expect(m.values[2]).toEqual([1, null]);
  });

  describe("stray scans at the edges of the day", () => {
    // the server's range runs from the first to the last slot that has a break: here 03:00 to 23:30
    const slots = Array.from({ length: 42 }, (_, i) => ({ index: 6 + i, label: `s${6 + i}` }));
    const cell = (slot: number, breaks: number) => ({
      weekday: 0,
      slot,
      breaks,
      measured: breaks,
      overruns: 0,
      overrunPct: null,
      minutesLost: 0,
    });

    it("leaves them out and counts them, so nothing is dropped silently", () => {
      // 1000 breaks, almost all at 10:00 and 10:30; one test scan at 03:00 and one at 23:30 (0.1 % each)
      const cells = [cell(6, 1), cell(20, 600), cell(21, 398), cell(47, 1)];
      const shown = visibleSlots({ slots, cells, totalBreaks: 1000 });
      expect(shown.slots.map((s) => s.index)).toEqual([20, 21]);
      expect(shown.hidden).toBe(2);
    });

    it("keeps an edge slot that holds a real share of the breaks", () => {
      const cells = [cell(6, 50), cell(20, 500), cell(47, 450)]; // 5 % at 03:00
      const shown = visibleSlots({ slots, cells, totalBreaks: 1000 });
      expect(shown.slots[0].index).toBe(6);
      expect(shown.slots[shown.slots.length - 1].index).toBe(47);
      expect(shown.hidden).toBe(0);
    });

    it("trims nothing when asked not to", () => {
      const cells = [cell(6, 1), cell(20, 998), cell(47, 1)];
      expect(visibleSlots({ slots, cells, totalBreaks: 1000 }, 0).slots).toHaveLength(42);
    });
  });

  it("keeps every column when the day is evenly used, and never trims to nothing", () => {
    const even = visibleSlots(fx.heatmap);
    expect(even.slots).toHaveLength(13);
    expect(even.hidden).toBe(0);
    const one = visibleSlots(heat({ slots: [{ index: 20, label: "10:00" }], totalBreaks: 5 }));
    expect(one.slots).toHaveLength(1);
    expect(visibleSlots(heat({ slots: [], cells: [], totalBreaks: 0 })).slots).toEqual([]);
  });

  it("writes the sentences under the grid", () => {
    expect(heatmapCaption(fx.heatmap)).toEqual([
      "Busiest half hour: 10:00 (67% of breaks)",
      "Highest overrun rate: Sat 10:00 (67%)",
    ]);
    expect(heatmapCaption({ busiestSlots: [], worstCells: [] })).toEqual([]);
  });
});

describe("people and the rule", () => {
  it("writes the worst case and the line under a name", () => {
    expect(worstCase({ worstMinutes: 60, worstDate: "2026-09-06" })).toBe("60 min on 06 Sep");
    expect(worstCase({ worstMinutes: 45, worstDate: null })).toBe("45 min");
    expect(worstCase({ worstMinutes: null, worstDate: null })).toBe("—");
    expect(offenderSub({ employeeCode: "C", department: "Stitching", unit: "Unit 1" })).toBe("C · Stitching · Unit 1");
    expect(offenderSub({ employeeCode: "G", department: "No department", unit: null })).toBe("G · No department");
  });

  it("classifies a break from shortest to longest", () => {
    expect(ruleLegend({ allowedMinutes: 15, missedScanMinutes: 60 }).map((i) => [i.id, i.title])).toEqual([
      ["on-time", "Up to 15 min"],
      ["overrun", "16 to 60 min"],
      ["missed", "Over 60 min"],
      ["no-return", "No return scan"],
    ]);
  });

  it("has no overrun band when the allowance reaches the missed-scan cut-off", () => {
    const ids = ruleLegend({ allowedMinutes: 60, missedScanMinutes: 60 }).map((i) => i.id);
    expect(ids).not.toContain("overrun");
    expect(ruleLegend({ allowedMinutes: 90, missedScanMinutes: 60 })[0].title).toBe("Up to 60 min");
  });

  it("says when the rule was last changed, or that none has been saved", () => {
    expect(ruleUpdatedText({ isDefault: false, updatedAt: "2026-09-03" })).toBe("Last changed 03 Sep 2026.");
    expect(ruleUpdatedText({ isDefault: true, updatedAt: null })).toContain("default allowance");
    expect(ruleUpdatedText({ isDefault: false, updatedAt: null })).toBe("");
  });
});

describe("previousText", () => {
  it("names the period the change chips compare with", () => {
    expect(previousText(fx.summary)).toBe("18 Aug to 31 Aug 2026");
  });
});

describe("words for the assistant", () => {
  it("summarises the page's figures", () => {
    expect(assistantSummary(fx.summary)).toMatchObject({
      "Allowed minutes": 15,
      "Breaks taken": 28,
      "Overrun rate": "58.3%",
      "Minutes lost": 200,
      "Within allowance": "41.7%",
      "Employees scanning": "83%",
    });
    expect(assistantSummary(undefined)).toBeUndefined();
    expect(assistantSummary(fx.emptySummary)?.["Overrun rate"]).toBeNull();
  });

  it("describes the period and the selection", () => {
    expect(periodText({ preset: "last_7_days" })).toBe("Last 7 days");
    expect(periodText({ preset: "custom", from: "2026-09-01", to: "2026-09-14" })).toBe("01 Sep 2026 to 14 Sep 2026");
    expect(scopeText(EVERYONE, "Unit 2 · all departments · staff and production")).toBe(
      "Unit 2 · all departments · staff and production",
    );
    expect(scopeText({ ...EVERYONE, department: "Stitching" })).toBe("All units · Stitching · staff and production");
  });

  it("puts the period and the selection in every question, and leaves the selection out for everyone", () => {
    const q = askQuestions("Last 30 days", null);
    expect(q.page).toBe(
      "Summarise tea-break discipline (Last 30 days): how many breaks ran over, how much time was lost and what needs my attention.",
    );
    expect(q.shifts).toBe("Which shifts have the worst tea-break overruns (Last 30 days)?");
    const scoped = askQuestions("Last 7 days", "Unit 2 · all departments · staff and production");
    expect(scoped.trend).toContain("(Last 7 days, Unit 2 · all departments · staff and production)");
    expect(scoped.rule).toBe("What counts as a tea-break overrun, and which breaks are left out of the figures?");
    for (const question of Object.values(q)) expect(question.length).toBeGreaterThan(20);
  });
});
