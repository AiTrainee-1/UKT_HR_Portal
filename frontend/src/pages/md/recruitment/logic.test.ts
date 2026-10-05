import { describe, expect, it } from "vitest";
import { CHART } from "@/components/md/kit/chartTheme";
import {
  PERIOD_PRESETS,
  ageBar,
  assistantSummary,
  collectNotes,
  daysLeftText,
  daysText,
  deltaOf,
  docsChip,
  earlyHeadline,
  funnelBars,
  gapBarItems,
  gapColor,
  hasVacancyLine,
  mixSegments,
  mixTitle,
  outlookLine,
  periodText,
  plural,
  reasonSlices,
  scopeText,
  stepColor,
  trendRows,
  trendVerdict,
  waitTone,
} from "./logic";
import { FUNNEL_ALL } from "./testing-fixtures";
import type { GapRow, SummaryCurrent, TrendMonth } from "./types";

describe("words", () => {
  it("counts days in plain English", () => {
    expect(daysText(null)).toBe("—");
    expect(daysText(0)).toBe("0 days");
    expect(daysText(1)).toBe("1 day");
    expect(daysText(1234)).toBe("1,234 days");
    expect(daysText(5.5)).toBe("5.5 days"); // an average keeps its decimal
    expect(daysText(2.04)).toBe("2 days"); // a fraction that rounds to a whole number reads as whole
    expect(daysLeftText(0)).toBe("leaves today");
    expect(daysLeftText(-2)).toBe("leaves today");
    expect(daysLeftText(1)).toBe("1 day left");
    expect(daysLeftText(15)).toBe("15 days left");
    expect(plural(1, "document")).toBe("1 document");
    expect(plural(3, "person", "people")).toBe("3 people");
  });
});

describe("change chips", () => {
  it("colours a rise by whether it is good news", () => {
    const joiners = deltaOf({ abs: 2, pct: 100 }, "number", "up");
    expect(joiners).toEqual({ text: "+100%", tone: "good", direction: "up" });
    const leavers = deltaOf({ abs: 3, pct: 300 }, "number", "down");
    expect(leavers?.tone).toBe("bad");
    expect(deltaOf({ abs: -2, pct: -40 }, "number", "down")).toEqual({ text: "-40%", tone: "good", direction: "down" });
  });

  it("shows percentage points for a percentage and the plain change when there is no percentage", () => {
    expect(deltaOf({ abs: 6, pct: 300 }, "pct", "down")).toEqual({ text: "+6 pts", tone: "bad", direction: "up" });
    expect(deltaOf({ abs: 1, pct: null }, "number", "up")).toEqual({ text: "+1", tone: "good", direction: "up" });
  });

  it("shows nothing when there is nothing to compare with, and a neutral chip for no change", () => {
    expect(deltaOf(null, "number", "up")).toBeNull();
    expect(deltaOf(undefined, "pct", "down")).toBeNull();
    expect(deltaOf({ abs: 0, pct: 0 }, "number", "up")?.tone).toBe("neutral");
  });

  it("warns on a resignation that has waited a week and goes red at two", () => {
    expect([0, 6, 7, 13, 14, 40].map((d) => waitTone(d, 7))).toEqual([
      "slate",
      "slate",
      "amber",
      "amber",
      "red",
      "red",
    ]);
  });
});

