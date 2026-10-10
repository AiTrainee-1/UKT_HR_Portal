import { describe, expect, it } from "vitest";
import {
  emptyOverview,
  emptyTrends,
  ME,
  overview,
  overviewWithFailedPayroll,
  trends,
  UNITS_WITH_LATE,
} from "./fixtures";
import {
  assistantContext,
  attendanceDomain,
  attendanceRows,
  BRIEFING_QUESTION,
  exploreTiles,
  failedSources,
  failureMessage,
  firstName,
  greetingLine,
  kpiLook,
  longDate,
  moreText,
  movementRows,
  movementSummary,
  pageNotes,
  payrollRows,
  provenanceFor,
  SKELETON_KPIS,
  tickLabel,
  tickMonth,
  unitCaption,
  unitSegments,
} from "./logic";
import { isSectionError, type AttendanceTrend, type MovementTrend, type PayrollTrend } from "./types";

describe("the hero", () => {
  it("calls the MD by the first real word of the name", () => {
    expect(firstName("R. Murugan")).toBe("Murugan");
    expect(firstName("Mr. Rajesh Kumar")).toBe("Rajesh");
    expect(firstName("Dr S. Anand Kumar")).toBe("Anand");
    expect(firstName("Murugan R")).toBe("Murugan");
    expect(firstName("Sundar")).toBe("Sundar");
    expect(firstName("md_test")).toBe("md_test");
    expect(firstName("A. B.")).toBe("A.");
    expect(firstName("  ")).toBe("");
    expect(firstName(null)).toBe("");
    expect(firstName(undefined)).toBe("");
  });

  it("writes the date in full, without depending on the browser's locale", () => {
    expect(longDate("2026-10-05")).toBe("Monday, 5 October 2026");
    expect(longDate("2026-10-05T14:10:00")).toBe("Monday, 5 October 2026");
    expect(longDate("2026-01-01")).toBe("Thursday, 1 January 2026");
    expect(longDate("")).toBe("");
    expect(longDate(undefined)).toBe("");
    expect(longDate("not a date")).toBe("");
  });

  it("greets by the factory's clock", () => {
    expect(greetingLine("2026-10-05T09:00:00", "R. Murugan")).toBe("Good morning, Murugan");
    expect(greetingLine("2026-10-05T14:10:00", "R. Murugan")).toBe("Good afternoon, Murugan");
    expect(greetingLine("2026-10-05T19:30:00", "Sundar")).toBe("Good evening, Sundar");
    expect(greetingLine("2026-10-05T14:10:00", undefined)).toBe("Good afternoon");
  });

  it("asks the assistant the briefing question the server also uses", () => {
    expect(BRIEFING_QUESTION).toBe(overview.briefing.ask);
  });
});

describe("what went wrong", () => {
  it("lists the pages that could not be read, and nothing when all answered", () => {
    expect(failedSources(overview)).toEqual([]);
    expect(failedSources(undefined)).toEqual([]);
    expect(failedSources(overviewWithFailedPayroll)).toEqual([
      { module: "payroll", title: "Payroll Analysis", message: "Payroll Analysis could not be loaded just now." },
    ]);
  });

  it("says it in one sentence however many pages failed", () => {
    expect(failureMessage([{ title: "Payroll Analysis" }])).toBe(
      "Payroll Analysis could not be read just now, so its figures and exceptions are missing from this page.",
    );
    expect(failureMessage([{ title: "Payroll Analysis" }, { title: "Tea Break" }, { title: "Recruitment" }])).toBe(
      "Payroll Analysis, Tea Break and Recruitment could not be read just now, so their figures and exceptions are missing from this page.",
    );
  });

  it("keeps the notes the failure banner does not already say", () => {
    expect(
      pageNotes([
        "Payroll Analysis could not be loaded, so what it adds is missing here.",
        "Matched unit 'unit1' to 'Unit 1'.",
        "The cards are for the whole company.",
        "The cards are for the whole company.",
      ]),
    ).toEqual(["The cards are for the whole company."]);
    expect(pageNotes(undefined)).toEqual([]);
  });
});

