import { describe, expect, it } from "vitest";
import { EVERYONE } from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import * as fx from "./fixtures";
import {
  askQuestions,
  assistantSummary,
  calendarMatrix,
  compareRows,
  deltaChip,
  exportWhen,
  focusScope,
  gapText,
  hasAbsences,
  hasExports,
  kpiTiles,
  latestLine,
  markShares,
  periodText,
  previousText,
  reportBars,
  scopeText,
  trendCaption,
  trendRows,
  userBars,
} from "./logic";

describe("deltaChip", () => {
  it("colours a change by whether it is good news", () => {
    expect(deltaChip({ abs: -22.3, pct: -33.4 }, "pts", "up")).toEqual({
      text: "-22.3 pts",
      tone: "bad",
      direction: "down",
    });
    expect(deltaChip({ abs: 6, pct: 200 }, "pct", "down")).toEqual({ text: "+200%", tone: "bad", direction: "up" });
    expect(deltaChip({ abs: 2, pct: 50 }, "pct", "none")).toEqual({ text: "+50%", tone: "neutral", direction: "up" });
  });

  it("falls back to the plain difference when there is no previous figure to take a percentage of", () => {
    expect(deltaChip({ abs: 3, pct: null }, "pct", "down")).toEqual({ text: "+3", tone: "bad", direction: "up" });
  });

  it("shows a change that rounds to nothing as flat and neutral", () => {
    expect(deltaChip({ abs: 0, pct: 0 }, "pct", "down")).toEqual({ text: "0%", tone: "neutral", direction: "flat" });
    expect(deltaChip({ abs: 0.01, pct: null }, "pts", "up")?.text).toBe("0 pts");
  });

  it("has no chip without a change", () => {
    expect(deltaChip(null, "pct", "up")).toBeNull();
    expect(deltaChip(undefined, "pts", "up")).toBeNull();
  });
});

describe("the figures strip", () => {
  const tiles = kpiTiles(fx.summary, fx.trend);
  const tile = (id: string) => tiles.find((t) => t.id === id)!;

  it("has eight tiles in a fixed order", () => {
    expect(tiles.map((t) => t.id)).toEqual([
      "absences",
      "followed",
      "notInformed",
      "unmarked",
      "gaps",
      "exports",
      "people",
      "latest",
    ]);
  });

  it("shows the hand-counted figures", () => {
    expect(tile("absences").value).toBe("9");
    expect(tile("absences").sub).toBe("On scheduled days · 7 complete days");
    expect(tile("followed").value).toBe("44.4%");
    expect(tile("followed").sub).toBe("4 of 9 absences marked");
    expect(tile("notInformed").value).toBe("2");
    expect(tile("notInformed").sub).toBe("22% of absences · unauthorised");
    expect(tile("unmarked").value).toBe("5");
    expect(tile("unmarked").sub).toBe("56% of absences have no call");
    expect(tile("gaps").value).toBe("1");
    expect(tile("gaps").sub).toBe("2+ absences, none marked");
    expect(tile("exports").value).toBe("6");
    expect(tile("exports").sub).toBe("5 of 7 days · on record");
    expect(tile("people").value).toBe("2");
    expect(tile("people").sub).toBe("8 exports of any report");
    expect(tile("latest").value).toBe("Priya");
    expect(tile("latest").sub).toBe("Daily Attendance Register · 13 Sep, 11:50 pm");
  });

  it("colours each change by whether it is good news", () => {
    expect(tile("absences").delta?.tone).toBe("bad"); // more absences
    expect(tile("followed").delta?.tone).toBe("bad"); // less followed up
    expect(tile("notInformed").delta?.tone).toBe("bad");
    expect(tile("unmarked").delta?.tone).toBe("bad");
    expect(tile("exports").delta?.tone).toBe("neutral"); // more exports is neither good nor bad
    expect(tile("people").delta?.direction).toBe("flat");
  });

  it("draws the exports sparkline from the trend", () => {
    expect(tile("exports").spark).toEqual([1, 1, 2, 1, 0, 0, 1]);
    expect(tile("absences").spark).toBeUndefined();
  });

  it("says where each figure is explained", () => {
    expect(tile("gaps").provenanceIds).toEqual(["reportlog-gaps"]);
    expect(tile("exports").provenanceIds).toEqual(["reportlog-exports"]);
  });

  it("shows a dash, never a zero, where there is no rate or no completed day", () => {
    const empty = kpiTiles(fx.emptySummary);
    expect(empty.find((t) => t.id === "followed")?.value).toBe("—");
    expect(empty.find((t) => t.id === "absences")?.value).toBe("0");
    expect(empty.find((t) => t.id === "unmarked")?.sub).toBe("No absences");
    expect(empty.find((t) => t.id === "latest")?.value).toBe("—");
    expect(empty.find((t) => t.id === "latest")?.sub).toBe("None on record in this period");
    const early = kpiTiles(fx.noCompletedDaySummary);
    expect(early.find((t) => t.id === "absences")?.value).toBe("—");
    expect(early.find((t) => t.id === "absences")?.sub).toBe("No completed day in this period yet");
    expect(early.find((t) => t.id === "gaps")?.value).toBe("—");
  });

  it("names the period the changes compare with", () => {
    expect(previousText(fx.summary)).toBe("31 Aug to 06 Sep 2026");
    expect(exportWhen(null)).toBe("—");
  });
});

