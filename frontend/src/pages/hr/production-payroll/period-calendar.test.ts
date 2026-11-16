import { describe, expect, it } from "vitest";
import type { CyclePeriodRow } from "@/lib/api-client/custom-hooks";
import {
  KIND_META,
  addDays,
  addMonths,
  calendarLimits,
  clampView,
  dayLabel,
  gridWindow,
  kindCounts,
  latestGeneratedRow,
  mergeRows,
  monthRows,
  nextDueRow,
  payslipSummary,
  periodInView,
  periodKind,
  periodMiddle,
  periodSpan,
  periodTiming,
  probeDates,
  rowHolding,
  rowsSignature,
  sweepDelay,
  viewFor,
  weekStartOf,
  weekdayHeads,
} from "./period-calendar";

// The pay-period calendar's pure helpers: a period's colour comes from the server's state, a month is laid out in the
// cycle's own weeks, and the months on screen ask the server once for every period it has not given yet.

const row = (periodStart: string, periodEnd: string, over: Partial<CyclePeriodRow> = {}): CyclePeriodRow => ({
  periodStart,
  periodEnd,
  periodEnded: true,
  isNext: false,
  generated: 0,
  paid: 0,
  state: "not_generated",
  parked: 0,
  ...over,
});

// BiWeekly, Monday weeks, as the live server lists them
const BI = [
  row("2026-09-28", "2026-10-11", { generated: 11, state: "paid" }),
  row("2026-10-12", "2026-10-25", { generated: 114, state: "finalized" }),
  row("2026-10-26", "2026-11-08", { generated: 113, state: "generated", isNext: true }),
  row("2026-11-09", "2026-11-22", { periodEnded: false }),
];

describe("what a pay period's colour says", () => {
  it("follows the server's state: Paid, Payroll Done, Generated; else ended (needs attention) or not ended", () => {
    expect(periodKind(BI[0])).toBe("paid");
    expect(periodKind(BI[1])).toBe("done");
    expect(periodKind(BI[2])).toBe("generated");
    expect(periodKind(row("2026-09-14", "2026-09-27"))).toBe("due");
    expect(periodKind(BI[3])).toBe("upcoming");
  });

  it("reads an older server's row (no state) by its payslips", () => {
    expect(periodKind({ generated: 3, periodEnded: true })).toBe("generated");
    expect(periodKind({ generated: 0, periodEnded: true })).toBe("due");
    expect(periodKind({ generated: 0, periodEnded: false })).toBe("upcoming");
  });

  it("paints Paid green and says more than colour: every kind has its own words", () => {
    expect(KIND_META.paid.block).toContain("emerald");
    expect(KIND_META.paid.solid).toBe("bg-emerald-600");
    expect(KIND_META.generated.block).toContain("indigo");
    expect(KIND_META.done.block).toContain("amber");
    expect(KIND_META.due.block).toContain("rose");
    // still to come: dashed and striped, whatever a theme does with the blues
    expect(KIND_META.upcoming.block).toContain("border-dashed");
    expect(KIND_META.upcoming.block).toContain("repeating-linear-gradient");
    const labels = Object.values(KIND_META).map((m) => m.label);
    expect(new Set(labels).size).toBe(5);
  });

  it("counts the periods of each colour that the months on screen show", () => {
    expect(kindCounts(BI, { from: "2026-10-01", to: "2026-10-31" })).toEqual({
      paid: 1,
      done: 1,
      generated: 1,
      due: 0,
      upcoming: 0,
    });
    expect(kindCounts(BI, null).generated).toBe(0);
  });
});

