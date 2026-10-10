import { describe, expect, it } from "vitest";
import {
  amountOf,
  checkIncrement,
  departmentBreakdown,
  dueForIncrement,
  filterDue,
  filterIncrements,
  filtersActive,
  inBand,
  lastIncrements,
  monthlyTrend,
  NO_DUE_FILTERS,
  NO_FILTERS,
  salaryPath,
  sortIncrements,
  summarizeIncrements,
  topIncrements,
  type IncrementEmployee,
  type IncrementRecord,
} from "./logic";

const TODAY = "2026-10-10";

let nextId = 1;
const inc = (over: Partial<IncrementRecord>): IncrementRecord => ({
  id: nextId++,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  previousSalary: 20000,
  newSalary: 22000,
  percent: 10,
  effectiveDate: "2026-01-01",
  notes: null,
  addedBy: "HR Admin",
  department: "Stitching",
  designation: "Operator",
  branchName: "Head Office",
  employmentType: "staff",
  ...over,
});

const emp = (over: Partial<IncrementEmployee> & { id: number }): IncrementEmployee => ({
  employeeCode: `E00${over.id}`,
  firstName: "First",
  lastName: `Last${over.id}`,
  departmentName: "Stitching",
  designationTitle: "Operator",
  branchName: "Head Office",
  employmentType: "staff",
  joinDate: "2020-01-01",
  salaryAmount: 20000,
  salaryType: "monthly",
  status: "active",
  ...over,
});

const rows = [
  inc({ id: 1, employeeId: 1, effectiveDate: "2026-01-01", percent: 10, previousSalary: 20000, newSalary: 22000 }),
  inc({
    id: 2,
    employeeId: 2,
    employeeCode: "E002",
    employeeName: "Ravi Singh",
    effectiveDate: "2025-04-01",
    percent: 5,
    previousSalary: 30000,
    newSalary: 31500,
    department: "Cutting",
    designation: "Cutter",
    branchName: "Unit 2",
    employmentType: "production",
    notes: "Annual appraisal",
  }),
  inc({ id: 3, employeeId: 1, effectiveDate: "2026-09-15", percent: 15, previousSalary: 22000, newSalary: 25300 }),
];

describe("bands", () => {
  it("puts the lower edge in the higher band", () => {
    expect(inBand(4.99, "under_5")).toBe(true);
    expect(inBand(5, "under_5")).toBe(false);
    expect(inBand(5, "5_to_10")).toBe(true);
    expect(inBand(10, "5_to_10")).toBe(false);
    expect(inBand(10, "10_to_15")).toBe(true);
    expect(inBand(15, "over_15")).toBe(true);
    expect(inBand(99, "all")).toBe(true);
  });
});

describe("filtering and sorting the history", () => {
  it("starts with no filter on", () => {
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filterIncrements(rows, NO_FILTERS, TODAY)).toHaveLength(3);
  });

  it("searches name, code, department, designation and notes", () => {
    const find = (query: string) => filterIncrements(rows, { ...NO_FILTERS, query }, TODAY).map((r) => r.id);
    expect(find("ravi")).toEqual([2]);
    expect(find("e001")).toEqual([1, 3]);
    expect(find("cutting")).toEqual([2]);
    expect(find("appraisal ravi")).toEqual([2]);
    expect(find("appraisal asha")).toEqual([]);
  });

  it("filters by department, designation, branch, type, percentage band and period", () => {
    const f = (patch: Partial<typeof NO_FILTERS>) =>
      filterIncrements(rows, { ...NO_FILTERS, ...patch }, TODAY).map((r) => r.id);
    expect(f({ department: "Cutting" })).toEqual([2]);
    expect(f({ designation: "Operator" })).toEqual([1, 3]);
    expect(f({ branch: "Unit 2" })).toEqual([2]);
    expect(f({ type: "production" })).toEqual([2]);
    expect(f({ band: "over_15" })).toEqual([3]);
    expect(f({ band: "5_to_10" })).toEqual([2]);
    expect(f({ period: "this_year" })).toEqual([1, 3]);
    expect(f({ period: "last_year" })).toEqual([2]);
    expect(f({ period: "custom", from: "2025-01-01", to: "2025-12-31" })).toEqual([2]);
  });

  it("sorts by date, percentage, amount and employee", () => {
    expect(sortIncrements(rows, "date", "desc").map((r) => r.id)).toEqual([3, 1, 2]);
    expect(sortIncrements(rows, "percent", "desc").map((r) => r.id)).toEqual([3, 1, 2]);
    expect(sortIncrements(rows, "amount", "desc").map((r) => r.id)).toEqual([3, 1, 2]);
    expect(sortIncrements(rows, "amount", "asc").map((r) => r.id)).toEqual([2, 1, 3]);
    expect(sortIncrements(rows, "employee", "asc").map((r) => r.employeeName)).toEqual([
      "Asha Kumar",
      "Asha Kumar",
      "Ravi Singh",
    ]);
  });
});

