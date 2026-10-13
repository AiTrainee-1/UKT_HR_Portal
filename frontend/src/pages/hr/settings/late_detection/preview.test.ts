import { describe, expect, it } from "vitest";
import { payFor } from "../attendance/example";
import { capChanges, lateChanges, lateDraftFrom, latePayload, lateProblem, sameLate } from "./form";
import {
  allowanceProblem,
  capProblem,
  latePool,
  slabDeduction,
  slabWarnings,
  slabsProblem,
  withinCap,
  type Slab,
} from "./preview";

// The engine's own numbers (payroll_views.late_shift_deduction, attendance_final.late_pool_summary and
// backend/api/tests_late_permission_rules.py), with the default table of models/payroll.py
// _default_late_deduction_slabs: every 3 billable marks a quarter shift, up to 30 -> 2.5.

const DEFAULT_SLABS: Slab[] = Array.from({ length: 10 }, (_, i) => ({
  fromLates: (i + 1) * 3,
  deductionShifts: Math.round((i + 1) * 0.25 * 100) / 100,
}));
const cost = (marks: number, allowance = 3, slabs = DEFAULT_SLABS) =>
  slabDeduction(Math.max(0, marks - allowance), slabs);

describe("what a month's marks cost (allowance 3, default slabs, ₹1,000 a day)", () => {
  it("prices the worked example the tab shows", () => {
    expect([0, 2, 4, 6, 9, 12, 15, 20].map((n) => cost(n))).toEqual([0, 0, 0, 0.25, 0.5, 0.75, 1, 1.25]);
  });

  it("matches the inventory's money: 6 marks ₹250, 12 marks ₹750, 20 marks ₹1,250, 45 marks ₹2,500 and never more", () => {
    expect(payFor(cost(4))).toBe(0);
    expect(payFor(cost(6))).toBe(250);
    expect(payFor(cost(7))).toBe(250);
    expect(payFor(cost(12))).toBe(750);
    expect(payFor(cost(20))).toBe(1250);
    expect(payFor(cost(45))).toBe(2500);
    expect(payFor(cost(400))).toBe(2500);
  });

  it("reads rows in ascending order, skips rows that are not numbers, and costs nothing with no rows", () => {
    const shuffled = [
      { fromLates: 6, deductionShifts: 0.5 },
      { fromLates: 3, deductionShifts: 0.25 },
    ];
    expect(slabDeduction(4, shuffled)).toBe(0.25);
    expect(slabDeduction(9, shuffled)).toBe(0.5);
    expect(slabDeduction(9, [...shuffled, { fromLates: NaN, deductionShifts: 9 }])).toBe(0.5);
    expect(slabDeduction(50, [])).toBe(0);
  });

  it("takes a row 'from 0' from everyone, even with no marks (and says so)", () => {
    expect(slabDeduction(0, [{ fromLates: 0, deductionShifts: 0.5 }])).toBe(0.5);
    expect(slabWarnings([{ fromLates: 0, deductionShifts: 0.5 }])[0]).toContain("every staff member");
    expect(slabWarnings(DEFAULT_SLABS)).toEqual([]);
    expect(
      slabWarnings([
        { fromLates: 3, deductionShifts: 1 },
        { fromLates: 6, deductionShifts: 0.5 },
      ])[0],
    ).toContain("more marks would cost less");
  });
});

