import { describe, expect, it } from "vitest";
import type { CyclePeriodRow, PeriodEmployee, ProductionPayrollItem } from "@/lib/api-client/custom-hooks";
import {
  cycleBlurb,
  cycleTitle,
  defaultPeriod,
  filterRoster,
  filterRows,
  formatPeriod,
  parseDay,
  periodFromValue,
  periodOptionLabel,
  periodValue,
  readyCount,
  rosterState,
  samePeriod,
  totalsOf,
  unassignedNotice,
} from "./logic";

const row = (over: Partial<CyclePeriodRow> = {}): CyclePeriodRow => ({
  periodStart: "2026-02-02",
  periodEnd: "2026-02-08",
  periodEnded: true,
  isNext: false,
  generated: 0,
  paid: 0,
  ...over,
});

const payroll = (over: Partial<ProductionPayrollItem> = {}): ProductionPayrollItem =>
  ({
    id: 1,
    employeeId: 1,
    employeeName: "Asha Kumar",
    employeeCode: "P001",
    departmentId: 4,
    salaryMode: "shift",
    month: 2,
    year: 2026,
    totalWorkingDays: 7,
    presentDays: 7,
    absentDays: 0,
    otHours: 0,
    otAmount: 0,
    baseSalary: 3500,
    grossSalary: 3500,
    deductions: 500,
    bonus: 0,
    finalSalary: 3000,
    status: "pending",
    bankAccount: "",
    bankIfsc: "",
    bankName: "",
    email: "",
    departmentName: "Weaving",
    ...over,
  }) as ProductionPayrollItem;

const person = (over: Partial<PeriodEmployee> = {}): PeriodEmployee => ({
  employeeId: 1,
  employeeCode: "P001",
  name: "Asha Kumar",
  departmentName: "Weaving",
  salaryPerShift: 500,
  payroll: null,
  blockedReason: null,
  ...over,
});

