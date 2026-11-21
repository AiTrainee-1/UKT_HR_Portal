// The Payslip tab of Staff Payroll and of the Production Payroll cycle pages as plain data: its filters in the address,
// which payslips they leave, the departments to offer, the totals of a set, the days / shifts lines, the selection
// (checkboxes) and the names of the files. Pure, so it is easy to test.

import { monthYear, num as fixed } from "@/components/payroll/kit/format";
import { PAY_CYCLE_INFO, type PayrollKind, type PayrollScope, type PayslipRow } from "@/lib/api-client/custom-hooks";

export const ALL = "all";
export const NO_DEPARTMENT = "none";

// ── The filters in the address ────────────────────────────────────────────────

/** The tab's own keys (prefixed "pl", so they never collide with the Payroll tab's or the other tabs'). */
export const PAYSLIP_URL_DEFAULTS = { plq: "", pldept: ALL, plstatus: ALL, plpay: ALL } as const;

export type PayslipUrlKey = keyof typeof PAYSLIP_URL_DEFAULTS;

export type PayslipFilters = {
  q: string;
  /** A department name, "none" (no department) or "all". */
  dept: string;
  /** The payroll's status: "pending", "paid" (Cleared) or "all". */
  status: "pending" | "paid" | typeof ALL;
  /** The month's / period's Mark as Paid: "unpaid", "paid" or "all". */
  payment: "unpaid" | "paid" | typeof ALL;
};

export const DEFAULT_PAYSLIP_FILTERS: Readonly<PayslipFilters> = Object.freeze({
  q: "",
  dept: ALL,
  status: ALL,
  payment: ALL,
});

export function payslipFiltersFromUrl(values: Partial<Record<string, string | null | undefined>>): PayslipFilters {
  return {
    q: values.plq ?? "",
    dept: values.pldept || ALL,
    status: values.plstatus === "pending" || values.plstatus === "paid" ? values.plstatus : ALL,
    payment: values.plpay === "unpaid" || values.plpay === "paid" ? values.plpay : ALL,
  };
}

export function payslipFiltersToUrl(patch: Partial<PayslipFilters>): Partial<Record<PayslipUrlKey, string>> {
  const out: Partial<Record<PayslipUrlKey, string>> = {};
  if (patch.q !== undefined) out.plq = patch.q;
  if (patch.dept !== undefined) out.pldept = patch.dept;
  if (patch.status !== undefined) out.plstatus = patch.status;
  if (patch.payment !== undefined) out.plpay = patch.payment;
  return out;
}

export const payslipFilterCount = (f: PayslipFilters): number =>
  (f.q.trim() ? 1 : 0) + (f.dept !== ALL ? 1 : 0) + (f.status !== ALL ? 1 : 0) + (f.payment !== ALL ? 1 : 0);

// ── Which payslips are listed ─────────────────────────────────────────────────

const isPaidPayment = (row: Pick<PayslipRow, "paymentStatus">) => row.paymentStatus === "paid";
const isCleared = (row: Pick<PayslipRow, "status">) => row.status === "paid";