describe("this period against the previous", () => {
  const rows = compareRows(fx.summary);
  const row = (id: string) => rows.find((r) => r.id === id)!;

  it("lists eight figures side by side", () => {
    expect(rows).toHaveLength(8);
    expect(row("absences")).toMatchObject({ current: "9", previous: "3" });
    expect(row("followed")).toMatchObject({ current: "44.4%", previous: "66.7%" });
    expect(row("exports")).toMatchObject({ current: "6", previous: "4" });
    expect(row("exportDays")).toMatchObject({ current: "5", previous: "4" });
  });

  it("says which way is good news for each", () => {
    expect(row("unmarked").delta?.tone).toBe("bad");
    expect(row("followed").delta?.tone).toBe("bad");
    expect(row("informed").delta?.tone).toBe("neutral");
    expect(row("exports").delta?.tone).toBe("neutral");
  });
});

describe("the trend", () => {
  it("makes one row per day", () => {
    const rows = trendRows(fx.trend);
    expect(rows).toHaveLength(7);
    expect(rows[3]).toMatchObject({ date: "2026-09-10", informed: 1, notInformed: 0, unmarked: 2, exports: 1 });
    expect(rows[3].reviewedPct).toBe(33.3);
    expect(rows[5].reviewedPct).toBeNull(); // no absences: no rate
  });

  it("knows when there is nothing to draw", () => {
    expect(hasAbsences(fx.trend)).toBe(true);
    expect(hasAbsences(fx.emptyTrend)).toBe(false);
    expect(hasExports(fx.trend)).toBe(true);
    expect(hasExports(fx.emptyTrend)).toBe(false);
  });

  it("does not count a day the figures do not cover yet", () => {
    const today = { ...fx.trend.points[0], date: "2026-09-21", absences: null, informed: null, unmarked: null };
    expect(hasAbsences({ points: [today] })).toBe(false);
  });

  it("says in one sentence how many absences have no call and when it was worst", () => {
    expect(trendCaption(fx.trend)).toBe("5 of 9 absences have no call. Most unmarked on 08 Sep 2026 (2).");
    const allMarked = { points: fx.trend.points.map((p) => ({ ...p, unmarked: 0 })) };
    expect(trendCaption(allMarked)).toBe("0 of 9 absences have no call. Every absence has a call.");
    expect(trendCaption(fx.emptyTrend)).toBeNull();
  });
});

describe("the gap calendar", () => {
  it("lays a week out Monday to Sunday with a dot where nothing was to be marked", () => {
    const m = calendarMatrix(fx.gaps.days);
    expect(m.rows).toEqual(["Week of 07 Sep"]);
    expect(m.cols).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    // unmarked absences per day; Mon and Fri are fully marked (0), the weekend had no absences (null)
    expect(m.values).toEqual([[0, 2, 1, 2, 0, null, null]]);
  });

  it("puts a Sunday in the week it ends, and a short week in its own row", () => {
    const days = [
      { date: "2026-09-06", absences: 1, unmarked: 1 }, // Sunday
      { date: "2026-09-07", absences: 2, unmarked: 2 }, // Monday
      { date: "2026-09-09", absences: null, unmarked: null }, // not covered yet
    ];
    const m = calendarMatrix(days);
    expect(m.rows).toEqual(["Week of 31 Aug", "Week of 07 Sep"]);
    expect(m.values[0][6]).toBe(1);
    expect(m.values[1]).toEqual([2, null, null, null, null, null, null]);
  });

  it("says in words what the calendar shows", () => {
    expect(gapText(fx.gaps)).toBe(
      "1 day had 2+ absences and nobody marked any (the latest: 08 Sep 2026). 2 of 5 days with absences have every absence marked.",
    );
    expect(gapText({ ...fx.gaps, gapDayCount: 0, gapDays: [] })).toBe(
      "No day had 2+ absences with nothing marked. 2 of 5 days with absences have every absence marked.",
    );
    expect(gapText(fx.emptyGaps)).toBe("No day in this period had an absence to follow up.");
    expect(gapText({ ...fx.gaps, gapDayCount: 2, gapDays: [fx.gaps.gapDays[0], fx.gaps.gapDays[0]] })).toContain(
      "2 days had",
    );
  });
});

describe("how a group's absences were marked", () => {
  it("splits a row into shares that add up to 100", () => {
    const s = markShares(fx.departments.rows[0]);
    expect(s).toEqual({ informed: 25, notInformed: 12.5, unmarked: 62.5 });
    expect(s.informed + s.notInformed + s.unmarked).toBe(100);
  });

  it("has no shares without absences", () => {
    expect(markShares({ absences: 0, informed: 0, notInformed: 0, unmarked: 0 })).toEqual({
      informed: 0,
      notInformed: 0,
      unmarked: 0,
    });
  });
});

