import { describe, expect, it } from "vitest";
import { PAY_CYCLE_INFO, PAY_CYCLES } from "@/lib/api-client/custom-hooks";
import {
  addDays,
  CYCLE_INFO,
  CYCLES,
  cycleAnchor,
  describeCycleRule,
  formatPeriod,
  missingDateError,
  nextCyclePeriod,
  normalizeWeekStart,
  parseIsoDay,
  periodDays,
  resolveCyclePeriod,
  snapToWeekStart,
  weekdayOf,
  WEEK_START_OPTIONS,
  WEEK_STARTS,
  weekRunsText,
  type CycleRule,
  type Day,
  type PayCycle,
  type WeekStart,
} from "./cycles";

// The vectors backend/api/tests_production_cycles.py checks the engine with (all in 2026): Monday 2 February starts
// every cycle, Weekly weeks run Mon-Sun, BiWeekly periods are 2-15 Feb and 16 Feb-1 Mar, the four-week Monthly
// period is 2 Feb-1 Mar. "Today" is Tuesday 10 March, so every February period has ended.

const day = (iso: string): Day => parseIsoDay(iso)!;
const TODAY = day("2026-03-10");
const MON = { weekStart: "monday", anchorDate: "2026-02-02" };
const SUN = { weekStart: "sunday", anchorDate: "2026-02-02" };

const periodOf = (iso: string, cycle: PayCycle, rule: CycleRule) => {
  const r = resolveCyclePeriod(day(iso), cycle, rule);
  return "error" in r ? r.error : formatPeriod(r.period);
};

describe("calendar days", () => {
  it("reads only real dates and knows the weekday", () => {
    expect(parseIsoDay("2026-02-29")).toBeNull();
    expect(parseIsoDay("2028-02-29")).toEqual({ year: 2028, month: 2, day: 29 });
    expect(parseIsoDay("12/10/2026")).toBeNull();
    expect(parseIsoDay(null)).toBeNull();
    expect(weekdayOf(day("2026-02-02"))).toBe(0);
    expect(weekdayOf(day("2026-02-01"))).toBe(6);
  });

  it("knows each cycle's length and monthly factor, and agrees with the API client's cycle list", () => {
    expect([CYCLE_INFO.weekly.days, CYCLE_INFO.biweekly.days, CYCLE_INFO.monthly.days]).toEqual([7, 14, 28]);
    expect(
      [CYCLE_INFO.weekly, CYCLE_INFO.biweekly, CYCLE_INFO.monthly].map((c) => [c.label, c.monthlyFactor, c.needsDate]),
    ).toEqual([
      ["Weekly", 4, false],
      ["BiWeekly", 2, true],
      ["Monthly", 1, true],
    ]);
    // cycles.ts keeps its own copy so the search catalogue never loads the API client: it must not drift
    expect(CYCLES).toEqual(PAY_CYCLES);
    for (const cycle of PAY_CYCLES) {
      const { label, weeks, days, path } = PAY_CYCLE_INFO[cycle];
      expect(CYCLE_INFO[cycle]).toMatchObject({ label, weeks, days, path });
    }
  });
});

