import { inr, monthYear, periodLabel as periodRange, plural } from "@/components/payroll/kit/format";
import { periodNoun } from "@/components/payroll/kit/scope";
import {
  PAY_CYCLE_INFO,
  type ExcessAction,
  type ExcessDepartment,
  type ExcessEmployeeOption,
  type ExcessEmployeeRow,
  type ExcessEntry,
  type ExcessHistoryFilters,
  type ExcessHistoryItem,
  type ExcessKind,
  type ExcessSource,
  type PayrollKind,
  type PayrollScope,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

// The Excess tab of Staff Payroll and of the Production Payroll cycle pages (owner 2026-11-20), the pure part: filters,
// grouping, totals, validation and the sentences the screen says. "Excess" = an amount HR adds to an employee's earned
// salary for the month (staff) or the pay period (production), "Detection" = an amount HR takes off it; both by hand, with
// a mandatory remark.

// ── Staff month or production period ──────────────────────────────────────────

/** The tab's permission key: unchanged since it was the Salary tab (`?tab=salary` on both pages). */
export const excessPermissionKey = (kind: PayrollKind): string =>
  kind === "production" ? "production_payroll.salary" : "salary";

export { employeeNoun, periodNoun, scopeKey, scopeLabel } from "@/components/payroll/kit/scope";

// ── The tab's state in the address ────────────────────────────────────────────

/** Prefixed "ex" so nothing collides with the page's other keys (q, dept, view ... belong to the Payroll tab). */
export type ExcessUrlKey =
  "exview" | "exq" | "exdept" | "exkind" | "exin" | "exhall" | "exhdept" | "exhemp" | "exhkind" | "exhact" | "exhpage";

export const EXCESS_URL_DEFAULTS: Record<ExcessUrlKey, string> = {
  /** breakdown | history */
  exview: "breakdown",
  exq: "",
  /** A department id ("none" = no department), empty = all. */
  exdept: "",
  /** excess | detection, empty = both. */
  exkind: "",
  /** "1" = only employees in the payroll. */
  exin: "",
  /** "1" = the history of every month / every period of the cycle (default: the page's own). */
  exhall: "",
  exhdept: "",
  exhemp: "",
  exhkind: "",
  exhact: "",
  exhpage: "",
};

export type ExcessView = "breakdown" | "history";
export const excessView = (value: string | undefined): ExcessView => (value === "history" ? "history" : "breakdown");

// ── Money and labels ──────────────────────────────────────────────────────────

/** "₹2,000", or "₹2,000.50" when there are paise. */
export function rupees(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return inr(value, Number.isInteger(Math.round(value * 100) / 100) ? 0 : 2);
}

/** "+₹2,000" / "−₹500" / "₹0": a change to the salary. */
export function signedRupees(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value > 0) return `+${rupees(value)}`;
  if (value < 0) return `−${rupees(-value)}`;
  return rupees(0);
}

/** An entry's effect on the salary: an Excess adds, a Detection takes off. */
export const signedAmount = (kind: ExcessKind, amount: number): number => (kind === "detection" ? -amount : amount);

export const KIND_LABEL: Record<ExcessKind, string> = { excess: "Excess", detection: "Detection" };
export const KIND_TONE: Record<ExcessKind, Tone> = { excess: "success", detection: "danger" };
export const KIND_HINT: Record<ExcessKind, string> = {
  excess: "Added to the earned salary",
  detection: "Taken off the earned salary",
};

export const ACTION_LABEL: Record<ExcessAction, string> = { added: "Added", changed: "Changed", removed: "Removed" };
export const ACTION_TONE: Record<ExcessAction, Tone> = { added: "info", changed: "warning", removed: "neutral" };

export const SOURCE_LABEL: Record<ExcessSource, string> = {
  manual: "Single",
  bulk: "Bulk",
  migrated: "Earlier bonus",
};
export const SOURCE_HINT: Record<ExcessSource, string> = {
  manual: "Added for this employee alone",
  bulk: "Added to several employees at once, the same amount each",
  migrated: "A bonus that was on this payroll before the Excess tab existed",
};

