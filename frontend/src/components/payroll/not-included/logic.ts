// The "Not included" view of the Payroll tab (Staff Payroll: one month; a Production Payroll cycle page: one pay period)
// as plain data: its filters in the address, which employees they leave, how each reason reads (label, colour, one-line
// hint), the reason chips and the Excel / CSV columns. Pure, so it is easy to test.

import type { TableColumn } from "@/components/payroll/kit/export-table";
import { fileStem, monthYear } from "@/components/payroll/kit/format";
import {
  PAY_CYCLE_INFO,
  type NotIncludedEmployee,
  type NotIncludedReasonCode,
  type PayrollKind,
  type PayrollScope,
  type PeriodNotIncluded,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

export const ALL = "all";

// ── The filters in the address ────────────────────────────────────────────────

/** The category a page shows first: its own employees (the others are paid on the other payroll). */
export const defaultCategory = (kind: PayrollKind): "staff" | "production" => kind;

/** The view's own keys on Staff Payroll (prefixed "ni", so they never collide with the records' or the other tabs'). */
export const NOT_INCLUDED_URL_DEFAULTS = {
  niq: "",
  nidept: ALL,
  nidesig: ALL,
  nistatus: ALL,
  /** Staff by default: production employees are paid on Production Payroll. */
  nicat: "staff",
  nireason: ALL,
} as const;

/** The same keys on a Production Payroll cycle page: Production by default. */
export const PRODUCTION_NOT_INCLUDED_URL_DEFAULTS = {
  ...NOT_INCLUDED_URL_DEFAULTS,
  nicat: "production",
} as const;

export const notIncludedUrlDefaults = (kind: PayrollKind) =>
  kind === "production" ? PRODUCTION_NOT_INCLUDED_URL_DEFAULTS : NOT_INCLUDED_URL_DEFAULTS;

export type NotIncludedUrlKey = keyof typeof NOT_INCLUDED_URL_DEFAULTS;

export type NotIncludedCategory = "staff" | "production" | typeof ALL;
export type NotIncludedStatus = "active" | "inactive" | typeof ALL;

export type NotIncludedFilters = {
  q: string;
  /** A department id, or "all". */
  dept: string;
  /** A designation id, or "all". */
  desig: string;
  status: NotIncludedStatus;
  category: NotIncludedCategory;
  /** A reason code, or "all". */
  reason: string;
};

export const DEFAULT_NOT_INCLUDED_FILTERS: Readonly<NotIncludedFilters> = Object.freeze({
  q: "",
  dept: ALL,
  desig: ALL,
  status: ALL,
  category: "staff",
  reason: ALL,
});

export const defaultNotIncludedFilters = (kind: PayrollKind): NotIncludedFilters => ({
  ...DEFAULT_NOT_INCLUDED_FILTERS,
  category: defaultCategory(kind),
});

/** The filters from address values; anything unknown or hand-edited falls back to its default. */
export function notIncludedFiltersFromUrl(
  values: Partial<Record<string, string | null | undefined>>,
  kind: PayrollKind = "staff",
): NotIncludedFilters {
  const status = values.nistatus === "active" || values.nistatus === "inactive" ? values.nistatus : ALL;
  const category: NotIncludedCategory =
    values.nicat === "staff" || values.nicat === "production" || values.nicat === ALL
      ? values.nicat
      : defaultCategory(kind);
  return {
    q: values.niq ?? "",
    dept: values.nidept || ALL,
    desig: values.nidesig || ALL,
    status,
    category,
    reason: values.nireason || ALL,
  };
}

export function notIncludedFiltersToUrl(
  patch: Partial<NotIncludedFilters>,
): Partial<Record<NotIncludedUrlKey, string>> {
  const out: Partial<Record<NotIncludedUrlKey, string>> = {};
  if (patch.q !== undefined) out.niq = patch.q;
  if (patch.dept !== undefined) out.nidept = patch.dept;
  if (patch.desig !== undefined) out.nidesig = patch.desig;
  if (patch.status !== undefined) out.nistatus = patch.status;
  if (patch.category !== undefined) out.nicat = patch.category;
  if (patch.reason !== undefined) out.nireason = patch.reason;
  return out;
}

/** How many filters differ from the defaults (the category counts only when it is not the page's own). */
export function notIncludedFilterCount(f: NotIncludedFilters, kind: PayrollKind = "staff"): number {
  return (
    (f.q.trim() ? 1 : 0) +
    (f.dept !== ALL ? 1 : 0) +
    (f.desig !== ALL ? 1 : 0) +
    (f.status !== ALL ? 1 : 0) +
    (f.category !== defaultCategory(kind) ? 1 : 0) +
    (f.reason !== ALL ? 1 : 0)
  );
}

// ── Which employees are listed ────────────────────────────────────────────────

export const isActive = (e: Pick<NotIncludedEmployee, "status">): boolean =>
  (e.status ?? "").trim().toLowerCase() === "active";

/**
 * The employees that pass every filter (the search: every word, in the name or the code), in the server's order.
 * `hideWaiting` (a month / period not generated yet): the employees who are only waiting for the payroll ("not_generated")
 * are left out unless that reason is picked, so the list keeps to the definite exclusions; the banner counts the waiting.
 */
export function filterNotIncluded(
  rows: readonly NotIncludedEmployee[],
  f: NotIncludedFilters,
  options: { hideWaiting?: boolean } = {},
): NotIncludedEmployee[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return rows.filter((e) => {
    if (options.hideWaiting && f.reason === ALL && e.reasonCode === "not_generated") return false;
    if (f.category !== ALL && e.category !== f.category) return false;
    if (f.reason !== ALL && e.reasonCode !== f.reason) return false;
    if (f.status === "active" && !isActive(e)) return false;
    if (f.status === "inactive" && isActive(e)) return false;
    if (f.dept !== ALL && String(e.departmentId ?? "") !== f.dept) return false;
    if (f.desig !== ALL && String(e.designationId ?? "") !== f.desig) return false;
    if (words.length === 0) return true;
    const haystack = `${e.name ?? ""} ${e.code ?? ""}`.toLowerCase();
    return words.every((w) => haystack.includes(w));
  });
}

/**
 * How many the view lists with no filter set: the page's own category, without the ones only waiting for a payroll that
 * is not generated yet. The count on the Payroll tab's view switch, so it always matches the list the view opens on.
 */
export function notIncludedCount(
  data: Pick<PeriodNotIncluded, "employees" | "generated"> | null | undefined,
  kind: PayrollKind,
): number | null {
  if (!data) return null;
  return filterNotIncluded(data.employees ?? [], defaultNotIncludedFilters(kind), { hideWaiting: !data.generated })
    .length;
}

export type Option = { value: string; label: string };

/**
 * The departments and designations to offer: those someone listed in the chosen category belongs to (plus the one already
 * chosen, so the select never shows an empty value), by name.
 */
export function filterOptions(
  data: Pick<PeriodNotIncluded, "departments" | "designations" | "employees"> | null | undefined,
  f: Pick<NotIncludedFilters, "category" | "dept" | "desig">,
): { departments: Option[]; designations: Option[] } {
  const inCategory = (data?.employees ?? []).filter((e) => f.category === ALL || e.category === f.category);
  const deptIds = new Set(inCategory.map((e) => String(e.departmentId ?? "")));
  const desigIds = new Set(inCategory.map((e) => String(e.designationId ?? "")));
  const byLabel = (a: Option, b: Option) => a.label.localeCompare(b.label);
  return {
    departments: (data?.departments ?? [])
      .map((d) => ({ value: String(d.id), label: d.name }))
      .filter((o) => deptIds.has(o.value) || o.value === f.dept)
      .sort(byLabel),
    designations: (data?.designations ?? [])
      .map((d) => ({ value: String(d.id), label: d.title }))
      .filter((o) => desigIds.has(o.value) || o.value === f.desig)
      .sort(byLabel),
  };
}

// ── The reasons ───────────────────────────────────────────────────────────────

export type ReasonMeta = {
  label: string;
  tone: Tone;
  /** Extra classes for a reason whose colour is not one of the portal's tones (the other payroll: its page's colour). */
  className?: string;
  /** What HR can do about it, in a few words. */
  hint: string;
};

/** The colour of each payroll (a category chip, the reason "paid on the other payroll"). */
export const CATEGORY_CLASS: Record<"staff" | "production", string> = {
  staff: "border-indigo-200 bg-indigo-50 text-indigo-700",
  production: "border-amber-200 bg-amber-50 text-amber-800",
};

const REASON_META: Record<string, ReasonMeta> = {
  not_generated: {
    label: "Not generated",
    tone: "danger",
    hint: "Would be paid: generate the payroll again to add the employee.",
  },
  skipped: { label: "Skipped by payroll", tone: "caution", hint: "Payroll could not work out a salary." },
  no_salary: { label: "No salary", tone: "caution", hint: "Set a monthly salary on the employee's profile." },
  on_hold: { label: "On hold", tone: "warning", hint: "Salary held for the month: release it under Skipped." },
  new_joiner: { label: "New joiner", tone: "accent", hint: "Kept aside until HR adds the employee to the payroll." },
  paid_separately: { label: "Paid separately", tone: "success", hint: "Released and paid on its own after the lock." },
  joined_after: { label: "Joined later", tone: "info", hint: "Joined after the month ended." },
  inactive: { label: "Inactive", tone: "neutral", hint: "Inactive employees are left out of the payroll." },
  other_cycle: { label: "Other pay cycle", tone: "info", hint: "Paid on another pay cycle's page." },
  no_cycle: {
    label: "No pay cycle",
    tone: "caution",
    hint: "Assign the employee to a pay cycle on Production Employees.",
  },
  production: {
    label: "Production",
    tone: "neutral",
    className: CATEGORY_CLASS.production,
    hint: "Paid on Production Payroll.",
  },
  staff: {
    label: "Staff",
    tone: "neutral",
    className: CATEGORY_CLASS.staff,
    hint: "Paid on the Staff Payroll.",
  },
};

/** Where a production page's words differ from the staff page's. */
const PRODUCTION_HINTS: Record<string, Partial<ReasonMeta>> = {
  no_salary: { label: "No rate per shift", hint: "Set a salary per shift on the employee's profile." },
  joined_after: { hint: "Joined after the period ended." },
  new_joiner: { hint: "Waiting in New Joiners until HR adds the worker to the payroll." },
};

/** The order the reason chips are shown in: the ones HR can act on first, the other payroll last. */
export const REASON_ORDER: readonly string[] = [
  "not_generated",
  "skipped",
  "no_salary",
  "no_cycle",
  "on_hold",
  "new_joiner",
  "paid_separately",
  "joined_after",
  "other_cycle",
  "inactive",
  "production",
  "staff",
];

/** "Paid separately"; a code the screen does not know yet reads as its own words ("left_company" -> "Left company"). */
export function reasonMeta(code: NotIncludedReasonCode | null | undefined, kind: PayrollKind = "staff"): ReasonMeta {
  const known = code ? REASON_META[code] : undefined;
  if (known) return kind === "production" && code ? { ...known, ...PRODUCTION_HINTS[code] } : known;
  const words = (code ?? "").replace(/[_-]+/g, " ").trim();
  return { label: words ? words.charAt(0).toUpperCase() + words.slice(1) : "Other", tone: "neutral", hint: "" };
}

export type ReasonChip = { code: string; label: string; count: number; tone: Tone; className?: string };

/** One chip per reason that has someone, in REASON_ORDER (codes the screen does not know yet come last, by name). */
export function reasonChips(
  byReason: PeriodNotIncluded["summary"]["byReason"] | null | undefined,
  kind: PayrollKind = "staff",
): ReasonChip[] {
  const entries = Object.entries(byReason ?? {}).filter(([, n]) => typeof n === "number" && n > 0) as [
    string,
    number,
  ][];
  const rank = (code: string) => {
    const i = REASON_ORDER.indexOf(code);
    return i === -1 ? REASON_ORDER.length : i;
  };
  return entries
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([code, count]) => {
      const meta = reasonMeta(code, kind);
      return { code, count, label: meta.label, tone: meta.tone, className: meta.className };
    });
}

