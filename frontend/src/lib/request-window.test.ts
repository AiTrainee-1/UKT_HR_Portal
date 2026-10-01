import { describe, expect, it } from "vitest";
import {
  GRACE_DAYS,
  checkRequestDate,
  checkRequestRange,
  getRequestWindow,
  isIsoDate,
  windowHint,
  windowMessage,
} from "./request-window";
import { requestWindowVectors } from "./request-window.vectors";

// Every probe in the shared vectors names its "today" as YYYY-MM-DD. The rule reads the LOCAL calendar day of `now`
// (like the device clock the form guides the user with), so build the Date from local parts: this passes in any time
// zone the tests run in.
const at = (today: string, hour = 13, minute = 30) => {
  const [y, m, d] = today.split("-").map(Number);
  return new Date(y, m - 1, d, hour, minute);
};

describe("request-window shared vectors (the same ones the backend and both apps assert)", () => {
  it("carries all 83 vectors (22 windows + 47 single dates + 14 ranges) and the shared grace length", () => {
    const { windows, dates, ranges } = requestWindowVectors;
    expect(windows).toHaveLength(22);
    expect(dates).toHaveLength(47);
    expect(ranges).toHaveLength(14);
    expect(windows.length + dates.length + ranges.length).toBe(83);
    expect(requestWindowVectors.graceDays).toBe(GRACE_DAYS);
    expect(GRACE_DAYS).toBe(2);
  });

  describe("getRequestWindow / windowMessage / windowHint", () => {
    it.each(requestWindowVectors.windows)("window on $today", (v) => {
      const w = getRequestWindow(at(v.today));
      expect(w.min).toBe(v.min);
      expect(w.max).toBe(v.max);
      expect(w.today).toBe(v.today);
      expect(w.graceOpen).toBe(v.graceOpen);
      expect(w.currentMonth).toBe(v.currentMonth);
      expect(w.previousMonth).toBe(v.previousMonth);
      expect(windowMessage(w)).toBe(v.message);
      expect(windowHint(w)).toBe(v.hint);
    });
  });

  describe("checkRequestDate", () => {
    it.each(requestWindowVectors.dates)('today $today, date "$date"', (v) => {
      expect(checkRequestDate(v.date, at(v.today))).toBe(v.error);
    });

    it.each(requestWindowVectors.dates)('today $today, date "$date" (Missing Punch, noFuture)', (v) => {
      expect(checkRequestDate(v.date, at(v.today), { noFuture: true })).toBe(v.errorNoFuture);
    });
  });

  describe("checkRequestRange", () => {
    it.each(requestWindowVectors.ranges)('today $today, "$start" to "$end"', (v) => {
      expect(checkRequestRange(v.start, v.end, at(v.today))).toBe(v.error);
    });
  });
});

describe("request-window behaviour around the vectors", () => {
  it("reads only the calendar day of `now`, not the time of day", () => {
    for (const [hour, minute] of [
      [0, 0],
      [0, 1],
      [12, 0],
      [23, 59],
    ]) {
      const w = getRequestWindow(at("2026-10-02", hour, minute));
      expect(w.today).toBe("2026-10-02");
      expect(w.graceOpen).toBe(true);
      expect(w.min).toBe("2026-09-01");
    }
    expect(getRequestWindow(at("2026-10-03", 0, 0)).graceOpen).toBe(false);
  });

  it("does not remember a previous `now` (the window follows the clock passed in each time)", () => {
    const lastNightOfGrace = at("2026-10-02", 23, 59);
    const firstMinuteAfter = at("2026-10-03", 0, 0);
    expect(checkRequestDate("2026-09-30", lastNightOfGrace)).toBeNull();
    expect(checkRequestDate("2026-09-30", firstMinuteAfter)).toBe("You can only request dates in October 2026.");
    // ...and going back to the earlier clock reopens it: nothing is cached between calls.
    expect(checkRequestDate("2026-09-30", lastNightOfGrace)).toBeNull();
  });

  it("a range needs BOTH ends inside the window, whichever end is outside", () => {
    const now = at("2026-10-15");
    expect(checkRequestRange("2026-09-30", "2026-10-02", now)).toBe("You can only request dates in October 2026.");
    expect(checkRequestRange("2026-10-30", "2026-11-02", now)).toBe("You can only request dates in October 2026.");
    expect(checkRequestRange("2026-10-01", "2026-10-31", now)).toBeNull();
  });

  it("single-day and half-day requests are a range whose two ends are equal", () => {
    expect(checkRequestRange("2026-10-20", "2026-10-20", at("2026-10-15"))).toBeNull();
    expect(checkRequestRange("2026-11-01", "2026-11-01", at("2026-10-15"))).toBe(
      "You can only request dates in October 2026.",
    );
  });

  it("the future is allowed up to month end unless noFuture is set (Leave vs Missing Punch)", () => {
    const now = at("2026-10-15");
    expect(checkRequestDate("2026-10-31", now)).toBeNull();
    expect(checkRequestDate("2026-10-16", now, { noFuture: true })).toBe("Date cannot be in the future.");
    expect(checkRequestDate("2026-10-15", now, { noFuture: true })).toBeNull();
  });
});

describe("isIsoDate", () => {
  it("accepts real calendar dates, including a leap day", () => {
    expect(isIsoDate("2026-10-15")).toBe(true);
    expect(isIsoDate("2028-02-29")).toBe(true);
  });

  it("rejects empty, malformed and impossible dates", () => {
    for (const bad of [
      "",
      null,
      undefined,
      "not-a-date",
      "2026-10-1",
      "26-10-15",
      "2026-13-01",
      "2026-02-29",
      "2026-04-31",
    ]) {
      expect(isIsoDate(bad)).toBe(false);
    }
  });
});