export const isExcessKind = (value: unknown): value is ExcessKind => value === "excess" || value === "detection";
export const isExcessAction = (value: unknown): value is ExcessAction =>
  value === "added" || value === "changed" || value === "removed";

/** An entry changed after it was added (amount corrected). */
export const entryWasChanged = (entry: ExcessEntry): boolean =>
  !!entry.updatedAt && !!entry.createdAt && entry.updatedAt !== entry.createdAt;

/** After a save: what happened to the payroll ("2 payrolls updated at once ..." / "Applied when ... is generated."). */
export function payrollLine(updated: number | boolean, kind: PayrollKind): string {
  const count = typeof updated === "boolean" ? (updated ? 1 : 0) : updated;
  if (count <= 0) return `Applied when the ${periodNoun(kind)}'s payroll is generated.`;
  return typeof updated === "boolean"
    ? "The payroll is updated at once: earned salary and NET."
    : `${plural(count, "payroll")} updated at once: earned salary and NET.`;
}

// ── Where an employee stands with the month's / period's payroll ──────────────

export type RowState = "in_payroll" | "not_generated" | "held_or_new";

export function rowState(row: Pick<ExcessEmployeeRow, "inPayroll" | "payrollId">): RowState {
  if (row.inPayroll) return "in_payroll";
  return row.payrollId === null || row.payrollId === undefined ? "not_generated" : "held_or_new";
}

export type RowStateMeta = { label: string; tone: Tone; hint: string };

/** The chip of a row's payroll state. Production has no salary hold: a payroll set aside is a new joiner waiting. */
export function rowStateMeta(state: RowState, kind: PayrollKind = "staff"): RowStateMeta {
  if (state === "in_payroll")
    return {
      label: "In payroll",
      tone: "success",
      hint: "The amounts are already in this employee's payroll (earned salary and NET).",
    };
  if (state === "not_generated")
    return {
      label: "Not generated yet",
      tone: "warning",
      hint: "No payroll for this employee yet: the amounts are added when the payroll is generated.",
    };
  return kind === "production"
    ? {
        label: "New joiner waiting",
        tone: "accent",
        hint: "The payroll exists but waits in New Joiners: the amounts are in it and count once it is added to the payroll.",
      }
    : {
        label: "Held or new joiner",
        tone: "accent",
        hint: "The payroll exists but is set aside (salary on hold or a new joiner not added yet): the amounts are in it and count once it is paid.",
      };
}

/** Earned salary before and after this employee's Excess / Detection; null while there is no payroll. */
export function earnedMove(row: ExcessEmployeeRow): { before: number; after: number } | null {
  if (row.earnedSalary === null || row.earnedSalary === undefined) return null;
  return { before: row.earnedSalary, after: row.earnedWithExcess ?? row.earnedSalary + row.net };
}

// ── The breakdown's filters ───────────────────────────────────────────────────

export type ExcessTypeFilter = "" | ExcessKind;

export type BreakdownFilters = {
  q: string;
  /** deptKey() of one department, empty = all. */
  dept: string;
  /** Has an Excess / has a Detection, empty = either. */
  kind: ExcessTypeFilter;
  inPayrollOnly: boolean;
};

export const DEFAULT_BREAKDOWN_FILTERS: BreakdownFilters = { q: "", dept: "", kind: "", inPayrollOnly: false };

export function breakdownFiltersFromUrl(url: Partial<Record<string, string>>): BreakdownFilters {
  return {
    q: url.exq ?? "",
    dept: url.exdept ?? "",
    kind: isExcessKind(url.exkind) ? url.exkind : "",
    inPayrollOnly: url.exin === "1",
  };
}