describe("the cards", () => {
  it("give the eight usual ones their own icon and tint, and any other its page's", () => {
    expect(kpiLook({ id: "attendance-today", module: "attendance" })).toEqual({ icon: "attendance", tone: "green" });
    expect(kpiLook({ id: "payroll-overtime", module: "payroll" })).toEqual({ icon: "overtime", tone: "purple" });
    expect(kpiLook({ id: "tea-break.overrun-pct", module: "tea_break" })).toEqual({ icon: "coffee", tone: "amber" });
    expect(kpiLook({ id: "something.new", module: "unknown" })).toEqual({ icon: "users", tone: "slate" });
    expect(SKELETON_KPIS).toHaveLength(8);
    expect(SKELETON_KPIS.map((t) => t.id)).toEqual(overview.kpis.map((k) => k.id));
  });

  it("find the entries that explain them by id", () => {
    const card = overview.kpis[1];
    expect(provenanceFor(card, overview.provenance).map((p) => p.id)).toEqual(["attendance:live-today"]);
    expect(provenanceFor({ provenanceIds: [] }, overview.provenance)).toEqual([]);
    expect(provenanceFor(card, undefined)).toEqual([]);
  });
});

describe("today by unit", () => {
  const row = { expected: 14, present: 11, late: null, leave: 0, absent: 3 };

  it("cuts a bar into the people in, on leave and not in yet", () => {
    const segments = unitSegments({ expected: 700, present: 595, late: null, leave: 10, absent: 95 });
    expect(segments.map((s) => [s.key, s.value])).toEqual([
      ["in", 595],
      ["leave", 10],
      ["notIn", 95],
    ]);
    expect(segments.reduce((sum, s) => sum + s.widthPct, 0)).toBeCloseTo(100, 6);
    expect(segments[0].widthPct).toBeCloseTo(85, 6);
  });

  it("takes late arrivals out of 'in' when the day records say how many", () => {
    const segments = unitSegments({ ...row, late: 2 });
    expect(segments.map((s) => [s.key, s.value])).toEqual([
      ["in", 9],
      ["late", 2],
      ["notIn", 3],
    ]);
    expect(segments.reduce((sum, s) => sum + s.widthPct, 0)).toBeCloseTo(100, 6);
  });

  it("draws nothing for a unit nobody is scheduled in, and never a negative piece", () => {
    expect(unitSegments({ expected: 0, present: 0, late: null, leave: 0, absent: 0 })).toEqual([]);
    expect(unitSegments({ expected: 5, present: 2, late: 4, leave: 0, absent: 3 }).map((s) => s.key)).toEqual([
      "late",
      "notIn",
    ]);
  });

  it("says it in words", () => {
    expect(unitCaption(row)).toBe("11 of 14 in · 3 not in yet");
    expect(unitCaption({ expected: 490, present: 480, late: 11, leave: 10, absent: 0 })).toBe(
      "480 of 490 in · 10 on leave · 11 late",
    );
    expect(unitCaption({ expected: 5, present: 5, late: null, leave: 0, absent: 0 })).toBe("5 of 5 in");
  });

  it("has a fixture whose late arrivals add up", () => {
    expect(UNITS_WITH_LATE.rows.reduce((n, r) => n + (r.late ?? 0), 0)).toBe(UNITS_WITH_LATE.total.late);
  });
});

