import { describe, expect, it } from "vitest";
import {
  DATE_RANGE_DEFAULTS,
  addDays,
  canStepForward,
  chooseDays,
  chooseMonth,
  choosePreset,
  dayInRange,
  dayLabel,
  earliestDay,
  isDayKey,
  isDefaultRange,
  isMonthKey,
  istDay,
  istDayOf,
  monthDays,
  monthLabel,
  monthShortLabel,
  msUntilNextIstDay,
  rangeDays,
  rangeLabel,
  rangeParams,
  rangePhrase,
  rangeQuery,
  readDateRange,
  sameRange,
  shiftMonth,
  shownMonth,
  spanOverlaps,
  stepMonth,
  type DateRangeValue,
} from "./date-range";

// Tuesday 24 Nov 2026, 11:30 in India (06:00 UTC).
const NOW = new Date("2026-11-24T06:00:00Z");
const MONTH: DateRangeValue = { range: "month", month: "", from: "", to: "" };
const custom = (from: string, to = from): DateRangeValue => ({ range: "custom", month: "", from, to });

describe("days and months", () => {
  it("reads only real days and months", () => {
    expect(isDayKey("2026-11-24")).toBe(true);
    expect(isDayKey("2026-02-30")).toBe(false);
    expect(isDayKey("24-11-2026")).toBe(false);
    expect(isDayKey(undefined)).toBe(false);
    expect(isMonthKey("2026-11")).toBe(true);
    expect(isMonthKey("2026-13")).toBe(false);
    expect(isMonthKey("2026-1")).toBe(false);
    expect(isMonthKey(null)).toBe(false);
  });

  it("counts days in India, whatever the browser's zone", () => {
    expect(istDay(NOW)).toBe("2026-11-24");
    // 23:59 in India on the 24th is still the 24th; 18:31 UTC is already the 25th there
    expect(istDay(new Date("2026-11-24T18:29:00Z"))).toBe("2026-11-24");
    expect(istDay(new Date("2026-11-24T18:31:00Z"))).toBe("2026-11-25");
    expect(istDayOf("2026-11-24T19:00:00Z")).toBe("2026-11-25");
    expect(istDayOf("2026-11-03")).toBe("2026-11-03");
    expect(istDayOf("nonsense")).toBe("");
    expect(istDayOf(null)).toBe("");
    expect(msUntilNextIstDay(new Date("2026-11-24T18:29:00Z"))).toBe(60_000);
  });

  it("moves days and months across their ends", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(monthDays("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthDays("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(monthLabel("2026-11")).toBe("November 2026");
    expect(monthShortLabel("2026-09")).toBe("Sep 2026");
    expect(dayLabel("2026-11-03")).toBe("3 Nov");
    expect(dayLabel("2026-11-03", { year: true })).toBe("3 Nov 2026");
  });
});

describe("the days each choice stands for", () => {
  it("Today and Yesterday are single India days", () => {
    expect(rangeDays({ ...MONTH, range: "today" }, NOW)).toEqual({ from: "2026-11-24", to: "2026-11-24" });
    expect(rangeDays({ ...MONTH, range: "yesterday" }, NOW)).toEqual({ from: "2026-11-23", to: "2026-11-23" });
    // on the 1st, yesterday is the last day of the month before
    expect(rangeDays({ ...MONTH, range: "yesterday" }, new Date("2026-12-01T06:00:00Z")).from).toBe("2026-11-30");
  });

  it("This Month is the whole calendar month (a request can be for a later day of it); an earlier month likewise", () => {
    expect(rangeDays(MONTH, NOW)).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(rangeDays({ ...MONTH, month: "2026-02" }, NOW)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });

  it("Custom is one day or a from - to range", () => {
    expect(rangeDays(custom("2026-11-03"), NOW)).toEqual({ from: "2026-11-03", to: "2026-11-03" });
    expect(rangeDays(custom("2026-11-03", "2026-11-09"), NOW)).toEqual({ from: "2026-11-03", to: "2026-11-09" });
    expect(rangeDays({ ...custom("2026-11-09"), to: "" }, NOW)).toEqual({ from: "2026-11-09", to: "2026-11-09" });
  });

  it("says them in words", () => {
    expect(rangeLabel(MONTH, NOW)).toBe("November 2026");
    expect(rangeLabel({ ...MONTH, month: "2026-10" }, NOW)).toBe("October 2026");
    expect(rangeLabel({ ...MONTH, range: "today" }, NOW)).toBe("Today, 24 Nov");
    expect(rangeLabel({ ...MONTH, range: "yesterday" }, NOW)).toBe("Yesterday, 23 Nov");
    expect(rangeLabel(custom("2026-11-12"), NOW)).toBe("12 Nov 2026");
    expect(rangeLabel(custom("2026-11-03", "2026-11-09"), NOW)).toBe("3 Nov – 9 Nov 2026");
    expect(rangeLabel(custom("2025-12-28", "2026-01-03"), NOW)).toBe("28 Dec 2025 – 3 Jan 2026");
    expect(rangePhrase(MONTH, NOW)).toBe("in November 2026");
    expect(rangePhrase({ ...MONTH, range: "today" }, NOW)).toBe("today");
    expect(rangePhrase({ ...MONTH, range: "yesterday" }, NOW)).toBe("yesterday");
    expect(rangePhrase(custom("2026-11-12"), NOW)).toBe("on 12 Nov 2026");
    expect(rangePhrase(custom("2026-11-03", "2026-11-09"), NOW)).toBe("between 3 Nov – 9 Nov 2026");
  });
});

describe("the address", () => {
  it("This Month of the current month is the default: nothing in the address", () => {
    expect(readDateRange({}, NOW)).toEqual(MONTH);
    expect(readDateRange(DATE_RANGE_DEFAULTS, NOW)).toEqual(MONTH);
    expect(rangeQuery(MONTH)).toBe("");
    expect(isDefaultRange(MONTH)).toBe(true);
  });

  it("round-trips every choice through the address", () => {
    const choices: DateRangeValue[] = [
      MONTH,
      { ...MONTH, month: "2026-08" },
      { ...MONTH, range: "today" },
      { ...MONTH, range: "yesterday" },
      custom("2026-11-12"),
      custom("2026-11-03", "2026-11-09"),
    ];
    for (const value of choices) {
      const back = readDateRange(Object.fromEntries(new URLSearchParams(rangeQuery(value))), NOW);
      expect(sameRange(back, value), JSON.stringify(value)).toBe(true);
    }
    expect(rangeQuery(custom("2026-11-03", "2026-11-09"))).toBe("range=custom&from=2026-11-03&to=2026-11-09");
    // a single custom day keeps no `to`
    expect(rangeParams(custom("2026-11-12"))).toEqual({ range: "custom", month: "", from: "2026-11-12", to: "" });
    expect(rangeQuery({ ...MONTH, month: "2026-08" })).toBe("month=2026-08");
  });

  it("never points to the future, and mends what it cannot read", () => {
    // a later month, or a month that is not one, is the current month
    expect(readDateRange({ range: "month", month: "2027-01" }, NOW)).toEqual(MONTH);
    expect(readDateRange({ range: "month", month: "2026-11" }, NOW)).toEqual(MONTH);
    expect(readDateRange({ range: "month", month: "soon" }, NOW)).toEqual(MONTH);
    // custom days after today are today; From after To is swapped
    expect(readDateRange({ range: "custom", from: "2026-11-20", to: "2026-12-05" }, NOW)).toEqual(
      custom("2026-11-20", "2026-11-24"),
    );
    expect(readDateRange({ range: "custom", from: "2026-11-09", to: "2026-11-03" }, NOW)).toEqual(
      custom("2026-11-03", "2026-11-09"),
    );
    // custom with no readable day, or an unknown range, is This Month
    expect(readDateRange({ range: "custom", from: "x" }, NOW)).toEqual(MONTH);
    expect(readDateRange({ range: "forever" }, NOW)).toEqual(MONTH);
  });

  it("days in the address without a range (an old link, or the gate pages' week / all) are Custom", () => {
    expect(readDateRange({ from: "2026-11-03", to: "2026-11-09" }, NOW)).toEqual(custom("2026-11-03", "2026-11-09"));
    expect(readDateRange({ range: "month", from: "2026-11-03" }, NOW)).toEqual(custom("2026-11-03"));
    expect(readDateRange({ range: "week", from: "2026-11-23", to: "2026-11-24" }, NOW)).toEqual(
      custom("2026-11-23", "2026-11-24"),
    );
    expect(readDateRange({ to: "2026-11-09" }, NOW)).toEqual(custom("2026-11-09"));
  });
});

describe("changing it", () => {
  it("a preset is what it says; Custom starts on the days on screen, up to today", () => {
    expect(choosePreset("today", MONTH, NOW)).toEqual({ ...MONTH, range: "today" });
    expect(choosePreset("month", { ...MONTH, month: "2026-08" }, NOW)).toEqual(MONTH);
    expect(choosePreset("custom", MONTH, NOW)).toEqual(custom("2026-11-01", "2026-11-24"));
    expect(choosePreset("custom", { ...MONTH, range: "yesterday" }, NOW)).toEqual(custom("2026-11-23"));
    expect(choosePreset("custom", { ...MONTH, month: "2026-08" }, NOW)).toEqual(custom("2026-08-01", "2026-08-31"));
    const already = custom("2026-11-03", "2026-11-09");
    expect(choosePreset("custom", already, NOW)).toBe(already);
  });

  it("steps month by month back, and forward only up to the current month", () => {
    const oct = stepMonth(MONTH, -1, NOW);
    expect(oct).toEqual({ ...MONTH, month: "2026-10" });
    expect(stepMonth(oct, -1, NOW)).toEqual({ ...MONTH, month: "2026-09" });
    expect(stepMonth(oct, 1, NOW)).toEqual(MONTH);
    expect(stepMonth(MONTH, 1, NOW)).toEqual(MONTH);
    expect(canStepForward(MONTH, NOW)).toBe(false);
    expect(canStepForward(oct, NOW)).toBe(true);
    // from Today or Custom days, the stepper starts at their month
    expect(shownMonth({ ...MONTH, range: "today" }, NOW)).toBe("2026-11");
    expect(stepMonth({ ...MONTH, range: "today" }, -1, NOW)).toEqual({ ...MONTH, month: "2026-10" });
    expect(canStepForward({ ...MONTH, range: "today" }, NOW)).toBe(true);
    expect(shownMonth(custom("2026-07-28", "2026-08-03"), NOW)).toBe("2026-08");
    expect(chooseMonth("2027-02", NOW)).toEqual(MONTH);
    expect(chooseMonth("2026-03", NOW)).toEqual({ ...MONTH, month: "2026-03" });
  });

  it("picked days are clamped to today and put in order", () => {
    expect(chooseDays("2026-11-09", "", NOW)).toEqual(custom("2026-11-09"));
    expect(chooseDays("2026-11-09", "2026-11-03", NOW)).toEqual(custom("2026-11-03", "2026-11-09"));
    expect(chooseDays("2026-11-20", "2026-12-31", NOW)).toEqual(custom("2026-11-20", "2026-11-24"));
  });
});

describe("matching records", () => {
  const days = { from: "2026-11-01", to: "2026-11-30" };

  it("a day is in the range or not; nothing unreadable is", () => {
    expect(dayInRange("2026-11-01", days)).toBe(true);
    expect(dayInRange("2026-11-30", days)).toBe(true);
    expect(dayInRange("2026-12-01", days)).toBe(false);
    expect(dayInRange("", days)).toBe(false);
    expect(dayInRange(null, days)).toBe(false);
  });

  it("a span of days counts when any of them is in the range", () => {
    expect(spanOverlaps("2026-10-30", "2026-11-02", days)).toBe(true);
    expect(spanOverlaps("2026-11-29", "2026-12-03", days)).toBe(true);
    expect(spanOverlaps("2026-10-20", "2026-10-31", days)).toBe(false);
    expect(spanOverlaps("2026-11-05", null, days)).toBe(true);
    expect(spanOverlaps("2026-11-05", "2026-11-01", days)).toBe(true); // a backwards end is the one day
    expect(spanOverlaps(undefined, "2026-11-05", days)).toBe(false);
  });

  it("finds the earliest day of a list", () => {
    expect(earliestDay(["2026-11-09", "", "2026-10-28", null, "2026-11-01"])).toBe("2026-10-28");
    expect(earliestDay([])).toBe("");
  });
});