describe("the period a day falls in", () => {
  it("Weekly: Monday weeks run Monday to Sunday, with or without a date", () => {
    expect(periodOf("2026-02-04", "weekly", MON)).toBe("2 Feb - 8 Feb 2026");
    expect(periodOf("2026-02-04", "weekly", { weekStart: "monday", anchorDate: null })).toBe("2 Feb - 8 Feb 2026");
    expect(periodOf("2026-02-04", "weekly", { weekStart: "", anchorDate: "" })).toBe("2 Feb - 8 Feb 2026");
    expect(periodOf("2026-02-09", "weekly", MON)).toBe("9 Feb - 15 Feb 2026");
    // a date that is not a Monday changes nothing for Weekly
    expect(periodOf("2026-02-04", "weekly", { weekStart: "monday", anchorDate: "2026-01-15" })).toBe(
      "2 Feb - 8 Feb 2026",
    );
  });

  it("Weekly: Sunday weeks run Sunday to Saturday", () => {
    expect(periodOf("2026-02-04", "weekly", { weekStart: "sunday", anchorDate: null })).toBe("1 Feb - 7 Feb 2026");
    expect(periodOf("2026-02-08", "weekly", { weekStart: "sunday", anchorDate: null })).toBe("8 Feb - 14 Feb 2026");
  });

  it("Weekly: a week may start on any weekday and ends the day before it comes round again", () => {
    // Wednesday 4 Feb 2026: the week holding it, for each weekday weeks may start on (the engine's own vectors)
    const holding: Record<WeekStart, string> = {
      monday: "2 Feb - 8 Feb 2026",
      tuesday: "3 Feb - 9 Feb 2026",
      wednesday: "4 Feb - 10 Feb 2026",
      thursday: "29 Jan - 4 Feb 2026",
      friday: "30 Jan - 5 Feb 2026",
      saturday: "31 Jan - 6 Feb 2026",
      sunday: "1 Feb - 7 Feb 2026",
    };
    expect(WEEK_STARTS).toEqual(Object.keys(holding));
    for (const weekStart of WEEK_STARTS) {
      expect(periodOf("2026-02-04", "weekly", { weekStart, anchorDate: null }), weekStart).toBe(holding[weekStart]);
    }
  });

  it("every start weekday gives back-to-back seven-day weeks with no gap or overlap", () => {
    for (const [number, weekStart] of WEEK_STARTS.entries()) {
      let ref = day("2026-06-01");
      for (let i = 0; i < 6; i++) {
        const r = resolveCyclePeriod(ref, "weekly", { weekStart, anchorDate: null });
        if ("error" in r) throw new Error(r.error);
        expect(weekdayOf(r.period.start), weekStart).toBe(number);
        expect(periodDays(r.period), weekStart).toBe(7);
        ref = addDays(r.period.end, 1); // the next week must begin on exactly this day
      }
    }
  });

  it("BiWeekly and Monthly count from the first period start on any start weekday", () => {
    // Friday weeks: a first period start of Wednesday 4 Feb is moved back to Friday 30 Jan
    const friday = { weekStart: "friday", anchorDate: "2026-02-04" };
    expect(cycleAnchor("biweekly", friday)).toEqual({ anchor: day("2026-01-30") });
    expect(periodOf("2026-02-10", "biweekly", friday)).toBe("30 Jan - 12 Feb 2026");
    expect(periodOf("2026-02-13", "biweekly", friday)).toBe("13 Feb - 26 Feb 2026");
    expect(periodOf("2026-02-20", "monthly", friday)).toBe("30 Jan - 26 Feb 2026");
    expect(periodOf("2026-02-27", "monthly", friday)).toBe("27 Feb - 26 Mar 2026");
  });

  it("BiWeekly pairs the weeks from the first period start, backwards too", () => {
    expect(periodOf("2026-02-10", "biweekly", MON)).toBe("2 Feb - 15 Feb 2026");
    expect(periodOf("2026-02-16", "biweekly", MON)).toBe("16 Feb - 1 Mar 2026");
    expect(periodOf("2026-02-01", "biweekly", MON)).toBe("19 Jan - 1 Feb 2026");
  });

  it("Monthly is four whole weeks, not a calendar month", () => {
    expect(periodOf("2026-02-20", "monthly", MON)).toBe("2 Feb - 1 Mar 2026");
    expect(periodOf("2026-03-02", "monthly", MON)).toBe("2 Mar - 29 Mar 2026");
  });

  it("a first period start on the wrong weekday is moved back to the start weekday", () => {
    const wednesday = "2026-02-04";
    expect(cycleAnchor("biweekly", { weekStart: "monday", anchorDate: wednesday })).toEqual({
      anchor: day("2026-02-02"),
    });
    expect(cycleAnchor("biweekly", { weekStart: "sunday", anchorDate: wednesday })).toEqual({
      anchor: day("2026-02-01"),
    });
    expect(snapToWeekStart(day("2026-02-02"), "monday")).toEqual(day("2026-02-02"));
    expect(periodOf("2026-02-10", "biweekly", { weekStart: "monday", anchorDate: wednesday })).toBe(
      "2 Feb - 15 Feb 2026",
    );
  });

  it("BiWeekly and Monthly need a first period start, with the engine's words; Weekly does not", () => {
    const none = { weekStart: "monday", anchorDate: null };
    expect(periodOf("2026-02-02", "weekly", none)).toBe("2 Feb - 8 Feb 2026");
    expect(periodOf("2026-02-02", "biweekly", none)).toBe(
      "Set the first period start date for BiWeekly in Settings -> Production Payroll -> BiWeekly.",
    );
    expect(periodOf("2026-02-02", "monthly", { weekStart: "monday", anchorDate: "" })).toBe(
      missingDateError("monthly"),
    );
  });
});

