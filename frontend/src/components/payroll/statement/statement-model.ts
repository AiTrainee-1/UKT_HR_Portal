import type { SalaryStatement, StatementColumn, StatementGroup, StatementRow } from "@/lib/api-client/custom-hooks";
import { ddmmyyyy, fileStem } from "@/components/payroll/kit/format";

// The pure half of the Salary Statement: filtering with recomputed totals, pagination into printed pages, cell
// formatting, column widths and the titles. No React, no DOM: the on-screen view, the Excel / PDF exports and the print
// sheets all read the same functions, so the statement says the same thing everywhere.

export type StatementAccent = "indigo" | "amber";
export type ColumnGroupKey = StatementColumn["group"];
export type CellValue = number | string | null;

/** The select value that means "no filter". */
export const ALL = "all";

/** Lines (bands + rows + subtotals + total) on one printed A4 landscape page: the reference prints ~15 employees a page. */
export const DEFAULT_ROWS_PER_PAGE = 18;
/** A page can never be shorter than this: the biggest block that has to stay together (band + row + subtotal + total). */
export const MIN_ROWS_PER_PAGE = 5;

// ── Reading a row ────────────────────────────────────────────────────────────

/** A number from a cell that may arrive as a decimal string ("14750.00") or not at all. */
export function toNumber(value: CellValue | undefined): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** What a row holds under a column. The serial number lives on the row itself (`row.sno`), everything else in `values`. */
export function cellValue(row: StatementRow, column: StatementColumn): CellValue {
  if (column.key === "sno") return row.sno ?? row.values.sno ?? null;
  const v = row.values[column.key];
  return v === undefined ? null : v;
}

const textOf = (v: CellValue | undefined): string => (v === null || v === undefined ? "" : String(v));
export const rowName = (row: StatementRow): string => textOf(row.values.name);
export const rowCode = (row: StatementRow): string => textOf(row.values.code);

export const statementRowCount = (statement: SalaryStatement): number =>
  statement.groups.reduce((n, g) => n + g.rows.length, 0);

export type DepartmentOption = { key: string; label: string; count: number };

/** The departments of the statement, for the department filter. */
export const departmentOptions = (statement: SalaryStatement): DepartmentOption[] =>
  statement.groups.map((g) => ({ key: g.key, label: g.label, count: g.rows.length }));

// ── Totals and filtering ─────────────────────────────────────────────────────

/** Sums a column over rows. Money and days go through whole paise so 0.1 + 0.2 stays 0.30, never 0.30000000000000004. */
function sumColumn(column: StatementColumn, rows: StatementRow[]): number {
  if (column.format === "int") {
    let total = 0;
    for (const r of rows) total += toNumber(cellValue(r, column)) ?? 0;
    return total;
  }
  let cents = 0;
  for (const r of rows) cents += Math.round((toNumber(cellValue(r, column)) ?? 0) * 100);
  return cents / 100;
}

/** A subtotal / total line for `rows`: every column that adds up is summed, the others stay empty. */
export function buildTotalRow(columns: StatementColumn[], rows: StatementRow[]): StatementRow {
  const values: Record<string, CellValue> = {};
  for (const col of columns) values[col.key] = col.total ? sumColumn(col, rows) : null;
  return { payrollId: null, employeeId: null, sno: null, status: null, values };
}

export function countStatement(groups: StatementGroup[]): SalaryStatement["counts"] {
  let employees = 0;
  let paid = 0;
  let pending = 0;
  for (const g of groups) {
    for (const r of g.rows) {
      employees += 1;
      if (r.status === "paid") paid += 1;
      else if (r.status === "pending") pending += 1;
    }
  }
  return { employees, departments: groups.length, paid, pending };
}

export type StatementFilters = {
  /** Matches the employee's name or ID no, any case. */
  search?: string;
  /** A department's group key; "all" or empty keeps every department. */
  department?: string;
  /** "paid" | "pending"; "all" or empty keeps every row. */
  status?: string;
};

const clean = (v: string | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" || t === ALL ? null : t;
};

export const isFiltering = (f: StatementFilters): boolean =>
  (f.search ?? "").trim() !== "" || clean(f.department) !== null || clean(f.status) !== null;