describe("the figures", () => {
  it("amountOf is the rise to the paisa", () => {
    expect(amountOf({ previousSalary: 20000, newSalary: 22000 })).toBe(2000);
    expect(amountOf({ previousSalary: 100.05, newSalary: 110.06 })).toBe(10.01);
  });

  it("summarises everything and this year", () => {
    const s = summarizeIncrements(rows, TODAY);
    expect(s.total).toBe(3);
    expect(s.employees).toBe(2);
    expect(s.totalAmount).toBe(2000 + 1500 + 3300);
    expect(s.avgPercent).toBe(10);
    expect(s.thisYear).toEqual({ count: 2, amount: 5300, avgPercent: 12.5 });
    expect(summarizeIncrements([], TODAY)).toMatchObject({
      total: 0,
      avgPercent: 0,
      thisYear: { count: 0, avgPercent: 0 },
    });
  });

  it("breaks down by department, biggest total first, with 'Unassigned' for none", () => {
    const d = departmentBreakdown([
      ...rows,
      inc({ id: 9, employeeId: 7, department: null, previousSalary: 1000, newSalary: 1100 }),
    ]);
    expect(d.map((x) => x.department)).toEqual(["Stitching", "Cutting", "Unassigned"]);
    expect(d[0]).toEqual({
      department: "Stitching",
      incrementCount: 2,
      employeeCount: 1,
      avgPercent: 12.5,
      totalAmount: 5300,
    });
  });

  it("picks the top increments by percentage, newer first among equals", () => {
    const tied = [...rows, inc({ id: 10, employeeId: 4, percent: 15, effectiveDate: "2026-10-01" })];
    expect(topIncrements(tied, 2).map((r) => r.id)).toEqual([10, 3]);
  });

  it("monthlyTrend gives twelve months ending this one, with counts and amounts", () => {
    const t = monthlyTrend(rows, TODAY, 12);
    expect(t).toHaveLength(12);
    expect(t[0].key).toBe("2025-11");
    expect(t[11].key).toBe("2026-10");
    expect(t.find((b) => b.key === "2026-09")).toMatchObject({ count: 1, amount: 3300 });
    expect(t.find((b) => b.key === "2026-01")).toMatchObject({ count: 1, amount: 2000 });
    // April 2025 is before the window
    expect(t.reduce((n, b) => n + b.count, 0)).toBe(2);
  });
});

