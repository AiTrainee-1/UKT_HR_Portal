// The Salary Slip page's rules, as pure functions (tested in logic.test.ts): the month in the address, the category tabs
// and their counts, the filters, the selection, the Generate batches, what a download needs first, file names and the
// day-by-day calendar. Nothing here touches React or the network.
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  SlipDownloadError,
  type BankCheck,
  type GenerateSlipsResult,
  type SlipCalendarDay,
  type SlipCenterDepartment,
  type SlipCenterDesignation,
  type SlipCenterEmployee,
  type SlipCenterUnit,
  type SlipFileRequest,
  type SlipOptions,
} from "@/lib/api-client/custom-hooks/salary-slip-center";

export const SALARY_SLIP_PATH = "/hr/salary-slip";
/** The page's permission key (view = list, preview, files; edit = Generate and Hold / Release). */
export const SALARY_SLIP_MODULE = "salary_slip_center";

// ── The month ────────────────────────────────────────────────────────────────

export const MONTHS_LONG = [
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
];

/** The month and year in the address, or the current month when either is missing or out of range. */
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

/** The years the picker offers: three back and one ahead of this year, plus the one picked when it is outside. */
export function yearOptions(current: number, picked: number): number[] {
  const out = [current - 3, current - 2, current - 1, current, current + 1];
  return out.includes(picked) ? out : [...out, picked].sort((a, b) => a - b);
}

export const monthLabel = (month: number, year: number): string => `${MONTHS_LONG[month - 1] ?? ""} ${year}`.trim();

// ── Tabs and filters ─────────────────────────────────────────────────────────

/** The category tabs, in the order shown. They overlap on purpose: a held active employee is in Active AND On Hold. */
export const SLIP_TABS = ["active", "on_hold", "new_joiners", "inactive", "all"] as const;
export type SlipTab = (typeof SLIP_TABS)[number];

export const TAB_LABEL: Record<SlipTab, string> = {
  active: "Active",
  on_hold: "On Hold",
  new_joiners: "New Joiners",
  inactive: "Inactive",
  all: "All",
};

export const isSlipTab = (v: string): v is SlipTab => (SLIP_TABS as readonly string[]).includes(v);

export type CategoryFilter = "all" | "staff" | "production";
export type StatusFilter = "all" | "active" | "inactive";
export type SlipFilter = "all" | "generated" | "not_generated";

export type SlipFilters = {
  search: string;
  category: CategoryFilter;
  /** A department name, or "all" (by name: each unit has its own department of the same name). */
  department: string;
  /** A designation title, or "all". */
  designation: string;
  /** A unit (branch) id, or "all". */
  unit: string;
  status: StatusFilter;
  slip: SlipFilter;
};

export const ALL = "all";

export const NO_FILTERS: SlipFilters = {
  search: "",
  category: "all",
  department: ALL,
  designation: ALL,
  unit: ALL,
  status: "all",
  slip: "all",
};

/** The page's state in the address. A value equal to its default is left out, so a fresh page keeps a clean URL. */
export const URL_DEFAULTS: Record<string, string> = {
  month: "",
  year: "",
  tab: "active",
  q: "",
  cat: "all",
  dept: ALL,
  desig: ALL,
  unit: ALL,
  status: "all",
  slip: "all",
  page: "1",
};

const pick = <T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly string[]).includes(value ?? "") ? (value as T) : fallback;

/** The filters as the address holds them (anything unknown falls back to its default). */
export function filtersFromUrl(url: Record<string, string>): SlipFilters {
  return {
    search: url.q ?? "",
    category: pick(url.cat, ["all", "staff", "production"] as const, "all"),
    department: url.dept || ALL,
    designation: url.desig || ALL,
    unit: url.unit || ALL,
    status: pick(url.status, ["all", "active", "inactive"] as const, "all"),
    slip: pick(url.slip, ["all", "generated", "not_generated"] as const, "all"),
  };
}

/** The address keys for a change of filters (page 1 again: a narrower list must not strand the reader). */
export function filtersToUrl(f: Partial<SlipFilters>): Record<string, string> {
  const out: Record<string, string> = { page: "1" };
  if (f.search !== undefined) out.q = f.search;
  if (f.category !== undefined) out.cat = f.category;
  if (f.department !== undefined) out.dept = f.department;
  if (f.designation !== undefined) out.desig = f.designation;
  if (f.unit !== undefined) out.unit = f.unit;
  if (f.status !== undefined) out.status = f.status;
  if (f.slip !== undefined) out.slip = f.slip;
  return out;
}

