import { describe, expect, it } from "vitest";
import { EVERYONE } from "@/lib/md/period";
import { EMPTY_SUMMARY, EXCEPTIONS, HEATMAP, LIVE, SUMMARY, WEEKDAY } from "./fixtures";
import {
  EXCEPTION_TABS,
  ask,
  attendanceDomain,
  buildAssistantContext,
  coverageText,
  datesText,
  dayGridInput,
  exceptionCounts,
  firstBusyTab,
  formatOf,
  gridRange,
  liveSentence,
  measuredText,
  metricDelta,
  metricText,
  mondayText,
  mostMissing,
  notesWithoutCoverage,
  pointsDelta,
  previousText,
  ruleText,
  trendRows,
  trendTick,
  waitText,
  waitTone,
  wasText,
  weekdayBars,
  weekGridInput,
  withDepartment,
  withType,
  withUnit,
  worstDaysText,
} from "./logic";
import type { Metric, TrendPoint } from "./types";

const m = (value: number | null, previous: number | null, good: Metric["good"], abs: number | null = null): Metric => ({
  value,
  previous,
  delta: abs == null ? null : { abs, pct: null },
  good,
  spark: null,
});

describe("how a figure is written", () => {
  it("knows each figure's format", () => {
    expect(formatOf("attendancePct")).toBe("pct");
    expect(formatOf("coveragePct")).toBe("pct");
    expect(formatOf("avgLateMinutes")).toBe("minutes");
    expect(formatOf("overtimeHours")).toBe("number");
    expect(formatOf("halfDays")).toBe("number");
  });

  it("writes percentages, minutes, hours and counts, and a dash for no data", () => {
    expect(metricText("attendancePct", m(75.9, null, "up"))).toBe("75.9%");
    expect(metricText("avgLateMinutes", m(35, null, "down"))).toBe("35m");
    expect(metricText("avgLateMinutes", m(95, null, "down"))).toBe("1h 35m");
    expect(metricText("overtimeHours", m(6.5, null, "down"))).toBe("6.5 h");
    expect(metricText("overtimeHours", m(1204, null, "down"))).toBe("1,204.0 h");
    expect(metricText("halfDays", m(2, null, "down"))).toBe("2");
    expect(metricText("scheduledDays", m(123456, null, null))).toBe("1,23,456"); // Indian grouping
    expect(metricText("halfDays", m(null, null, "down"))).toBe("—");
    expect(metricText("halfDays", undefined)).toBe("—");
    expect(metricText("attendancePct", m(0, null, "up"))).toBe("0%"); // a real zero is not "no data"
  });

  it("shows the change in points for a percentage, coloured by which way is good", () => {
    expect(metricDelta("attendancePct", m(75.9, 89.6, "up", -13.7))).toEqual({
      text: "-13.7 pts",
      tone: "bad",
      direction: "down",
    });
    expect(metricDelta("absenteeismPct", m(17.2, 8.3, "down", 8.9))).toEqual({
      text: "+8.9 pts",
      tone: "bad",
      direction: "up",
    });
    expect(metricDelta("absenteeismPct", m(5, 8.3, "down", -3.3))?.tone).toBe("good");
    expect(metricDelta("leaveDays", m(1, 0, null, 1))?.tone).toBe("neutral"); // leave is neither good nor bad
    expect(metricDelta("attendancePct", m(75.9, null, "up"))).toBeNull(); // nothing to compare with
    expect(metricDelta("attendancePct", undefined)).toBeNull();
  });

  it("writes the previous figure in words", () => {
    expect(wasText("attendancePct", m(75.9, 89.6, "up"))).toBe("was 89.6% before");
    expect(wasText("avgLateMinutes", m(35, 20, "down"))).toBe("was 20m before");
    expect(wasText("attendancePct", m(75.9, null, "up"))).toBeNull();
  });

  it("writes a change in points for a table cell", () => {
    expect(pointsDelta(-22.2, true)).toEqual({ text: "-22.2 pts", tone: "bad", direction: "down" });
    expect(pointsDelta(14.5, false)?.tone).toBe("bad"); // absence going up
    expect(pointsDelta(0, true)).toEqual({ text: "0 pts", tone: "neutral", direction: "flat" });
    expect(pointsDelta(null, true)).toBeNull();
  });

  it("names the days the figures cover", () => {
    expect(measuredText(SUMMARY)).toBe("07 Sep – 13 Sep");
    expect(previousText(SUMMARY)).toBe("31 Aug – 06 Sep");
    expect(previousText({ ...SUMMARY, previous: null })).toBeNull();
    expect(measuredText({ ...SUMMARY, measured: { start: "2026-09-07", end: "2026-09-07", days: 1 } })).toBe("07 Sep");
  });
});

