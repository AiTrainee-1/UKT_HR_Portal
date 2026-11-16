import { describe, expect, it } from "vitest";
import {
  dayOfPeriodText,
  FACTOR_WORDS,
  formatPeriodLong,
  holds,
  LENGTH_WORDS,
  parseIsoDay,
  periodStrip,
  weekRunsArrow,
  type Day,
  type Period,
} from "./cycles";

// The words and the calendar strip of the cycle cards (Settings -> Production Payroll). The same vectors as cycles.test.ts:
// Monday 2 February 2026 starts every cycle and "today" is Tuesday 10 March 2026.

const day = (iso: string): Day => parseIsoDay(iso)!;
const period = (start: string, end: string): Period => ({ start: day(start), end: day(end) });
const TODAY = day("2026-03-10");
const MON = { weekStart: "monday", anchorDate: "2026-02-02" };

describe("cycle cards: the words", () => {
  it("says which weekdays a week runs between, with an arrow", () => {
    expect(weekRunsArrow("monday")).toBe("Monday → Sunday");
    expect(weekRunsArrow("wednesday")).toBe("Wednesday → Tuesday");
    expect(weekRunsArrow("sunday")).toBe("Sunday → Saturday");
    // an old stored key and an unknown one read as the engine reads them
    expect(weekRunsArrow("sun_sat")).toBe("Sunday → Saturday");
    expect(weekRunsArrow("whenever")).toBe("Monday → Sunday");
  });

  it("says how long a period is, Monthly as four weeks and not a calendar month, and the PF / ESI factor in words", () => {
    expect(LENGTH_WORDS.weekly.days).toBe("7 days");
    expect(LENGTH_WORDS.biweekly.days).toBe("14 days");
    expect(LENGTH_WORDS.monthly.days).toBe("28 days");
    expect(LENGTH_WORDS.monthly.weeks).toContain("Monthly = four weeks (28 days), not a calendar month");
    expect(FACTOR_WORDS.weekly).toContain("times four");
    expect(FACTOR_WORDS.biweekly).toContain("times two");
    expect(FACTOR_WORDS.monthly).toContain("as it is");
  });

  it("writes a period with its weekdays, and the year once unless it changes", () => {
    expect(formatPeriodLong(period("2026-10-12", "2026-10-18"))).toBe("Mon 12 Oct – Sun 18 Oct 2026");
    expect(formatPeriodLong(period("2026-12-28", "2027-01-03"))).toBe("Mon 28 Dec 2026 – Sun 3 Jan 2027");
  });

  it("says which day of its period today is", () => {
    const p = period("2026-03-09", "2026-03-15");
    expect(holds(p, TODAY)).toBe(true);
    expect(holds(p, day("2026-03-16"))).toBe(false);
    expect(dayOfPeriodText(p, TODAY)).toBe("Today is day 2 of 7.");
  });
});

describe("cycle cards: the calendar strip", () => {
  it("lines up the latest generated period, the next one and three after it, today marked", () => {
    const strip = periodStrip("weekly", MON, period("2026-02-23", "2026-03-01"), TODAY);
    if ("error" in strip) throw new Error(strip.error);
    expect(strip.map((s) => [formatPeriodLong(s.period), s.tags.join(" ")])).toEqual([
      ["Mon 23 Feb – Sun 1 Mar 2026", "generated"],
      ["Mon 2 Mar – Sun 8 Mar 2026", "next"],
      ["Mon 9 Mar – Sun 15 Mar 2026", "today"],
      ["Mon 16 Mar – Sun 22 Mar 2026", ""],
      ["Mon 23 Mar – Sun 29 Mar 2026", ""],
    ]);
  });

  it("shows a generated period that is still open once, as generated and next", () => {
    const open = period("2026-03-02", "2026-03-08");
    const strip = periodStrip("weekly", MON, open, TODAY, 1, open);
    if ("error" in strip) throw new Error(strip.error);
    expect(strip.map((s) => [formatPeriodLong(s.period), s.tags.join(" ")])).toEqual([
      ["Mon 2 Mar – Sun 8 Mar 2026", "generated next"],
      ["Mon 9 Mar – Sun 15 Mar 2026", "today"],
    ]);
  });

  it("starts at the latest period that has ended when nothing is generated yet", () => {
    const strip = periodStrip("biweekly", MON, null, TODAY, 1);
    if ("error" in strip) throw new Error(strip.error);
    expect(strip.map((s) => [formatPeriodLong(s.period), s.tags.join(" ")])).toEqual([
      ["Mon 16 Feb – Sun 1 Mar 2026", "next"],
      ["Mon 2 Mar – Sun 15 Mar 2026", "today"],
    ]);
  });

  it("marks a next period that starts inside one already generated", () => {
    // Sunday weeks after Monday weeks were generated up to Sun 1 Mar: the next period is Sun 1 - Sat 7 Mar
    const strip = periodStrip("weekly", { weekStart: "sunday" }, period("2026-02-23", "2026-03-01"), TODAY, 0);
    if ("error" in strip) throw new Error(strip.error);
    expect(strip.map((s) => s.tags.join(" "))).toEqual(["generated", "next overlap"]);
  });

  it("says why there is no strip while BiWeekly or Monthly has no first period start", () => {
    expect(periodStrip("monthly", { weekStart: "monday" }, null, TODAY)).toEqual({
      error: "Set the first period start date for Monthly in Settings -> Production Payroll -> Monthly.",
    });
  });
});