describe("funnelBars", () => {
  it("scales every bar to the widest pipeline step and never draws a non-empty step as nothing", () => {
    const bars = funnelBars(FUNNEL_ALL);
    expect(bars.map((b) => b.id)).toEqual(["applied", "screened", "shortlisted", "interviewed", "offered", "joined"]);
    expect(bars.map((b) => Math.round(b.widthPct))).toEqual([100, 77, 54, 38, 8, 31]); // 13, 10, 7, 5, 1 (floor), 4
    expect(bars[0].conversion).toBeNull();
    expect(bars[1].conversion).toBe("76.9% of applied");
    expect(bars[1].dropOff).toBe("3 dropped (23.1%)");
    expect(bars[4].conversion).toBe("33.3% of interviewed (job board)");
  });

  it("marks Joined as coming from somewhere else and gives it no conversion", () => {
    const joined = funnelBars(FUNNEL_ALL)[5];
    expect(joined.standalone).toBe(true);
    expect(joined.conversion).toBeNull();
    expect(joined.note).toContain("not a share of those offered");
  });

  it("says a step is not tracked rather than showing 0, and draws an empty one as empty", () => {
    const stages = FUNNEL_ALL.map((s) =>
      s.id === "offered" ? { ...s, count: null, ofPrevious: null, dropOff: null } : s,
    );
    const offered = funnelBars(stages)[4];
    expect([offered.tracked, offered.count, offered.widthPct]).toEqual([false, null, 0]);
    const empty = FUNNEL_ALL.map((s) => (s.id === "interviewed" ? { ...s, count: 0 } : s));
    expect(funnelBars(empty)[3]).toMatchObject({ tracked: true, count: 0, widthPct: 0 });
  });

  it("does not let a joiner count larger than the pipeline overflow its bar, nor blank the pipeline", () => {
    const stages = FUNNEL_ALL.map((s) => (s.id === "joined" ? { ...s, count: 400 } : s));
    const bars = funnelBars(stages);
    expect(bars[5].widthPct).toBe(100);
    expect(bars[0].widthPct).toBe(100);
  });

  it("copes with an entirely empty funnel", () => {
    const empty = FUNNEL_ALL.map((s) => ({ ...s, count: 0, ofPrevious: null, dropOff: null, dropOffPct: null }));
    const bars = funnelBars(empty);
    expect(bars.every((b) => b.widthPct === 0 && b.conversion === null && b.dropOff === null)).toBe(true);
  });

  it("darkens the colour down the funnel and stays inside the ramp", () => {
    const colours = [0, 1, 2, 3, 4].map((i) => stepColor(i, 5));
    expect(new Set(colours).size).toBeGreaterThan(2);
    expect(colours.every((c) => (CHART.ramp as readonly string[]).includes(c))).toBe(true);
    expect(stepColor(0, 1)).toBe(CHART.ramp[1]);
  });
});

describe("ageBar", () => {
  it("scales to the oldest position and ticks where stale starts", () => {
    expect(ageBar(82, 45, 82)).toEqual({ widthPct: 100, markerPct: (45 / 82) * 100, tone: "stale" });
    const fresh = ageBar(15, 45, 82);
    expect(fresh.tone).toBe("ok");
    expect(fresh.widthPct).toBeCloseTo((15 / 82) * 100, 5);
  });

  it("never fills the bar for one fresh posting: the scale is at least 1.5 times the stale line", () => {
    const bar = ageBar(20, 45, 20);
    expect(bar.widthPct).toBeCloseTo((20 / 67.5) * 100, 5);
    expect(bar.markerPct).toBeCloseTo((45 / 67.5) * 100, 5);
  });

  it("warns from three quarters of the stale line and is stale only past it", () => {
    expect(ageBar(33, 45, 90).tone).toBe("ok");
    expect(ageBar(34, 45, 90).tone).toBe("warn");
    expect(ageBar(45, 45, 90).tone).toBe("warn");
    expect(ageBar(46, 45, 90).tone).toBe("stale");
  });

  it("draws a posting from today as nothing and one from yesterday as a sliver", () => {
    expect(ageBar(0, 45, 80).widthPct).toBe(0);
    expect(ageBar(1, 45, 4000).widthPct).toBe(3);
  });
});

