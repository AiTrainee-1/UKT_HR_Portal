// Report Center: API types + how filter values become a query string (and back).
// The backend (api/reporting/filters.py) is the source of truth for parameter names.

import type { ColumnType } from "./report-format";

export type FilterKind =
  | "period"
  | "year"
  | "dateRange"
  | "department"
  | "designation"
  | "branch"
  | "employee"
  | "employmentType"
  | "employeeStatus"
  | "select"
  | "boolean"
  | "text"
  | "number";

export interface FilterOption {
  value: string;
  label: string;
}

export interface ReportFilter {
  key: string;
  kind: FilterKind;
  label: string;
  required: boolean;
  multi: boolean;
  /** period: "2026-09"; year: 2026; dateRange: {dateFrom, dateTo}; id lists: []; boolean: bool */
  default: unknown;
  options?: FilterOption[];
  help?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  maxDays?: number;
  /** A saved custom report's filter whose saved value (its default) an EMPTY parameter widens to "all": the server
   *  reads a parameter left out as the saved value, so a cleared one must travel empty (api/reporting/custom/build.py
   *  SavedReportSpec). Absent on every other report. */
  clearable?: boolean;
}

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  width: number;
  total: "sum" | "count" | "avg" | null;
  align: "left" | "center" | "right" | null;
}

/** The row ceilings the server applies to a report (api/reporting/runner.limit_for): on screen, in Excel, in a PDF.
 *  Counted in data rows (subtotal and total lines do not count). */
export interface ExportLimits {
  screen: number;
  xlsx: number;
  pdf: number;
}

export interface ReportMeta {
  id: string;
  title: string;
  description: string;
  category: string;
  icon: string;
  tags: string[];
  family: string | null;
  variant: string | null;
  landscape: boolean;
  filters: ReportFilter[];
  columns: ReportColumn[];
  dynamicColumns: boolean;
  exports: ("xlsx" | "pdf")[];
  /** Absent from an older server: the limits are then only learnt from a refused download. */
  exportLimits?: ExportLimits;
  /** false: opening the report waits for "Show report" (its defaults are too heavy to run on every open). */
  autoRun?: boolean;
}

export interface ReportCategory {
  id: string;
  label: string;
  description: string;
  icon: string;
  count: number;
}

export interface NamedOption {
  id: number;
  name: string;
  /** Departments and designations: Staff or Production (lib/departments.ts). */
  category?: "staff" | "production" | null;
  /** Departments: the branch, which tells two same-named departments of one kind apart. */
  branchId?: number | null;
  branchName?: string | null;
  /** Designations: their department. */
  departmentId?: number | null;
}

export interface ReportCatalog {
  generatedAt: string;
  branchScoped: boolean;
  categories: ReportCategory[];
  reports: ReportMeta[];
  options: { departments: NamedOption[]; designations: NamedOption[]; branches: NamedOption[] };
}

export interface ReportSummaryCard {
  label: string;
  value: number | string | null;
  format: ColumnType;
}

export type ReportRow = Record<string, unknown> & { _kind?: "subtotal" | "total" };

export interface ReportRunResult {
  id: string;
  title: string;
  category: string;
  generatedAt: string;
  generatedBy: string;
  filters: { label: string; value: string }[];
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number | null> | null;
  summary: ReportSummaryCard[];
  notes: string[];
  rowCount: number;
  truncated: boolean;
  limit: number;
}

export type DateRangeValue = { dateFrom: string; dateTo: string };
export type FilterValue = string | number | boolean | string[] | DateRangeValue | null | undefined;
export type FilterValues = Record<string, FilterValue>;

/** Query-parameter name for the multi-id filters. */
const ID_PARAM: Record<string, string> = {
  department: "departmentIds",
  designation: "designationIds",
  branch: "branchIds",
  employee: "employeeIds",
};

export function defaultValues(filters: ReportFilter[]): FilterValues {
  const out: FilterValues = {};
  for (const f of filters) {
    out[f.key] = (f.default as FilterValue) ?? (f.multi || f.kind in ID_PARAM ? [] : "");
  }
  return out;
}

function asList(v: FilterValue): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (v === null || v === undefined || v === "") return [];
  return String(v).split(",").filter(Boolean);
}

/** A tick box the server treats as ticked when the query does not mention it. */
export function isOnByDefault(f: ReportFilter): boolean {
  return f.kind === "boolean" && (f.default === true || f.default === "true");
}

