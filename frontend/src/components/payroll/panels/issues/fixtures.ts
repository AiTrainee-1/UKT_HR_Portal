import type { IssueCodeCount, PayrollIssue, PayrollIssuesResponse, PayrollScope } from "@/lib/api-client/custom-hooks";
import { ISSUE_META } from "@/components/payroll/kit/issue-meta";
import type { SkippedItem } from "../skipped/skipped-types";

// A small, realistic October 2026 of Staff Payroll: three employees, eleven issues (4 on 13-20 Oct and 5 about the
// whole period), used by the logic tests and the render tests of the panels.

export const STAFF_SCOPE: PayrollScope = { kind: "staff", month: 10, year: 2026 };
export const PRODUCTION_SCOPE: PayrollScope = {
  kind: "production",
  cycle: "weekly",
  periodStart: "2026-10-05",
  periodEnd: "2026-10-11",
};

/** When payroll computed (and so flagged) everything. */
export const DETECTED_AT = "2026-10-13T05:12:00+05:30";

/** The employee part of an issue. */
export type Person = Pick<
  PayrollIssue,
  "employeeId" | "employeeCode" | "employeeName" | "department" | "designation" | "payrollId"
>;

export const ASHA: Person = {
  employeeId: 11,
  employeeCode: "PC-S1",
  employeeName: "Asha Worker",
  department: "Weaving",
  designation: "Weaver",
  payrollId: 101,
};
export const BALA: Person = {
  employeeId: 12,
  employeeCode: "PC-S2",
  employeeName: "Bala Kumar",
  department: "Stitching",
  designation: "Tailor",
  payrollId: 102,
};
export const CHITRA: Person = {
  employeeId: 13,
  employeeCode: "PC-S3",
  employeeName: "Chitra Devi",
  department: "Weaving",
  designation: "Weaver",
  payrollId: 103,
};

/** One issue, with the severity, category and title its code has in the kit unless told otherwise. */
export function makeIssue(
  who: Person,
  code: PayrollIssue["code"],
  date: string | null,
  over: Partial<PayrollIssue> = {},
): PayrollIssue {
  const meta = ISSUE_META[code];
  return {
    id: `${who.payrollId}:${code}:${date ?? "period"}`,
    ...who,
    code,
    category: meta.category,
    severity: meta.severity,
    title: meta.label,
    detail: `Detail of ${meta.label.toLowerCase()}`,
    date,
    detectedAt: DETECTED_AT,
    impact: null,
    rule: null,
    ...over,
  };
}

export const LATE_RULE = { label: "Late allowance", settingsPath: "/hr/settings?tab=late_detection#free-allowance" };

export const ISSUES: PayrollIssue[] = [
  makeIssue(ASHA, "late_in", "2026-10-13", {
    detail: "First punch 09:42, after General 09:00 + 10 min grace (09:10)",
    impact: { days: 0.25 },
    rule: LATE_RULE,
  }),
  // The two absences are marked critical for the tests only (the real catalogue calls an absence "warning"): the panel's
  // ordering and counts need a critical issue to be worth testing, and none of the other staff codes is critical.
  makeIssue(ASHA, "absent", "2026-10-14", {
    detail: "No punches recorded and no approved leave",
    severity: "critical",
    impact: { days: 1, amount: 1134.62 },
  }),
  makeIssue(ASHA, "late_penalty", null, {
    detail: "4 late arrivals: 3 free, 1 charged",
    impact: { amount: 300 },
    rule: { label: "Late deduction slabs", settingsPath: "/hr/settings?tab=late_detection#deduction-slabs" },
  }),
  makeIssue(ASHA, "ot_pay", null, {
    detail: "6 overtime hours at ₹200",
    impact: { amount: 1200, label: "Added to pay" },
  }),
  makeIssue(BALA, "absent", "2026-10-13", {
    detail: "No punches recorded and no approved leave",
    severity: "critical",
    impact: { days: 1, amount: 900 },
  }),
  makeIssue(BALA, "half_day", "2026-10-20", {
    detail: "Worked 4h 10m of a 9h shift",
    impact: { days: 0.5, amount: 450 },
  }),
  makeIssue(BALA, "bank_missing", null, { detail: "No bank account number on the profile" }),
  makeIssue(BALA, "no_shift", null, {
    detail: "No shift is assigned for this month",
    rule: { label: "Shift assignment", settingsPath: null },
  }),
  makeIssue(CHITRA, "missing_punch", "2026-10-13", { detail: "Punched in at 09:01, never punched out" }),
  makeIssue(CHITRA, "unpaid_leave", "2026-10-15", {
    detail: "Leave without pay approved",
    impact: { days: 1, amount: 800 },
  }),
  makeIssue(CHITRA, "pf_number_missing", null, { detail: "No PF number on the profile" }),
];

/** What the server's summary would say about a list of issues. */
export function summaryOf(issues: PayrollIssue[], employees = 3): PayrollIssuesResponse["summary"] {
  const byCode = new Map<string, IssueCodeCount>();
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const people = new Set<number>();
  const departments = new Map<string, number>();
  for (const i of issues) {
    bySeverity[i.severity] += 1;
    people.add(i.employeeId);
    const entry = byCode.get(i.code);
    if (entry) entry.count += 1;
    else byCode.set(i.code, { code: i.code, label: i.title, severity: i.severity, category: i.category, count: 1 });
    departments.set(i.department ?? "No department", (departments.get(i.department ?? "No department") ?? 0) + 1);
  }
  return {
    employees,
    employeesWithIssues: people.size,
    total: issues.length,
    bySeverity,
    byCode: [...byCode.values()],
    byDepartment: [...departments].map(([department, count]) => ({ department, count })),
  };
}

export const STAFF_PERIOD: PayrollIssuesResponse["scope"] = {
  label: "October 2026",
  start: "2026-10-01",
  end: "2026-10-31",
  month: 10,
  year: 2026,
  days: 31,
  cycle: null,
  cycleLabel: null,
};

export function makeResponse(
  issues: PayrollIssue[] = ISSUES,
  over: Partial<PayrollIssuesResponse> = {},
): PayrollIssuesResponse {
  return { scope: STAFF_PERIOD, detectedAt: DETECTED_AT, summary: summaryOf(issues), issues, ...over };
}

/** Employees payroll could not generate for. */
export const SKIPPED: SkippedItem[] = [
  {
    employeeId: 21,
    employeeCode: "PC-S9",
    name: "Divya Nair",
    reason: "No Salary Amount set on this employee's profile",
    department: "Accounts",
  },
  {
    employeeId: 22,
    employeeCode: "PC-S10",
    name: "Esha Roy",
    reason:
      "No working days found in 10/2026 for this employee's shift (check Holidays and Saturday-off configuration)",
  },
];

/** `n` day issues spread over the period for `n` different people, for the pagination tests. */
export function manyIssues(n: number): PayrollIssue[] {
  return Array.from({ length: n }, (_, i) =>
    makeIssue(
      {
        employeeId: 1000 + i,
        employeeCode: `E${String(i + 1).padStart(3, "0")}`,
        employeeName: `Worker ${String(i + 1).padStart(3, "0")}`,
        department: i % 2 === 0 ? "Weaving" : "Stitching",
        designation: "Operator",
        payrollId: 5000 + i,
      },
      "late_in",
      `2026-10-${String((i % 28) + 1).padStart(2, "0")}`,
      { detail: `Late by ${i + 1} minutes` },
    ),
  );
}
