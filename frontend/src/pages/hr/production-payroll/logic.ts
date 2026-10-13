/**
 * Pure helpers of the Production Payroll cycle pages (Weekly / BiWeekly / Monthly): how a period is written, which one
 * is picked by default, what a roster row says about an employee, and the totals shown above the payslip list.
 */

import type {
  CyclePeriod,
  CyclePeriodRow,
  PayCycle,
  PeriodEmployee,
  ProductionPayrollItem,
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

// ── the payslips of a period ──

export type RowTotals = {
  gross: number;
  deductions: number;
  net: number;
  /** Distinct employees with something still unpaid (a period can hold several rows for one person). */
  pendingEmployees: number;
  pendingRecords: number;
  pendingNet: number;
  paidNet: number;
};

export function totalsOf(rows: ProductionPayrollItem[]): RowTotals {
  const pendingPeople = new Set<number>();
  const totals: RowTotals = {
    gross: 0,
    deductions: 0,
    net: 0,
    pendingEmployees: 0,
    pendingRecords: 0,
    pendingNet: 0,
    paidNet: 0,
  };
  for (const row of rows) {
    totals.gross += row.grossSalary;
    totals.deductions += row.deductions;
    totals.net += row.finalSalary;
    if (row.status === "paid") {
      totals.paidNet += row.finalSalary;
    } else {
      totals.pendingRecords += 1;
      totals.pendingNet += row.finalSalary;
      pendingPeople.add(row.employeeId);
    }
  }
  totals.pendingEmployees = pendingPeople.size;
  return totals;
}

/** The payslip list's search box and department filter. */
export function filterRows(rows: ProductionPayrollItem[], search: string, department: string): ProductionPayrollItem[] {
  const q = search.trim().toLowerCase();
  return rows.filter((r) => {
    if (department !== "all" && String(r.departmentId ?? "") !== department) return false;
    if (!q) return true;
    return (r.employeeName ?? "").toLowerCase().includes(q) || (r.employeeCode ?? "").toLowerCase().includes(q);
  });
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

/** How many of the roster a "Generate payroll" click would compute: those with nothing yet and nothing in the way. */
export const readyCount = (employees: PeriodEmployee[]): number =>
  employees.filter((e) => rosterState(e) === "ready").length;

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

export const rupees = (value: number): string => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
