import { describe, expect, it } from "vitest";
import { cyclePay, judgeProductionDay, lateShiftDeduction, productionLatePenalty } from "./preview";

// Expected amounts are the settings inventory's, worked out with the slab loop of late_shift_deduction and the PF / ESI
// branch of _generate_production_payroll with each cycle's monthly factor.

describe("late deductions", () => {
  const slabs = [
    { fromLates: 3, deductionShifts: 0.25 },
    { fromLates: 6, deductionShifts: 0.5 },
    { fromLates: 9, deductionShifts: 0.75 },
  ];

  it("free allowance 3: 2 lates -> 0 billable, 6 lates -> 3 billable", () => {
    expect(productionLatePenalty(2, 3, slabs, 600).billable).toBe(0);
    expect(productionLatePenalty(6, 3, slabs, 600).billable).toBe(3);
  });

  it("₹600 a shift: 7 lates -> 0.25 shift = ₹150, 9 -> 0.5 = ₹300, 15 -> 0.75 = ₹450 (the last row holds)", () => {
    expect(productionLatePenalty(7, 3, slabs, 600)).toEqual({ billable: 4, shifts: 0.25, penalty: 15_000 });
    expect(productionLatePenalty(9, 3, slabs, 600)).toEqual({ billable: 6, shifts: 0.5, penalty: 30_000 });
    expect(productionLatePenalty(15, 3, slabs, 600)).toEqual({ billable: 12, shifts: 0.75, penalty: 45_000 });
  });

  it("a row starting at 0 deducts from everyone, even with no late at all; no rows deduct nothing", () => {
    expect(productionLatePenalty(0, 3, [{ fromLates: 0, deductionShifts: 0.25 }], 600).penalty).toBe(15_000);
    expect(lateShiftDeduction(20, [])).toBe(0);
  });

  it("sorts rows, skips unreadable ones and lets the later of two equal thresholds win", () => {
    expect(
      lateShiftDeduction(7, [
        { fromLates: 6, deductionShifts: 0.5 },
        { fromLates: 3, deductionShifts: 0.25 },
      ]),
    ).toBe(0.5);
    expect(
      lateShiftDeduction(7, [
        { fromLates: "x", deductionShifts: 1 },
        { fromLates: "3", deductionShifts: "0.25" },
      ]),
    ).toBe(0.25);
    expect(
      lateShiftDeduction(4, [
        { fromLates: 3, deductionShifts: 0.25 },
        { fromLates: 3, deductionShifts: 1 },
      ]),
    ).toBe(1);
  });
});

describe("a production late day", () => {
  const shift = { shiftStart: "08:00", shiftEnd: "17:00", graceMinutes: 10 };

  it("Simple: 08:10 is on time, 08:10:20 and 08:11 are late (seconds count)", () => {
    const late = (firstPunch: string) => judgeProductionDay({ ...shift, firstPunch, mode: "simple" }).late;
    expect([late("08:10"), late("08:10:20"), late("08:11")]).toEqual([false, true, true]);
  });

  it("Strict: leaving at 16:49 (before 16:50) is late too; 16:50 is not; both together are one late day", () => {
    const day = (lastPunch: string, firstPunch = "08:00") =>
      judgeProductionDay({ ...shift, firstPunch, lastPunch, mode: "strict" });
    expect(day("16:49")).toEqual({ late: true, arrivedLate: false, leftEarly: true });
    expect(day("16:50").late).toBe(false);
    expect(day("16:49", "08:30")).toEqual({ late: true, arrivedLate: true, leftEarly: true });
    expect(judgeProductionDay({ ...shift, firstPunch: "08:00", lastPunch: "16:49", mode: "simple" }).late).toBe(false);
  });
});

describe("PF and ESI on a cycle's payslip", () => {
  const flat = {
    ratePerShift: 600,
    flatOn: true,
    pfRate: 12,
    esiRate: 0.75,
    esiCeiling: 21000,
    bandsOn: false,
    bands: [],
  };

  it("estimates a month as the period x 4, x 2 or x 1: 6 shifts a week = ₹3,600, estimate ₹14,400 on every cycle", () => {
    expect(cyclePay({ ...flat, shifts: 6 }, "weekly").monthlyEstimate).toBe(1_440_000);
    expect(cyclePay({ ...flat, shifts: 12 }, "biweekly").monthlyEstimate).toBe(1_440_000);
    expect(cyclePay({ ...flat, shifts: 24 }, "monthly").monthlyEstimate).toBe(1_440_000);
  });

  it("tests the ESI ceiling on the estimate: 10 shifts in a week (₹6,000, estimate ₹24,000) pays PF but no ESI", () => {
    const week = cyclePay({ ...flat, shifts: 10 }, "weekly");
    expect([week.source, week.pf, week.esi, week.net]).toEqual(["flat", 72_000, 0, 528_000]);
    const month = cyclePay({ ...flat, shifts: 10 }, "monthly");
    expect([month.esi, month.net]).toEqual([4_500, 523_500]);
  });

  it("a matching band is tested on the estimate too, and wins over the flat rates", () => {
    const bands = [{ label: "Low", minSalary: 0, maxSalary: 15000, pfRate: 10, efRate: 1 }];
    const paid = cyclePay({ ...flat, shifts: 6, bandsOn: true, bands }, "weekly");
    expect([paid.source, paid.band?.label, paid.pf, paid.esi]).toEqual(["band", "Low", 36_000, 3_600]);
    // the same shifts on Monthly: estimate ₹3,600 is still in the band; 7 shifts a week (₹4,200 x 4 = ₹16,800) is not
    expect(cyclePay({ ...flat, shifts: 6, bandsOn: true, bands }, "monthly").source).toBe("band");
    expect(cyclePay({ ...flat, shifts: 7, bandsOn: true, bands }, "weekly").source).toBe("flat");
    expect(cyclePay({ ...flat, shifts: 7, bandsOn: true, bands, flatOn: false }, "weekly").source).toBe("none");
  });
});
