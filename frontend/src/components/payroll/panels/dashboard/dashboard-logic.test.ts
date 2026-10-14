import { describe, expect, it } from "vitest";
import type { PayrollIssuesSummary, PayrollRunItem } from "@/lib/api-client/custom-hooks";
import {
  byDepartment,
  departmentTotals,
  issueBars,
  issueSplitText,
  paymentSplit,
  percentText,
  summarizeRuns,
  worstSeverity,
} from "./dashboard-logic";

const run = (id: number, employeeId: number, over: Partial<PayrollRunItem> = {}): PayrollRunItem => ({
  id,
  employeeId,
  employeeName: `Employee ${employeeId}`,
  employeeCode: `E${employeeId}`,
  departmentId: 1,
  departmentName: "Weaving",
  salaryMode: "monthly",
  month: 10,
  year: 2026,
  totalWorkingDays: 26,
  presentDays: 26,
  absentDays: 0,
  otHours: 0,
  otAmount: 0,
  baseSalary: 10000,
  grossSalary: 10000,
  deductions: 1000,
  bonus: 0,
  finalSalary: 9000,
  status: "pending",
  ...over,
});

describe("summarizeRuns", () => {
  it("is all zeros for nothing, null or undefined", () => {
    for (const input of [[], null, undefined]) {
      const s = summarizeRuns(input);
      expect(s).toEqual({
        records: 0,
        employees: 0,
        gross: 0,
        deductions: 0,
        bonus: 0,
        net: 0,
        paid: { records: 0, employees: 0, net: 0 },
        pending: { records: 0, employees: 0, net: 0 },
      });
    }
  });

  it("adds gross, deductions, bonus and net, and splits paid from pending", () => {
    const s = summarizeRuns([
      run(1, 1, { grossSalary: 30000, deductions: 2000, bonus: 500, finalSalary: 28500, status: "paid" }),
      run(2, 2, { grossSalary: 20000, deductions: 0, finalSalary: 20000 }),
      run(3, 3, { grossSalary: 10000, deductions: 1000, finalSalary: 9000 }),
    ]);
    expect(s.records).toBe(3);
    expect(s.employees).toBe(3);
    expect(s.gross).toBe(60000);
    expect(s.deductions).toBe(3000);
    expect(s.bonus).toBe(500);
    expect(s.net).toBe(57500);
    expect(s.paid).toEqual({ records: 1, employees: 1, net: 28500 });
    expect(s.pending).toEqual({ records: 2, employees: 2, net: 29000 });
  });

  it("counts a person once however many rows they have, per group too", () => {
    const s = summarizeRuns([
      run(1, 7, { status: "paid" }),
      run(2, 7, { status: "pending" }),
      run(3, 7, { status: "pending" }),
      run(4, 8),
    ]);
    expect(s.records).toBe(4);
    expect(s.employees).toBe(2);
    expect(s.paid.employees).toBe(1);
    expect(s.pending.employees).toBe(2); // 7 (still has pending rows) and 8
    expect(s.pending.records).toBe(3);
  });

  it("treats any status other than paid as still to be released", () => {
    const s = summarizeRuns([run(1, 1, { status: "draft" }), run(2, 2, { status: "approved" })]);
    expect(s.paid.records).toBe(0);
    expect(s.pending.records).toBe(2);
  });

  it("does not leave floating-point dust in the totals", () => {
    const s = summarizeRuns([run(1, 1, { finalSalary: 0.1 }), run(2, 2, { finalSalary: 0.2 })]);
    expect(s.net).toBe(0.3);
    expect(s.pending.net).toBe(0.3);
  });

  it("reads a number sent as text, and ignores a value that is not a number", () => {
    const s = summarizeRuns([
      run(1, 1, { grossSalary: "1500.50" as unknown as number, finalSalary: "1500.50" as unknown as number }),
      run(2, 2, { grossSalary: undefined as unknown as number, finalSalary: null as unknown as number }),
    ]);
    expect(s.gross).toBe(1500.5);
    expect(s.net).toBe(1500.5);
  });
});