/** The reason that means "paid on the other payroll": production employees on the staff page, staff on a production one. */
export const otherPayrollReason = (kind: PayrollKind): "production" | "staff" =>
  kind === "production" ? "staff" : "production";

/**
 * Clicking a reason chip: picks the reason (clicking it again shows every reason). The "other payroll" reason belongs to
 * the other category, so the category follows it (and comes back to the page's own when one of its reasons is picked).
 */
export function pickReason(
  current: NotIncludedFilters,
  code: string,
  kind: PayrollKind = "staff",
): Partial<NotIncludedFilters> {
  if (current.reason === code) return { reason: ALL };
  const other = otherPayrollReason(kind);
  if (code === other) return { reason: code, category: current.category === ALL ? ALL : other };
  return { reason: code, category: current.category === other ? defaultCategory(kind) : current.category };
}

// ── Labels ────────────────────────────────────────────────────────────────────

export const categoryLabel = (category: string | null | undefined): string =>
  category === "production" ? "Production" : category === "staff" ? "Staff" : (category ?? "—");

export const statusLabel = (e: Pick<NotIncludedEmployee, "status">): string => (isActive(e) ? "Active" : "Inactive");

/** "12 staff" / "30 employees": what the list counts, in the category chosen. */
export function listedNoun(category: NotIncludedCategory): string {
  return category === "staff" ? "staff employee" : category === "production" ? "production employee" : "employee";
}

