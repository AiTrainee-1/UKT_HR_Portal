// Payroll insights: the read-only data behind the redesigned Staff Payroll and Production Payroll pages -a payroll's
// full details page, the issues payroll detected, the rules in force, and the Salary Statement. Backend:
// api/payroll_insights.py (+ _views), api/payroll_statement_views.py. Everything here is READ-ONLY: it explains what the
// payroll engine already decided from the stored breakdowns and never recomputes or writes a payroll.
import { useQuery } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { DayCompensationMarker } from "./attendance";
import type { PayCycle } from "./production-cycles";

// ── Which payroll ─────────────────────────────────────────────────────────────

export type PayrollKind = "staff" | "production";

/** The slice of payroll a screen is about: one month of staff payroll, or one period of one production pay cycle. */
export type PayrollScope =
  | { kind: "staff"; month: number; year: number }
  | { kind: "production"; cycle: PayCycle; periodStart: string; periodEnd: string };

/** Optional narrowing every list endpoint accepts. */
export type PayrollListFilters = { departmentId?: number; employeeId?: number; branchId?: number };

/** The API base of a kind: staff is under /api/payroll (module "payroll"), production under /api/payroll/production
 *  (module "production_payroll"), so each role only reaches its own data. */
export const payrollApiBase = (kind: PayrollKind): string =>
  kind === "production" ? "/api/payroll/production" : "/api/payroll";

export function scopeQuery(scope: PayrollScope, filters?: PayrollListFilters): string {
  const qs = new URLSearchParams();
  if (scope.kind === "staff") {
    qs.set("month", String(scope.month));
    qs.set("year", String(scope.year));
  } else {
    qs.set("cycle", scope.cycle);
    qs.set("periodStart", scope.periodStart);
    qs.set("periodEnd", scope.periodEnd);
  }
  if (filters?.departmentId) qs.set("departmentId", String(filters.departmentId));
  if (filters?.employeeId) qs.set("employeeId", String(filters.employeeId));
  if (filters?.branchId) qs.set("branchId", String(filters.branchId));
  return qs.toString();
}

/** What the period is called on screen: "October 2026" for staff, "2 Feb - 8 Feb 2026" for a production period. */
export type PayrollPeriodInfo = {
  label: string;
  start: string; // ISO date
  end: string; // ISO date
  month: number;
  year: number;
  days: number;
  cycle: PayCycle | null;
  cycleLabel: string | null;
};

// ── Issues ────────────────────────────────────────────────────────────────────

export type IssueSeverity = "critical" | "warning" | "info";
export type IssueCategory = "attendance" | "pay" | "profile" | "rule" | "generation";

/**
 * Every kind of issue payroll can detect. The first block comes from a day's attendance, the second from the month /
 * period as a whole, the third from the employee's profile; "skipped" is added by the screens themselves for an
 * employee payroll could not generate for (it has no payroll row, so the issues endpoint never returns it).
 */
export type IssueCode =
  | "absent"
  | "unpaid_leave"
  | "late_in"
  | "early_out"
  | "half_day"
  | "quarter_day"
  | "missing_punch"
  | "no_attendance"
  | "no_shift"
  | "late_penalty"
  | "excess_permission"
  | "advance_recovery"
  | "ot_pay"
  | "adjustment"
  | "bank_missing"
  | "pf_number_missing"
  | "esi_number_missing"
  | "skipped";