export function filtersActive(f: SlipFilters): boolean {
  return (
    f.search.trim() !== "" ||
    f.category !== "all" ||
    f.department !== ALL ||
    f.designation !== ALL ||
    f.unit !== ALL ||
    f.status !== "all" ||
    f.slip !== "all"
  );
}

export const isActiveEmployee = (e: Pick<SlipCenterEmployee, "status">): boolean =>
  (e.status ?? "").toLowerCase() === "active";

export function matchesTab(e: SlipCenterEmployee, tab: SlipTab): boolean {
  switch (tab) {
    case "active":
      return isActiveEmployee(e);
    case "inactive":
      return !isActiveEmployee(e);
    case "on_hold":
      return e.onHold;
    case "new_joiners":
      return e.isNewJoiner;
    default:
      return true;
  }
}

const sameName = (a: string | null | undefined, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export function matchesFilters(e: SlipCenterEmployee, f: SlipFilters): boolean {
  const q = f.search.trim().toLowerCase();
  if (q && !e.name.toLowerCase().includes(q) && !e.code.toLowerCase().includes(q)) return false;
  if (f.category !== "all" && e.category !== f.category) return false;
  if (f.department !== ALL && !sameName(e.department, f.department)) return false;
  if (f.designation !== ALL && !sameName(e.designation, f.designation)) return false;
  if (f.unit !== ALL && String(e.branchId ?? "") !== f.unit) return false;
  if (f.status === "active" && !isActiveEmployee(e)) return false;
  if (f.status === "inactive" && isActiveEmployee(e)) return false;
  if (f.slip === "generated" && !e.slip) return false;
  if (f.slip === "not_generated" && e.slip) return false;
  return true;
}

/** How many employees each tab holds under the current filters (the tab itself aside). */
export function tabCounts(employees: readonly SlipCenterEmployee[], f: SlipFilters): Record<SlipTab, number> {
  const out: Record<SlipTab, number> = { active: 0, on_hold: 0, new_joiners: 0, inactive: 0, all: 0 };
  for (const e of employees) {
    if (!matchesFilters(e, f)) continue;
    for (const tab of SLIP_TABS) if (matchesTab(e, tab)) out[tab] += 1;
  }
  return out;
}

/** The rows of the list: the tab, then the filters, in the server's order. */
export function visibleRows(
  employees: readonly SlipCenterEmployee[],
  tab: SlipTab,
  f: SlipFilters,
): SlipCenterEmployee[] {
  return employees.filter((e) => matchesTab(e, tab) && matchesFilters(e, f));
}

export type Option = { value: string; label: string };

const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);

/**
 * Departments / designations offered for the chosen category ("all": every one), once per name: each unit has its own
 * department of the same name, and picking "ACCOUNTS" means the accounts people of every unit (the Unit filter narrows).
 */
function categoryOptions(
  items: readonly { label: string; category: string | null }[],
  category: CategoryFilter,
): Option[] {
  const byName = new Map<string, Option>();
  for (const i of items) {
    const name = i.label.trim();
    if (!name || (category !== "all" && (i.category ?? "") !== category)) continue;
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { value: name, label: name });
  }
  return [...byName.values()].sort(byLabel);
}

export const departmentOptions = (list: readonly SlipCenterDepartment[], category: CategoryFilter): Option[] =>
  categoryOptions(
    list.map((d) => ({ label: d.name, category: d.category })),
    category,
  );

export const designationOptions = (list: readonly SlipCenterDesignation[], category: CategoryFilter): Option[] =>
  categoryOptions(
    list.map((d) => ({ label: d.title, category: d.category })),
    category,
  );

export const unitOptions = (list: readonly SlipCenterUnit[]): Option[] =>
  list.map((u) => ({ value: String(u.id), label: u.name })).sort(byLabel);

/**
 * A new category was picked: the department / designation filters keep their value only when the new category still
 * offers it (a Staff department is not a choice under Production).
 */
