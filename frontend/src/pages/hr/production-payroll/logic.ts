/**
 * Pure helpers of the Production Payroll cycle pages (Weekly / BiWeekly / Monthly): how a period is written, which one
 * is picked by default, what a roster row says about an employee, who Payroll skipped, the Payroll register, and the
 * state of the page in its address (?tab=salary&period=2026-02-02_2026-02-08&view=issues).
 */

import type { TableColumn } from "@/components/payroll/kit/export-table";
import { STATEMENT_URL_DEFAULTS } from "@/components/payroll/kit/statement-url";
import { parsePeriodParam } from "@/components/payroll/kit/url-state";
import { FILTER_URL_DEFAULTS } from "@/components/payroll/panels/filters";
import { DEFAULT_ISSUE_FILTERS, sanitizeFilters, type IssueFilterState } from "@/components/payroll/panels/issues";
import type { SkippedItem } from "@/components/payroll/panels/skipped";
import type {
  CyclePeriod,
  CyclePeriodRow,
  PayCycle,
  PayrollRunItem,
  PayrollScope,
  PeriodEmployee,
} from "@/lib/api-client/custom-hooks";
import { PAY_CYCLE_INFO } from "@/lib/api-client/custom-hooks";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type Day = { year: number; month: number; day: number };

/** "2026-02-09" -> a day; null for anything that is not a real date. */
export function parseDay(text: string | null | undefined): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text ?? "").trim());
  if (!m) return null;
  const day = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const probe = new Date(Date.UTC(day.year, day.month - 1, day.day));
  const real =
    probe.getUTCFullYear() === day.year && probe.getUTCMonth() === day.month - 1 && probe.getUTCDate() === day.day;
  return real ? day : null;
}

/** "2 Feb - 8 Feb 2026" (the year once when both ends share it), "29 Dec 2025 - 4 Jan 2026" across a year. */
export function formatPeriod(period: CyclePeriod): string {
  const a = parseDay(period.periodStart);
  const b = parseDay(period.periodEnd);
  if (!a || !b) return `${period.periodStart} - ${period.periodEnd}`;
  const end = `${b.day} ${MONTHS[b.month - 1]} ${b.year}`;
  const start = a.year === b.year ? `${a.day} ${MONTHS[a.month - 1]}` : `${a.day} ${MONTHS[a.month - 1]} ${a.year}`;
  return `${start} - ${end}`;
}

export const periodValue = (period: CyclePeriod): string => `${period.periodStart}|${period.periodEnd}`;

export function periodFromValue(value: string): CyclePeriod | null {
  const [periodStart, periodEnd] = value.split("|");
  return parseDay(periodStart) && parseDay(periodEnd) ? { periodStart, periodEnd } : null;
}

export function samePeriod(a: CyclePeriod | null | undefined, b: CyclePeriod | null | undefined): boolean {
  return !!a && !!b && a.periodStart === b.periodStart && a.periodEnd === b.periodEnd;
}

/** The period the page opens on: the one Generate would pay next, else the newest. */
export function defaultPeriod(periods: CyclePeriodRow[]): CyclePeriod | null {
  const row = periods.find((p) => p.isNext) ?? periods[0];
  return row ? { periodStart: row.periodStart, periodEnd: row.periodEnd } : null;
}

/** The text of one entry of the period picker. */
export function periodOptionLabel(row: CyclePeriodRow, roster: number): string {
  const parts = [formatPeriod(row)];
  if (row.generated > 0)
    parts.push(roster > 0 ? `${row.generated} of ${roster} generated` : `${row.generated} generated`);
  else parts.push("not generated");
  if (!row.periodEnded) parts.push("not ended yet");
  if (row.isNext) parts.push("next due");
  return parts.join(" · ");
}

// ── the roster of a period ──

export type RosterState = "ready" | "pending" | "paid" | "blocked";