export type PayrollIssue = {
  /** Stable within a response: `${payrollId}:${code}:${date ?? "period"}`. */
  id: string;
  payrollId: number | null;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  code: IssueCode;
  category: IssueCategory;
  severity: IssueSeverity;
  /** Short name: "Late arrival", "Absent", "No shift assigned". */
  title: string;
  /** The specifics: "First punch 09:42, after General 09:00 + 10 min grace (09:10)". */
  detail: string;
  /** The day it was detected on (an attendance date, ISO); null for an issue about the whole period. */
  date: string | null;
  /** When payroll flagged it: the time the payroll was last computed (ISO datetime). */
  detectedAt: string | null;
  /** What it cost, when it costs anything: days of pay, shifts, rupees. */
  impact: { days?: number; shifts?: number; amount?: number; label?: string } | null;
  /** The rule that fired it and where HR changes that rule. */
  rule: { label: string; settingsPath: string | null } | null;
  /** Raw facts behind it (punch times, counts), for the details screens. */
  facts?: Record<string, string | number | boolean | null>;
};

export type IssueCodeCount = {
  code: IssueCode;
  label: string;
  severity: IssueSeverity;
  category: IssueCategory;
  count: number;
};

export type PayrollIssuesSummary = {
  employees: number; // payrolls in the scope
  employeesWithIssues: number;
  total: number;
  bySeverity: Record<IssueSeverity, number>;
  byCode: IssueCodeCount[];
  byDepartment: { department: string; count: number }[];
};

export type PayrollIssuesResponse = {
  scope: PayrollPeriodInfo;
  /** The time the newest payroll in the scope was computed (ISO), the moment its issues were flagged. */
  detectedAt: string | null;
  summary: PayrollIssuesSummary;
  issues: PayrollIssue[];
};

export const getPayrollIssuesQueryKey = (scope: PayrollScope, filters?: PayrollListFilters) =>
  ["/api/payroll/insights/issues", scope, filters ?? null] as const;

export const usePayrollIssues = (
  scope: PayrollScope | null,
  filters?: PayrollListFilters,
  options?: Partial<UseQueryOptions<PayrollIssuesResponse>>,
) =>
  useQuery<PayrollIssuesResponse>({
    queryKey: getPayrollIssuesQueryKey(scope ?? { kind: "staff", month: 0, year: 0 }, filters),
    queryFn: () =>
      customFetch<PayrollIssuesResponse>(`${payrollApiBase(scope!.kind)}/issues?${scopeQuery(scope!, filters)}`),
    enabled: !!scope,
    ...options,
  });

// ── Rules ─────────────────────────────────────────────────────────────────────

/** Where a rule comes from: the Settings page, the employee's own profile, their assigned shift, or their pay cycle. */
export type RuleSource = "settings" | "employee" | "shift" | "cycle";

export type RuleItem = {
  /** "attendance_mode", "late_free_allowance", "pf_rules", ... */
  key: string;
  label: string;
  /** In words: "Strict (4-punch)", "3 free, then slabs", "12% when Basic is up to ₹25,000". */
  value: string;
  detail?: string | null;
  source: RuleSource;
  /** The Settings address that changes it (deep link: /hr/settings?tab=...#setting-id), or null when it is not a setting. */
  settingsPath: string | null;
  /** On a payroll's details: what that payroll was generated with ... */
  applied?: string | null;
  /** ... and whether the rule has been changed since (so regenerating would price it differently). */
  changed?: boolean;
};

export type RuleGroup = { group: string; items: RuleItem[] };

/** One employee's rules in the "Rules assigned to each employee" table. */
export type EmployeeRules = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  payrollId: number | null;
  /** Short chips for the table: [{ key: "shift", label: "General 09:00-18:00", tone: "info" }, ...]. */
  chips: {
    key: string;
    label: string;
    tone: "success" | "warning" | "caution" | "danger" | "info" | "accent" | "neutral";
  }[];
  /** The employee's rules in full (the same shape as the details page's groups). */
  groups: RuleGroup[];
  /** Problems with the assignment itself: "no_shift", "no_rate", "no_cycle" ... */
  flags: string[];
};

export type PayrollRulesResponse = {
  scope: PayrollPeriodInfo;
  /** Rules configured on the Settings page that this payroll uses, grouped, each with its Settings link. */
  settings: RuleGroup[];
  employees: EmployeeRules[];
};