describe("the monthly pool", () => {
  it("counts each approved permission beyond the cap once, on top of the Late and Early Out days", () => {
    // tests_late_permission_rules: four permissions, cap 3 -> one excess, and day 4's lateness IS that excess
    expect(latePool({ lateIn: 0, earlyOut: 0, approvedPermissions: 4, cap: 3, allowance: 3 })).toEqual({
      lateIn: 0,
      earlyOut: 0,
      excess: 1,
      total: 1,
      free: 1,
      billable: 0,
    });
    // ... and a plain Late day still counts on top: 2 marks, both free
    expect(latePool({ lateIn: 1, earlyOut: 0, approvedPermissions: 4, cap: 3, allowance: 3 })).toMatchObject({
      total: 2,
      billable: 0,
    });
    expect(latePool({ lateIn: 5, earlyOut: 1, approvedPermissions: 4, cap: 3, allowance: 3 })).toMatchObject({
      total: 7,
      free: 3,
      billable: 4,
    });
    expect(latePool({ lateIn: 2, earlyOut: 0, approvedPermissions: 2, cap: 0, allowance: 0 }).billable).toBe(4);
  });

  it("ranks permissions earliest first: the first `cap` are within it", () => {
    expect(withinCap(4, 3)).toEqual([true, true, true, false]);
    expect(withinCap(4, 0)).toEqual([false, false, false, false]);
    expect(withinCap(2, 5)).toEqual([true, true]);
  });
});

describe("checks before saving", () => {
  it("wants whole numbers for the allowance and the cap", () => {
    expect(allowanceProblem("3")).toBeNull();
    expect(allowanceProblem("2.5")).toBeTruthy();
    expect(allowanceProblem("-1")).toBeTruthy();
    expect(allowanceProblem("")).toBeTruthy();
    expect(capProblem("31")).toBeNull();
    expect(capProblem("32")).toBe("Permission monthly cap must be a whole number from 0 to 31.");
    expect(capProblem("1.5")).toBeTruthy();
  });

  it("wants every slab to be whole marks and 0-31 shifts with two decimals, and no threshold twice", () => {
    expect(slabsProblem([{ fromLates: "3", deductionShifts: "0.25" }])).toBeNull();
    expect(slabsProblem([{ fromLates: "2.5", deductionShifts: "0.25" }])).toBeTruthy();
    expect(slabsProblem([{ fromLates: "3", deductionShifts: "-1" }])).toBeTruthy();
    expect(slabsProblem([{ fromLates: "3", deductionShifts: "0.125" }])).toBeTruthy();
    expect(
      slabsProblem([
        { fromLates: "3", deductionShifts: "0.25" },
        { fromLates: "3", deductionShifts: "0.5" },
      ]),
    ).toBe("Duplicate threshold: 3 billable marks appears more than once.");
  });
});

describe("the two forms", () => {
  const saved = lateDraftFrom({ lateFreeAllowance: 3, lateDeductionSlabs: DEFAULT_SLABS.slice(0, 2) });

  it("loads, compares in any row order, and sends the rows in ascending order", () => {
    expect(saved).toEqual({
      allowance: "3",
      slabs: [
        { fromLates: "3", deductionShifts: "0.25" },
        { fromLates: "6", deductionShifts: "0.5" },
      ],
    });
    const reordered = { ...saved, slabs: [...saved.slabs].reverse() };
    expect(sameLate(reordered, saved)).toBe(true);
    expect(latePayload({ ...saved, slabs: [...saved.slabs, { fromLates: "1", deductionShifts: "0.1" }] })).toEqual({
      lateFreeAllowance: 3,
      lateDeductionSlabs: [
        { fromLates: 1, deductionShifts: 0.1 },
        { fromLates: 3, deductionShifts: 0.25 },
        { fromLates: 6, deductionShifts: 0.5 },
      ],
    });
    expect(lateProblem(saved)).toBeNull();
    expect(lateDraftFrom({})).toEqual({ allowance: "3", slabs: [] });
  });

  it("lists what changed for the confirm", () => {
    expect(lateChanges({ ...saved, allowance: "5" }, saved)).toEqual([
      { key: "allowance", label: "Free allowance", from: "3 marks", to: "5 marks", money: true },
    ]);
    expect(lateChanges({ ...saved, slabs: [] }, saved)[0]).toMatchObject({
      label: "Deduction slabs",
      from: "3 → 0.25, 6 → 0.5",
      to: "no slabs (nothing deducted)",
    });
    expect(capChanges({ cap: "2" }, { cap: "3" })).toEqual([
      { key: "cap", label: "Permission monthly cap", from: "3 a month", to: "2 a month", money: true },
    ]);
    expect(capChanges({ cap: "3" }, { cap: "3" })).toEqual([]);
  });
});