export function breakdownFiltersToUrl(patch: Partial<BreakdownFilters>): Partial<Record<ExcessUrlKey, string>> {
  const out: Partial<Record<ExcessUrlKey, string>> = {};
  if (patch.q !== undefined) out.exq = patch.q;
  if (patch.dept !== undefined) out.exdept = patch.dept;
  if (patch.kind !== undefined) out.exkind = patch.kind;
  if (patch.inPayrollOnly !== undefined) out.exin = patch.inPayrollOnly ? "1" : "";
  return out;
}

export const hasBreakdownFilters = (f: BreakdownFilters): boolean =>
  f.q.trim() !== "" || f.dept !== "" || f.kind !== "" || f.inPayrollOnly;

/** A department's key in the filter and the collapse state ("none" for employees without a department). */
export const deptKey = (d: Pick<ExcessDepartment, "departmentId">): string =>
  d.departmentId === null || d.departmentId === undefined ? "none" : String(d.departmentId);

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();

export function rowMatches(row: ExcessEmployeeRow, f: BreakdownFilters): boolean {
  const q = norm(f.q);
  if (q && ![row.code, row.name, row.designation].some((v) => norm(v).includes(q))) return false;
  if (f.kind === "excess" && !(row.excess > 0)) return false;
  if (f.kind === "detection" && !(row.detection > 0)) return false;
  if (f.inPayrollOnly && !row.inPayroll) return false;
  return true;
}

