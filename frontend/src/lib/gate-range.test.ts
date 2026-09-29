import { describe, expect, it } from "vitest";
import { gateRangeStart, inGateRange } from "./gate-range";

// 2026-09-29 is a Tuesday. IST = UTC+05:30.
const TUE_2PM_IST = new Date("2026-09-29T08:30:00Z"); // 14:00 IST

describe("gateRangeStart (Asia/Kolkata boundaries)", () => {
  it("today starts at IST midnight", () => {
    expect(new Date(gateRangeStart("today", TUE_2PM_IST)).toISOString()).toBe("2026-09-28T18:30:00.000Z");
  });

  it("this week starts on that week's Monday", () => {
    expect(new Date(gateRangeStart("week", TUE_2PM_IST)).toISOString()).toBe("2026-09-27T18:30:00.000Z"); // Mon 28 Sep IST
  });

  it("this month starts on the 1st", () => {
    expect(new Date(gateRangeStart("month", TUE_2PM_IST)).toISOString()).toBe("2026-08-31T18:30:00.000Z"); // 1 Sep IST
  });

  it("uses the factory's day even when it is still the previous day in UTC", () => {
    const justAfterMidnightIst = new Date("2026-09-29T19:00:00Z"); // 00:30 on Wed 30 Sep IST
    expect(new Date(gateRangeStart("today", justAfterMidnightIst)).toISOString()).toBe("2026-09-29T18:30:00.000Z");
    // Wednesday: the week still started on Monday 28 Sep
    expect(new Date(gateRangeStart("week", justAfterMidnightIst)).toISOString()).toBe("2026-09-27T18:30:00.000Z");
  });

  it("a Sunday belongs to the week that started six days earlier", () => {
    const sunday = new Date("2026-10-04T06:00:00Z"); // Sun 4 Oct, 11:30 IST
    expect(new Date(gateRangeStart("week", sunday)).toISOString()).toBe("2026-09-27T18:30:00.000Z"); // Mon 28 Sep IST
  });

  it("the first of a month is its own month start and rolls the week back into the previous month", () => {
    const firstOfMonth = new Date("2026-10-01T05:00:00Z"); // Thu 1 Oct, 10:30 IST
    expect(new Date(gateRangeStart("month", firstOfMonth)).toISOString()).toBe("2026-09-30T18:30:00.000Z");
    expect(new Date(gateRangeStart("week", firstOfMonth)).toISOString()).toBe("2026-09-27T18:30:00.000Z");
  });
});

describe("inGateRange", () => {
  it("keeps only requests made today under Today", () => {
    expect(inGateRange("2026-09-29T04:00:00Z", "today", TUE_2PM_IST)).toBe(true); // 09:30 IST today
    expect(inGateRange("2026-09-25T07:06:00Z", "today", TUE_2PM_IST)).toBe(false); // 25 Sep
  });

  it("treats the exact start instant as inside and one millisecond earlier as outside", () => {
    const start = gateRangeStart("today", TUE_2PM_IST);
    expect(inGateRange(new Date(start).toISOString(), "today", TUE_2PM_IST)).toBe(true);
    expect(inGateRange(new Date(start - 1).toISOString(), "today", TUE_2PM_IST)).toBe(false);
  });

  it("This Week includes Monday and excludes the Sunday before it", () => {
    expect(inGateRange("2026-09-28T02:00:00Z", "week", TUE_2PM_IST)).toBe(true); // Mon 07:30 IST
    expect(inGateRange("2026-09-27T12:00:00Z", "week", TUE_2PM_IST)).toBe(false); // Sun 17:30 IST
  });

  it("This Month covers the whole month so far and nothing from the month before", () => {
    expect(inGateRange("2026-09-01T03:00:00Z", "month", TUE_2PM_IST)).toBe(true);
    expect(inGateRange("2026-08-31T10:00:00Z", "month", TUE_2PM_IST)).toBe(false);
  });

  it("is open-ended: a later timestamp still counts", () => {
    expect(inGateRange("2026-09-30T10:00:00Z", "today", TUE_2PM_IST)).toBe(true);
  });

  it("never treats a missing or unreadable timestamp as in range", () => {
    expect(inGateRange(null, "month", TUE_2PM_IST)).toBe(false);
    expect(inGateRange(undefined, "month", TUE_2PM_IST)).toBe(false);
    expect(inGateRange("not a date", "month", TUE_2PM_IST)).toBe(false);
  });
});