describe("departmentTotals and byDepartment", () => {
  const dept = (id: number | null, name: string | null, employeeId: number, net: number) =>
    run(employeeId * 10 + (id ?? 0), employeeId, { departmentId: id, departmentName: name, finalSalary: net });

  it("groups by department, biggest net first, with each department's share of the whole", () => {
    const rows = departmentTotals([
      dept(1, "Weaving", 1, 3000),
      dept(2, "Stitching", 2, 6000),
      dept(1, "Weaving", 3, 1000),
    ]);
    expect(rows.map((r) => [r.label, r.net, r.employees, r.records])).toEqual([
      ["Stitching", 6000, 1, 1],
      ["Weaving", 4000, 2, 2],
    ]);
    expect(rows[0].share).toBeCloseTo(0.6);
    expect(rows[1].share).toBeCloseTo(0.4);
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
  });

  it("breaks a tie by name so the order is stable", () => {
    const rows = departmentTotals([dept(2, "Zeta", 1, 500), dept(1, "Alpha", 2, 500)]);
    expect(rows.map((r) => r.label)).toEqual(["Alpha", "Zeta"]);
  });

  it("puts rows with no department together as 'No department'", () => {
    const rows = departmentTotals([dept(null, null, 1, 100), dept(null, "", 2, 200), dept(1, "Weaving", 3, 50)]);
    expect(rows.map((r) => [r.key, r.label, r.net])).toEqual([
      ["none", "No department", 300],
      ["id:1", "Weaving", 50],
    ]);
  });

  it("groups by name when a row has no department id", () => {
    const rows = departmentTotals([dept(null, "Packing", 1, 100), dept(null, "packing", 2, 100)]);
    expect(rows).toHaveLength(1);
    expect(rows[0].employees).toBe(2);
  });

  it("has no share when nothing is payable", () => {
    const rows = departmentTotals([dept(1, "Weaving", 1, 0)]);
    expect(rows[0].share).toBe(0);
  });

  it("is empty for nothing", () => {
    expect(departmentTotals([])).toEqual([]);
    expect(byDepartment(undefined)).toEqual([]);
  });

  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => dept(i + 1, `Dept ${i + 1}`, i + 1, (count - i) * 1000));

  it("shows up to 7 departments by name (an 'Others' of one is no saving)", () => {
    expect(byDepartment(many(6))).toHaveLength(6);
    const seven = byDepartment(many(7));
    expect(seven).toHaveLength(7);
    expect(seven.some((r) => r.others)).toBe(false);
  });

  it("folds everything below the top 6 into one Others row", () => {
    const rows = byDepartment(many(9));
    expect(rows).toHaveLength(7);
    expect(rows.slice(0, 6).map((r) => r.label)).toEqual(["Dept 1", "Dept 2", "Dept 3", "Dept 4", "Dept 5", "Dept 6"]);
    const others = rows[6];
    expect(others).toMatchObject({ key: "others", label: "Others", others: true, departments: 3 });
    expect(others.net).toBe(3000 + 2000 + 1000);
    expect(others.records).toBe(3);
    expect(others.employees).toBe(3);
    expect(rows.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1);
  });

  it("counts the people of the folded departments once", () => {
    const rows = byDepartment(
      [
        ...many(8),
        // the same person (employee 8) also has a row in department 7, both folded into Others
        run(9999, 8, { departmentId: 7, departmentName: "Dept 7", finalSalary: 10 }),
      ],
      6,
    );
    expect(rows.at(-1)).toMatchObject({ others: true, departments: 2 });
    expect(rows.at(-1)!.employees).toBe(2); // employees 7 and 8, not 3
    expect(rows.at(-1)!.records).toBe(3);
  });

  it("honours another limit", () => {
    const rows = byDepartment(many(5), 2);
    expect(rows.map((r) => r.label)).toEqual(["Dept 1", "Dept 2", "Others"]);
    expect(rows[2].departments).toBe(3);
  });
});