/** What a roster row says: nothing generated yet (ready, or blocked with a reason), a pending payslip, or a paid one. */
export function rosterState(employee: PeriodEmployee): RosterState {
  if (employee.payroll) return employee.payroll.status === "paid" ? "paid" : "pending";
  return employee.blockedReason ? "blocked" : "ready";
}

export const ROSTER_STATE_LABEL: Record<RosterState, string> = {
  ready: "Not generated",
  pending: "Generated - pending",
  paid: "Paid",
  blocked: "Cannot be generated",
};

export const ROSTER_STATES: readonly RosterState[] = ["ready", "pending", "paid", "blocked"];

export function filterRoster(
  employees: PeriodEmployee[],
  search: string,
  state: RosterState | "all",
): PeriodEmployee[] {
  const q = search.trim().toLowerCase();
  return employees.filter((e) => {
    if (state !== "all" && rosterState(e) !== state) return false;
    if (!q) return true;
    return e.name.toLowerCase().includes(q) || e.employeeCode.toLowerCase().includes(q);
  });
}

/** How many of the roster are in each state (the filter chips of the Employees tab), and how many there are in all. */
export function rosterStateCounts(
  employees: readonly PeriodEmployee[] | null | undefined,
): Record<RosterState | "all", number> {
  const counts: Record<RosterState | "all", number> = { all: 0, ready: 0, pending: 0, paid: 0, blocked: 0 };
  for (const e of employees ?? []) {
    counts.all += 1;
    counts[rosterState(e)] += 1;
  }
  return counts;
}

/** How many of the roster a "Generate payroll" click would compute: those with nothing yet and nothing in the way. */
export const readyCount = (employees: PeriodEmployee[]): number =>
  employees.filter((e) => rosterState(e) === "ready").length;

/**
 * The people Payroll cannot generate for in this period, as the Skipped Employees view lists them: the roster's blocked
 * rows (no salary per shift, or days that overlap another payslip), each with the reason the roster gives. Somebody who
 * already has a payslip is never blocked, whatever their row says.
 */
export function skippedFromRoster(employees: readonly PeriodEmployee[] | null | undefined): SkippedItem[] {
  return (employees ?? [])
    .filter((e) => rosterState(e) === "blocked")
    .map((e) => ({
      employeeId: e.employeeId,
      employeeCode: e.employeeCode,
      name: e.name,
      reason: e.blockedReason ?? "",
      department: e.departmentName,
    }));
}

// ── page wording ──

export function cycleTitle(cycle: PayCycle): string {
  return `Production Payroll - ${PAY_CYCLE_INFO[cycle].label}`;
}

export function cycleBlurb(cycle: PayCycle): string {
  const info = PAY_CYCLE_INFO[cycle];
  return `${info.calculation}: a ${info.days}-day pay period. Only the production employees assigned to the ${info.label} cycle are paid here.`;
}

/** "5 production employees are not assigned to a pay cycle..." (null when everyone is). */
export function unassignedNotice(unassigned: number): string | null {
  if (unassigned <= 0) return null;
  const who = unassigned === 1 ? "1 production employee is" : `${unassigned} production employees are`;
  return `${who} not assigned to a pay cycle yet, so no payroll includes them.`;
}

// ── the state of the page, in its address ──────────────────────────────────────

export type ProductionTab = "payroll" | "employees" | "salary" | "payslip";
export type ProductionView = "records" | "issues" | "skipped" | "rules";

export const PRODUCTION_TABS: readonly ProductionTab[] = ["payroll", "employees", "salary", "payslip"];
export const PRODUCTION_VIEWS: readonly ProductionView[] = ["records", "issues", "skipped", "rules"];

export const isProductionTab = (v: string): v is ProductionTab => (PRODUCTION_TABS as readonly string[]).includes(v);
export const isProductionView = (v: string): v is ProductionView => (PRODUCTION_VIEWS as readonly string[]).includes(v);

/** What a page hands its tabs to change the address. */
export type UrlSetter = (patch: Record<string, string>) => void;

/**
 * The Issues view's own filters in the address: prefixed, so they never collide with the records' filters (q, dept ...).
 * The same keys, with the same defaults, as the Staff Payroll page's.
 */