describe("who is due for an increment", () => {
  const people = [
    emp({ id: 1 }), // last increment 15 Sep 2026
    emp({ id: 2 }), // last increment 1 Apr 2025: 18 months
    emp({ id: 3, joinDate: "2024-06-01" }), // never: 28 months
    emp({ id: 4, joinDate: "2026-06-01" }), // never, joined 4 months ago
    emp({ id: 5, joinDate: null }), // nothing to go on
    emp({ id: 6, salaryAmount: null }), // no salary
    emp({ id: 7, status: "inactive" }),
  ];

  it("uses the newest increment, else the joining date, and skips people who cannot be given one", () => {
    expect(lastIncrements(rows).get(1)).toMatchObject({ date: "2026-09-15", percent: 15 });
    const { rows: due, unknown, noSalary } = dueForIncrement(people, rows, 12, TODAY);
    expect(due.map((r) => r.employee.id)).toEqual([3, 2]);
    expect(due.map((r) => r.basis)).toEqual(["joining", "increment"]);
    expect(due[1]).toMatchObject({ months: 18, lastPercent: 5 });
    expect(unknown).toBe(1);
    expect(noSalary).toBe(1);
  });

  it("a shorter wait lets more people in", () => {
    const { rows: due } = dueForIncrement(people, rows, 6, TODAY);
    expect(due.map((r) => r.employee.id)).toEqual([3, 2]);
    // id 4 joined 4 months ago: not yet at 6, due at 3
    expect(dueForIncrement(people, rows, 3, TODAY).rows.map((r) => r.employee.id)).toEqual([3, 2, 4]);
  });

  it("filters the due list", () => {
    const { rows: due } = dueForIncrement(people, rows, 3, TODAY);
    expect(filterDue(due, { ...NO_DUE_FILTERS, basis: "increment" }).map((r) => r.employee.id)).toEqual([2]);
    expect(filterDue(due, { ...NO_DUE_FILTERS, query: "last4" }).map((r) => r.employee.id)).toEqual([4]);
    expect(filterDue(due, { ...NO_DUE_FILTERS, department: "Cutting" })).toEqual([]);
  });
});

describe("checkIncrement", () => {
  const base = { percent: "10", effectiveDate: TODAY, currentSalary: 20000, joinDate: "2020-01-01" };

  it("a good form has a projection and nothing to say", () => {
    const c = checkIncrement(base, TODAY);
    expect(c.errors).toEqual([]);
    expect(c.warnings).toEqual([]);
    expect(c.projection).toEqual({ newSalary: 22000, increase: 2000 });
  });

  it("explains a missing or bad percentage and gives no projection", () => {
    expect(checkIncrement({ ...base, percent: "" }, TODAY)).toMatchObject({
      errors: ["Enter the increment percentage."],
      projection: null,
    });
    expect(checkIncrement({ ...base, percent: "0" }, TODAY).errors).toEqual(["The percentage must be more than 0."]);
    expect(checkIncrement({ ...base, percent: "900" }, TODAY).projection).toBeNull();
  });

  it("refuses an employee with no salary, as the server does", () => {
    const c = checkIncrement({ ...base, currentSalary: 0 }, TODAY);
    expect(c.errors[0]).toContain("no base salary");
    expect(c.projection).toBeNull();
  });

  it("needs a real effective date", () => {
    expect(checkIncrement({ ...base, effectiveDate: "" }, TODAY).errors).toEqual(["Pick the effective date."]);
  });

  it("warns, without stopping, about large, recent, back-dated and future increments", () => {
    expect(checkIncrement({ ...base, percent: "35" }, TODAY).warnings[0]).toContain("large increase");
    const recent = checkIncrement(base, TODAY, { date: "2026-08-20", percent: 7 });
    expect(recent.errors).toEqual([]);
    expect(recent.warnings).toEqual(["Their last increment (7%) was only 1 month ago."]);
    expect(checkIncrement(base, TODAY, { date: "2026-10-05", percent: 7 }).warnings[0]).toContain("this month");
    expect(
      checkIncrement({ ...base, effectiveDate: "2026-01-01" }, TODAY, { date: "2026-03-01", percent: 7 }).warnings,
    ).toContain("The effective date is earlier than their last increment.");
    expect(checkIncrement({ ...base, effectiveDate: "2019-01-01" }, TODAY).warnings).toEqual([
      "The effective date is before their joining date.",
    ]);
    expect(checkIncrement({ ...base, effectiveDate: "2026-12-01" }, TODAY).warnings[0]).toContain("in the future");
  });
});

describe("salaryPath", () => {
  it("lists one employee's increments newest first with the amount of each", () => {
    const path = salaryPath(rows.filter((r) => r.employeeId === 1));
    expect(path.map((s) => s.id)).toEqual([3, 1]);
    expect(path[0]).toMatchObject({ from: 22000, to: 25300, percent: 15, amount: 3300 });
  });
});