export const getPayrollRulesQueryKey = (scope: PayrollScope, filters?: PayrollListFilters) =>
  ["/api/payroll/insights/rules", scope, filters ?? null] as const;

export const usePayrollRules = (
  scope: PayrollScope | null,
  filters?: PayrollListFilters,
  options?: Partial<UseQueryOptions<PayrollRulesResponse>>,
) =>
  useQuery<PayrollRulesResponse>({
    queryKey: getPayrollRulesQueryKey(scope ?? { kind: "staff", month: 0, year: 0 }, filters),
    queryFn: () =>
      customFetch<PayrollRulesResponse>(`${payrollApiBase(scope!.kind)}/rules?${scopeQuery(scope!, filters)}`),
    enabled: !!scope,
    ...options,
  });

// ── One payroll's details ─────────────────────────────────────────────────────

/** A line of the earnings or deductions list, ready to draw. */
export type MoneyLine = {
  key: string;
  label: string;
  /** How it was worked out: "₹30,000 / 26 working days x 24 days". */
  note?: string | null;
  amount: number;
  /** "info" lines are shown but not added (e.g. the daily rate). */
  kind: "earning" | "deduction" | "info" | "subtotal";
  /** The rule behind it, when there is one. */
  ruleKey?: string | null;
};

/** One day of the period in the same shape for staff and production. */
// A day may carry the compensation marker (compensationKind / Minutes / Note) once the details endpoint sends it; it
// does not today (payroll_insights.py builds the day from the stored breakdown), so the screens draw it only when present.
/** Why a day was what it was, for the calendar: the six attendance categories HR looks for (read live from the attendance records). */
export type DayMark = "late" | "permission" | "excess_permission" | "on_duty" | "on_duty_punch" | "missed_punch";

export type PayrollDay = DayCompensationMarker & {
  date: string;
  day: string;
  /** staff: present | absent | paid_leave | unpaid_leave; production: present | half_shift | absent | holiday | ... */
  status: string;
  firstIn: string | null;
  lastOut: string | null;
  /** Shifts the day earned (staff: 1 / 0.5 / 0.75 per present day, production: 0.25 steps). */
  shifts: number | null;
  flags: IssueCode[];
  /** The attendance categories of the day (permission, On-Duty, missed punch ...). Older servers do not send it. */
  marks?: DayMark[];
  note: string | null;
};

export type PayrollDetails = {
  payrollId: number;
  kind: PayrollKind | "legacy_session";
  /** The payroll's salary slip (for the PDF / email / WhatsApp actions) and its number; null when none was stored. */
  slipId: number | null;
  slipNumber: string | null;
  status: string;
  /** The last time payroll computed this record, and the first time it did (ISO datetimes). */
  generatedAt: string | null;
  firstGeneratedAt: string | null;
  period: PayrollPeriodInfo;
  employee: {
    id: number;
    code: string;
    name: string;
    department: string | null;
    designation: string | null;
    branch: string | null;
    employmentType: string;
    /** "active" | "inactive" ... (the employee's status now). */
    status: string;
    joinDate: string | null;
    salaryAmount: number | null;
    salaryPerShift: number | null;
    payCycle: PayCycle | null;
    /** Payment readiness without exposing the full account number. */
    bank: { hasAccount: boolean; bankName: string | null; hasIfsc: boolean; accountLast4: string | null };
    pfNumber: string | null;
    esiNumber: string | null;
    /** The two salary-split portions (Basic+DA+Retaining | Other+Petrol+HRA+Special+CA), when recorded. */
    split: { first: number; second: number; components: { key: string; label: string; amount: number }[] } | null;
  };
  money: {
    gross: number;
    deductions: number;
    bonus: number;
    otAmount: number;
    net: number;
    /** Staff: the monthly salary and the daily rate it is prorated by. */
    monthlySalary: number | null;
    dailyRate: number | null;
  };
  /** Counts of days / shifts (the breakdown's own summary, same keys). */
  summary: Record<string, number | null>;
  earnings: MoneyLine[];
  deductions: MoneyLine[];
  /** The rules that govern this employee, as applied to this payroll, with the current Settings value when it changed. */
  rules: RuleGroup[];
  issues: PayrollIssue[];
  issueCounts: { total: number; bySeverity: Record<IssueSeverity, number>; byCode: Record<string, number> };
  days: PayrollDay[];
  advances: { advanceId: number; repaymentId: number; amount: number; notes: string | null }[];
  /** Notes HR typed when adjusting (Payroll.notes). */
  notes: string | null;
  /** The same employee's earlier payrolls of the same kind, newest first (up to 6). */
  history: { payrollId: number; label: string; net: number; status: string; issues: number }[];
  /** The neighbours of this payroll in the same period (ordered by employee name), for Previous / Next. */
  neighbours: { previousId: number | null; nextId: number | null; position: number; total: number };
  /** What the list page needs to link back to the right place. */
  context: {
    kind: PayrollKind;
    month: number;
    year: number;
    cycle: PayCycle | null;
    periodStart: string | null;
    periodEnd: string | null;
  };
};

