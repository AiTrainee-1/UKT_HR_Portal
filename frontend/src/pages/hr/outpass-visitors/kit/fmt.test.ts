import { describe, expect, it } from "vitest";
import {
  fmtCount,
  fmtDate,
  fmtDateTime,
  fmtMinutes,
  fmtRangeLabel,
  fmtTime,
  fmtWhen,
  isDateKey,
  isTodayIst,
  istDateKey,
  presetRange,
  resolveDateRange,
  toInstant,
} from "./fmt";

// Times, dates, durations and the date filter's ranges, all in India time whatever the machine's zone (the server cuts its
// days the same way). 18 November 2026 is a Wednesday.

const at = (iso: string) => new Date(iso);

describe("times and dates (India time)", () => {
  it("writes a time as 24-hour hh:mm and a day as '18 Nov'", () => {
    expect(fmtTime("2026-11-18T03:04:00Z")).toBe("08:34");
    expect(fmtTime("2026-11-18T14:45:00Z")).toBe("20:15");
    expect(fmtDate("2026-11-18T03:04:00Z")).toBe("18 Nov");
    expect(fmtDate("2026-11-18T03:04:00Z", { year: true })).toBe("18 Nov 2026");
    expect(fmtDateTime("2026-11-18T03:04:00Z")).toBe("18 Nov, 08:34");
    expect(fmtDateTime(at("2026-01-02T00:00:00Z"), { year: true })).toBe("2 Jan 2026, 05:30");
  });

  it("puts a late-evening UTC instant on the next Indian day", () => {
    expect(istDateKey("2026-11-18T19:00:00Z")).toBe("2026-11-19");
    expect(fmtDate("2026-11-18T19:00:00Z")).toBe("19 Nov");
    expect(fmtTime("2026-11-18T19:00:00Z")).toBe("00:30");
  });

  it("reads a bare day as that day in India", () => {
    expect(fmtDate("2026-11-18")).toBe("18 Nov");
    expect(istDateKey("2026-11-18")).toBe("2026-11-18");
    expect(toInstant("2026-11-18")?.toISOString()).toBe("2026-11-17T18:30:00.000Z");
  });

  it("shows a dash for nothing or something unreadable", () => {
    for (const bad of [null, undefined, "", "not a date", new Date(NaN)]) {
      expect(fmtTime(bad)).toBe("—");
      expect(fmtDate(bad)).toBe("—");
      expect(fmtDateTime(bad)).toBe("—");
    }
    expect(istDateKey(null)).toBe("");
  });

  it("knows a valid calendar day", () => {
    expect(isDateKey("2026-11-18")).toBe(true);
    expect(isDateKey("2026-02-29")).toBe(false);
    expect(isDateKey("2028-02-29")).toBe(true);
    expect(isDateKey("2026-13-01")).toBe(false);
    expect(isDateKey("18-11-2026")).toBe(false);
    expect(isDateKey(undefined)).toBe(false);
  });

  it("a table's time: the day only when it is not today, the year only when it is another year", () => {
    const now = at("2026-11-18T06:00:00Z");
    expect(fmtWhen("2026-11-18T03:04:00Z", now)).toEqual({ time: "08:34", date: null });
    expect(fmtWhen("2026-11-17T20:00:00Z", now)).toEqual({ time: "01:30", date: null });
    expect(fmtWhen("2026-11-17T03:04:00Z", now)).toEqual({ time: "08:34", date: "17 Nov" });
    expect(fmtWhen("2025-11-17T03:04:00Z", now)).toEqual({ time: "08:34", date: "17 Nov 2025" });
    expect(fmtWhen(null, now)).toEqual({ time: "—", date: null });
    expect(isTodayIst("2026-11-18T18:29:00Z", now)).toBe(true);
    expect(isTodayIst("2026-11-18T18:30:00Z", now)).toBe(false);
  });
});