export const ISSUE_URL_DEFAULTS = {
  iq: "",
  icode: "",
  isev: "",
  idept: "",
  ifrom: "",
  ito: "",
  igroup: DEFAULT_ISSUE_FILTERS.groupBy,
} as const;

/** The Employees tab's search (eq) and state filter (estate: "all" or one of the roster states). */
export const ROSTER_URL_DEFAULTS = { eq: "", estate: "all" } as const;

/**
 * Every key the page keeps in its address, with its default (a value equal to its default is left out of the address).
 * `period` empty = the period the cycle is due to pay next (the page follows it); `month` / `year` empty = the current
 * month and year, for the Payslip tab. A module-level constant: `useUrlParams` needs a stable identity.
 */
export const PRODUCTION_URL_DEFAULTS: Record<string, string> = {
  tab: "payroll",
  view: "records",
  period: "",
  month: "",
  year: "",
  layout: "cards",
  ...FILTER_URL_DEFAULTS,
  ...ISSUE_URL_DEFAULTS,
  ...STATEMENT_URL_DEFAULTS,
  ...ROSTER_URL_DEFAULTS,
};

/**
 * `?period=2026-02-02_2026-02-08` -> the two days. Anything that is not a real, ordered pair of calendar days is
 * ignored (the page then follows the next due period), so a hand-edited address never breaks it.
 */
export function periodFromUrl(value: string | null | undefined): CyclePeriod | null {
  const parsed = parsePeriodParam(value);
  if (!parsed || !parseDay(parsed.periodStart) || !parseDay(parsed.periodEnd)) return null;
  return parsed.periodStart <= parsed.periodEnd ? parsed : null;
}

/** The month the Payslip tab shows: the address's `month` / `year` when they are real, else today's. */
export function resolveSlipMonth(
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

export const rosterStateFromUrl = (value: string | null | undefined): RosterState | "all" =>
  (ROSTER_STATES as readonly string[]).includes(value ?? "") ? (value as RosterState) : "all";

/** The slice of payroll the insight panels (issues, rules, salary statement) ask the server about. */
export const productionScope = (cycle: PayCycle, period: CyclePeriod): PayrollScope => ({
  kind: "production",
  cycle,
  periodStart: period.periodStart,
  periodEnd: period.periodEnd,
});

// ── The Issues view's filters <-> the address ──────────────────────────────────

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

// ── Payroll register (the Export menu on the Payroll tab) ──────────────────────

const cycleName = (run: Pick<PayrollRunItem, "payCycle">): string =>
  PAY_CYCLE_INFO[run.payCycle as PayCycle]?.label ?? "";

/** The columns of the production Payroll register, in the order of the sheet. Shifts, not days: production is paid per shift. */
export const PRODUCTION_REGISTER_COLUMNS: TableColumn<PayrollRunItem>[] = [
  { key: "employeeCode", label: "Employee code", width: 14 },
  { key: "employeeName", label: "Employee", width: 28 },
  { key: "departmentName", label: "Department", width: 22 },
  { key: "payCycle", label: "Pay cycle", width: 12, value: cycleName },
  { key: "periodStart", label: "Period start", width: 14, type: "date" },
  { key: "periodEnd", label: "Period end", width: 14, type: "date" },
  { key: "totalWorkingDays", label: "Days in period", width: 14, type: "int" },
  { key: "presentDays", label: "Shifts earned", width: 14, type: "money" },
  { key: "absentDays", label: "Days absent", width: 13, type: "int" },
  { key: "grossSalary", label: "Gross earned", width: 15, type: "money" },
  { key: "bonus", label: "Bonus", width: 12, type: "money" },
  { key: "deductions", label: "Deductions", width: 14, type: "money" },
  { key: "finalSalary", label: "Net payable", width: 15, type: "money" },
  { key: "status", label: "Status", width: 11 },
  { key: "notes", label: "Notes", width: 50 },
];
