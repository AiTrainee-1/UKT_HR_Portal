// The payslip list as plain data: which slips a search / department / "not yet emailed" choice leaves, what the month's
// figures are, how a slip's period reads, and the columns of the "Payslip register" export. Pure, so it is easy to test.

import type { PayCycle, SalarySlipItem } from "@/lib/api-client/custom-hooks";
import { PAY_CYCLE_INFO } from "@/lib/api-client/custom-hooks";
import { dateShort, dateTime, fileStem, monthYear, periodLabel } from "@/components/payroll/kit/format";
import type { TableColumn } from "@/components/payroll/kit/export-table";
import { withTdsColumns } from "@/components/payroll/kit/statutory";

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export const ALL_DEPARTMENTS = "all";
export const NO_DEPARTMENT = "none";

/** A year typed into the box: four digits between 2000 and 2100, else null (so a half-typed year asks the server nothing). */
export function parseYear(text: string): number | null {
  if (!/^\d{4}$/.test(text.trim())) return null;
  const year = Number(text);
  return year >= 2000 && year <= 2100 ? year : null;
}

// ── One slip ──────────────────────────────────────────────────────────────────

/** "October 2026" for a staff slip, "2 Feb - 8 Feb 2026" for a production slip, "Week 3 · February 2026" for an old week. */
export function slipPeriodText(
  slip: Pick<SalarySlipItem, "periodStart" | "periodEnd" | "weekNumber" | "month" | "year">,
): string {
  if (slip.periodStart && slip.periodEnd) return periodLabel(slip.periodStart, slip.periodEnd);
  if (slip.weekNumber) return `Week ${slip.weekNumber} · ${monthYear(slip.month, slip.year)}`;
  return monthYear(slip.month, slip.year);
}

/** The pay cycle a production slip was generated on ("Weekly"), or null for a staff slip and a slip from before the cycles. */
export function slipCycleLabel(slip: Pick<SalarySlipItem, "payCycle">): string | null {
  const cycle = slip.payCycle as PayCycle | null | undefined;
  return cycle && cycle in PAY_CYCLE_INFO ? PAY_CYCLE_INFO[cycle].label : null;
}

const two = (n: number) => String(n).padStart(2, "0");

/** The day a slip was emailed, as the viewer's own calendar shows it ("13 Oct 2026"); null when it never was. */
export function emailedDay(emailedAt: string | null | undefined): string | null {
  if (!emailedAt) return null;
  const d = new Date(emailedAt);
  if (Number.isNaN(d.getTime())) return null;
  return dateShort(`${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`);
}

/** What a failed send says: the server's own sentence when it sent one, else the error's message. */
export function errorText(err: unknown): string {
  const e = err as { data?: unknown; message?: unknown } | null | undefined;
  const body = e?.data;
  if (body && typeof body === "object") {
    const sentence = (body as { error?: unknown }).error;
    if (typeof sentence === "string" && sentence.trim()) return sentence.trim();
  }
  return typeof e?.message === "string" && e.message ? e.message : "Unknown error";
}

// ── The list ──────────────────────────────────────────────────────────────────

export type SlipFilter = { q: string; dept: string; notEmailed: boolean };

export const NO_SLIP_FILTER: Readonly<SlipFilter> = Object.freeze({ q: "", dept: ALL_DEPARTMENTS, notEmailed: false });

export const slipFilterCount = (f: SlipFilter): number =>
  (f.q.trim() ? 1 : 0) + (f.dept !== ALL_DEPARTMENTS ? 1 : 0) + (f.notEmailed ? 1 : 0);

/** The slips that pass the search (every word, in the name or the code), the department and "not yet emailed", in the order given. */
export function filterSlips(slips: readonly SalarySlipItem[], filter: SlipFilter): SalarySlipItem[] {
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  return slips.filter((s) => {
    if (filter.notEmailed && s.emailedAt) return false;
    if (filter.dept === NO_DEPARTMENT) {
      if (s.departmentName) return false;
    } else if (filter.dept !== ALL_DEPARTMENTS && s.departmentName !== filter.dept) return false;
    if (words.length === 0) return true;
    const haystack = `${s.employeeName ?? ""} ${s.employeeCode ?? ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** The departments the slips belong to, by name ("No department" last when some slip has none). */
export function slipDepartments(slips: readonly SalarySlipItem[]): { value: string; label: string }[] {
  const names = new Set<string>();
  let missing = false;
  for (const s of slips) {
    if (s.departmentName) names.add(s.departmentName);
    else missing = true;
  }
  const options = [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name }));
  if (missing) options.push({ value: NO_DEPARTMENT, label: "No department" });
  return options;
}

export type SlipTotals = {
  /** Slips in the set. */
  slips: number;
  /** Distinct employees (a production month can hold several slips for one person). */
  employees: number;
  gross: number;
  deductions: number;
  net: number;
  /** Slips that were never emailed. */
  notEmailed: number;
};

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const num = (value: unknown): number => {
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) ? v : 0;
};

export function slipTotals(slips: readonly SalarySlipItem[]): SlipTotals {
  const people = new Set<number>();
  const out: SlipTotals = { slips: 0, employees: 0, gross: 0, deductions: 0, net: 0, notEmailed: 0 };
  for (const s of slips) {
    out.slips += 1;
    people.add(s.employeeId);
    out.gross += num(s.grossSalary);
    out.deductions += num(s.totalDeductions);
    out.net += num(s.netSalary);
    if (!s.emailedAt) out.notEmailed += 1;
  }
  out.employees = people.size;
  out.gross = money(out.gross);
  out.deductions = money(out.deductions);
  out.net = money(out.net);
  return out;
}

// ── The register export ───────────────────────────────────────────────────────

/** The columns of the "Payslip register" (Excel and CSV): one line per slip. */
export const REGISTER_COLUMNS: TableColumn<SalarySlipItem>[] = [
  { key: "slipNumber", label: "Slip no", width: 20 },
  { key: "employeeCode", label: "Code", width: 12 },
  { key: "employeeName", label: "Name", width: 26 },
  { key: "departmentName", label: "Department", width: 20, value: (s) => s.departmentName ?? "" },
  { key: "designationTitle", label: "Designation", width: 22, value: (s) => s.designationTitle ?? "" },
  { key: "period", label: "Period", width: 22, value: slipPeriodText },
  { key: "grossSalary", label: "Gross", width: 14, type: "money" },
  { key: "totalDeductions", label: "Deductions", width: 14, type: "money" },
  { key: "netSalary", label: "Net", width: 14, type: "money" },
  { key: "emailedAt", label: "Emailed at", width: 20, value: (s) => (s.emailedAt ? dateTime(s.emailedAt) : "") },
];

/**
 * The register for the slips listed: the same columns, plus "TDS %" and "TDS" just before the deductions total when one
 * of the slips has TDS (an employee on the TDS list). With no TDS slip it is `REGISTER_COLUMNS` itself.
 */
export const registerColumnsFor = (slips: readonly SalarySlipItem[]): TableColumn<SalarySlipItem>[] =>
  withTdsColumns(REGISTER_COLUMNS, slips, "totalDeductions");

/** "Payslip_register_Weekly_Feb_2026" / "Payslip_register_Staff_October_2026": a file name safe on every system. */
export function registerFileStem(
  kind: "staff" | "production",
  cycle: PayCycle | undefined,
  month: number,
  year: number,
): string {
  const who = kind === "production" ? (cycle ? PAY_CYCLE_INFO[cycle].label : "Production") : "Staff";
  return fileStem("Payslip register", who, MONTH_NAMES[month - 1] ?? month, year);
}
