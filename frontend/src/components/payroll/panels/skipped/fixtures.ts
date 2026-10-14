import type { SkipCategory, SkippedItem } from "./skipped-types";

/**
 * Every skip reason the backend produces (backend/api/payroll_views.py `PayrollSkip(...)`, production_payroll_views.py
 * `_classify` / `_select` / the roster's blockedReason) with the category it must be classified as.
 */
export const REAL_REASONS: { reason: string; category: SkipCategory; kind: "staff" | "production" }[] = [
  { reason: "No Salary Amount set on this employee's profile", category: "no_salary", kind: "staff" },
  {
    reason:
      "No working days found in 10/2026 for this employee's shift (check Holidays and Saturday-off configuration)",
    category: "no_working_days",
    kind: "staff",
  },
  { reason: "No Salary Per Shift set on this employee's profile", category: "no_rate", kind: "production" },
  { reason: "Already paid for this period.", category: "already_paid", kind: "production" },
  {
    reason: "Overlaps the payroll already generated for 2026-02-01 to 2026-02-14.",
    category: "overlap",
    kind: "production",
  },
  { reason: "Not a production employee in your scope.", category: "not_production", kind: "production" },
  { reason: "Not an active employee.", category: "inactive", kind: "production" },
  { reason: "Not assigned to the Weekly cycle (assigned to BiWeekly).", category: "wrong_cycle", kind: "production" },
  { reason: "Not assigned to the Weekly cycle (assigned to Monthly).", category: "wrong_cycle", kind: "production" },
  { reason: "Not assigned to the BiWeekly cycle (assigned to Weekly).", category: "wrong_cycle", kind: "production" },
  { reason: "Not assigned to the Weekly cycle (assigned to no pay cycle).", category: "no_cycle", kind: "production" },
  // an unexpected engine failure reads as the exception's own text
  { reason: "division by zero", category: "other", kind: "staff" },
  { reason: "[<class 'decimal.ConversionSyntax'>]", category: "other", kind: "production" },
];

/** A production Weekly period's skipped employees: two without a rate, an overlap, a wrong cycle, a paid one and a stranger. */
export const PRODUCTION_SKIPPED: SkippedItem[] = [
  {
    employeeId: 41,
    employeeCode: "PW-1",
    name: "Ravi Kumar",
    reason: "No Salary Per Shift set on this employee's profile",
    department: "Weaving",
  },
  {
    employeeId: 42,
    employeeCode: "PW-2",
    name: "Mani Selvam",
    reason: "No Salary Per Shift set on this employee's profile",
    department: "Weaving",
  },
  {
    employeeId: 43,
    employeeCode: "PW-3",
    name: "Selvi Rani",
    reason: "Overlaps the payroll already generated for 2026-02-01 to 2026-02-14.",
    department: "Stitching",
  },
  {
    employeeId: 44,
    employeeCode: "PW-4",
    name: "Kumar Raj",
    reason: "Not assigned to the Weekly cycle (assigned to BiWeekly).",
    department: "Cutting",
  },
  {
    employeeId: 45,
    employeeCode: "PW-5",
    name: "Lakshmi Devi",
    reason: "Already paid for this period.",
    department: "Weaving",
  },
  { employeeId: 46, employeeCode: "PW-6", name: "Mystery Worker", reason: "division by zero", department: null },
];

/** `n` employees with no salary, for the pagination test. */
export function manySkipped(n: number): SkippedItem[] {
  return Array.from({ length: n }, (_, i) => ({
    employeeId: 900 + i,
    employeeCode: `S${String(i + 1).padStart(3, "0")}`,
    name: `Skipped ${String(i + 1).padStart(3, "0")}`,
    reason: "No Salary Amount set on this employee's profile",
    department: "Accounts",
  }));
}