// ── The export ────────────────────────────────────────────────────────────────

export const notIncludedColumns = (kind: PayrollKind = "staff"): TableColumn<NotIncludedEmployee>[] => [
  { key: "code", label: "Code", width: 12 },
  { key: "name", label: "Name", width: 26 },
  { key: "department", label: "Department", width: 20, value: (e) => e.department ?? "" },
  { key: "designation", label: "Designation", width: 22, value: (e) => e.designation ?? "" },
  { key: "unit", label: "Unit", width: 10, value: (e) => e.unit ?? "" },
  { key: "status", label: "Status", width: 10, value: statusLabel },
  { key: "category", label: "Category", width: 12, value: (e) => categoryLabel(e.category) },
  { key: "joinDate", label: "Joined", width: 14, type: "date", value: (e) => e.joinDate ?? "" },
  { key: "reasonCode", label: "Reason code", width: 18, value: (e) => reasonMeta(e.reasonCode, kind).label },
  { key: "reason", label: "Reason", width: 48 },
  { key: "detail", label: "Detail", width: 48, value: (e) => e.detail ?? "" },
];

/** The staff columns (kept for the staff exports and tests). */
export const NOT_INCLUDED_COLUMNS: TableColumn<NotIncludedEmployee>[] = notIncludedColumns("staff");

/** "Not_included_November_2026" / "Not_included_Weekly_2026_02_02_2026_02_08". */
export function notIncludedFileStem(scope: PayrollScope): string {
  return scope.kind === "staff"
    ? fileStem("Not included", monthYear(scope.month, scope.year))
    : fileStem("Not included", PAY_CYCLE_INFO[scope.cycle]?.label ?? scope.cycle, scope.periodStart, scope.periodEnd);
}
