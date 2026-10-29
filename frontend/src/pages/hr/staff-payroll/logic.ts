import type { PayrollRunItem } from "@/lib/api-client";
import type { PayrollScope } from "@/lib/api-client/custom-hooks";
import { monthYear } from "@/components/payroll/kit/format";
import { payStatusLabel } from "@/components/payroll/kit/pay-status";
import type { TableColumn } from "@/components/payroll/kit/export-table";
import { STATEMENT_URL_DEFAULTS } from "@/components/payroll/kit/statement-url";
import { FILTER_URL_DEFAULTS } from "@/components/payroll/panels/filters";
import { DEFAULT_ISSUE_FILTERS, sanitizeFilters, type IssueFilterState } from "@/components/payroll/panels/issues";

// The state of the Staff Payroll page. It lives in the address (?tab=salary&month=10&year=2026&q=asha) so a reload, a
// shared link and Back from a payroll's details page all land on the same view.

export type StaffTab = "payroll" | "salary" | "payslip";
export type StaffView = "records" | "issues" | "skipped" | "rules";

export const STAFF_TABS: readonly StaffTab[] = ["payroll", "salary", "payslip"];
export const STAFF_VIEWS: readonly StaffView[] = ["records", "issues", "skipped", "rules"];

/** The Issues view's own filters in the address: prefixed, so they never collide with the records' filters (q, dept ...). */
export const ISSUE_URL_DEFAULTS = {
  iq: "",
  icode: "",
  isev: "",
  idept: "",
  ifrom: "",
  ito: "",
  igroup: DEFAULT_ISSUE_FILTERS.groupBy,
} as const;

/**
 * Every key the page keeps in its address, with its default (a value equal to its default is left out of the address).
 * `month` / `year` empty = the current month and year (resolved when the page renders, never frozen in a constant).
 */
export const STAFF_URL_DEFAULTS: Record<string, string> = {
  tab: "payroll",
  view: "records",
  month: "",
  year: "",
  layout: "table",
  /** The department whose records are open on the Payroll tab (empty = the first department). */
  pdept: "",
  ...FILTER_URL_DEFAULTS,
  ...ISSUE_URL_DEFAULTS,
  ...STATEMENT_URL_DEFAULTS,
};

export const isStaffTab = (v: string): v is StaffTab => (STAFF_TABS as readonly string[]).includes(v);
export const isStaffView = (v: string): v is StaffView => (STAFF_VIEWS as readonly string[]).includes(v);

export function resolvePeriod(
  values: { month?: string; year?: string },
  today: Date = new Date(),
): { month: number; year: number } {
  const month = Number(values.month);
  const year = Number(values.year);
  return {
    month: Number.isInteger(month) && month >= 1 && month <= 12 ? month : today.getMonth() + 1,
    year: Number.isInteger(year) && year >= 2000 && year <= 2100 ? year : today.getFullYear(),
  };
}

/** The month before / after, rolling the year. */
export function shiftMonth(p: { month: number; year: number }, by: number): { month: number; year: number } {
  const index = p.year * 12 + (p.month - 1) + by;
  return { month: (index % 12) + 1, year: Math.floor(index / 12) };
}

export const staffScope = (p: { month: number; year: number }): PayrollScope => ({
  kind: "staff",
  month: p.month,
  year: p.year,
});

export const staffPeriodLabel = (p: { month: number; year: number }): string => monthYear(p.month, p.year);

/** This page lists Staff payroll only: Production payroll has its own pages. */
export const onlyStaff = (runs: PayrollRunItem[] | undefined): PayrollRunItem[] =>
  (runs ?? []).filter((r) => r.salaryMode === "monthly");

/** Years offered in the period selects: two back, one ahead of the current year. */
export function yearOptions(current: number): number[] {
  return [current - 2, current - 1, current, current + 1];
}

/** How many of a month's payrolls already exist, and how many of those are paid (the Generate dialog warns about both). */
export function existingPayroll(runs: PayrollRunItem[] | undefined): { total: number; paid: number; pending: number } {
  const staff = onlyStaff(runs);
  const paid = staff.filter((r) => r.status === "paid").length;
  return { total: staff.length, paid, pending: staff.length - paid };
}

// ── The Issues view's filters <-> the address ─────────────────────────────────

export function issueFiltersFromUrl(values: Partial<Record<string, string | null | undefined>>): IssueFilterState {
  return sanitizeFilters({
    q: values.iq ?? "",
    code: values.icode ?? "",
    severity: (values.isev ?? "") as IssueFilterState["severity"],
    dept: values.idept ?? "",
    from: values.ifrom ?? "",
    to: values.ito ?? "",
    groupBy: (values.igroup || DEFAULT_ISSUE_FILTERS.groupBy) as IssueFilterState["groupBy"],
  });
}

export function issueFiltersToUrl(
  patch: Partial<IssueFilterState>,
): Partial<Record<keyof typeof ISSUE_URL_DEFAULTS, string>> {
  const out: Partial<Record<keyof typeof ISSUE_URL_DEFAULTS, string>> = {};
  if (patch.q !== undefined) out.iq = patch.q;
  if (patch.code !== undefined) out.icode = patch.code;
  if (patch.severity !== undefined) out.isev = patch.severity;
  if (patch.dept !== undefined) out.idept = patch.dept;
  if (patch.from !== undefined) out.ifrom = patch.from;
  if (patch.to !== undefined) out.ito = patch.to;
  if (patch.groupBy !== undefined) out.igroup = patch.groupBy;
  return out;
}

// ── Salary Payroll Statement (the Export menu on the Payroll tab) ─────────────

/** The Report Center report the Export menu downloads: the printed Salary Statement of HR Reports. */
export const STATEMENT_REPORT_ID = "hr-salary-statement";

/**
 * The report's filters for the month on the page: `period` ("2026-10") and, when the page is showing only Cleared or only
 * Pending payments, the same payment status. The statement itself lists every department, each with its sub total.
 */
export function statementQuery(p: { month: number; year: number }, status: string = "all"): URLSearchParams {
  const query = new URLSearchParams({ period: `${p.year}-${String(p.month).padStart(2, "0")}` });
  if (status === "paid" || status === "pending") query.set("paymentStatus", status);
  return query;
}

// ── Payroll register (the Export menu on the Payroll tab) ─────────────────────

export const REGISTER_COLUMNS: TableColumn<PayrollRunItem>[] = [
  { key: "employeeCode", label: "Employee code", width: 14 },
  { key: "employeeName", label: "Employee", width: 28 },
  { key: "departmentName", label: "Department", width: 22 },
  { key: "period", label: "Period", width: 14, value: (r) => `${r.month}/${r.year}` },
  { key: "totalWorkingDays", label: "Working days", width: 13, type: "int" },
  { key: "presentDays", label: "Present days", width: 13, type: "money" },
  { key: "absentDays", label: "Absent days", width: 13, type: "money" },
  { key: "baseSalary", label: "Monthly salary", width: 15, type: "money" },
  { key: "otAmount", label: "Overtime", width: 13, type: "money" },
  { key: "grossSalary", label: "Gross earned", width: 15, type: "money" },
  { key: "bonus", label: "Bonus", width: 12, type: "money" },
  { key: "deductions", label: "Deductions", width: 14, type: "money" },
  { key: "finalSalary", label: "Net payable", width: 15, type: "money" },
  { key: "status", label: "Status", width: 11, value: (r) => payStatusLabel(r.status) },
  { key: "notes", label: "Notes", width: 50 },
];
