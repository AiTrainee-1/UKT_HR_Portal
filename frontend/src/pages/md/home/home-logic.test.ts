import { describe, expect, it } from "vitest";
import { HOME } from "./home-fixtures";
import {
  addMonths,
  averagePresentPct,
  changePct,
  countsFor,
  currentAndPrevious,
  monthName,
  monthOf,
  payrollRows,
  shortDate,
  staffShare,
  trendRows,
  unitRows,
  validMonth,
  weekday,
} from "./home-logic";

describe("the Dashboard's month", () => {
  it("reads the month of a date or the server's clock", () => {
    expect(monthOf("2026-11-13T17:26")).toBe("2026-11");
    expect(monthOf("2026-01-01")).toBe("2026-01");
    expect(monthOf(undefined)).toBeNull();
    expect(monthOf("soon")).toBeNull();
  });

  it("steps across years and names the month", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(addMonths("2026-11", -17)).toBe("2025-06");
    expect(monthName("2026-10")).toBe("October 2026");
    expect(monthName("2026-10", true)).toBe("Oct 2026");
  });

  it("takes a month from the address only when the server can answer it", () => {
    expect(validMonth("2026-10", "2026-11")).toBe("2026-10");
    expect(validMonth("2026-11", "2026-11")).toBe("2026-11");
    expect(validMonth("2026-12", "2026-11")).toBeNull(); // not started
    expect(validMonth("2025-06", "2026-11")).toBe("2025-06"); // 17 back: the oldest
    expect(validMonth("2025-05", "2026-11")).toBeNull();
    expect(validMonth("2026-13", "2026-11")).toBeNull();
    expect(validMonth("October", "2026-11")).toBeNull();
    expect(validMonth(null, "2026-11")).toBeNull();
  });
});

describe("the attendance views", () => {
  it("picks the whole company, staff or production", () => {
    expect(countsFor(HOME.attendance, "all")).toMatchObject({ expected: 256, present: 82, absent: 170, cl: 4 });
    expect(countsFor(HOME.attendance, "staff")).toMatchObject({ expected: 142, present: 82, absent: 56, onLeave: 6 });
    expect(countsFor(HOME.attendance, "production")).toMatchObject({ expected: 114, present: 0, absent: 114 });
  });

  it("draws the trend for a view and leaves today out of the average", () => {
    const rows = trendRows(HOME.attendance.trend, "staff");
    expect(rows.map((r) => [r.label, r.day, r.present, r.cl, r.absent, r.today])).toEqual([
      ["11 Nov", "Wed", 65, 0, 77, false],
      ["12 Nov", "Thu", 82, 1, 59, false],
      ["13 Nov", "Fri", 82, 4, 56, true],
    ]);
    // (65 + 82) / (142 + 142), the running day not counted
    expect(averagePresentPct(HOME.attendance.trend, "staff")).toBe(51.8);
    expect(averagePresentPct([HOME.attendance.trend[2]], "staff")).toBeNull();
  });

  it("lists the units a view has anybody due at, the largest first", () => {
    expect(unitRows(HOME.attendance, "all").map((u) => u.name)).toEqual(["Unit1", "Head Office", "No unit"]);
    expect(unitRows(HOME.attendance, "production").map((u) => u.name)).toEqual(["Unit1"]);
    expect(unitRows(HOME.attendance, "staff")[0]).toMatchObject({
      name: "Head Office",
      present: 78,
      cl: 4,
      absent: 37,
    });
  });

  it("writes dates the factory's way", () => {
    expect(shortDate("2026-11-13")).toBe("13 Nov");
    expect(weekday("2026-11-15")).toBe("Sun");
  });
});

describe("the payroll months", () => {
  it("pairs the running month with the one before, with the changes", () => {
    const pair = currentAndPrevious(HOME.payroll.months);
    expect(pair.current?.month).toBe("2026-11");
    expect(pair.previous?.month).toBe("2026-10");
    expect(pair.grossChange).toBe(-79);
    expect(pair.peopleChange).toBe(-114);
  });

  it("stacks staff and production month by month, in gross or net", () => {
    const gross = payrollRows(HOME.payroll.months, "gross");
    expect(gross.map((r) => [r.label, r.staff, r.production, r.current, r.previous])).toEqual([
      ["Sep 26", 3275880.22, 0, false, false],
      ["Oct 26", 3764679.34, 764030.75, false, true],
      ["Nov 26", 951730.61, 0, true, false],
    ]);
    expect(payrollRows(HOME.payroll.months, "net")[1].total).toBe(4509593.37);
    expect(staffShare(HOME.payroll.months[1], "gross")).toBe(83.1);
  });

  it("has no change without a month to compare with", () => {
    expect(changePct(10, 0)).toBeNull();
    expect(changePct(null, 5)).toBeNull();
    expect(currentAndPrevious([])).toMatchObject({ current: null, previous: null, grossChange: null });
  });
});