/**
 * The statement with only the rows that match. Subtotals, the grand total and the counts are RECOMPUTED from the rows that
 * are left (a filtered statement must add up on its own page); serial numbers stay the server's, and a department with
 * no row left is dropped. With no filter the statement is returned as it is, server totals and all.
 */
export function filterStatement(statement: SalaryStatement, filters: StatementFilters = {}): SalaryStatement {
  if (!isFiltering(filters)) return statement;
  const query = (filters.search ?? "").trim().toLowerCase();
  const department = clean(filters.department);
  const status = clean(filters.status);
  const groups: StatementGroup[] = [];
  for (const group of statement.groups) {
    if (department !== null && group.key !== department) continue;
    const rows = group.rows.filter((row) => {
      if (status !== null && row.status !== status) return false;
      if (query === "") return true;
      return rowName(row).toLowerCase().includes(query) || rowCode(row).toLowerCase().includes(query);
    });
    if (rows.length === 0) continue;
    groups.push({ ...group, rows, subtotal: buildTotalRow(statement.columns, rows) });
  }
  const all = groups.flatMap((g) => g.rows);
  return { ...statement, groups, total: buildTotalRow(statement.columns, all), counts: countStatement(groups) };
}

// ── Cells ────────────────────────────────────────────────────────────────────

/** Columns whose empty cells stay blank instead of showing a dash (most rows have no remark). */
const BLANK_WHEN_EMPTY = ["remarks"];

/**
 * Indian grouping with a fixed number of decimals, one cached formatter per precision: a statement formats thousands of
 * figures, and building a formatter (what `toLocaleString` does on every call) is what makes that slow.
 */
