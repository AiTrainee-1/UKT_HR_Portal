import { describe, expect, it } from "vitest";
import type { AlreadyPaidPart, CatchUpPart, PeriodCoverage, PeriodEmployee } from "@/lib/api-client/custom-hooks";
import { coverageLines, coverageText, dayRangeText, partialReady, rangesText } from "./coverage";

const paid = (from: string, to: string, label = "Weekly", over: Partial<AlreadyPaidPart> = {}): AlreadyPaidPart => ({
  from,
  to,
  payrollId: 1,
  cycle: "weekly",
  kind: "production",
  label,
  status: "pending",
  periodStart: from,
  periodEnd: to,
  ...over,
});

const catchUp = (from: string, to: string, fromLabel = "Monthly"): CatchUpPart => ({
  from,
  to,
  days: 14,
  fromCycle: "monthly",
  fromKind: "production",
  fromLabel,
  afterPayrollId: 9,
});

const coverage = (over: Partial<PeriodCoverage> = {}): PeriodCoverage => ({
  periodStart: "2026-11-02",
  periodEnd: "2026-11-29",
  periodDays: 28,
  payDays: 28,
  catchUpDays: 0,
  paidDays: 28,
  payRanges: [{ from: "2026-11-02", to: "2026-11-29" }],
  alreadyPaid: [],
  catchUp: [],
  legacyGap: null,
  partial: false,
  refused: false,
  note: null,
  ...over,
});

describe("how a run of days is written", () => {
  it("is short inside a month, names both months across one, and both years across a year end", () => {
    expect(dayRangeText({ from: "2026-11-09", to: "2026-11-29" })).toBe("9–29 Nov");
    expect(dayRangeText({ from: "2026-11-09", to: "2026-11-09" })).toBe("9 Nov");
    expect(dayRangeText({ from: "2026-02-23", to: "2026-03-01" })).toBe("23 Feb – 1 Mar");
    expect(dayRangeText({ from: "2025-12-29", to: "2026-01-04" })).toBe("29 Dec 2025 – 4 Jan 2026");
    expect(dayRangeText({ from: "2026-11-09", to: "2026-11-29" }, true)).toBe("9–29 Nov 2026");
    expect(dayRangeText({ from: "soon", to: "later" })).toBe("soon – later");
  });

  it("joins several runs with commas and a final 'and'", () => {
    expect(rangesText([])).toBe("");
    expect(
      rangesText([
        { from: "2026-02-02", to: "2026-02-08" },
        { from: "2026-02-23", to: "2026-03-01" },
      ]),
    ).toBe("2–8 Feb and 23 Feb – 1 Mar");
    expect(
      rangesText([
        { from: "2026-02-02", to: "2026-02-02" },
        { from: "2026-02-04", to: "2026-02-04" },
        { from: "2026-02-06", to: "2026-02-06" },
      ]),
    ).toBe("2 Feb, 4 Feb and 6 Feb");
  });
});

describe("what a payslip says about the days it pays", () => {
  it("says nothing for an ordinary payslip", () => {
    expect(coverageLines(coverage())).toBeNull();
    expect(coverageLines(null)).toBeNull();
    expect(coverageLines(undefined)).toBeNull();
    expect(coverageText(coverage())).toBeNull();
  });

  it("names the days it pays and the cycle that already paid the rest (the owner's Weekly -> Monthly example)", () => {
    const c = coverage({
      payRanges: [{ from: "2026-11-09", to: "2026-11-29" }],
      alreadyPaid: [paid("2026-11-02", "2026-11-08")],
      partial: true,
    });
    expect(coverageLines(c)).toEqual({
      paid: "Pays 9–29 Nov only · 2–8 Nov already paid on Weekly",
      catchUp: [],
      legacy: null,
    });
  });

  it("groups the days already paid by the payroll that paid them", () => {
    const c = coverage({
      payRanges: [{ from: "2026-11-23", to: "2026-11-29" }],
      alreadyPaid: [
        paid("2026-11-02", "2026-11-08"),
        paid("2026-11-09", "2026-11-15"),
        paid("2026-11-16", "2026-11-22", "Staff Payroll", { kind: "staff", cycle: null }),
      ],
    });
    expect(coverageLines(c)?.paid).toBe(
      "Pays 23–29 Nov only · 2–8 Nov and 9–15 Nov already paid on Weekly · 16–22 Nov already paid on Staff Payroll",
    );
  });

  it("adds the catch-up days with the cycle the employee came from (the owner's Monthly -> Weekly example)", () => {
    const c = coverage({
      periodStart: "2026-11-16",
      periodEnd: "2026-11-22",
      payRanges: [{ from: "2026-11-16", to: "2026-11-22" }],
      catchUp: [catchUp("2026-11-02", "2026-11-15")],
    });
    expect(coverageLines(c)).toEqual({ paid: null, catchUp: ["+ catch-up 2–15 Nov from Monthly"], legacy: null });
    expect(coverageText(c)).toBe("+ catch-up 2–15 Nov from Monthly");
  });

  it("says when nothing is left to pay, and reports a gap after a payroll from before the cycles", () => {
    const refused = coverage({
      payRanges: [],
      alreadyPaid: [paid("2026-11-02", "2026-11-29", "Monthly")],
      refused: true,
    });
    expect(coverageLines(refused)?.paid).toBe("Nothing left to pay · 2–29 Nov already paid on Monthly");
    const gap = coverage({ legacyGap: catchUp("2026-10-19", "2026-11-01", "Production Payroll") });
    expect(coverageText(gap)).toBe("19 Oct – 1 Nov not paid by any payroll (not added automatically)");
  });

  it("reads the details page's coverage too (no legacy gap, no refused flag)", () => {
    expect(
      coverageText({
        payRanges: [{ from: "2026-02-09", to: "2026-03-01" }],
        alreadyPaid: [paid("2026-02-02", "2026-02-08")],
        catchUp: [],
      }),
    ).toBe("Pays 9 Feb – 1 Mar only · 2–8 Feb already paid on Weekly");
  });
});

describe("who a Generate click pays for part of the period", () => {
  const person = (id: number, over: Partial<PeriodEmployee> = {}): PeriodEmployee => ({
    employeeId: id,
    employeeCode: `E${id}`,
    name: `E ${id}`,
    departmentName: null,
    salaryPerShift: 500,
    payroll: null,
    blockedReason: null,
    ...over,
  });

  it("lists only ready employees whose payslip is not an ordinary one", () => {
    const part = coverage({
      payRanges: [{ from: "2026-11-09", to: "2026-11-29" }],
      alreadyPaid: [paid("2026-11-02", "2026-11-08")],
    });
    const people = [
      person(1, { coverage: part }),
      person(2, { coverage: coverage() }),
      person(3),
      person(4, { coverage: part, blockedReason: "No Salary Per Shift set on this employee's profile" }),
      person(5, { coverage: part, payroll: { id: 50 } as PeriodEmployee["payroll"] }),
      person(6, { coverage: coverage({ legacyGap: catchUp("2026-10-19", "2026-11-01", "Production Payroll") }) }),
    ];
    expect(partialReady(people).map((p) => p.employeeId)).toEqual([1]);
  });
});