/** A single select may offer "All" only when the server reads "nothing chosen" as all: with a default of its own, an
 *  empty value would quietly come back as that default (filters.py parse_params) - unless the filter is `clearable`
 *  (a saved custom report's: an empty value travels and means all). */
export function offersAny(f: ReportFilter): boolean {
  return !f.required && (f.clearable === true || f.default === null || f.default === undefined || f.default === "");
}

/** The query-parameter names a filter travels under (a date range is two: dateFrom and dateTo). */
export function filterParamNames(f: ReportFilter): string[] {
  if (f.kind === "dateRange") return ["dateFrom", "dateTo"];
  if (f.kind in ID_PARAM) return [ID_PARAM[f.kind]];
  if (f.kind === "select" || f.kind === "boolean" || f.kind === "text" || f.kind === "number") return [f.key];
  return [f.kind];
}

/** Whether the URL carries any of the report's filters (a shared link or a variant switch, not a plain "open"). */
export function hasFilterParams(filters: ReportFilter[], q: URLSearchParams): boolean {
  return filters.some((f) => filterParamNames(f).some((name) => q.has(name)));
}

/** The filter a server error points at: its `field` is a parameter name ("dateTo", "departmentIds", "period") or, for
 *  a report's own check, a filter key or kind ("employee"). Null when it names none of this report's filters. */
export function filterKeyForParam(filters: ReportFilter[], param: string | null | undefined): string | null {
  if (!param) return null;
  const hit =
    filters.find((f) => filterParamNames(f).includes(param)) ??
    filters.find((f) => f.key === param) ??
    filters.find((f) => f.kind === param);
  return hit ? hit.key : null;
}

/** Filter values -> query string (empty values are omitted, so the server applies its defaults; a `clearable` filter's
 *  empty value is sent empty instead, which the server reads as "all"). */
export function buildQuery(filters: ReportFilter[], values: FilterValues): URLSearchParams {
  const q = new URLSearchParams();
  for (const f of filters) {
    const v = values[f.key];
    switch (f.kind) {
      case "dateRange": {
        const r = v as DateRangeValue | undefined;
        if (r?.dateFrom) q.set("dateFrom", r.dateFrom);
        if (r?.dateTo) q.set("dateTo", r.dateTo);
        break;
      }
      case "department":
      case "designation":
      case "branch":
      case "employee": {
        const ids = asList(v);
        if (ids.length || f.clearable) q.set(ID_PARAM[f.kind], ids.join(","));
        break;
      }
      case "select": {
        const list = asList(v);
        if (list.length || f.clearable) q.set(f.key, list.join(","));
        break;
      }
      case "boolean":
        // An absent tick box means "the default" to the server, so a box that is ON by default and switched off must
        // say so ("false"); one that is off by default only travels when ticked.
        if (v === true) q.set(f.key, "true");
        else if (v === false && isOnByDefault(f)) q.set(f.key, "false");
        break;
      case "employmentType":
      case "employeeStatus":
      case "period":
      case "year":
      case "text":
      case "number": {
        const name = f.kind === "text" || f.kind === "number" ? f.key : f.kind;
        if (v !== null && v !== undefined && v !== "") q.set(name, String(v));
        else if (f.clearable) q.set(name, "");
        break;
      }
    }
  }
  return q;
}

/** Query string -> filter values (anything absent falls back to the filter's default). */
export function parseQuery(filters: ReportFilter[], q: URLSearchParams): FilterValues {
  const out = defaultValues(filters);
  for (const f of filters) {
    switch (f.kind) {
      case "dateRange": {
        const from = q.get("dateFrom");
        const to = q.get("dateTo");
        if (from || to) {
          const d = f.default as DateRangeValue | undefined;
          out[f.key] = { dateFrom: from ?? d?.dateFrom ?? "", dateTo: to ?? d?.dateTo ?? "" };
        }
        break;
      }
      case "department":
      case "designation":
      case "branch":
      case "employee": {
        const raw = q.get(ID_PARAM[f.kind]);
        if (raw !== null) out[f.key] = raw.split(",").filter(Boolean);
        break;
      }
      case "select": {
        const raw = q.get(f.key);
        if (raw !== null) out[f.key] = f.multi ? raw.split(",").filter(Boolean) : raw;
        break;
      }
      case "boolean": {
        const raw = q.get(f.key);
        if (raw !== null) out[f.key] = raw === "true";
        break;
      }
      case "text":
      case "number": {
        const raw = q.get(f.key);
        if (raw !== null) out[f.key] = raw;
        break;
      }
      default: {
        const raw = q.get(f.kind);
        if (raw !== null) out[f.key] = f.kind === "year" ? Number(raw) || raw : raw;
      }
    }
  }
  return out;
}