describe("applicants of a position", () => {
  it("splits them into proportional segments and leaves out the empty ones", () => {
    const segments = mixSegments({ applied: 2, attended: 1, selected: 1, rejected: 0, other: 0 });
    expect(segments.map((s) => [s.key, s.count, s.widthPct])).toEqual([
      ["applied", 2, 50],
      ["attended", 1, 25],
      ["selected", 1, 25],
    ]);
    expect(mixSegments({ applied: 0, attended: 0, selected: 0, rejected: 0, other: 0 })).toEqual([]);
  });

  it("describes them in words for a tooltip", () => {
    expect(mixTitle({ applied: 2, attended: 1, selected: 0, rejected: 1, other: 0 })).toBe(
      "2 applied · 1 attended interview · 1 rejected",
    );
    expect(mixTitle({ applied: 0, attended: 0, selected: 0, rejected: 0, other: 0 })).toBe("No applicants yet");
  });
});

describe("the staffing gap", () => {
  const row = (id: number, name: string, required: number, current: number, jobs = 0): GapRow => ({
    departmentId: id,
    department: name,
    unit: "Unit 1",
    required,
    current,
    vacancy: Math.max(0, required - current),
    surplus: Math.max(0, current - required),
    fillPct: Math.round((current / required) * 1000) / 10,
    openJobs: jobs,
    shortlisted: 0,
  });

  it("ranks the short departments, biggest gap first, and leaves out the fully staffed", () => {
    const items = gapBarItems([row(1, "Cutting", 3, 2, 1), row(2, "Accounts", 40, 43), row(3, "Stitching", 6, 2)]);
    expect(items.map((i) => [i.label, i.value, i.display])).toEqual([
      ["Stitching", 4, "4 short"],
      ["Cutting", 1, "1 short"],
    ]);
    expect(items[0].sub).toBe("2 of 6 filled (33%) · no open posting");
    expect(items[1].sub).toBe("2 of 3 filled (67%) · 1 open posting");
  });

  it("colours by how much of the plan is filled", () => {
    expect([null, 40, 69.9, 70, 89.9, 90, 107].map(gapColor)).toEqual([
      CHART.slate,
      CHART.bad,
      CHART.bad,
      CHART.warn,
      CHART.warn,
      CHART.brand,
      CHART.brand,
    ]);
  });
});

describe("resignations", () => {
  it("keeps one colour per reason so periods can be compared", () => {
    const slices = reasonSlices([
      { id: "pay", label: "Pay or a better job offer", count: 2, pct: 40 },
      { id: "not_stated", label: "Not stated", count: 1, pct: 20 },
      { id: "brand-new", label: "Something new", count: 1, pct: 20 },
    ]);
    expect(slices.map((s) => [s.name, s.value])).toEqual([
      ["Pay or a better job offer", 2],
      ["Not stated", 1],
      ["Something new", 1],
    ]);
    expect(slices[0].color).toBe("#006496");
    expect(slices[2].color).toBe(CHART.slate); // a group the page has not met falls back, it does not crash
  });

  it("words the outlook", () => {
    expect(outlookLine({ days: 30, approved: 1, pending: 2, total: 3 })).toBe(
      "1 serving notice · 2 waiting for a decision",
    );
    expect(outlookLine({ days: 30, approved: 0, pending: 2, total: 2 })).toBe("2 waiting for a decision");
    expect(outlookLine({ days: 60, approved: 0, pending: 0, total: 0 })).toBe("Nobody is due to leave");
  });
});