describe("today, live", () => {
  it("says who is in so far", () => {
    expect(liveSentence(LIVE)).toBe("228 of 262 in so far (87%) · 14 on leave · 20 not in yet");
    expect(liveSentence({ ...LIVE, leave: 0 })).toBe("228 of 262 in so far (87%) · 20 not in yet");
    expect(liveSentence({ ...LIVE, isWorkingDay: false })).toContain("Nobody is scheduled");
  });

  it("finds where the most people are missing", () => {
    expect(mostMissing(LIVE.byUnit)).toEqual({
      name: "Unit 1",
      expected: 180,
      present: 150,
      leave: 10,
      absent: 20,
      attendancePct: 83.3,
      id: 1,
    });
    expect(mostMissing([{ name: "A", absent: 0 }])).toBeNull();
    expect(mostMissing([])).toBeNull();
    expect(
      mostMissing([
        { name: "B", absent: 2 },
        { name: "A", absent: 2 },
      ])?.name,
    ).toBe("A"); // ties by name
  });
});

describe("data coverage", () => {
  const cov = {
    expectedDays: 29,
    recordedDays: 26,
    missingDays: 3,
    coveragePct: 89.7,
    partial: true,
    worstDays: [
      { date: "2026-09-08", expected: 5, recorded: 4, coveragePct: 80 },
      { date: "2026-09-09", expected: 5, recorded: 4, coveragePct: 80 },
    ],
  };

  it("says how much of the period has records, and which dates to open first", () => {
    expect(coverageText(cov)).toBe("89.7% of scheduled days have an attendance record (26 of 29 employee-days).");
    expect(worstDaysText(cov)).toBe("08 Sep (80%), 09 Sep (80%)");
    expect(worstDaysText({ ...cov, worstDays: [] })).toBe("");
    expect(coverageText(null)).toContain("No scheduled days");
    expect(coverageText({ ...cov, expectedDays: 0 })).toContain("No scheduled days");
  });

  it("leaves the partial-coverage sentence to the note at the foot of the page", () => {
    const notes = [
      "Today is still running and is left out of the figures.",
      "Attendance day records exist for 89.7% of scheduled days (26 of 29 employee-days).",
      "No attendance day records exist for these days: HR has not opened them.",
    ];
    expect(notesWithoutCoverage(notes)).toEqual([notes[0], notes[2]]);
    expect(notesWithoutCoverage([])).toEqual([]);
  });
});