describe("the charts", () => {
  const attendance = trends.attendance as AttendanceTrend;
  const payroll = trends.payroll as PayrollTrend;
  const movement = trends.movement as MovementTrend;

  it("tells a section from an error entry", () => {
    expect(isSectionError({ error: "x" })).toBe(true);
    expect(isSectionError(attendance)).toBe(false);
    expect(isSectionError(undefined)).toBe(false);
  });

  it("shapes the attendance line and gives it a range that shows a dip", () => {
    const rows = attendanceRows(attendance);
    expect(rows).toHaveLength(attendance.points.length);
    expect(rows[0]).toEqual({ date: attendance.points[0].date, attendance: attendance.points[0].attendancePct });
    const [low, high] = attendanceDomain(rows);
    expect(high).toBe(100);
    expect(low % 5).toBe(0);
    expect(low).toBeLessThanOrEqual(Math.min(...rows.map((r) => r.attendance as number)) - 5);
    expect(attendanceDomain([])).toEqual([0, 100]);
    expect(attendanceDomain([{ date: "x", attendance: null }])).toEqual([0, 100]);
    expect(attendanceDomain([{ date: "x", attendance: 3 }])[0]).toBe(0);
  });

  it("draws a provisional month lighter, as the Payroll page does", () => {
    const rows = payrollRows(payroll);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.grossProvisional === null)).toBe(true);
    const provisional = payrollRows({
      ...payroll,
      months: payroll.months.map((m, i) =>
        i === 11 ? { ...m, state: "in_progress" } : i === 10 ? { ...m, provisionalSlips: 4 } : m,
      ),
    });
    expect(provisional[11]).toMatchObject({ gross: null, grossProvisional: payroll.months[11].grossPay });
    expect(provisional[10]).toMatchObject({ gross: null, grossProvisional: payroll.months[10].grossPay });
    expect(provisional[9].gross).toBe(payroll.months[9].grossPay);
    expect(payrollRows({ ...payroll, months: [] })).toEqual([]);
  });

  it("writes month ticks short", () => {
    expect(tickMonth("2026-09")).toBe("Sep 26");
    expect(tickMonth("2026-01")).toBe("Jan 26");
    expect(tickLabel("Nov 2025")).toBe("Nov 25");
    expect(tickLabel("05 Oct - 11 Oct")).toBe("05 Oct - 11 Oct");
  });

  it("shapes joiners and leavers and sums them up", () => {
    const rows = movementRows(movement);
    expect(rows).toHaveLength(12);
    expect(rows[0]).toEqual({
      label: "Oct 2025",
      joiners: movement.points[0].joiners,
      leavers: movement.points[0].leavers,
    });
    expect(movementSummary(movement.totals)).toBe("165 joined · 177 left · net -12");
    expect(movementSummary({ joiners: 4, leavers: 1, net: 3, opening: null, closing: null })).toBe(
      "4 joined · 1 left · net +3",
    );
    expect(movementSummary({ joiners: 0, leavers: 0, net: 0, opening: 0, closing: 0 })).toBe(
      "0 joined · 0 left · net 0",
    );
  });

  it("has an empty fixture that really is empty", () => {
    expect((emptyTrends.attendance as AttendanceTrend).points).toEqual([]);
    expect((emptyTrends.payroll as PayrollTrend).hasData).toBe(false);
  });
});

describe("explore", () => {
  it("offers every page but the dashboard, in sidebar order, with the page's own summary", () => {
    const tiles = exploreTiles(ME.pages);
    expect(tiles.map((t) => t.id)).toEqual([
      "employees",
      "branches",
      "attendance",
      "attendance-production",
      "geo-attendance",
      "attendance-search",
      "report-log",
      "outpass",
      "visitors",
      "tea-break",
      "shifts",
      "leave",
      "requests",
      "payroll",
      "reports",
      "recruitment",
      "activity",
    ]);
    const payroll = tiles.find((t) => t.id === "payroll");
    expect(payroll?.path).toBe("/md/payroll");
    expect(payroll?.summary).toContain("Payroll cost and its trend");
    expect(payroll?.question).toMatch(/payroll/i);
    expect(tiles.every((t) => t.question.endsWith("?"))).toBe(true);
  });

  it("works before the page list has loaded", () => {
    const tiles = exploreTiles(undefined);
    expect(tiles).toHaveLength(17);
    expect(tiles.every((t) => t.summary === "")).toBe(true);
  });
});

describe("the assistant", () => {
  it("is told the headline numbers as the cards write them, and the first item", () => {
    const context = assistantContext(overview);
    expect(context.page).toBe("dashboard");
    expect(context.filters).toEqual({ Scope: "Whole company", "Numbers as of": "2:10 pm" });
    expect(context.summary?.["Active headcount"]).toBe("1,240");
    expect(context.summary?.["Payroll cost"]).toBe("₹2.4 Cr");
    expect(context.summary?.["Most important item"]).toBe("Stitching absenteeism is 14%, double its 90-day average");
  });

  it("says 'no data' for a card without a figure and publishes nothing before the first answer", () => {
    expect(assistantContext(emptyOverview).summary?.["Attendance today"]).toBe("no data");
    expect(assistantContext(undefined).summary).toBeUndefined();
  });
});

describe("the exceptions footer", () => {
  it("says how many were left out, and nothing when none were", () => {
    expect(moreText(7, 5)).toContain("And 2 more");
    expect(moreText(5, 5)).toBeNull();
    expect(moreText(0, 0)).toBeNull();
  });
});