describe("a month in the cycle's own weeks", () => {
  it("starts every row on the cycle's start weekday, so a period fills whole rows", () => {
    // Friday weeks (the live Weekly cycle): November 2026 runs from Fri 30 Oct to Thu 3 Dec
    const rows = monthRows({ year: 2026, month: 11 }, 5);
    expect(rows[0][0]).toBe("2026-10-30");
    expect(rows[rows.length - 1][6]).toBe("2026-12-03");
    expect(rows.every((r) => r.length === 7)).toBe(true);
    expect(weekdayHeads(5)).toEqual(["Fri", "Sat", "Sun", "Mon", "Tue", "Wed", "Thu"]);
    // Monday weeks: October 2026 starts on Mon 28 Sep
    expect(monthRows({ year: 2026, month: 10 }, 1)[0][0]).toBe("2026-09-28");
  });

  it("reads the start weekday from the server's own periods", () => {
    expect(weekStartOf(BI)).toBe(1);
    expect(weekStartOf([row("2026-11-13", "2026-11-19")])).toBe(5);
    expect(weekStartOf([])).toBeNull();
  });

  it("knows the first and last day drawn for one or two months", () => {
    expect(gridWindow({ year: 2026, month: 10 }, 2, 1)).toEqual({ from: "2026-09-28", to: "2026-12-06" });
    expect(gridWindow({ year: 2026, month: 11 }, 1, 1)).toEqual({ from: "2026-10-26", to: "2026-12-06" });
  });

  it("counts months across a year", () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("asking the server for the periods on screen", () => {
  const limits = { min: "2023-11-01", max: "2027-02-28" };

  it("asks once for each period it has not seen, by the period's first day", () => {
    expect(probeDates(BI, { from: "2026-09-28", to: "2026-12-06" }, 14, limits)).toEqual(["2026-11-23"]);
    expect(probeDates(BI, { from: "2026-08-31", to: "2026-10-11" }, 14, limits)).toEqual(["2026-08-31", "2026-09-14"]);
  });

  it("asks nothing when every period is known, or before any period is known", () => {
    expect(probeDates(BI, { from: "2026-09-28", to: "2026-11-22" }, 14, limits)).toEqual([]);
    expect(probeDates([], { from: "2026-09-28", to: "2026-11-22" }, 14, limits)).toEqual([]);
  });

  it("stays inside the limits", () => {
    expect(probeDates(BI, { from: "2026-11-23", to: "2027-04-30" }, 14, limits)).toEqual([
      "2026-11-23",
      "2026-12-07",
      "2026-12-21",
      "2027-01-04",
      "2027-01-18",
      "2027-02-01",
      "2027-02-15",
    ]);
    // a period that begins before the oldest day is asked for by the oldest day
    expect(probeDates(BI, { from: "2023-10-23", to: "2023-11-05" }, 14, limits)).toEqual(["2023-11-01"]);
  });

  it("merges lists: a later copy of a period replaces an earlier one, oldest first", () => {
    const fresh = row("2026-10-26", "2026-11-08", { generated: 113, state: "finalized" });
    const merged = mergeRows(BI, [fresh], null);
    expect(merged).toHaveLength(4);
    expect(merged.map((r) => r.periodStart)).toEqual(["2026-09-28", "2026-10-12", "2026-10-26", "2026-11-09"]);
    expect(rowHolding(merged, "2026-11-01")?.state).toBe("finalized");
    expect(rowsSignature(merged)).not.toBe(rowsSignature(BI));
    expect(rowsSignature(mergeRows(BI))).toBe(rowsSignature(BI));
  });
});

describe("which months are on screen", () => {
  it("shows the month holding most of the period on the right", () => {
    const p = { periodStart: "2026-10-26", periodEnd: "2026-11-08" };
    expect(periodMiddle(p)).toBe("2026-11-01");
    expect(viewFor(p, 2)).toEqual({ year: 2026, month: 10 });
    expect(viewFor(p, 1)).toEqual({ year: 2026, month: 11 });
    expect(periodInView(p, { year: 2026, month: 10 }, 2)).toBe(true);
    expect(periodInView(p, { year: 2026, month: 10 }, 1)).toBe(false);
  });

  it("pages three years back and two months ahead, and always far enough for the selected period", () => {
    const l = calendarLimits("2026-11-16", 2);
    expect(l.minLeft).toEqual({ year: 2023, month: 11 });
    expect(l.maxLeft).toEqual({ year: 2026, month: 12 }); // December + January on screen
    expect(l.min).toBe("2023-11-01");
    expect(l.max).toBe("2027-02-28");
    const old = calendarLimits("2030-01-10", 2, { periodStart: "2026-02-02", periodEnd: "2026-02-08" });
    expect(old.minLeft).toEqual({ year: 2026, month: 2 });
    expect(old.min).toBe("2026-02-01");
    expect(clampView({ year: 2020, month: 1 }, l)).toEqual(l.minLeft);
    expect(clampView({ year: 2028, month: 1 }, l)).toEqual(l.maxLeft);
  });
});

describe("the selection's sweep", () => {
  it("fills the days in one after another in about half a second, and all at once with reduced motion", () => {
    expect(sweepDelay(0, 14, false)).toBe(0);
    expect(sweepDelay(1, 14, false)).toBe(0.035);
    expect(sweepDelay(13, 14, false)).toBeCloseTo(0.455, 3);
    expect(sweepDelay(27, 28, false)).toBeLessThanOrEqual(0.5);
    expect(sweepDelay(13, 14, true)).toBe(0);
  });
});

describe("quick picks and the summary's words", () => {
  it("finds the next due period and the newest one with payroll", () => {
    expect(nextDueRow(BI)?.periodStart).toBe("2026-10-26");
    expect(latestGeneratedRow(BI)?.periodStart).toBe("2026-10-26");
    expect(latestGeneratedRow([row("2026-11-09", "2026-11-22")])).toBeUndefined();
  });

  it("says how many payslips there are and how many are on the cycle now, without a confusing '114 of 113'", () => {
    expect(payslipSummary(BI[2], 113)).toEqual({ line: "113 payslips · 113 on the cycle now", note: null });
    const more = payslipSummary(BI[1], 112);
    expect(more.line).toBe("114 payslips · 112 on the cycle now");
    expect(more.note).toContain("since moved to another cycle or left");
    expect(payslipSummary(row("2026-11-09", "2026-11-22"), 112).line).toBe("No payslips yet · 112 on the cycle now");
    expect(payslipSummary({ generated: 5, paid: 2, parked: 1 }, 5).line).toBe(
      "5 payslips · 5 on the cycle now · 2 Cleared · 1 waiting in New Joiners",
    );
  });

  it("says when the period ended, when it ends, or when it starts", () => {
    expect(periodTiming(BI[2], "2026-11-16")).toBe("Ended 8 Nov 2026");
    expect(periodTiming(row("2026-09-14", "2026-09-27"), "2026-11-16")).toBe(
      "Ended 27 Sep 2026 · ready to be generated",
    );
    expect(periodTiming(BI[3], "2026-11-16")).toBe(
      "In progress · ends 22 Nov 2026 · can be generated from 23 Nov 2026",
    );
    expect(periodTiming(row("2026-11-23", "2026-12-06", { periodEnded: false }), "2026-11-16")).toBe(
      "Starts 23 Nov 2026 · can be generated from 7 Dec 2026",
    );
  });

  it("writes the span and a day's spoken label", () => {
    expect(periodSpan(BI[2])).toBe("Mon 26 Oct → Sun 8 Nov · 14 days");
    expect(dayLabel("2026-11-02", BI[2], "2026-11-16", true)).toBe(
      "Mon 2 Nov 2026, pay period 26 Oct 2026 to 8 Nov 2026, Generated, 113 payslips, next due, selected",
    );
    expect(dayLabel("2026-11-16", undefined, "2026-11-16", false)).toBe(
      "Mon 16 Nov 2026, today, pay period not loaded yet",
    );
  });
});