export const getPayrollDetailsQueryKey = (kind: PayrollKind, id: number) =>
  ["/api/payroll/insights/details", kind, id] as const;

export const usePayrollDetails = (kind: PayrollKind, id: number | null) =>
  useQuery<PayrollDetails>({
    queryKey: getPayrollDetailsQueryKey(kind, id ?? 0),
    queryFn: () => customFetch<PayrollDetails>(`${payrollApiBase(kind)}/${id}/details`),
    enabled: !!id,
  });

// ── Salary Statement ──────────────────────────────────────────────────────────

export type StatementColumn = {
  key: string;
  label: string;
  /** A second header line, like the printed statement's "Total / Days". */
  sub?: string | null;
  align: "left" | "center" | "right";
  format: "text" | "int" | "days" | "money";
  /** Relative width (1 = a narrow number column). */
  weight: number;
  /** The column adds up in the department subtotal and the grand total. */
  total: boolean;
  group: "identity" | "attendance" | "earnings" | "deductions" | "result";
};

export type StatementRow = {
  /** null on a subtotal / total line. */
  payrollId: number | null;
  employeeId: number | null;
  sno: number | null;
  status: string | null;
  values: Record<string, number | string | null>;
};

export type StatementGroup = {
  key: string;
  /** The department (the printed statement's ACCOUNTS / ADMIN band). */
  label: string;
  rows: StatementRow[];
  subtotal: StatementRow;
};

export type SalaryStatement = {
  kind: PayrollKind;
  company: { name: string; branchLabel: string | null };
  title: string;
  period: PayrollPeriodInfo & { fromLabel: string; toLabel: string };
  generatedAt: string;
  columns: StatementColumn[];
  groups: StatementGroup[];
  total: StatementRow;
  counts: { employees: number; departments: number; paid: number; pending: number };
  /** How the columns were worked out and what the HRMS does not track (printed under the table). */
  notes: string[];
};

export const getSalaryStatementQueryKey = (scope: PayrollScope, filters?: PayrollListFilters) =>
  ["/api/payroll/insights/statement", scope, filters ?? null] as const;

export const useSalaryStatement = (
  scope: PayrollScope | null,
  filters?: PayrollListFilters,
  options?: Partial<UseQueryOptions<SalaryStatement>>,
) =>
  useQuery<SalaryStatement>({
    queryKey: getSalaryStatementQueryKey(scope ?? { kind: "staff", month: 0, year: 0 }, filters),
    queryFn: () =>
      customFetch<SalaryStatement>(`${payrollApiBase(scope!.kind)}/salary-statement?${scopeQuery(scope!, filters)}`),
    enabled: !!scope,
    ...options,
  });
