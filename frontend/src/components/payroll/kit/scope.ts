import { PAY_CYCLE_INFO, type PayrollKind, type PayrollScope } from "@/lib/api-client/custom-hooks";
import { monthYear, periodLabel } from "./format";

// The words of a payroll screen shared by Staff Payroll (one month) and the Production Payroll cycle pages (one pay
// period): what the period is called, and the nouns the sentences use.

/** What the page calls its period before the server answers: "November 2026" / "Weekly 2 Feb - 8 Feb 2026". */
export function scopeLabel(scope: PayrollScope): string {
  if (scope.kind === "staff") return monthYear(scope.month, scope.year);
  return `${PAY_CYCLE_INFO[scope.cycle]?.label ?? scope.cycle} ${periodLabel(scope.periodStart, scope.periodEnd)}`;
}

/** A stable key of the month / period (a new one starts with nothing picked). */
export const scopeKey = (scope: PayrollScope): string =>
  scope.kind === "staff"
    ? `staff:${scope.month}/${scope.year}`
    : `${scope.cycle}:${scope.periodStart}_${scope.periodEnd}`;

/** "month" (staff) or "period" (production), for the sentences. */
export const periodNoun = (kind: PayrollKind): string => (kind === "production" ? "period" : "month");

/** "staff employee" / "production employee", for the counts. */
export const employeeNoun = (kind: PayrollKind): string =>
  kind === "production" ? "production employee" : "staff employee";

/** The permission key of a payroll's Payroll tab (a role without it gets no link to it, nor to a details page). */
export const payrollTabKey = (kind: PayrollKind): string =>
  kind === "production" ? "production_payroll.payroll" : "payroll";

/** The permission key of a payroll's Generate button. */
export const generateKey = (kind: PayrollKind): string =>
  kind === "production" ? "production_payroll.generate" : "payroll.generate";