describe("focusing the page on a group", () => {
  const org: MdOrg = {
    branches: [
      { id: 1, name: "Unit A" },
      { id: 2, name: "Head Office" },
    ],
    departments: [
      { id: 10, name: "Stitching", branchId: 1, branchName: "Unit A", employees: 3 },
      { id: 12, name: "Accounts", branchId: 2, branchName: "Head Office", employees: 1 },
    ],
  };

  it("narrows to a department by name, and not twice", () => {
    expect(focusScope(EVERYONE, "department", { key: "Stitching", label: "Stitching" })).toEqual({
      ...EVERYONE,
      department: "Stitching",
    });
    expect(
      focusScope({ ...EVERYONE, department: "Stitching" }, "department", { key: "Stitching", label: "Stitching" }),
    ).toBeNull();
  });

  it("narrows to staff or production from the label the server gives", () => {
    expect(focusScope(EVERYONE, "type", { key: "Staff", label: "Staff" })).toEqual({ ...EVERYONE, type: "staff" });
    expect(focusScope(EVERYONE, "type", { key: "Production", label: "Production" })).toEqual({
      ...EVERYONE,
      type: "production",
    });
    expect(focusScope(EVERYONE, "type", { key: "Other", label: "Other" })).toBeNull();
    expect(focusScope({ ...EVERYONE, type: "staff" }, "type", { key: "Staff", label: "Staff" })).toBeNull();
  });

  it("narrows to a unit and drops a department that unit does not have", () => {
    expect(focusScope(EVERYONE, "unit", { key: "Unit A", label: "Unit A" }, org)).toEqual({ ...EVERYONE, branch: "1" });
    expect(
      focusScope({ ...EVERYONE, department: "Stitching" }, "unit", { key: "Head Office", label: "Head Office" }, org),
    ).toEqual({
      ...EVERYONE,
      branch: "2",
      department: "",
    });
    expect(focusScope(EVERYONE, "unit", { key: "Unit A", label: "Unit A" })).toBeNull(); // no unit list yet
    expect(focusScope({ ...EVERYONE, branch: "1" }, "unit", { key: "Unit A", label: "Unit A" }, org)).toBeNull();
  });
});

describe("who exports reports", () => {
  it("ranks people with their share, days and last export", () => {
    const bars = userBars(fx.exportsData.byUser);
    expect(bars[0]).toMatchObject({
      label: "Priya",
      value: 4,
      display: "4 · 67%",
      sub: "4 days · last 13 Sep, 11:50 pm",
    });
    expect(bars[1].sub).toBe("2 days · last 09 Sep, 3:00 pm");
  });

  it("ranks the reports with their share", () => {
    const bars = reportBars(fx.exportsData.byReport);
    expect(bars.map((b) => [b.label, b.display])).toEqual([
      ["Daily Attendance Register", "3 · 50%"],
      ["Late Coming Summary (Counts)", "2 · 33%"],
      ["Attendance Search (punch export)", "1 · 17%"],
    ]);
  });

  it("writes a latest export on one line", () => {
    expect(latestLine(fx.exportsData.latest[0])).toBe("13 Sep, 11:50 pm · Priya · Daily Attendance Register");
  });
});

describe("the assistant", () => {
  it("is given the headline figures in words", () => {
    const ctx = assistantSummary(fx.summary)!;
    expect(ctx["Absences on scheduled days"]).toBe(9);
    expect(ctx["Followed up"]).toBe("44.4%");
    expect(ctx["Days nobody made the call"]).toBe(1);
    expect(ctx["Attendance report exports on record"]).toBe(6);
    expect(assistantSummary(undefined)).toBeUndefined();
  });

  it("is given a null where there is no rate or no completed day", () => {
    expect(assistantSummary(fx.emptySummary)!["Followed up"]).toBeNull();
    expect(assistantSummary(fx.noCompletedDaySummary)!["Days nobody made the call"]).toBeNull();
  });

  it("carries the period and the selection in every question", () => {
    const q = askQuestions("Last 30 days", "Unit A · all departments · staff only");
    for (const text of Object.values(q).filter((t) => t.includes("("))) {
      expect(text).toContain("Last 30 days");
    }
    expect(q.attention).toContain("Unit A · all departments · staff only");
    expect(askQuestions("Last 30 days", null).page).toContain("(Last 30 days)");
    expect(q.limits).toContain("can't");
  });

  it("writes the period and the selection in words", () => {
    expect(periodText({ preset: "last_7_days" })).toBe("Last 7 days");
    expect(periodText({ preset: "custom", from: "2026-09-07", to: "2026-09-13" })).toBe("07 Sep 2026 to 13 Sep 2026");
    expect(scopeText(EVERYONE, "Unit A · all departments · staff only")).toBe("Unit A · all departments · staff only");
    expect(scopeText({ ...EVERYONE, department: "Stitching" })).toBe("All units · Stitching · staff and production");
  });
});