/** First problem that would make the server reject the filters, in plain words (or null). */
export function validateFilters(filters: ReportFilter[], values: FilterValues): string | null {
  for (const f of filters) {
    const v = values[f.key];
    if (f.kind === "dateRange") {
      const r = (v ?? {}) as Partial<DateRangeValue>;
      if (f.required && (!r.dateFrom || !r.dateTo)) return "Choose both a From and a To date.";
      if (r.dateFrom && r.dateTo) {
        if (r.dateFrom > r.dateTo) return "The From date is after the To date.";
        if (f.maxDays) {
          const days = Math.round((Date.parse(r.dateTo) - Date.parse(r.dateFrom)) / 86_400_000) + 1;
          if (days > f.maxDays) return `Pick at most ${f.maxDays} days for this report.`;
        }
      }
    } else if (f.required && (v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length))) {
      return `${f.label} is required.`;
    }
  }
  return null;
}

// ── date presets ──────────────────────────────────────────────────────────

export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface DatePreset {
  id: string;
  label: string;
  range: DateRangeValue;
}

/** Quick ranges for the date filter, relative to `today` (local time; the app is single-timezone). */
export function datePresets(today: Date): DatePreset[] {
  const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastMonthEnd = addDays(monthStart, -1);
  const lastMonthStart = new Date(lastMonthEnd.getFullYear(), lastMonthEnd.getMonth(), 1);
  const weekStart = addDays(today, -((today.getDay() + 6) % 7)); // Monday
  const qStartMonth = Math.floor(today.getMonth() / 3) * 3;
  const fyStartYear = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const r = (a: Date, b: Date): DateRangeValue => ({ dateFrom: isoDate(a), dateTo: isoDate(b) });
  return [
    { id: "today", label: "Today", range: r(today, today) },
    { id: "yesterday", label: "Yesterday", range: r(addDays(today, -1), addDays(today, -1)) },
    { id: "week", label: "This week", range: r(weekStart, today) },
    { id: "last7", label: "Last 7 days", range: r(addDays(today, -6), today) },
    { id: "month", label: "This month", range: r(monthStart, today) },
    { id: "lastMonth", label: "Last month", range: r(lastMonthStart, lastMonthEnd) },
    { id: "quarter", label: "This quarter", range: r(new Date(today.getFullYear(), qStartMonth, 1), today) },
    { id: "fy", label: "Financial year", range: r(new Date(fyStartYear, 3, 1), today) },
  ];
}