export function changeCategory(
  f: SlipFilters,
  category: CategoryFilter,
  departments: readonly SlipCenterDepartment[],
  designations: readonly SlipCenterDesignation[],
): Partial<SlipFilters> {
  const keep = (value: string, options: Option[]) =>
    value === ALL || options.some((o) => sameName(o.value, value)) ? value : ALL;
  return {
    category,
    department: keep(f.department, departmentOptions(departments, category)),
    designation: keep(f.designation, designationOptions(designations, category)),
  };
}

// ── Pages ─────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 50;

export type PageOf<T> = { rows: T[]; page: number; totalPages: number; from: number; to: number; total: number };

/** The rows of one page; the page number is clamped so a search that shrinks the list never strands the reader. */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number = PAGE_SIZE): PageOf<T> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const start = (safe - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return { rows: slice, page: safe, totalPages, from: total === 0 ? 0 : start + 1, to: start + slice.length, total };
}

// ── Selection ────────────────────────────────────────────────────────────────

export type Selection = ReadonlySet<number>;
export const NO_SELECTION: Selection = new Set<number>();

export function toggleId(selection: Selection, id: number): Selection {
  const next = new Set(selection);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function selectRows(selection: Selection, rows: readonly { id: number }[]): Selection {
  const next = new Set(selection);
  for (const r of rows) next.add(r.id);
  return next;
}

export function deselectRows(selection: Selection, rows: readonly { id: number }[]): Selection {
  const next = new Set(selection);
  for (const r of rows) next.delete(r.id);
  return next;
}

export type ListSelection = "none" | "some" | "all";

/** The header checkbox: how much of the listed rows (every page of the current list) is ticked. */
export function listSelection(selection: Selection, rows: readonly { id: number }[]): ListSelection {
  if (rows.length === 0) return "none";
  const ticked = rows.filter((r) => selection.has(r.id)).length;
  return ticked === 0 ? "none" : ticked === rows.length ? "all" : "some";
}

/** How many ticked employees the current tab and filters do not show. */
export function hiddenSelected(selection: Selection, rows: readonly { id: number }[]): number {
  const shown = new Set(rows.map((r) => r.id));
  let hidden = 0;
  for (const id of selection) if (!shown.has(id)) hidden++;
  return hidden;
}

/** The ticked employees, fresh from the month's list and in its order (anyone no longer listed drops out). */
export function selectedEmployees(
  selection: Selection,
  employees: readonly SlipCenterEmployee[],
): SlipCenterEmployee[] {
  return employees.filter((e) => selection.has(e.id));
}

/** Who of the ticked employees can be held, and who released. */
export function holdSplit(rows: readonly SlipCenterEmployee[]): {
  toHold: SlipCenterEmployee[];
  toRelease: SlipCenterEmployee[];
} {
  return { toHold: rows.filter((r) => !r.onHold), toRelease: rows.filter((r) => r.onHold) };
}

// ── Generate in batches ──────────────────────────────────────────────────────

/** Ids per Generate call: small enough to show steady progress (the server takes up to 50). */
export const GENERATE_BATCH = 20;

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.trunc(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

export const EMPTY_RESULT: GenerateSlipsResult = { generated: [], skipped: [] };

export function mergeResults(a: GenerateSlipsResult, b: GenerateSlipsResult): GenerateSlipsResult {
  return { generated: [...a.generated, ...b.generated], skipped: [...a.skipped, ...b.skipped] };
}

/** The ticked employees with no saved slip for the month (what a download has to generate first). */
export const missingSlips = (rows: readonly SlipCenterEmployee[]): SlipCenterEmployee[] => rows.filter((r) => !r.slip);

/**
 * The ids a download may ask for once the missing slips were generated: those that had a saved slip, plus those just
 * generated (anyone skipped stays out).
 */
export function idsWithSlips(rows: readonly SlipCenterEmployee[], generatedIds: readonly number[]): number[] {
  const made = new Set(generatedIds);
  return rows.filter((r) => r.slip || made.has(r.id)).map((r) => r.id);
}

/** "40 slips" / "1 slip". */
export const slipCount = (n: number): string => `${n} slip${n === 1 ? "" : "s"}`;
export const employeeCount = (n: number): string => `${n} employee${n === 1 ? "" : "s"}`;

export type Wording = { title: string; description?: string; variant?: "default" | "destructive" };

/** The toast after a Generate run (all batches): how many were saved, skipped, and whether it stopped early. */
export function generateWording(
  result: GenerateSlipsResult,
  requested: number,
  period: string,
  failed: string | null,
): Wording {
  const made = result.generated.length;
  const skipped = result.skipped.length;
  const notRun = Math.max(0, requested - made - skipped);
  const parts: string[] = [];
  if (skipped > 0) parts.push(`${skipped} skipped (see the list on the page)`);
  if (failed) parts.push(`${notRun} not done: ${failed}`);
  if (made === 0) {
    return {
      title: failed ? "No slips were generated" : `No slips generated for ${period}`,
      description: parts.join(". ") || undefined,
      variant: "destructive",
    };
  }
  return {
    title: `${slipCount(made)} generated for ${period}`,
    description: parts.length > 0 ? parts.join(". ") : "Saved. They can be downloaded now.",
    variant: failed ? "destructive" : "default",
  };
}

// ── Files ─────────────────────────────────────────────────────────────────────

/** The file name used when the server's own name (Content-Disposition) cannot be read. */
export function fallbackFileName(
  request: SlipFileRequest,
  month: number,
  year: number,
  rows: readonly Pick<SlipCenterEmployee, "code">[],
): string {
  const when = `${MONTHS_LONG[month - 1] ?? month}-${year}`;
  if (request.kind === "slips") {
    return rows.length === 1 ? `Salary-Slip-${rows[0].code}-${when}.pdf` : `Salary-Slips-${when}.pdf`;
  }
  if (request.kind === "statement") return `Salary-Statement-${when}.${request.fmt}`;
  return `Bank-File-${when}.xlsx`;
}

/** What the progress panel says while a file is being made. */
export function fileLabel(request: SlipFileRequest, count: number): string {
  if (request.kind === "slips") {
    return `Making the slips PDF (${slipCount(count)}, ${request.layout === "double" ? "two per page" : "one per page"})`;
  }
  if (request.kind === "statement") {
    return `Making the salary statement (${request.fmt === "pdf" ? "PDF" : "Excel"}, ${employeeCount(count)})`;
  }
  return `Making the bank file (${employeeCount(count)})`;
}

/** The bank check grouped by reason, for the confirmation panel: "On hold: 2", "No IFSC code: 1". */
export function leftOutByReason(check: BankCheck): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of check.leftOut) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

// ── Errors ────────────────────────────────────────────────────────────────────

/** The server's own sentence (`{"error": "..."}`) when there is one, else a plain fallback. */
export function errorText(e: unknown): string {
  if (e instanceof SlipDownloadError) return e.message;
  if (e instanceof ApiError) {
    const data = e.data as { error?: unknown; message?: unknown } | null;
    if (data && typeof data.error === "string" && data.error) return data.error;
    if (data && typeof data.message === "string" && data.message) return data.message;
  }
  if (e instanceof Error && e.message) {
    const m = /^HTTP \d+ [^:]*: (.+)$/s.exec(e.message);
    return m ? m[1] : e.message;
  }
  return "Could not reach the server. Check the connection and try again.";
}

/** The ids with no saved slip when a download was refused for want of them (the server's 409), else null. */
export function missingFromError(e: unknown): number[] | null {
  return e instanceof SlipDownloadError && e.status === 409 && e.missing.length > 0 ? e.missing : null;
}

// ── Options ──────────────────────────────────────────────────────────────────

export const OPTION_INFO: { key: keyof SlipOptions; label: string; hint: string }[] = [
  { key: "statutory", label: "PF / ESI / TDS", hint: "From each employee's Co Emp and TDS setting" },
  { key: "lateDeductions", label: "Late & permission deductions", hint: "From the month's attendance" },
  { key: "advances", label: "Advance instalments", hint: "This month's advance / loan instalments (read only)" },
];

export const sameOptions = (a: SlipOptions, b: SlipOptions): boolean =>
  a.statutory === b.statutory && a.lateDeductions === b.lateDeductions && a.advances === b.advances;

/** "PF / ESI / TDS, Advance instalments" or "No deductions". */
export function optionsText(o: SlipOptions): string {
  const on = OPTION_INFO.filter((i) => o[i.key]).map((i) => i.label);
  return on.length > 0 ? on.join(", ") : "No deductions";
}

// ── The calendar ─────────────────────────────────────────────────────────────

const isoWeekday = (iso: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return 0;
  // Monday = 0 ... Sunday = 6; UTC so the day never shifts with the viewer's zone
  return (new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() + 6) % 7;
};

/** The month's days as Monday-first weeks, with empty cells before the 1st and after the last day. */
export function calendarWeeks(days: readonly SlipCalendarDay[]): (SlipCalendarDay | null)[][] {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const cells: (SlipCalendarDay | null)[] = Array.from({ length: isoWeekday(sorted[0].date) }, () => null);
  cells.push(...sorted);
  while (cells.length % 7 !== 0) cells.push(null);
  return chunk(cells, 7);
}

/** "18" from "2026-11-18". */
export const dayOfMonth = (iso: string): string => String(Number(iso.slice(8, 10)) || "");

/** The calendar day's hover text: "Tue 3 Nov · Present · 1 shift · 08:58-18:02 · Late". */
export function calendarTitle(d: SlipCalendarDay, statusLabel: string): string {
  const parts = [`${d.day} ${dayOfMonth(d.date)}`, statusLabel];
  if (d.shifts !== null && d.shifts !== undefined && d.shifts > 0) {
    parts.push(`${d.shifts} shift${d.shifts === 1 ? "" : "s"}`);
  }
  if (d.firstIn || d.lastOut) parts.push(`${d.firstIn ?? "?"}-${d.lastOut ?? "?"}`);
  if (d.late) parts.push("Late");
  if (d.note) parts.push(d.note);
  return parts.join(" · ");
}

// ── A row's cells ─────────────────────────────────────────────────────────────

/** The salary as the row shows it: per month for staff, per shift for production; null when not set. */
export function salaryOf(e: SlipCenterEmployee): { amount: number; per: "month" | "shift" } | null {
  if (e.category === "production") return e.salaryPerShift ? { amount: e.salaryPerShift, per: "shift" } : null;
  return e.monthlySalary ? { amount: e.monthlySalary, per: "month" } : null;
}

/** The month's figures across the list: employees, slips generated and their net, holds, new joiners, issues. */
export function summarize(employees: readonly SlipCenterEmployee[]) {
  let generated = 0;
  let net = 0;
  let onHold = 0;
  let newJoiners = 0;
  let payIssues = 0;
  let bankIssues = 0;
  for (const e of employees) {
    if (e.slip) {
      generated++;
      net += e.slip.net;
    }
    if (e.onHold) onHold++;
    if (e.isNewJoiner) newJoiners++;
    if (e.payIssue) payIssues++;
    if (e.bankIssue) bankIssues++;
  }
  return { total: employees.length, generated, net, onHold, newJoiners, payIssues, bankIssues };
}

export type EmptyInfo = { title: string; hint: string; action: "clear" | "all" | "previous" | null };

/** Why the list is empty, and the way out. */
export function emptyInfo(tab: SlipTab, filtered: boolean, total: number, period: string): EmptyInfo {
  if (total === 0) {
    return {
      title: `No employees to show for ${period}`,
      hint: "No employee of the units you can see was employed this month. Pick another month.",
      action: "previous",
    };
  }
  if (filtered) {
    return {
      title: "No employee matches these filters",
      hint: "Clear the filters, or try another name or employee code.",
      action: "clear",
    };
  }
  const what: Record<SlipTab, string> = {
    active: "No active employees",
    on_hold: "Nobody is on hold",
    new_joiners: "No new joiners",
    inactive: "No inactive employees",
    all: "No employees",
  };
  const hint: Record<SlipTab, string> = {
    active: "Every employee listed this month is inactive. Open All to see them.",
    on_hold: `Hold an employee from the list to keep them out of ${period}'s bank file.`,
    new_joiners: `Nobody joined in ${period}.`,
    inactive: `Every employee listed for ${period} is active.`,
    all: "Pick another month.",
  };
  return { title: `${what[tab]} in ${period}`, hint: hint[tab], action: tab === "all" ? null : "all" };
}