describe("joiners and the trend", () => {
  it("says what is missing from a joiner's file", () => {
    expect(docsChip(null)).toEqual({ text: "Has left", tone: "slate" });
    expect(docsChip(0)).toEqual({ text: "Documents complete", tone: "green" });
    expect(docsChip(1)).toEqual({ text: "1 document missing", tone: "amber" });
    expect(docsChip(6)).toEqual({ text: "6 documents missing", tone: "amber" });
  });

  it("states early attrition, including the case of nobody leaving", () => {
    const early = { windowDays: 90, leavers: 2, totalLeavers: 4, pct: 50, list: [], listShown: 0, byDepartment: [] };
    expect(earlyHeadline(early)).toBe("2 of 4 leavers left within 90 days of joining (50%).");
    expect(earlyHeadline({ ...early, leavers: 1, totalLeavers: 1, pct: 100 })).toBe(
      "1 of 1 leaver left within 90 days of joining (100%).",
    );
    expect(earlyHeadline({ ...early, leavers: 0, totalLeavers: 0, pct: null })).toBe("Nobody has left in this period.");
  });

  const month = (m: string, vacancies: number | null): TrendMonth => ({
    month: m,
    label: m,
    partial: false,
    joiners: 2,
    leavers: 1,
    net: 1,
    headcount: 50,
    staffHeadcount: 40,
    vacancies,
  });

  it("shapes the months for the chart and knows when there is no plan line to draw", () => {
    expect(trendRows([month("2026-08", 4), month("2026-09", null)])).toEqual([
      { month: "2026-08", joiners: 2, leavers: 1, vacancies: 4 },
      { month: "2026-09", joiners: 2, leavers: 1, vacancies: null },
    ]);
    expect(hasVacancyLine([month("2026-08", null), month("2026-09", null)])).toBe(false);
    expect(hasVacancyLine([month("2026-08", null), month("2026-09", 0)])).toBe(true); // 0 vacancies is data
  });

  it("gives the verdict in a sentence", () => {
    expect(trendVerdict({ joiners: 8, leavers: 6, net: 2 })).toBe(
      "Hiring outpaced exits by 2 over the last 12 months.",
    );
    expect(trendVerdict({ joiners: 3, leavers: 9, net: -6 })).toBe(
      "Exits outpaced hiring by 6 over the last 12 months.",
    );
    expect(trendVerdict({ joiners: 4, leavers: 4, net: 0 })).toBe(
      "Hiring and exits were level over the last 12 months.",
    );
  });
});

describe("filters, notes and the assistant's view", () => {
  it("shows each note once, in the order first seen", () => {
    expect(
      collectNotes({ notes: ["a", "b"] }, undefined, { notes: ["b", "c"] }, { notes: [] }, { notes: ["a"] }),
    ).toEqual(["a", "b", "c"]);
    expect(collectNotes()).toEqual([]);
  });

  it("offers windows long enough for a slow-moving subject and opens on a quarter", () => {
    expect(PERIOD_PRESETS).toContain("last_90_days");
    expect(PERIOD_PRESETS).toContain("last_12_months");
  });

  it("describes the period and scope for the assistant", () => {
    expect(periodText({ preset: "last_90_days" })).toBe("Last 90 days");
    expect(periodText({ preset: "last_90_days" }, "Last 90 days")).toBe("Last 90 days");
    expect(periodText({ preset: "custom", from: "2026-09-01", to: "2026-09-30" })).toBe("2026-09-01 to 2026-09-30");
    const org = { branches: [{ id: 2, name: "Unit 2" }], departments: [] };
    expect(scopeText({ branch: "2", department: "Stitching", type: "staff" }, org)).toBe(
      "Unit 2 · Stitching · staff only",
    );
    expect(scopeText({ branch: "", department: "", type: "" })).toBe(
      "All units · all departments · staff and production",
    );
  });

  it("hands the assistant the headline numbers, with attrition as text and unknowns as null", () => {
    const current = {
      openPositions: 4,
      vacancies: null,
      stalePositions: 2,
      avgOpenDays: 49,
      applicantsInPipeline: 11,
      joiners: 4,
      leavers: 4,
      resignationsPending: 3,
      attritionPct: 8,
    } as unknown as SummaryCurrent;
    expect(assistantSummary(current)).toEqual({
      "Open positions": 4,
      "Vacancies against plan": null,
      "Positions open too long": 2,
      "Average days open": 49,
      "Candidates in the pipeline": 11,
      "Joined in the period": 4,
      "Left in the period": 4,
      "Resignations waiting for a decision": 3,
      Attrition: "8%",
    });
    expect(assistantSummary({ ...current, attritionPct: null }).Attrition).toBeNull();
  });
});