describe("paymentSplit", () => {
  it("sizes paid and pending by rupees", () => {
    const split = paymentSplit([run(1, 1, { finalSalary: 7500, status: "paid" }), run(2, 2, { finalSalary: 2500 })]);
    expect(split.net).toBe(10000);
    expect(split.paid.share).toBeCloseTo(0.75);
    expect(split.pending.share).toBeCloseTo(0.25);
    expect(split.paidPercent).toBe(75);
    expect(split.paid).toMatchObject({ records: 1, employees: 1, net: 7500 });
    expect(split.pending).toMatchObject({ records: 1, employees: 1, net: 2500 });
  });

  it("falls back to the number of rows when there are no rupees", () => {
    const split = paymentSplit([
      run(1, 1, { finalSalary: 0, status: "paid" }),
      run(2, 2, { finalSalary: 0 }),
      run(3, 3, { finalSalary: 0 }),
      run(4, 4, { finalSalary: 0 }),
    ]);
    expect(split.paid.share).toBeCloseTo(0.25);
    expect(split.paidPercent).toBe(25);
  });

  it("is zero for nothing", () => {
    const split = paymentSplit([]);
    expect(split.paidPercent).toBe(0);
    expect(split.paid.share).toBe(0);
    expect(split.pending.share).toBe(0);
    expect(split.records).toBe(0);
  });

  it("is 100% only when nothing is pending, and 0% only when nothing is paid", () => {
    expect(paymentSplit([run(1, 1, { status: "paid" })]).paidPercent).toBe(100);
    expect(paymentSplit([run(1, 1)]).paidPercent).toBe(0);
    // 99.6% paid by rupees, one small row still pending: never rounds up to a falsely complete 100
    const almost = paymentSplit([run(1, 1, { finalSalary: 99600, status: "paid" }), run(2, 2, { finalSalary: 400 })]);
    expect(almost.paidPercent).toBe(99);
    // a tiny paid row among a big pending one never reads 0%
    const barely = paymentSplit([run(1, 1, { finalSalary: 1, status: "paid" }), run(2, 2, { finalSalary: 99999 })]);
    expect(barely.paidPercent).toBe(1);
  });
});

describe("issueBars", () => {
  const byCode: PayrollIssuesSummary["byCode"] = [
    { code: "late_in", label: "Late arrival", severity: "warning", category: "attendance", count: 12 },
    { code: "absent", label: "Absent", severity: "critical", category: "attendance", count: 12 },
    { code: "ot_pay", label: "Overtime pay", severity: "info", category: "pay", count: 3 },
    { code: "bank_missing", label: "Bank details missing", severity: "warning", category: "profile", count: 0 },
  ];

  it("lists the most frequent first, the worse severity first on a tie, and drops zero counts", () => {
    const { bars, hidden } = issueBars({ byCode });
    expect(bars.map((b) => b.code)).toEqual(["absent", "late_in", "ot_pay"]);
    expect(hidden).toBe(0);
  });

  it("sizes the bars against the biggest", () => {
    const { bars } = issueBars({ byCode });
    expect(bars.map((b) => b.share)).toEqual([1, 1, 0.25]);
  });

  it("keeps the top few and says how many are left out", () => {
    const { bars, hidden } = issueBars({ byCode }, 2);
    expect(bars).toHaveLength(2);
    expect(hidden).toBe(1);
  });

  it("is empty without a summary", () => {
    expect(issueBars(undefined)).toEqual({ bars: [], hidden: 0 });
    expect(issueBars(null)).toEqual({ bars: [], hidden: 0 });
    expect(issueBars({ byCode: [] })).toEqual({ bars: [], hidden: 0 });
  });
});

describe("issue wording", () => {
  it("splits the severities into one line and leaves zeros out", () => {
    expect(issueSplitText({ critical: 3, warning: 12, info: 5 })).toBe("3 critical · 12 need a look · 5 info");
    expect(issueSplitText({ critical: 0, warning: 2, info: 0 })).toBe("2 need a look");
    expect(issueSplitText({ critical: 0, warning: 0, info: 0 })).toBe("Nothing flagged");
    expect(issueSplitText(undefined)).toBe("Nothing flagged");
  });

  it("finds the worst severity present", () => {
    expect(worstSeverity({ critical: 1, warning: 5, info: 9 })).toBe("critical");
    expect(worstSeverity({ critical: 0, warning: 5, info: 9 })).toBe("warning");
    expect(worstSeverity({ critical: 0, warning: 0, info: 9 })).toBe("info");
    expect(worstSeverity({ critical: 0, warning: 0, info: 0 })).toBeNull();
    expect(worstSeverity(undefined)).toBeNull();
  });

  it("writes a share as a whole percent, never 0% for something real", () => {
    expect(percentText(0.4)).toBe("40%");
    expect(percentText(1)).toBe("100%");
    expect(percentText(0.004)).toBe("<1%");
    expect(percentText(0)).toBe("0%");
    expect(percentText(Number.NaN)).toBe("0%");
  });
});