/** "2026-09" <-> {year, month}; navigation helpers for the month picker. */
export function shiftPeriod(period: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const d = new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function periodLabel(period: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (!m) return period;
  const names = [
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
  return `${names[Number(m[2]) - 1]} ${m[1]}`;
}

// ── last used filters ───────────────────────────────────────────────────────

/**
 * What the Report Center remembers of a report's last run, per browser (lib/report-prefs.ts). Only WHO the report
 * covers and HOW it is laid out (branch, department, designation, employee type and status, the report's own options)
 * are kept as values. Months, years and date ranges are kept only as a relative choice ("last month", "this week") and
 * worked out again on the next visit, so a November visit never silently re-runs September. Employees and free text are
 * not kept at all (a one-off choice, and a shared HR PC).
 */
export interface RememberedFilters {
  /** Query string of the remembered filters that differ from the report's defaults. */
  query: string;
  /** filter key -> relative token: thisMonth / lastMonth, thisYear / lastYear, or a date preset id (datePresets). */
  relative: Record<string, string>;
}

const REMEMBERED_KINDS: ReadonlySet<FilterKind> = new Set<FilterKind>([
  "branch",
  "department",
  "designation",
  "employmentType",
  "employeeStatus",
  "select",
  "boolean",
  "number",
]);

/** When two presets give the same dates (the 1st of a month: "Today" = "This month") the broader, likelier one wins. */
const PRESET_PREFERENCE = ["month", "lastMonth", "quarter", "fy", "week", "last7", "yesterday", "today"];

const periodOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

/** The relative choice a month / year / date range value stands for today, or null for a fixed one. */
export function relativeToken(f: ReportFilter, v: FilterValue, today: Date): string | null {
  if (f.kind === "period") {
    const now = periodOf(today);
    if (v === now) return "thisMonth";
    if (v === shiftPeriod(now, -1)) return "lastMonth";
    return null;
  }
  if (f.kind === "year") {
    const y = Number(v);
    if (y === today.getFullYear()) return "thisYear";
    if (y === today.getFullYear() - 1) return "lastYear";
    return null;
  }
  if (f.kind === "dateRange") {
    const r = v as Partial<DateRangeValue> | null | undefined;
    if (!r?.dateFrom || !r.dateTo) return null;
    const presets = datePresets(today);
    for (const id of PRESET_PREFERENCE) {
      const p = presets.find((x) => x.id === id);
      if (p && p.range.dateFrom === r.dateFrom && p.range.dateTo === r.dateTo) return id;
    }
  }
  return null;
}

/** A relative token back to a value for `today` (undefined when the token does not fit the filter). */
export function resolveToken(f: ReportFilter, token: string, today: Date): FilterValue | undefined {
  if (f.kind === "period") {
    if (token === "thisMonth") return periodOf(today);
    if (token === "lastMonth") return shiftPeriod(periodOf(today), -1);
  } else if (f.kind === "year") {
    if (token === "thisYear") return today.getFullYear();
    if (token === "lastYear") return today.getFullYear() - 1;
  } else if (f.kind === "dateRange") {
    return datePresets(today).find((p) => p.id === token)?.range;
  }
  return undefined;
}

const sameAs = (f: ReportFilter, a: FilterValue, b: FilterValue) =>
  buildQuery([f], { [f.key]: a }).toString() === buildQuery([f], { [f.key]: b }).toString();

/** What to remember after a run with `values` (null: nothing differs from the defaults, so nothing to remember). */
export function rememberFilters(filters: ReportFilter[], values: FilterValues, today: Date): RememberedFilters | null {
  const defaults = defaultValues(filters);
  const q = new URLSearchParams();
  const relative: Record<string, string> = {};
  for (const f of filters) {
    if (sameAs(f, values[f.key], defaults[f.key])) continue;
    if (REMEMBERED_KINDS.has(f.kind)) {
      buildQuery([f], values).forEach((value, name) => q.set(name, value));
    } else {
      const token = relativeToken(f, values[f.key], today);
      if (token) relative[f.key] = token;
    }
  }
  const query = q.toString();
  return query || Object.keys(relative).length ? { query, relative } : null;
}

/** Ids an org filter can still offer (a department deleted since the last visit is dropped, not sent). */
function knownIds(f: ReportFilter, options?: ReportCatalog["options"]): Set<string> | null {
  if (!options) return null;
  const list =
    f.kind === "department"
      ? options.departments
      : f.kind === "designation"
        ? options.designations
        : f.kind === "branch"
          ? options.branches
          : null;
  return list ? new Set(list.map((o) => String(o.id))) : null;
}

/**
 * The values to open a report with from what was remembered: its defaults, with the remembered filters on top. A value
 * the report no longer offers (a removed option, a deleted department) is dropped. `restored` names the filters that
 * came back different from the defaults (empty: the report opens exactly as a first visit would).
 */
export function restoreFilters(
  filters: ReportFilter[],
  remembered: RememberedFilters,
  today: Date,
  options?: ReportCatalog["options"],
): { values: FilterValues; restored: string[] } {
  const values = defaultValues(filters);
  const parsed = parseQuery(filters, new URLSearchParams(remembered.query));
  const restored: string[] = [];
  for (const f of filters) {
    let next: FilterValue | undefined;
    if (REMEMBERED_KINDS.has(f.kind)) {
      next = parsed[f.key];
      if (f.kind === "select" && f.options) {
        const offered = new Set(f.options.map((o) => o.value));
        const picked = asList(next);
        if (picked.some((p) => !offered.has(p))) next = undefined;
      }
      const known = knownIds(f, options);
      if (known && Array.isArray(next)) next = next.filter((id) => known.has(String(id)));
    } else {
      const token = remembered.relative[f.key];
      next = token ? resolveToken(f, token, today) : undefined;
    }
    if (next === undefined || sameAs(f, next, values[f.key])) continue;
    values[f.key] = next;
    restored.push(f.label);
  }
  return { values, restored };
}