describe("charts", () => {
  const point = (date: string, attendancePct: number | null): TrendPoint => ({
    date,
    days: 1,
    attendancePct,
    absentPct: 5,
    latePct: 2,
    present: 9,
    half: 0,
    absent: 1,
    leave: 0,
    late: 1,
    expected: 10,
    rostered: 10,
    coveragePct: 100,
  });

  it("shapes the trend for the chart", () => {
    const rows = trendRows([point("2026-09-07", 90), point("2026-09-08", null)]);
    expect(rows).toEqual([
      { date: "2026-09-07", attendancePct: 90, absentPct: 5, latePct: 2, present: 9, absent: 1, leave: 0, late: 1 },
      { date: "2026-09-08", attendancePct: null, absentPct: 5, latePct: 2, present: 9, absent: 1, leave: 0, late: 1 },
    ]);
  });

  it("zooms the attendance line to just under its lowest point, in steps of 5", () => {
    expect(attendanceDomain([point("a", 75), point("b", 90)])).toEqual([70, 100]); // 73 -> 70
    expect(attendanceDomain([point("a", 98.2), point("b", 99)])).toEqual([95, 100]);
    expect(attendanceDomain([point("a", 3)])).toEqual([0, 100]); // never below zero
    expect(attendanceDomain([point("a", null)])).toEqual([0, 100]);
    expect(attendanceDomain([])).toEqual([0, 100]);
  });

  it("labels days and weeks", () => {
    expect(trendTick("day")("2026-09-07")).toBe("07 Sep");
    expect(trendTick("week")("2026-09-07")).toBe("Wk 07 Sep");
  });

  it("ranks the weekdays by absence with the worst in red", () => {
    const bars = weekdayBars(WEEKDAY.weekdays);
    expect(bars.map((b) => [b.label, b.value, b.display])).toEqual([
      ["Mon", 0, "0%"],
      ["Wed", 40, "40%"],
    ]);
    expect(bars[1].color).not.toBe(bars[0].color);
    expect(bars[1].sub).toBe("Attendance 50% · late 33.3% · 2 absent in 5 scheduled days");
    expect(weekdayBars([{ ...WEEKDAY.weekdays[0] }]).every((b) => b.color === bars[0].color)).toBe(true); // 0 % is not "worst"
  });

  it("says what Mondays look like", () => {
    expect(mondayText({ mondayAbsentPct: 14.8, otherDaysAbsentPct: 8.2, gapPts: 6.6, mondays: 3 })).toBe(
      "Mondays run 14.8% absent against 8.2% on other days.",
    );
    expect(mondayText({ mondayAbsentPct: 0, otherDaysAbsentPct: 20.8, gapPts: -20.8, mondays: 1 })).toContain(
      "no worse",
    );
    expect(mondayText(null)).toBeNull();
  });

  it("shapes the two grids", () => {
    expect(weekGridInput(WEEKDAY.heatmap)).toEqual({ rows: ["Mon", "Wed"], cols: ["07 Sep"], values: [[100], [50]] });
    expect(dayGridInput(HEATMAP)).toEqual({
      rows: ["Stitching", "Cutting"],
      cols: ["7", "8", "9"],
      values: [
        [100, 66.7, 16.7],
        [100, 100, null],
      ],
    });
    expect(gridRange(HEATMAP)).toBe("07 Sep – 09 Sep");
    expect(gridRange({ ...HEATMAP, days: [] })).toBe("");
  });
});

describe("exceptions", () => {
  it("counts each list and opens on the first one with someone in it", () => {
    const counts = exceptionCounts(EXCEPTIONS);
    expect(counts).toEqual({
      chronicAbsentees: 1,
      habitualLate: 0,
      longAbsences: 1,
      missingPunches: 1,
      afterOffAbsences: 0,
    });
    expect(firstBusyTab(counts)).toBe("chronicAbsentees");
    expect(firstBusyTab({ ...counts, chronicAbsentees: 0 })).toBe("longAbsences");
    expect(
      firstBusyTab({ chronicAbsentees: 0, habitualLate: 0, longAbsences: 0, missingPunches: 0, afterOffAbsences: 0 }),
    ).toBe("chronicAbsentees");
    expect(exceptionCounts(undefined).longAbsences).toBe(0);
    expect(EXCEPTION_TABS.map((t) => t.key)).toEqual([
      "chronicAbsentees",
      "habitualLate",
      "longAbsences",
      "missingPunches",
      "afterOffAbsences",
    ]);
  });

  it("states each rule from the thresholds the server used", () => {
    const t = EXCEPTIONS.thresholds;
    expect(ruleText("chronicAbsentees", t)).toBe(
      "3 or more unplanned absence days, and at least 10% of the person's scheduled days.",
    );
    expect(ruleText("habitualLate", t)).toContain("Late on 4 or more days");
    expect(ruleText("longAbsences", t)).toContain("3 or more days in a row");
    expect(ruleText("missingPunches", t)).toContain("3 or more missing-punch requests");
    expect(ruleText("afterOffAbsences", t)).toContain("at least 60%");
    expect(ruleText("chronicAbsentees", undefined)).toBe("");
  });

  it("shortens a list of dates", () => {
    expect(datesText(["2026-09-10", "2026-09-09"])).toBe("10 Sep, 09 Sep");
    expect(datesText(["2026-09-10", "2026-09-09", "2026-09-08", "2026-09-07", "2026-09-06"])).toBe(
      "10 Sep, 09 Sep, 08 Sep +2 more",
    );
    expect(datesText([])).toBe("");
  });
});

describe("approvals waiting", () => {
  it("writes how long and how worrying", () => {
    expect([waitText(null), waitText(0), waitText(1), waitText(20)]).toEqual(["—", "today", "1 day", "20 days"]);
    expect([waitTone(null), waitTone(7), waitTone(8), waitTone(14), waitTone(15)]).toEqual([
      "slate",
      "slate",
      "amber",
      "amber",
      "red",
    ]);
  });
});