const formatters = new Map<number, Intl.NumberFormat>();
export function formatNumber(value: number, digits: number): string {
  let formatter = formatters.get(digits);
  if (!formatter) {
    formatter = new Intl.NumberFormat("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    formatters.set(digits, formatter);
  }
  return formatter.format(value);
}

export type FormattedCell = {
  text: string;
  /** A number that is exactly zero: drawn muted so the real figures stand out. */
  zero: boolean;
  /** No value at all (null / empty). */
  empty: boolean;
};

/**
 * One cell as text: `money` and `days` carry two decimals ("1,67,462.00", "24.50"), `int` none, `text` is shown as is.
 * Nothing at all reads as a dash; it is blank in the Remarks column and on a subtotal line (`blankNull`), where most
 * columns do not add up.
 */
export function formatCell(
  column: StatementColumn,
  value: CellValue | undefined,
  options: { blankNull?: boolean } = {},
): FormattedCell {
  const blank = options.blankNull ?? BLANK_WHEN_EMPTY.includes(column.key);
  const nothing: FormattedCell = { text: blank ? "" : "—", zero: false, empty: true };
  if (value === null || value === undefined || value === "") return nothing;
  if (column.format === "text") return { text: String(value), zero: false, empty: false };
  const n = toNumber(value);
  // a number column holding words (the server's own note): shown untouched
  if (n === null) return typeof value === "string" ? { text: value, zero: false, empty: false } : nothing;
  const digits = column.format === "int" ? 0 : 2;
  const rounded = Math.round(n * 10 ** digits) / 10 ** digits;
  const shown = rounded === 0 ? 0 : n; // never "-0.00"
  return { text: formatNumber(shown, digits), zero: rounded === 0, empty: false };
}

export type RemarkTone = "danger" | "info" | "warning" | "neutral";

const REMARK_TONES: [RegExp, RemarkTone][] = [
  [/\b(left|resign|abscond|terminat|retire)/i, "danger"],
  [/\b(join|new)/i, "info"],
  [/\b(hold|held|stop|review)/i, "warning"],
];

/** The Remarks cell as small labels: "LEFT, JOINED 12-09-2026" -> two chips, each with a tone. */
export function remarkChips(text: CellValue | undefined): { label: string; tone: RemarkTone }[] {
  return textOf(text)
    .split(/[;,|]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((label) => ({ label, tone: REMARK_TONES.find(([re]) => re.test(label))?.[1] ?? "neutral" }));
}

// ── Columns ──────────────────────────────────────────────────────────────────

export const GROUP_LABEL: Record<ColumnGroupKey, string> = {
  identity: "Employee",
  attendance: "Attendance",
  earnings: "Earnings",
  deductions: "Deductions",
  result: "Net pay",
};

export type ColumnBand = {
  group: ColumnGroupKey;
  label: string;
  /** Index of the first column of the band. */
  start: number;
  span: number;
  /** The second half of a band that was cut at `splitAt` (same group, label not repeated). */
  continued: boolean;
};

/**
 * The bands of the grouped header: runs of neighbouring columns of the same group. `splitAt` cuts a band in two at that
 * column index (the on-screen table cuts "Employee" where the sticky columns end).
 */
export function columnBands(columns: StatementColumn[], splitAt = 0): ColumnBand[] {
  const bands: ColumnBand[] = [];
  columns.forEach((col, i) => {
    const last = bands[bands.length - 1];
    const cut = splitAt > 0 && i === splitAt;
    if (last && last.group === col.group && !cut) {
      last.span += 1;
    } else {
      const continued = !!last && last.group === col.group && cut;
      bands.push({ group: col.group, label: GROUP_LABEL[col.group], start: i, span: 1, continued });
    }
  });
  return bands;
}

/** One unit of `weight` on screen; a weight of 1 is a narrow number column. */
export const COLUMN_UNIT_PX = 84;

const MIN_COLUMN_PX: Record<StatementColumn["format"], number> = { text: 64, int: 52, days: 64, money: 96 };

/** A column's on-screen width: its weight, but never narrower than the biggest figure of its kind needs. */
export function columnWidthPx(column: StatementColumn, unit = COLUMN_UNIT_PX): number {
  const weight = Number.isFinite(column.weight) && column.weight > 0 ? column.weight : 1;
  return Math.max(MIN_COLUMN_PX[column.format] ?? 64, Math.round(weight * unit));
}

export const columnWidthsPx = (columns: StatementColumn[], unit = COLUMN_UNIT_PX): number[] =>
  columns.map((c) => columnWidthPx(c, unit));

/**
 * The widths to draw when `room` pixels are available: the natural widths when the table is wider than the room (it then
 * scrolls), otherwise every column stretched by the same factor so the table fills the room. The widths always add up to
 * what is drawn, which is what keeps the sticky columns' offsets (the sum of the widths before them) exact.
 */
export function fitWidths(widths: number[], room: number): number[] {
  const total = widths.reduce((sum, w) => sum + w, 0);
  if (!Number.isFinite(room) || room <= total || total <= 0) return widths;
  const target = Math.floor(room);
  const scaled = widths.map((w) => Math.floor((w * target) / total));
  scaled[scaled.length - 1] += target - scaled.reduce((sum, w) => sum + w, 0);
  return scaled;
}

/** The identity columns that stay in view while the table scrolls sideways: SNO, ID NO and Name. */
const STICKY_KEYS = ["sno", "code", "name"];

/** How many of the leading columns are sticky (those that are SNO / ID NO / Name, in a row from the first column). */
export function stickyCount(columns: StatementColumn[]): number {
  let n = 0;
  while (n < columns.length && STICKY_KEYS.includes(columns[n].key)) n += 1;
  return n;
}

/** The `left` offset of each of the first `count` columns: the widths before it, added up. */
export function stickyOffsets(widths: number[], count: number): number[] {
  const out: number[] = [];
  let left = 0;
  for (let i = 0; i < count; i += 1) {
    out.push(left);
    left += widths[i] ?? 0;
  }
  return out;
}

/** How many columns at the start are identity columns (SNO .. Designation): where a subtotal's label may stretch to. */
export function leadingIdentityCount(columns: StatementColumn[]): number {
  let n = 0;
  while (n < columns.length && columns[n].group === "identity") n += 1;
  return n;
}

// ── Titles ───────────────────────────────────────────────────────────────────

export const GRAND_TOTAL_LABEL = "GRAND TOTAL";
export const subtotalLabel = (department: string): string => `${department} - Total`;

/** "U.K TEXTILES - H.O": the company and, when there is one, the branch. */
export function statementHeadline(statement: SalaryStatement): string {
  const { name, branchLabel } = statement.company;
  return branchLabel ? `${name} - ${branchLabel}` : name;
}

/** "Salary Statement From 01-09-2026 To 30-09-2026". A server title that already carries the dates is used as it is. */
export function statementTitle(statement: SalaryStatement): string {
  const title = statement.title?.trim() || "Salary Statement";
  const from = statement.period.fromLabel || ddmmyyyy(statement.period.start);
  const to = statement.period.toLabel || ddmmyyyy(statement.period.end);
  return title.includes(from) ? title : `${title} From ${from} To ${to}`;
}

/** "Salary_Statement_October_2026" (production: "Salary_Statement_Production_2_Feb_8_Feb_2026"), without extension. */
export const statementFileStem = (statement: SalaryStatement): string =>
  fileStem("Salary_Statement", statement.kind === "production" ? "Production" : null, statement.period.label);

/** "13-10-2026 10:42" in the viewer's time zone; `fallback` when the stamp is missing or not a date. */
export function formatStamp(iso: string | null | undefined, fallback: Date = new Date()): string {
  const parsed = iso ? new Date(iso) : fallback;
  const d = Number.isNaN(parsed.getTime()) ? fallback : parsed;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ── Pages ────────────────────────────────────────────────────────────────────

export type StatementLine =
  /** A department's band; `continued` marks the "(contd.)" band a department gets when it carries over to a new page. */
  | { kind: "band"; key: string; label: string; count: number; continued: boolean }
  | { kind: "row"; groupKey: string; row: StatementRow }
  | { kind: "subtotal"; groupKey: string; label: string; row: StatementRow }
  | { kind: "total"; row: StatementRow };

export type StatementPage = {
  /** 1-based. */
  number: number;
  lines: StatementLine[];
  /** Only the last page carries the grand total (and, printed under it, the notes). */
  last: boolean;
};

/**
 * Cuts the statement into printed pages of at most `rowsPerPage` lines (bands, rows and subtotals all count; the header is
 * repeated on every page and is not counted). Rules, as on the printed statement:
 *  - a department band is never left alone at the bottom of a page (it travels with its first row),
 *  - the last row of a department travels with its subtotal, and the last department's with the grand total,
 *  - a department that carries over starts the next page with a "(contd.)" band,
 *  - `reserveLastPage` lines are kept free on the last page (the notes printed under the table).
 */
export function paginateStatement(
  statement: SalaryStatement,
  rowsPerPage: number = DEFAULT_ROWS_PER_PAGE,
  options: { reserveLastPage?: number } = {},
): StatementPage[] {
  const cap = Math.max(
    MIN_ROWS_PER_PAGE,
    Math.floor(Number.isFinite(rowsPerPage) ? rowsPerPage : DEFAULT_ROWS_PER_PAGE),
  );
  const reserve = Math.min(Math.max(0, Math.floor(options.reserveLastPage ?? 0)), cap - MIN_ROWS_PER_PAGE);

  type Block = { lines: StatementLine[]; group: StatementGroup | null; final: boolean };
  const groups = statement.groups.filter((g) => g.rows.length > 0);
  const blocks: Block[] = [];
  groups.forEach((group, gi) => {
    const lastGroup = gi === groups.length - 1;
    group.rows.forEach((row, ri) => {
      const lines: StatementLine[] = [];
      if (ri === 0) {
        lines.push({ kind: "band", key: group.key, label: group.label, count: group.rows.length, continued: false });
      }
      lines.push({ kind: "row", groupKey: group.key, row });
      const lastRow = ri === group.rows.length - 1;
      if (lastRow) {
        lines.push({ kind: "subtotal", groupKey: group.key, label: subtotalLabel(group.label), row: group.subtotal });
        if (lastGroup) lines.push({ kind: "total", row: statement.total });
      }
      blocks.push({ lines, group, final: lastRow && lastGroup });
    });
  });
  if (groups.length === 0) blocks.push({ lines: [{ kind: "total", row: statement.total }], group: null, final: true });

  const pages: StatementPage[] = [];
  let current: StatementLine[] = [];
  const flush = () => {
    if (current.length > 0) pages.push({ number: pages.length + 1, lines: current, last: false });
    current = [];
  };
  for (const block of blocks) {
    const room = (block.final ? cap - reserve : cap) - current.length;
    if (current.length > 0 && block.lines.length > room) flush();
    if (current.length === 0 && block.group && block.lines[0].kind !== "band") {
      current.push({
        kind: "band",
        key: block.group.key,
        label: block.group.label,
        count: block.group.rows.length,
        continued: true,
      });
    }
    current.push(...block.lines);
  }
  flush();
  pages[pages.length - 1].last = true;
  return pages;
}