export type ExcessTotals = {
  employees: number;
  entries: number;
  excessTotal: number;
  detectionTotal: number;
  net: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function totalsOfRows(rows: readonly ExcessEmployeeRow[]): ExcessTotals {
  let excessTotal = 0;
  let detectionTotal = 0;
  let entries = 0;
  for (const r of rows) {
    excessTotal += r.excess;
    detectionTotal += r.detection;
    entries += r.entries.length;
  }
  return {
    employees: rows.length,
    entries,
    excessTotal: round2(excessTotal),
    detectionTotal: round2(detectionTotal),
    net: round2(excessTotal - detectionTotal),
  };
}

/**
 * The departments with only the rows that pass the filters, their totals worked out again from those rows; a department
 * left with no row is dropped. Without a filter the server's departments come back as they are.
 */
export function filterBreakdown(departments: readonly ExcessDepartment[], f: BreakdownFilters): ExcessDepartment[] {
  if (!hasBreakdownFilters(f)) return [...departments];
  const out: ExcessDepartment[] = [];
  for (const d of departments) {
    if (f.dept && deptKey(d) !== f.dept) continue;
    const rows = d.rows.filter((r) => rowMatches(r, f));
    if (rows.length === 0) continue;
    const t = totalsOfRows(rows);
    out.push({
      ...d,
      rows,
      employees: t.employees,
      excessTotal: t.excessTotal,
      detectionTotal: t.detectionTotal,
      net: t.net,
    });
  }
  return out;
}

export const rowsOf = (departments: readonly ExcessDepartment[]): ExcessEmployeeRow[] =>
  departments.flatMap((d) => d.rows);

/** The department options of the filter: the month's (period's) departments, by name. */
export const departmentFilterOptions = (departments: readonly ExcessDepartment[]): { value: string; label: string }[] =>
  departments.map((d) => ({ value: deptKey(d), label: d.unit ? `${d.department} (${d.unit})` : d.department }));

// ── Selections ────────────────────────────────────────────────────────────────

export const toggleId = (list: readonly number[], id: number): number[] =>
  list.includes(id) ? list.filter((x) => x !== id) : [...list, id];

/** Adds every id (none twice) when not all of them are in the list yet, else takes them all out. */
export function toggleAll(list: readonly number[], ids: readonly number[]): number[] {
  const all = ids.length > 0 && ids.every((id) => list.includes(id));
  return all ? list.filter((x) => !ids.includes(x)) : [...list, ...ids.filter((id) => !list.includes(id))];
}

export type EntryWithRow = { entry: ExcessEntry; row: ExcessEmployeeRow };

/** The chosen entries with their employee, in the breakdown's order (ids no longer on screen are left out). */
export function entriesByIds(departments: readonly ExcessDepartment[], ids: readonly number[]): EntryWithRow[] {
  const wanted = new Set(ids);
  const out: EntryWithRow[] = [];
  for (const row of rowsOf(departments))
    for (const entry of row.entries) if (wanted.has(entry.id)) out.push({ entry, row });
  return out;
}

/** Ids from a selection that still exist (after a reload an entry may be gone). */
export function keepExisting(ids: readonly number[], existing: Iterable<number>): number[] {
  const set = new Set(existing);
  return ids.filter((id) => set.has(id));
}

export const entryIdsOf = (departments: readonly ExcessDepartment[]): number[] =>
  rowsOf(departments).flatMap((r) => r.entries.map((e) => e.id));

// ── Validation (the server's rules: amount > 0 and at most 10,00,000; remark 3-500 characters) ───────────────────────

export const EXCESS_MAX_AMOUNT = 1_000_000;
export const REMARK_MIN = 3;
export const REMARK_MAX = 500;

const cleanAmount = (text: string) => text.replace(/[,\s₹]/g, "");

/** The amount typed, as a number (commas and a ₹ allowed), or null when it is not a plain positive figure. */
export function parseAmount(text: string): number | null {
  const cleaned = cleanAmount(text);
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function amountError(text: string): string | null {
  const cleaned = cleanAmount(text);
  if (cleaned === "") return "Enter an amount.";
  if (/^-(\d+\.?\d*|\.\d+)$/.test(cleaned)) return "The amount must be more than zero.";
  const n = parseAmount(text);
  if (n === null) return "Enter the amount in rupees, for example 2000.";
  if (/\.\d{3,}$/.test(cleaned)) return "Use at most 2 decimals (paise).";
  if (n <= 0) return "The amount must be more than zero.";
  if (n > EXCESS_MAX_AMOUNT) return `The amount cannot be more than ${inr(EXCESS_MAX_AMOUNT)}.`;
  return null;
}

/** `what` names the field in the message: "remark" (add) or "reason" (change, remove). */
export function remarkError(text: string, what: "remark" | "reason" = "remark"): string | null {
  const t = text.trim();
  if (t.length === 0) return `A ${what} is required.`;
  if (t.length < REMARK_MIN) return `Write at least ${REMARK_MIN} characters.`;
  if (t.length > REMARK_MAX) return `Keep the ${what} within ${REMARK_MAX} characters.`;
  return null;
}

/** "12 / 500", and whether the counter is over the limit. */
export function remarkCounter(text: string): { label: string; over: boolean } {
  const n = text.trim().length;
  return { label: `${n} / ${REMARK_MAX}`, over: n > REMARK_MAX };
}

// ── What the dialogs say ──────────────────────────────────────────────────────

/** The line under the add form: "Adds ₹2,000 to each of 5 employees (₹10,000 in all)". */
export function addSummary(kind: ExcessKind, amount: number | null, names: readonly string[]): string | null {
  const count = names.length;
  if (amount === null || amount <= 0 || count === 0) return null;
  if (kind === "excess") {
    return count === 1
      ? `Adds ${rupees(amount)} to ${names[0]}'s earned salary.`
      : `Adds ${rupees(amount)} to each of ${count} employees (${rupees(amount * count)} in all).`;
  }
  return count === 1
    ? `Takes ${rupees(amount)} off ${names[0]}'s earned salary.`
    : `Takes ${rupees(amount)} off each of ${count} employees (${rupees(amount * count)} in all).`;
}

/** The save button: "Add ₹2,000 excess to 3 employees". */
export function addButtonLabel(kind: ExcessKind, amount: number | null, count: number): string {
  const what = kind === "excess" ? "excess" : "detection";
  if (amount === null || amount <= 0 || count === 0) return `Add ${what}`;
  return `Add ${rupees(amount)} ${what} to ${plural(count, "employee")}`;
}

/** "₹2,000 → ₹2,500 (+₹500)" for the change dialog; null while the new amount is not valid. */
export function changePreview(from: number, toText: string): string | null {
  if (amountError(toText)) return null;
  const to = parseAmount(toText)!;
  const diff = round2(to - from);
  return `${rupees(from)} → ${rupees(to)} (${diff === 0 ? "no change" : signedRupees(diff)})`;
}

// ── The employee picker ───────────────────────────────────────────────────────

export function optionMatches(o: ExcessEmployeeOption, q: string): boolean {
  const s = norm(q);
  if (!s) return true;
  return [o.code, o.name, o.department, o.designation].some((v) => norm(v).includes(s));
}

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code.localeCompare(b.code, undefined, { numeric: true, sensitivity: "base" });

/** Selectable employees first, each part by code. */
export const sortOptions = (options: readonly ExcessEmployeeOption[]): ExcessEmployeeOption[] =>
  [...options].sort((a, b) => Number(b.eligible) - Number(a.eligible) || byCode(a, b));

/** The ids that may be picked: an ineligible employee is never selectable, even when the address or a row names them. */
export function eligibleOnly(ids: readonly number[], options: readonly ExcessEmployeeOption[]): number[] {
  const ok = new Set(options.filter((o) => o.eligible).map((o) => o.id));
  return ids.filter((id) => ok.has(id));
}

// ── History ───────────────────────────────────────────────────────────────────

export type HistoryUi = {
  /** Every month (staff) / every period of the cycle (production), instead of the page's own. */
  allPeriods: boolean;
  /** A department id, empty = all. */
  dept: string;
  /** An employee id, empty = all. */
  emp: string;
  kind: "" | ExcessKind;
  action: "" | ExcessAction;
  page: number;
};

export function historyUiFromUrl(url: Partial<Record<string, string>>): HistoryUi {
  const page = Number(url.exhpage);
  return {
    allPeriods: url.exhall === "1",
    dept: /^\d+$/.test(url.exhdept ?? "") ? url.exhdept! : "",
    emp: /^\d+$/.test(url.exhemp ?? "") ? url.exhemp! : "",
    kind: isExcessKind(url.exhkind) ? url.exhkind : "",
    action: isExcessAction(url.exhact) ? url.exhact : "",
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** A filter change goes back to page 1; a page change keeps the filters. */
export function historyUiToUrl(patch: Partial<HistoryUi>): Partial<Record<ExcessUrlKey, string>> {
  const out: Partial<Record<ExcessUrlKey, string>> = {};
  if (patch.allPeriods !== undefined) out.exhall = patch.allPeriods ? "1" : "";
  if (patch.dept !== undefined) out.exhdept = patch.dept;
  if (patch.emp !== undefined) out.exhemp = patch.emp;
  if (patch.kind !== undefined) out.exhkind = patch.kind;
  if (patch.action !== undefined) out.exhact = patch.action;
  if (patch.page !== undefined) out.exhpage = patch.page > 1 ? String(patch.page) : "";
  else if (Object.keys(out).length > 0) out.exhpage = "";
  return out;
}

export const hasHistoryFilters = (ui: HistoryUi): boolean =>
  ui.allPeriods || ui.dept !== "" || ui.emp !== "" || ui.kind !== "" || ui.action !== "";

/**
 * The history request: staff asks for the page's month (or every month), production for the page's cycle and period (or
 * every period of the cycle - a production history never mixes cycles).
 */
export function historyFilters(ui: HistoryUi, scope: PayrollScope, pageSize: number): ExcessHistoryFilters {
  const period: ExcessHistoryFilters =
    scope.kind === "staff"
      ? { month: ui.allPeriods ? null : scope.month, year: ui.allPeriods ? null : scope.year }
      : {
          cycle: scope.cycle,
          periodStart: ui.allPeriods ? null : scope.periodStart,
          periodEnd: ui.allPeriods ? null : scope.periodEnd,
        };
  return {
    ...period,
    departmentId: ui.dept ? Number(ui.dept) : null,
    employeeId: ui.emp ? Number(ui.emp) : null,
    kind: ui.kind || null,
    action: ui.action || null,
    page: ui.page,
    pageSize,
  };
}

/** "All months" / "Every Weekly period": the option of the history's period select. */
export function allPeriodsLabel(scope: PayrollScope): string {
  return scope.kind === "staff" ? "All months" : `Every ${PAY_CYCLE_INFO[scope.cycle]?.label ?? scope.cycle} period`;
}

/** The month or period a history line is about: "November 2026" / "2 Feb - 8 Feb 2026". */
export function historyItemPeriod(
  item: Pick<ExcessHistoryItem, "month" | "year" | "periodStart" | "periodEnd">,
): string {
  if (item.periodStart && item.periodEnd) return periodRange(item.periodStart, item.periodEnd);
  if (item.month && item.year) return monthYear(item.month, item.year);
  return "—";
}

export const totalPages = (total: number, pageSize: number): number =>
  Math.max(1, Math.ceil(Math.max(0, total) / Math.max(1, pageSize)));

/** What happened to the amount: "₹2,000 → ₹2,500", "New ₹2,000", "₹2,000 removed". */
export function amountMove(item: Pick<ExcessHistoryItem, "action" | "previousAmount" | "newAmount">): string {
  if (item.action === "added" || item.previousAmount === null) return `New ${rupees(item.newAmount)}`;
  if (item.action === "removed" || item.newAmount === null) return `${rupees(item.previousAmount)} removed`;
  return `${rupees(item.previousAmount)} → ${rupees(item.newAmount)}`;
}

/** The payroll's NET before → after, or null when no payroll was touched. */
export function netMove(item: Pick<ExcessHistoryItem, "payrollNetBefore" | "payrollNetAfter">): string | null {
  if (item.payrollNetBefore === null && item.payrollNetAfter === null) return null;
  return `${rupees(item.payrollNetBefore)} → ${rupees(item.payrollNetAfter)}`;
}

// ── Excel export of the breakdown ─────────────────────────────────────────────

export const EXPORT_HEADER = [
  "Department",
  "Unit",
  "Code",
  "Name",
  "Designation",
  "Excess",
  "Detection",
  "Net",
  "Earned salary before",
  "Earned salary after",
  "NET pay",
  "Payroll",
  "Entries",
] as const;

export type ExportCell = string | number | null;

/** One line per employee, then each department's total line, then the grand total (the same numbers as on screen). */
export function exportRows(
  departments: readonly ExcessDepartment[],
  kind: PayrollKind = "staff",
): {
  rows: ExportCell[][];
  totalRowIndexes: number[];
} {
  const rows: ExportCell[][] = [];
  const totalRowIndexes: number[] = [];
  for (const d of departments) {
    for (const r of d.rows) {
      const earned = earnedMove(r);
      rows.push([
        d.department,
        d.unit ?? "",
        r.code,
        r.name,
        r.designation ?? "",
        r.excess,
        r.detection,
        r.net,
        earned?.before ?? null,
        earned?.after ?? null,
        r.netPay ?? null,
        rowStateMeta(rowState(r), kind).label,
        r.entries
          .map((e) => `${KIND_LABEL[e.kind]} ${rupees(e.amount)}: ${e.remark}${e.createdBy ? ` (${e.createdBy})` : ""}`)
          .join("\n"),
      ]);
    }
    totalRowIndexes.push(rows.length);
    rows.push([
      `${d.department} total`,
      d.unit ?? "",
      "",
      plural(d.employees, "employee"),
      "",
      d.excessTotal,
      d.detectionTotal,
      d.net,
      null,
      null,
      null,
      "",
      "",
    ]);
  }
  const t = totalsOfRows(rowsOf(departments));
  totalRowIndexes.push(rows.length);
  rows.push([
    "Grand total",
    "",
    "",
    plural(t.employees, "employee"),
    "",
    t.excessTotal,
    t.detectionTotal,
    t.net,
    null,
    null,
    null,
    "",
    "",
  ]);
  return { rows, totalRowIndexes };
}
