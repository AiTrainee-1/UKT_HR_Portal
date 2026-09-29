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
}

export interface ReportColumn {
  key: string;
  label: string;
  type: ColumnType;
  width: number;
  total: "sum" | "count" | "avg" | null;
  align: "left" | "center" | "right" | null;
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

/** Filter values -> query string (empty values are omitted, so the server applies its defaults). */
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
        if (ids.length) q.set(ID_PARAM[f.kind], ids.join(","));
        break;
      }
      case "select": {
        const list = asList(v);
        if (list.length) q.set(f.key, list.join(","));
        break;
      }
      case "boolean":
        if (v === true) q.set(f.key, "true");
        break;
      case "employmentType":
      case "employeeStatus":
      case "period":
      case "year":
      case "text":
      case "number": {
        if (v !== null && v !== undefined && v !== "")
          q.set(f.kind === "text" || f.kind === "number" ? f.key : f.kind, String(v));
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