/** The payslips that pass the search (every word, in the name or the code) and the selects, in the server's order. */
export function filterPayslips<T extends PayslipRow>(rows: readonly T[], f: PayslipFilters): T[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((r) => {
    if (f.dept === NO_DEPARTMENT) {
      if (r.department) return false;
    } else if (f.dept !== ALL && r.department !== f.dept) return false;
    if (f.status === "paid" && !isCleared(r)) return false;
    if (f.status === "pending" && isCleared(r)) return false;
    if (f.payment === "paid" && !isPaidPayment(r)) return false;
    if (f.payment === "unpaid" && isPaidPayment(r)) return false;
    if (words.length === 0) return true;
    const haystack = `${r.name ?? ""} ${r.code ?? ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/** The departments the payslips belong to, by name ("No department" last when someone has none). */
export function payslipDepartments(rows: readonly PayslipRow[]): { value: string; label: string }[] {
  const names = new Set<string>();
  let missing = false;
  for (const r of rows) {
    if (r.department) names.add(r.department);
    else missing = true;
  }
  const options = [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name }));
  if (missing) options.push({ value: NO_DEPARTMENT, label: "No department" });
  return options;
}

// ── Figures ───────────────────────────────────────────────────────────────────

export type PayslipTotals = {
  employees: number;
  earned: number;
  excess: number;
  detection: number;
  deductions: number;
  net: number;
};

const money = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const numOf = (value: unknown): number => {
  const v = typeof value === "number" ? value : Number(value);
  return Number.isFinite(v) ? v : 0;
};

/** The figures of a set of payslips (the ones listed, when filtered). */
export function payslipTotals(rows: readonly PayslipRow[]): PayslipTotals {
  const out: PayslipTotals = { employees: 0, earned: 0, excess: 0, detection: 0, deductions: 0, net: 0 };
  for (const r of rows) {
    out.employees += 1;
    out.earned += numOf(r.earned);
    out.excess += numOf(r.excess);
    out.detection += numOf(r.detection);
    out.deductions += numOf(r.totalDeduction);
    out.net += numOf(r.net);
  }
  out.earned = money(out.earned);
  out.excess = money(out.excess);
  out.detection = money(out.detection);
  out.deductions = money(out.deductions);
  out.net = money(out.net);
  return out;
}

/** "25.5" / "27": a count of days or shifts, halves and quarters kept, no trailing zeros. */
export function countText(value: unknown): string {
  const n = numOf(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** "25.5 of 27": the paid days against the company's working days of the month. */
export function paidDaysText(row: Pick<PayslipRow, "paidDays" | "companyDays">): string {
  return row.companyDays ? `${countText(row.paidDays)} of ${countText(row.companyDays)}` : countText(row.paidDays);
}

export type DayLine = { key: string; label: string; value: number };

/**
 * The attendance lines of a payslip, in the order the PDF prints them: staff the company days, paid days, present, CL,
 * half days and loss of pay; production the shifts, the days worked and the days absent.
 */
export function dayLines(row: PayslipRow, kind: PayrollKind = "staff"): DayLine[] {
  if (kind === "production") {
    return [
      { key: "shifts", label: "Shifts", value: numOf(row.shifts) },
      { key: "daysWorked", label: "Days worked", value: numOf(row.daysWorked) },
      { key: "absent", label: "Absent", value: numOf(row.absent) },
    ];
  }
  return [
    { key: "companyDays", label: "Company days", value: numOf(row.companyDays) },
    { key: "paidDays", label: "Paid days", value: numOf(row.paidDays) },
    { key: "present", label: "Present", value: numOf(row.present) },
    { key: "cl", label: "Casual leave", value: numOf(row.cl) },
    { key: "hd", label: "Half days", value: numOf(row.hd) },
    { key: "lop", label: "Loss of pay", value: numOf(row.lop) },
  ];
}

/** A day / shift count as the sheet shows it: "23" or "23.50". */
export const dayValueText = (value: number): string => (Number.isInteger(value) ? String(value) : fixed(value, 2));

/** A payslip line's amount: "₹13,000.00", a negative one (a Detection) as "−₹500.00". */
export function lineAmountText(amount: number, fractionDigits = 2): string {
  const v = numOf(amount);
  const text = `₹${Math.abs(v).toLocaleString("en-IN", { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits })}`;
  return v < 0 ? `−${text}` : text;
}

// ── The selection ─────────────────────────────────────────────────────────────

/** One checkbox: adds or removes a payroll. */
export function toggleOne(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The header checkbox: every id given is picked, unless all of them already are (then they are all un-picked). */
export function toggleAll(selected: ReadonlySet<number>, ids: readonly number[]): Set<number> {
  const next = new Set(selected);
  const all = ids.length > 0 && ids.every((id) => next.has(id));
  for (const id of ids) {
    if (all) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** "checked" / "indeterminate" / unchecked, for the header checkbox over the ids listed. */
export function selectionState(selected: ReadonlySet<number>, ids: readonly number[]): boolean | "indeterminate" {
  if (ids.length === 0) return false;
  const picked = ids.filter((id) => selected.has(id)).length;
  if (picked === 0) return false;
  return picked === ids.length ? true : "indeterminate";
}

/** The picked payrolls still listed, in the list's order (a pick from another period never leaks into a download). */
export function pickedIds(selected: ReadonlySet<number>, rows: readonly Pick<PayslipRow, "payrollId">[]): number[] {
  return rows.filter((r) => selected.has(r.payrollId)).map((r) => r.payrollId);
}

// ── Words and files ───────────────────────────────────────────────────────────

/**
 * The name of the PDF when the server's Content-Disposition cannot be read: `Payslips-November-2026.pdf` (one employee:
 * `Payslip-<code>-November-2026.pdf`); a production period `Payslips-Weekly-2026-11-02-to-2026-11-08.pdf`.
 */
export function payslipsFileName(scope: PayrollScope, single?: Pick<PayslipRow, "code"> | null): string {
  const safe = (text: string) => text.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const period =
    scope.kind === "staff"
      ? monthYear(scope.month, scope.year).replace(" ", "-")
      : `${PAY_CYCLE_INFO[scope.cycle]?.label ?? scope.cycle}-${scope.periodStart}-to-${scope.periodEnd}`;
  return single ? `Payslip-${safe(single.code)}-${period}.pdf` : `Payslips-${period}.pdf`;
}