describe("narrowing the scope", () => {
  it("narrows to a department by name, a unit by id (dropping a department it may not have), a type", () => {
    const scope = { ...EVERYONE, branch: "2", department: "Cutting" };
    expect(withDepartment(EVERYONE, "Stitching")).toEqual({ branch: "", department: "Stitching", type: "" });
    expect(withUnit(scope, 1)).toEqual({ branch: "1", department: "", type: "" });
    expect(withType(EVERYONE, "production")).toEqual({ branch: "", department: "", type: "production" });
    expect(withType(EVERYONE, "contract")).toEqual(EVERYONE); // anything else changes nothing
  });
});

describe("questions for the assistant", () => {
  const context = { period: "Last 30 days", scope: "All units · Stitching · staff only", summary: SUMMARY };

  it("puts the figure on screen into the question", () => {
    expect(ask.attendance(context)).toBe(
      "Attendance is 75.9% (was 89.6% before) (Last 30 days, All units · Stitching · staff only). What is driving it, and which departments pull it down?",
    );
    expect(ask.absenteeism(context)).toContain("Absenteeism is 17.2%");
    expect(ask.late(context)).toContain("17.4% of days worked start late, by 35m on average");
    expect(ask.overtime(context)).toContain("6.5 h of overtime");
    expect(ask.trend(context)).toContain("now 75.9%");
  });

  it("still asks something sensible when there is no figure", () => {
    const empty = { ...context, summary: EMPTY_SUMMARY };
    expect(ask.attendance(empty)).toBe(
      "What does attendance look like (Last 30 days, All units · Stitching · staff only)?",
    );
    expect(ask.absenteeism({ ...context, summary: undefined })).toContain("How much unplanned absence");
    expect(ask.overtime(empty)).toContain("is it being tracked");
  });

  it("names the department, the list and the day", () => {
    expect(ask.department(context, "Stitching")).toContain("Why is attendance low in Stitching");
    expect(ask.exceptions(context, "longAbsences")).toContain("absent several days in a row");
    expect(ask.exceptions(context, "afterOffAbsences")).toContain("right after a weekly off");
    expect(ask.day(context, "yesterday")).toBe(
      "How many people were absent, late or on leave yesterday (All units · Stitching · staff only), by unit and department?",
    );
    expect(ask.day(context, "2026-09-09")).toBe(
      "How many people were absent, late or on leave on 09 Sep (All units · Stitching · staff only), by unit and department?",
    );
    expect(ask.today(context)).toContain("Who is not in yet today");
  });

  it("every question is a specific sentence", () => {
    const all = [
      ask.page(context),
      ask.halfDays(context),
      ask.missingPunches(context),
      ask.weekday(context),
      ask.departments(context),
      ask.heatmap(context),
      ask.overtimeByDepartment(context),
      ask.leave(context),
      ask.coverage(context),
      ...EXCEPTION_TABS.map((t) => ask.exceptions(context, t.key)),
    ];
    for (const q of all) {
      expect(q.length).toBeGreaterThan(40);
      expect(q).toContain("Last 30 days");
    }
  });
});

describe("what the assistant is told the page shows", () => {
  it("carries the filters and the headline numbers", () => {
    const ctx = buildAssistantContext({ ...SUMMARY, live: LIVE }, "07 Sep – 13 Sep 2026", "All units");
    expect(ctx.page).toBe("attendance");
    expect(ctx.title).toBe("Attendance Analytics");
    expect(ctx.filters).toEqual({ Period: "07 Sep – 13 Sep 2026", Scope: "All units", "Days measured": "7" });
    expect(ctx.summary).toMatchObject({
      Attendance: "75.9%",
      Absenteeism: "17.2%",
      "Late arrivals": "17.4%",
      "Average minutes late": "35m",
      "Overtime hours": "6.5 h",
      "Half days": 2,
      "Missing punches waiting": 2,
      "Data coverage": "100%",
      "In so far today": "228 of 262",
    });
  });

  it("leaves out what it does not know", () => {
    const ctx = buildAssistantContext(undefined, "Last 30 days", "All units");
    expect(ctx.summary?.Attendance).toBeNull();
    expect(ctx.summary?.["In so far today"]).toBeNull();
    expect(ctx.filters?.["Days measured"]).toBeNull();
  });
});