describe("the week start", () => {
  it("is read the way the engine reads it: any weekday in any case, the two legacy keys, else Monday", () => {
    for (const [raw, expected] of [
      ["wednesday", "wednesday"],
      [" Friday ", "friday"],
      ["SUNDAY", "sunday"],
      ["mon_sat", "monday"],
      ["sun_sat", "sunday"],
      ["someday", "monday"],
      ["", "monday"],
      [undefined, "monday"],
      [3, "monday"],
    ] as const) {
      expect(normalizeWeekStart(raw), String(raw)).toBe(expected);
    }
  });

  it("is offered as seven options, each saying where its weeks run from and to", () => {
    expect(WEEK_START_OPTIONS.map((o) => o.label)).toEqual([
      "Monday (weeks run Monday to Sunday)",
      "Tuesday (weeks run Tuesday to Monday)",
      "Wednesday (weeks run Wednesday to Tuesday)",
      "Thursday (weeks run Thursday to Wednesday)",
      "Friday (weeks run Friday to Thursday)",
      "Saturday (weeks run Saturday to Friday)",
      "Sunday (weeks run Sunday to Saturday)",
    ]);
    expect(WEEK_START_OPTIONS.map((o) => o.value)).toEqual([...WEEK_STARTS]);
    expect(weekRunsText("thursday")).toBe("Thursday to Wednesday");
  });

  it("describes a weekday's weeks in words", () => {
    expect(describeCycleRule("weekly", { weekStart: "wednesday", anchorDate: null })).toBe("Wednesday weeks");
    expect(describeCycleRule("weekly", { weekStart: "mon_sat", anchorDate: null })).toBe("Monday weeks");
  });
});

describe("the next period to generate", () => {
  const next = (cycle: PayCycle, rule: CycleRule, lastEnd: string | null, today = TODAY) => {
    const r = nextCyclePeriod(cycle, rule, lastEnd ? day(lastEnd) : null, today);
    if ("error" in r) throw new Error(r.error);
    return r;
  };

  it("on the first run offers the most recent period that has ended (today 10 Mar)", () => {
    expect(formatPeriod(next("weekly", MON, null).period)).toBe("2 Mar - 8 Mar 2026");
    expect(formatPeriod(next("biweekly", MON, null).period)).toBe("16 Feb - 1 Mar 2026");
    expect(formatPeriod(next("monthly", MON, null).period)).toBe("2 Feb - 1 Mar 2026");
    const weekly = next("weekly", MON, null);
    expect([weekly.ended, weekly.overlap, weekly.generateFrom]).toEqual([true, null, day("2026-03-08")]);
    expect(weekly.then.map(formatPeriod)).toEqual(["9 Mar - 15 Mar 2026", "16 Mar - 22 Mar 2026"]);
  });

  it("when today is the last day of a period, that period is offered", () => {
    expect(formatPeriod(next("weekly", MON, null, day("2026-03-08")).period)).toBe("2 Mar - 8 Mar 2026");
  });

  it("after a generated period the next one follows it, even when it has not ended", () => {
    const r = next("weekly", MON, "2026-03-08");
    expect(formatPeriod(r.period)).toBe("9 Mar - 15 Mar 2026");
    expect([r.ended, r.overlap, r.generateFrom]).toEqual([false, null, day("2026-03-15")]);
    expect(next("biweekly", MON, "2026-02-15").then.map(formatPeriod)).toEqual([
      "2 Mar - 15 Mar 2026",
      "16 Mar - 29 Mar 2026",
    ]);
  });

  it("a rule changed after periods were generated can make the next period cover days already paid", () => {
    // Monday weeks were generated up to Sun 8 Feb; with Sunday weeks the period holding Mon 9 Feb starts on the 8th
    const r = next("weekly", SUN, "2026-02-08");
    expect(formatPeriod(r.period)).toBe("8 Feb - 14 Feb 2026");
    expect(r.overlap && formatPeriod(r.overlap)).toBe("8 Feb - 8 Feb 2026");
  });

  it("refuses with the engine's words while the rule is not complete", () => {
    expect(nextCyclePeriod("monthly", { weekStart: "monday", anchorDate: null }, null, TODAY)).toEqual({
      error: missingDateError("monthly"),
    });
  });
});

describe("a rule in words", () => {
  it("names the start weekday, the counted-from date, or that it is not set", () => {
    expect(describeCycleRule("weekly", { weekStart: "sunday", anchorDate: null })).toBe("Sunday weeks");
    expect(describeCycleRule("biweekly", { weekStart: "monday", anchorDate: "2026-02-04" })).toBe(
      "Monday weeks counted from Mon 2 Feb 2026",
    );
    expect(describeCycleRule("monthly", { weekStart: "monday", anchorDate: "" })).toBe(
      "Monday weeks, first period start not set",
    );
  });
});