describe("durations and counts", () => {
  it("writes minutes as '18 min' under an hour and '1 h 05 m' from an hour", () => {
    expect(fmtMinutes(0)).toBe("0 min");
    expect(fmtMinutes(18)).toBe("18 min");
    expect(fmtMinutes(18.4)).toBe("18 min");
    expect(fmtMinutes(59.6)).toBe("1 h 00 m");
    expect(fmtMinutes(65)).toBe("1 h 05 m");
    expect(fmtMinutes(125)).toBe("2 h 05 m");
    expect(fmtMinutes(-3)).toBe("0 min");
    expect(fmtMinutes(null)).toBe("—");
    expect(fmtMinutes(Number.NaN)).toBe("—");
  });

  it("groups counts the Indian way", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(1240)).toBe("1,240");
    expect(fmtCount(123456)).toBe("1,23,456");
    expect(fmtCount(undefined)).toBe("—");
  });

  it("names a range of days shortly", () => {
    expect(fmtRangeLabel("2026-11-01", "2026-11-18")).toBe("1 – 18 Nov 2026");
    expect(fmtRangeLabel("2026-10-28", "2026-11-18")).toBe("28 Oct – 18 Nov 2026");
    expect(fmtRangeLabel("2025-12-28", "2026-01-02")).toBe("28 Dec 2025 – 2 Jan 2026");
    expect(fmtRangeLabel("2026-11-18", "2026-11-18")).toBe("18 Nov 2026");
    expect(fmtRangeLabel("2026-11-01", "")).toBe("From 1 Nov 2026");
    expect(fmtRangeLabel("", "2026-11-18")).toBe("Up to 18 Nov 2026");
    expect(fmtRangeLabel("", "")).toBe("All dates");
  });
});

describe("the date filter's presets (India time, a week from Monday)", () => {
  it("covers today, this week and this month up to today", () => {
    const wed = at("2026-11-18T06:00:00Z");
    expect(presetRange("today", wed)).toEqual({ from: "2026-11-18", to: "2026-11-18" });
    expect(presetRange("week", wed)).toEqual({ from: "2026-11-16", to: "2026-11-18" });
    expect(presetRange("month", wed)).toEqual({ from: "2026-11-01", to: "2026-11-18" });
  });

  it("uses the Indian day, not the machine's: 00:30 in India is already tomorrow", () => {
    const justAfterMidnight = at("2026-11-18T19:00:00Z"); // Thursday 19 Nov, 00:30 in India
    expect(presetRange("today", justAfterMidnight)).toEqual({ from: "2026-11-19", to: "2026-11-19" });
    expect(presetRange("week", justAfterMidnight).from).toBe("2026-11-16");
    // 1 Dec, 00:30 in India: a new month, and the week (a Tuesday) began on Monday 30 Nov
    const newMonth = at("2026-11-30T19:00:00Z");
    expect(presetRange("month", newMonth)).toEqual({ from: "2026-12-01", to: "2026-12-01" });
    expect(presetRange("week", newMonth)).toEqual({ from: "2026-11-30", to: "2026-12-01" });
  });

  it("a Sunday still belongs to the week that began on the Monday before it", () => {
    expect(presetRange("week", at("2026-11-22T10:00:00Z"))).toEqual({ from: "2026-11-16", to: "2026-11-22" });
    // Monday itself
    expect(presetRange("week", at("2026-11-16T10:00:00Z"))).toEqual({ from: "2026-11-16", to: "2026-11-16" });
  });

  it("turns {range, from, to} into the days the API takes", () => {
    const now = at("2026-11-18T06:00:00Z");
    expect(resolveDateRange({ range: "week", from: "2020-01-01", to: "2020-01-02" }, now)).toEqual({
      from: "2026-11-16",
      to: "2026-11-18",
    });
    expect(resolveDateRange({ range: "all" }, now)).toEqual({ from: "", to: "" });
    expect(resolveDateRange({ range: "custom", from: "2026-11-01", to: "2026-11-10" }, now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-10",
    });
    // From after To: swapped; an unreadable day is dropped
    expect(resolveDateRange({ range: "custom", from: "2026-11-10", to: "2026-11-01" }, now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-10",
    });
    expect(resolveDateRange({ range: "custom", from: "nope", to: "2026-11-10" }, now)).toEqual({
      from: "",
      to: "2026-11-10",
    });
    expect(resolveDateRange({ from: "2026-11-02" }, now)).toEqual({ from: "2026-11-02", to: "" });
  });
});