describe("writing a period", () => {
  it("shows the year once when both ends share it", () => {
    expect(formatPeriod({ periodStart: "2026-02-02", periodEnd: "2026-02-08" })).toBe("2 Feb - 8 Feb 2026");
    expect(formatPeriod({ periodStart: "2026-02-16", periodEnd: "2026-03-01" })).toBe("16 Feb - 1 Mar 2026");
  });

  it("shows both years across a year end", () => {
    expect(formatPeriod({ periodStart: "2025-12-29", periodEnd: "2026-01-04" })).toBe("29 Dec 2025 - 4 Jan 2026");
  });

  it("falls back to the raw text for something that is not a date", () => {
    expect(formatPeriod({ periodStart: "soon", periodEnd: "later" })).toBe("soon - later");
  });

  it("only accepts real calendar days", () => {
    expect(parseDay("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("02/02/2026")).toBeNull();
    expect(parseDay(null)).toBeNull();
  });

  it("round-trips through the picker's value", () => {
    const period = { periodStart: "2026-02-02", periodEnd: "2026-02-15" };
    expect(periodValue(period)).toBe("2026-02-02|2026-02-15");
    expect(periodFromValue(periodValue(period))).toEqual(period);
    expect(periodFromValue("nonsense")).toBeNull();
    expect(periodFromValue("2026-02-02|")).toBeNull();
  });

  it("compares two periods by both ends", () => {
    const a = { periodStart: "2026-02-02", periodEnd: "2026-02-08" };
    expect(samePeriod(a, { ...a })).toBe(true);
    expect(samePeriod(a, { periodStart: "2026-02-02", periodEnd: "2026-02-15" })).toBe(false);
    expect(samePeriod(a, null)).toBe(false);
  });
});

describe("choosing a period", () => {
  it("opens on the period that is next due", () => {
    const periods = [
      row({ periodStart: "2026-03-09", periodEnd: "2026-03-15" }),
      row({ periodStart: "2026-03-02", periodEnd: "2026-03-08", isNext: true }),
    ];
    expect(defaultPeriod(periods)).toEqual({ periodStart: "2026-03-02", periodEnd: "2026-03-08" });
  });

  it("falls back to the newest period and to nothing", () => {
    expect(defaultPeriod([row({ periodStart: "2026-03-09", periodEnd: "2026-03-15" })])).toEqual({
      periodStart: "2026-03-09",
      periodEnd: "2026-03-15",
    });
    expect(defaultPeriod([])).toBeNull();
  });

  it("describes each entry of the picker", () => {
    expect(periodOptionLabel(row({ generated: 12, isNext: true }), 14)).toBe(
      "2 Feb - 8 Feb 2026 · 12 of 14 generated · next due",
    );
    expect(periodOptionLabel(row(), 14)).toBe("2 Feb - 8 Feb 2026 · not generated");
    expect(periodOptionLabel(row({ periodEnded: false, generated: 3 }), 0)).toBe(
      "2 Feb - 8 Feb 2026 · 3 generated · not ended yet",
    );
  });
});

describe("totals of the payslips", () => {
  it("adds money up and counts people, not rows, as pending", () => {
    const rows = [
      payroll({ id: 1, employeeId: 1 }),
      payroll({ id: 2, employeeId: 1, grossSalary: 1000, deductions: 0, finalSalary: 1000 }),
      payroll({ id: 3, employeeId: 2, status: "paid", finalSalary: 2000, grossSalary: 2000, deductions: 0 }),
    ];
    expect(totalsOf(rows)).toEqual({
      gross: 6500,
      deductions: 500,
      net: 6000,
      pendingEmployees: 1,
      pendingRecords: 2,
      pendingNet: 4000,
      paidNet: 2000,
    });
  });

  it("is all zeros for no rows", () => {
    expect(totalsOf([]).net).toBe(0);
    expect(totalsOf([]).pendingEmployees).toBe(0);
  });

  it("filters by name or code and by department", () => {
    const rows = [
      payroll({ id: 1, employeeName: "Asha Kumar", employeeCode: "P001", departmentId: 4 }),
      payroll({ id: 2, employeeId: 2, employeeName: "Ravi Nair", employeeCode: "P002", departmentId: 5 }),
    ];
    expect(filterRows(rows, "", "all")).toHaveLength(2);
    expect(filterRows(rows, "ravi", "all").map((r) => r.id)).toEqual([2]);
    expect(filterRows(rows, "P001", "all").map((r) => r.id)).toEqual([1]);
    expect(filterRows(rows, "", "5").map((r) => r.id)).toEqual([2]);
    expect(filterRows(rows, "ravi", "4")).toEqual([]);
  });
});

describe("the roster", () => {
  it("reads each employee's state for the period", () => {
    expect(rosterState(person())).toBe("ready");
    expect(rosterState(person({ blockedReason: "No Salary Per Shift set on this employee's profile" }))).toBe(
      "blocked",
    );
    expect(rosterState(person({ payroll: payroll() }))).toBe("pending");
    expect(rosterState(person({ payroll: payroll({ status: "paid" }) }))).toBe("paid");
  });

  it("filters by state and by text", () => {
    const people = [
      person({ employeeId: 1, employeeCode: "P001", name: "Asha Kumar" }),
      person({ employeeId: 2, employeeCode: "P002", name: "Ravi Nair", payroll: payroll({ status: "paid" }) }),
      person({ employeeId: 3, employeeCode: "P003", name: "Meena Das", blockedReason: "No rate" }),
    ];
    expect(filterRoster(people, "", "all")).toHaveLength(3);
    expect(filterRoster(people, "", "paid").map((p) => p.employeeId)).toEqual([2]);
    expect(filterRoster(people, "", "blocked").map((p) => p.employeeId)).toEqual([3]);
    expect(filterRoster(people, "meena", "all").map((p) => p.employeeId)).toEqual([3]);
    expect(filterRoster(people, "p002", "ready")).toEqual([]);
  });

  it("counts what a Generate click would compute", () => {
    expect(
      readyCount([
        person(),
        person({ employeeId: 2, blockedReason: "x" }),
        person({ employeeId: 3, payroll: payroll() }),
      ]),
    ).toBe(1);
  });
});

describe("wording", () => {
  it("names each cycle's page", () => {
    expect(cycleTitle("weekly")).toBe("Production Payroll - Weekly");
    expect(cycleBlurb("biweekly")).toContain("Two-week calculation");
    expect(cycleBlurb("biweekly")).toContain("14-day");
    expect(cycleBlurb("monthly")).toContain("28-day");
  });

  it("warns about people on no cycle", () => {
    expect(unassignedNotice(0)).toBeNull();
    expect(unassignedNotice(1)).toBe(
      "1 production employee is not assigned to a pay cycle yet, so no payroll includes them.",
    );
    expect(unassignedNotice(5)).toContain("5 production employees are");
  });
});
