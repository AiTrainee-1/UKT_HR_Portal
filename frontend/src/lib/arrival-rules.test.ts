import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARRIVAL,
  arrivalLimits,
  arrivalZone,
  clock,
  minutesOf,
  shiftsFor,
  validateArrival,
  type ArrivalZone,
} from "./arrival-rules";

// The worked examples of backend/api/tests_late_permission_rules.py (shift 09:00, grace 15) and of the Settings
// preview (grace 10): the twin must agree with the engine about which side of every limit a punch is on.

describe("limits", () => {
  it("builds every limit from the shift's own start and grace", () => {
    expect(arrivalLimits("09:00", 10)).toEqual({
      onTimeUntil: 550,
      lateUntil: 610,
      permissionUntil: 670,
      firstHalfUntil: 690,
    });
    const l = arrivalLimits("09:00", 10)!;
    expect([l.onTimeUntil, l.lateUntil, l.permissionUntil, l.firstHalfUntil].map(clock)).toEqual([
      "09:10",
      "10:10",
      "11:10",
      "11:30",
    ]);
  });

  it("follows each shift's start and grace", () => {
    const l = arrivalLimits("14:00", 5)!;
    expect([l.onTimeUntil, l.lateUntil, l.permissionUntil, l.firstHalfUntil].map(clock)).toEqual([
      "14:05",
      "15:05",
      "16:05",
      "16:25",
    ]);
  });

  it("follows the settings and copes with junk", () => {
    const l = arrivalLimits("09:00", 15, {
      lateWindowMinutes: 30,
      permissionWindowMinutes: 30,
      extraMinutes: 10,
      quarterDeduction: 0.5,
    })!;
    expect([l.onTimeUntil, l.lateUntil, l.permissionUntil, l.firstHalfUntil].map(clock)).toEqual([
      "09:15",
      "09:45",
      "10:15",
      "10:25",
    ]);
    expect(arrivalLimits("", 10)).toBeNull();
    expect(arrivalLimits("25:00", 10)).toBeNull();
    expect(arrivalLimits("09:00", Number.NaN)!.onTimeUntil).toBe(540);
  });
});

describe("zones", () => {
  const limits = arrivalLimits("09:00", 15)!; // on time to 09:15, Late to 10:15, permission to 11:15, first half to 11:35

  it("puts a first punch on the timeline", () => {
    const table: [string, ArrivalZone, number][] = [
      ["09:15", "on_time", 1],
      ["09:16", "late", 1],
      ["10:15", "late", 1],
      ["10:16", "quarter", 0.75],
      ["11:15", "quarter", 0.75],
      ["11:35", "quarter", 0.75],
      ["11:36", "second_half", 0.5],
      ["13:40", "second_half", 0.5],
    ];
    for (const [punch, zone, shifts] of table) {
      expect(arrivalZone(punch, limits), punch).toBe(zone);
      expect(shiftsFor(zone, DEFAULT_ARRIVAL.quarterDeduction), punch).toBe(shifts);
    }
  });

  it("judges in whole minutes: the seconds never move a limit", () => {
    expect(arrivalZone("09:15:59", limits)).toBe("on_time");
    expect(arrivalZone("09:16:00", limits)).toBe("late");
    expect(arrivalZone("10:15:59", limits)).toBe("late");
  });

  it("lets an approved permission excuse up to the end of the permission window, but not the extra minutes", () => {
    expect(arrivalZone("09:40", limits, true)).toBe("excused");
    expect(arrivalZone("10:40", limits, true)).toBe("excused");
    expect(arrivalZone("11:15", limits, true)).toBe("excused");
    expect(arrivalZone("11:16", limits, true)).toBe("quarter");
    expect(arrivalZone("11:36", limits, true)).toBe("second_half");
    expect(arrivalZone("09:15", limits, true)).toBe("on_time");
  });

  it("takes the deduction from the settings", () => {
    expect(shiftsFor("quarter", 0.5)).toBe(0.5);
    expect(shiftsFor("quarter", 0)).toBe(1);
    expect(shiftsFor("quarter", 3)).toBe(0);
  });

  it("has no zone for a punch that is not a time", () => {
    expect(arrivalZone("", limits)).toBeNull();
    expect(arrivalZone(null, limits)).toBeNull();
  });
});

describe("validateArrival", () => {
  const ok = { lateWindowMinutes: 60, permissionWindowMinutes: 60, extraMinutes: 20, quarterDeduction: 0.25 };

  it("accepts the defaults and the edges", () => {
    expect(validateArrival(ok)).toBeNull();
    expect(validateArrival({ ...ok, lateWindowMinutes: 0, extraMinutes: 240, quarterDeduction: 1 })).toBeNull();
    expect(validateArrival({ ...ok, quarterDeduction: 0 })).toBeNull();
  });

  it("rejects what the server rejects", () => {
    expect(validateArrival({ ...ok, lateWindowMinutes: -1 })).toMatch(/Late window/);
    expect(validateArrival({ ...ok, permissionWindowMinutes: 241 })).toMatch(/Permission window/);
    expect(validateArrival({ ...ok, extraMinutes: 1.5 })).toMatch(/Extra minutes/);
    expect(validateArrival({ ...ok, extraMinutes: Number.NaN })).toMatch(/Extra minutes/);
    expect(validateArrival({ ...ok, quarterDeduction: 1.25 })).toMatch(/Quarter-shift deduction/);
    expect(validateArrival({ ...ok, quarterDeduction: -0.25 })).toMatch(/Quarter-shift deduction/);
    expect(validateArrival({ ...ok, quarterDeduction: 0.255 })).toMatch(/2 decimals/);
  });
});

describe("clock helpers", () => {
  it("reads and writes clock times", () => {
    expect(minutesOf("09:05:59")).toBe(545);
    expect(minutesOf("9:5")).toBeNull();
    expect(clock(0)).toBe("00:00");
    expect(clock(25 * 60)).toBe("01:00");
  });
});
