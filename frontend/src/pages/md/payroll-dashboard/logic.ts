// Pure logic of the MD Payroll page (/md/payroll): the page state in the address, the figures the cards derive from the
// contract (types.ts), chart rows, sorting and paging. No React here, so it is unit-tested on its own (logic.test.ts).

import { changeTone, inr, inrCompact, monthText, num, signed, type Tone } from "@/lib/md/format";
import type { ScopeChoice } from "@/lib/md/period";
import type {
  PayChange,
  PayDepartmentRow,
  PayFigures,
  PayMonthRow,
  PayMonthlyResponse,
  PayPersonMonth,
  PayPersonRow,
} from "./types";

const dash = "—";

const round2 = (n: number) => Math.round(n * 100) / 100;

// ── the page state in the address ─────────────────────────────────────────────────────────────────────────────────

export type DashView = "monthly" | "departments" | "employees";
export const VIEWS: DashView[] = ["monthly", "departments", "employees"];

/** The people list's server-side sort keys (contract 3). */
export type PeopleSort =
  | "name"
  | "code"
  | "department"
  | "actualSalary"
  | "earnedSalary"
  | "attendanceDeduction"
  | "deductions"
  | "netPaid"
  | "companyCost"
  | "clDays"
  | "clAmount";

export const PEOPLE_SORTS: PeopleSort[] = [
  "name",
  "code",
  "department",
  "actualSalary",
  "earnedSalary",
  "attendanceDeduction",
  "deductions",
  "netPaid",
  "companyCost",
  "clDays",
  "clAmount",
];

export const PEOPLE_SORT_LABEL: Record<PeopleSort, string> = {
  name: "Name",
  code: "Employee code",
  department: "Department",
  actualSalary: "Actual salary",
  earnedSalary: "Earned salary",
  attendanceDeduction: "Attendance deductions",
  deductions: "Deductions",
  netPaid: "Net paid",
  companyCost: "Company cost",
  clDays: "CL days",
  clAmount: "CL amount",
};

export type SortDir = "asc" | "desc";
export type EmploymentType = "" | "staff" | "production";

export type DashState = {
  view: DashView;
  /** "YYYY-MM"; "" = the latest month with slips (the server decides) */
  month: string;
  /** a unit id */
  branch: string;
  /** a department NAME (a name in several units covers all of them) */
  department: string;
  type: EmploymentType;
  /** the people search: a name or an employee code */
  q: string;
  /** the employee whose history is open (the Employees tab) */
  employee: number | null;
  sort: PeopleSort;
  dir: SortDir;
  page: number;
};

export const DEFAULT_STATE: DashState = {
  view: "monthly",
  month: "",
  branch: "",
  department: "",
  type: "",
  q: "",
  employee: null,
  sort: "name",
  dir: "asc",
  page: 1,
};

const TEXT_SORTS = new Set<PeopleSort>(["name", "code", "department"]);

/** A new sort column starts the way it is read: names A to Z, money highest first. */
export const defaultDir = (sort: PeopleSort): SortDir => (TEXT_SORTS.has(sort) ? "asc" : "desc");

const positiveInt = (raw: string | null): number | null => {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

/** The address's query string as the page state. Anything unknown or malformed falls back to its default, so a hand-edited
 *  or old link still opens a working page. An open employee always means the Employees tab. */
export function parseDashState(search: string): DashState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawView = p.get("view");
  const employee = positiveInt(p.get("employee"));
  const view: DashView = employee
    ? "employees"
    : VIEWS.includes(rawView as DashView)
      ? (rawView as DashView)
      : "monthly";
  const month = p.get("month") ?? "";
  const type = p.get("type");
  const sort = PEOPLE_SORTS.includes(p.get("sort") as PeopleSort) ? (p.get("sort") as PeopleSort) : "name";
  const dir = p.get("dir");
  return {
    view,
    month: /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : "",
    branch: (p.get("branch") ?? "").trim(),
    department: (p.get("department") ?? "").trim(),
    type: type === "staff" || type === "production" ? type : "",
    q: (p.get("q") ?? "").trim(),
    employee,
    sort,
    dir: dir === "asc" || dir === "desc" ? dir : defaultDir(sort),
    page: positiveInt(p.get("page")) ?? 1,
  };
}

/** The page state as a query string ("?view=employees&q=anitha"), leaving out every value that is its default, in a fixed
 *  order (so the same state is always the same address). "" when everything is the default. */
export function dashSearch(state: DashState): string {
  const p = new URLSearchParams();
  if (state.view !== "monthly" && !state.employee) p.set("view", state.view);
  if (state.employee) p.set("employee", String(state.employee));
  if (state.month) p.set("month", state.month);
  if (state.branch) p.set("branch", state.branch);
  if (state.department) p.set("department", state.department);
  if (state.type) p.set("type", state.type);
  if (state.q) p.set("q", state.q);
  if (state.sort !== "name") p.set("sort", state.sort);
  if (state.dir !== defaultDir(state.sort)) p.set("dir", state.dir);
  if (state.page > 1) p.set("page", String(state.page));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export type DashPatch = Partial<DashState>;

const LIST_KEYS: (keyof DashState)[] = ["month", "branch", "department", "type", "q", "sort", "dir"];

/** A change applied the way the page means it: a new filter, search or sort starts the list again at page 1; leaving the
 *  Employees tab closes the open employee. */
export function applyPatch(state: DashState, patch: DashPatch): DashState {
  const next: DashState = { ...state, ...patch };
  const listChanged = LIST_KEYS.some((k) => k in patch && patch[k] !== state[k]);
  if (listChanged && !("page" in patch)) next.page = 1;
  if (patch.employee) next.view = "employees";
  else if (next.view !== "employees") next.employee = null;
  next.page = Math.max(1, Math.floor(next.page || 1));
  return next;
}

/** Clicking a column: the same column turns its direction around, a new one starts in its natural direction. */
export function nextSort(state: Pick<DashState, "sort" | "dir">, key: PeopleSort): { sort: PeopleSort; dir: SortDir } {
  if (state.sort === key) return { sort: key, dir: state.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: defaultDir(key) };
}

export const scopeOf = (s: Pick<DashState, "branch" | "department" | "type">): ScopeChoice => ({
  branch: s.branch,
  department: s.department,
  type: s.type,
});

// ── figures ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** PF, ESI, TDS, advance and other lines: the slip's deductions without the late penalty (an attendance deduction). */
export const otherDeductions = (f: Pick<PayFigures, "deductions">): number =>
  round2(Math.max(0, f.deductions.total - f.deductions.late));

/** The change from `previous` to `current` (`pct` null when there is nothing to divide by); null when either is missing. */
export function changeBetween(current: number | null | undefined, previous: number | null | undefined): PayChange {
  if (current == null || previous == null || Number.isNaN(current) || Number.isNaN(previous)) return null;
  const abs = round2(current - previous);
  return { abs, pct: previous === 0 ? null : round2((abs / Math.abs(previous)) * 100) };
}

/** The headline figures the Monthly tab shows, each with its value read from a block of figures. */
export type KpiKey =
  | "companyCost"
  | "actualSalary"
  | "earnedSalary"
  | "attendanceDeduction"
  | "otherDeductions"
  | "netPaid"
  | "clDays"
  | "clAmount"
  | "employees";

export function kpiValue(f: PayFigures | null | undefined, key: KpiKey): number | null {
  if (!f) return null;
  if (key === "otherDeductions") return otherDeductions(f);
  return f[key];
}

type ServerChangeKey = keyof NonNullable<PayMonthlyResponse["change"]>;
const SERVER_CHANGE = new Set<string>([
  "companyCost",
  "earnedSalary",
  "netPaid",
  "attendanceDeduction",
  "clAmount",
  "employees",
]);

/** The selected month against the one before: the server's own change when it sends one, else worked out here. */
export function kpiChange(data: PayMonthlyResponse | undefined, key: KpiKey): PayChange {
  if (!data?.current) return null;
  if (SERVER_CHANGE.has(key)) {
    const server = data.change?.[key as ServerChangeKey];
    if (server !== undefined) return server;
  }
  if (!data.previous) return null;
  return changeBetween(kpiValue(data.current, key), kpiValue(data.previous, key));
}

export type DeltaView = { text: string; tone: Tone; direction: "up" | "down" | "flat" };

/**
 * The change chip next to a figure: the percent change when there is one, else the amount ("money": compact rupees,
 * "count": a whole number, "days": one decimal). `goodWhen`: the direction that is good news ("neutral" for figures that
 * are neither, such as headcount); the arrow always carries the direction, so colour is never the only signal.
 */
export function deltaOf(
  change: PayChange | undefined,
  kind: "money" | "count" | "days",
  goodWhen: "up" | "down" | "neutral" = "neutral",
): DeltaView | null {
  if (!change) return null;
  const direction = change.abs > 0 ? "up" : change.abs < 0 ? "down" : "flat";
  let text: string;
  if (change.pct != null) text = `${signed(change.pct, 1)}%`;
  else if (kind === "money") text = `${change.abs > 0 ? "+" : ""}${inrCompact(change.abs)}`;
  else text = signed(change.abs, kind === "count" ? 0 : 1);
  const tone: Tone = goodWhen === "neutral" ? "neutral" : changeTone(change.abs, goodWhen === "up");
  return { text, tone, direction };
}

/** A change in words with its arrow: "▲ +3.2%", "▼ -₹1,200", or "same" when nothing moved. */
export function arrowText(d: DeltaView | null | undefined): string {
  if (!d) return dash;
  if (d.direction === "flat") return "same";
  return `${d.direction === "up" ? "▲" : "▼"} ${d.text}`;
}

/** "12" / "12.5" / "4.75": days, with a half or quarter day kept (never rounded to a tenth). */
export function daysText(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return dash;
  const rounded = Math.round(value * 100) / 100;
  if (Number.isInteger(rounded)) return num(rounded);
  return num(rounded, 2).replace(/0$/, "");
}

/** "₹1,23,456" with a sign for a change ("+₹1,200" / "-₹800"). */
export function signedRupees(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return dash;
  if (value === 0) return inr(0);
  return `${value > 0 ? "+" : "-"}${inr(Math.abs(value))}`;
}

/** Figures added up (the totals row of a table built from rows the page already has). */
export function sumFigures(rows: PayFigures[]): PayFigures {
  const sum = (get: (f: PayFigures) => number | null) => {
    const values = rows.map(get).filter((v): v is number => v != null);
    return values.length ? round2(values.reduce((a, b) => a + b, 0)) : null;
  };
  const must = (get: (f: PayFigures) => number) => round2(rows.reduce((a, f) => a + get(f), 0));
  return {
    employees: must((f) => f.employees),
    actualSalary: sum((f) => f.actualSalary),
    earnedSalary: must((f) => f.earnedSalary),
    lossOfPay: sum((f) => f.lossOfPay),
    lateDeduction: must((f) => f.lateDeduction),
    attendanceDeduction: must((f) => f.attendanceDeduction),
    overtime: must((f) => f.overtime),
    bonus: must((f) => f.bonus),
    deductions: {
      pf: must((f) => f.deductions.pf),
      esi: must((f) => f.deductions.esi),
      tds: must((f) => f.deductions.tds),
      advance: must((f) => f.deductions.advance),
      late: must((f) => f.deductions.late),
      other: must((f) => f.deductions.other),
      total: must((f) => f.deductions.total),
    },
    netPaid: must((f) => f.netPaid),
    employerPfEsi: must((f) => f.employerPfEsi),
    companyCost: must((f) => f.companyCost),
    clDays: must((f) => f.clDays),
    clAmount: must((f) => f.clAmount),
    workingDays: must((f) => f.workingDays),
    paidDays: must((f) => f.paidDays),
    lopDays: must((f) => f.lopDays),
  };
}

/** Paid days as a share of working days ("attendance"), null without working days. */
export const attendancePct = (f: Pick<PayFigures, "paidDays" | "workingDays">): number | null =>
  f.workingDays > 0 ? round2((f.paidDays / f.workingDays) * 100) : null;

// ── months ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "2026-01" -> "2025-12". */
export function previousMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** A month on a chart's axis: "Oct", and the year at a January ("Jan '26") so a run across two years reads. */
export function monthTick(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  const short = monthText(ym, true);
  return m === 1 ? `${short} '${String(y).slice(2)}` : short;
}

export type MonthOption = { value: string; label: string };

/** The month picker's choices: the months with slips, newest first, plus a chosen month the server did not list (an old
 *  link) so the picker can still show it. */
export function monthOptions(available: string[] | undefined, chosen: string): MonthOption[] {
  const months = [...new Set([...(available ?? []), ...(chosen ? [chosen] : [])])].sort((a, b) => b.localeCompare(a));
  return months.map((m) => ({ value: m, label: monthText(m) }));
}

/** Money on a chart's axis, short: 950, 12k, 4.5L, 1.2Cr. */
export function axisMoney(value: number): string {
  const v = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  const trim = (n: number) => String(Number(n.toFixed(1)));
  if (v >= 1e7) return `${sign}${trim(v / 1e7)}Cr`;
  if (v >= 1e5) return `${sign}${trim(v / 1e5)}L`;
  if (v >= 1e3) return `${sign}${trim(v / 1e3)}k`;
  return `${sign}${Math.round(v)}`;
}

/** Where a month stands, as a tone for its banner and chip: paid = all well, pending = watch, generated = information. */
export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral";

export function statusTone(state: string | null | undefined): StatusTone {
  switch (state) {
    case "paid":
      return "success";
    case "part_paid":
    case "finalized":
    case "on_hold":
    case "pending":
      return "warning";
    case "not_generated":
      return "danger";
    case "generated":
      return "info";
    default:
      return "neutral";
  }
}

export const TONE_CHIP: Record<StatusTone, string> = {
  success: "md-chip-success",
  warning: "md-chip-warning",
  danger: "md-chip-danger",
  info: "md-money-pill-info",
  neutral: "md-money-pill-quiet",
};

// ── chart rows ────────────────────────────────────────────────────────────────────────────────────────────────────

/** One month of the salary trend: the three parts of the pay bill (stacked) and the lines drawn over them. */
export type FlowRow = {
  key: string;
  label: string;
  tick: string;
  selected: boolean;
  netPaid: number;
  otherDeductions: number;
  attendanceDeduction: number;
  earnedSalary: number;
  companyCost: number;
  actualSalary: number | null;
  lossOfPay: number | null;
  lateDeduction: number;
  overtime: number;
  bonus: number;
  employees: number;
};

const flowOf = (f: PayFigures) => ({
  netPaid: f.netPaid,
  otherDeductions: otherDeductions(f),
  attendanceDeduction: f.attendanceDeduction,
  earnedSalary: f.earnedSalary,
  companyCost: f.companyCost,
  actualSalary: f.actualSalary,
  lossOfPay: f.lossOfPay,
  lateDeduction: f.lateDeduction,
  overtime: f.overtime,
  bonus: f.bonus,
  employees: f.employees,
});

/** The months of the Monthly tab as chart rows, oldest first (as the server sends them). */
export function flowRows(months: PayMonthRow[], selected: string | null | undefined): FlowRow[] {
  return months.map((m) => ({
    key: m.month,
    label: m.label,
    tick: monthTick(m.month),
    selected: m.month === selected,
    ...flowOf(m),
  }));
}

/** The deductions of a month by type: the attendance part (loss of pay, late / early-out / permission) and the slip's
 *  own lines. */
export type DeductionRow = {
  key: string;
  label: string;
  tick: string;
  selected: boolean;
  lossOfPay: number;
  late: number;
  pf: number;
  esi: number;
  tds: number;
  advance: number;
  other: number;
};

export const DEDUCTION_KEYS = ["lossOfPay", "late", "pf", "esi", "tds", "advance", "other"] as const;
export type DeductionKey = (typeof DEDUCTION_KEYS)[number];

export const DEDUCTION_LABEL: Record<DeductionKey, string> = {
  lossOfPay: "Loss of pay",
  late: "Late / early-out",
  pf: "PF",
  esi: "ESI",
  tds: "TDS",
  advance: "Advance",
  other: "Other",
};

export function deductionRows(months: PayMonthRow[], selected: string | null | undefined): DeductionRow[] {
  return months.map((m) => ({
    key: m.month,
    label: m.label,
    tick: monthTick(m.month),
    selected: m.month === selected,
    lossOfPay: m.lossOfPay ?? 0,
    late: m.deductions.late,
    pf: m.deductions.pf,
    esi: m.deductions.esi,
    tds: m.deductions.tds,
    advance: m.deductions.advance,
    other: m.deductions.other,
  }));
}

export type ClRow = {
  key: string;
  label: string;
  tick: string;
  selected: boolean;
  clDays: number;
  clAmount: number;
};

export function clRows(months: PayMonthRow[], selected: string | null | undefined): ClRow[] {
  return months.map((m) => ({
    key: m.month,
    label: m.label,
    tick: monthTick(m.month),
    selected: m.month === selected,
    clDays: m.clDays,
    clAmount: m.clAmount,
  }));
}

/** "Stitching (Unit 1)" when a department name exists in several units of the answer, else just the name. */
export function departmentName(row: Pick<PayDepartmentRow, "department" | "unit">, rows: PayDepartmentRow[]): string {
  const repeated = rows.filter((r) => r.department === row.department).length > 1;
  return repeated && row.unit ? `${row.department} (${row.unit})` : row.department;
}

export type DepartmentMeasure = "cost" | "pay" | "average";

export type DepartmentBar = {
  key: string;
  name: string;
  department: string;
  unit: string | null;
  companyCost: number;
  netPaid: number;
  otherDeductions: number;
  attendanceDeduction: number;
  averageEarned: number;
  averageNetPaid: number;
  employees: number;
  sharePct: number;
};

/** Departments as chart bars, biggest company cost first (the order a comparison is read in). */
export function departmentBars(rows: PayDepartmentRow[]): DepartmentBar[] {
  return [...rows]
    .sort((a, b) => b.companyCost - a.companyCost || a.department.localeCompare(b.department))
    .map((r) => ({
      key: `${r.department}|${r.unit ?? ""}`,
      name: departmentName(r, rows),
      department: r.department,
      unit: r.unit,
      companyCost: r.companyCost,
      netPaid: r.netPaid,
      otherDeductions: otherDeductions(r),
      attendanceDeduction: r.attendanceDeduction,
      averageEarned: r.averageEarned,
      averageNetPaid: r.averageNetPaid,
      employees: r.employees,
      sharePct: r.sharePct,
    }));
}

/** A long name cut for a chart's axis ("Maintenance and Ut…"). */
export function shortName(name: string, max: number): string {
  return name.length <= max ? name : `${name.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export type PersonBar = {
  key: string;
  id: number;
  name: string;
  code: string;
  netPaid: number;
  otherDeductions: number;
  attendanceDeduction: number;
  companyCost: number;
};

/** The employees on the list's page as chart bars, in the list's order. */
export function peopleBars(rows: PayPersonRow[], limit: number): PersonBar[] {
  return rows.slice(0, limit).map((r) => ({
    key: String(r.employeeId),
    id: r.employeeId,
    name: r.name,
    code: r.code,
    netPaid: r.netPaid,
    otherDeductions: otherDeductions(r),
    attendanceDeduction: r.attendanceDeduction,
    companyCost: r.companyCost,
  }));
}

export type PersonChartRow = {
  key: string;
  label: string;
  tick: string;
  actualSalary: number | null;
  earnedSalary: number;
  netPaid: number;
  deductions: number;
  attendanceDeduction: number;
};

/** One employee's months for the chart: oldest first (the history comes newest first). */
export function personChartRows(months: PayPersonMonth[]): PersonChartRow[] {
  return [...months]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((m) => ({
      key: m.month,
      label: m.label,
      tick: monthTick(m.month),
      actualSalary: m.actualSalary,
      earnedSalary: m.earnedSalary,
      netPaid: m.netPaid,
      deductions: m.deductions.total,
      attendanceDeduction: m.attendanceDeduction,
    }));
}

// ── sorting and paging ────────────────────────────────────────────────────────────────────────────────────────────

/** Rows sorted by a value, empty values always last whichever the direction. Stable. */
export function sortRows<T>(rows: T[], get: (row: T) => string | number | null | undefined, dir: SortDir): T[] {
  const sign = dir === "asc" ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const x = get(a.row);
      const y = get(b.row);
      if (x == null && y == null) return a.i - b.i;
      if (x == null) return 1;
      if (y == null) return -1;
      const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return c === 0 ? a.i - b.i : c * sign;
    })
    .map((x) => x.row);
}

export type DepartmentSort =
  | "department"
  | "employees"
  | "actualSalary"
  | "earnedSalary"
  | "attendanceDeduction"
  | "deductions"
  | "netPaid"
  | "companyCost"
  | "averageEarned"
  | "averageNetPaid"
  | "attendancePct"
  | "clDays"
  | "clAmount"
  | "sharePct"
  | "change";

export function departmentValue(row: PayDepartmentRow, key: DepartmentSort): string | number | null {
  switch (key) {
    case "department":
      return `${row.department} ${row.unit ?? ""}`;
    case "deductions":
      return row.deductions.total;
    case "change":
      return row.change?.abs ?? null;
    default:
      return row[key];
  }
}

export type PageInfo = { page: number; pages: number; from: number; to: number; hasPrev: boolean; hasNext: boolean };

/** Where a page sits in the list: "26-50 of 112", page 2 of 5. */
export function pageInfo(total: number, page: number, pageSize: number): PageInfo {
  const pages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  const p = Math.min(Math.max(1, page), pages);
  const from = total === 0 ? 0 : (p - 1) * pageSize + 1;
  const to = Math.min(total, p * pageSize);
  return { page: p, pages, from, to, hasPrev: p > 1, hasNext: p < pages };
}

// ── words ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export const typeLabel = (type: "staff" | "production" | "" | null | undefined): string =>
  type === "staff" ? "Staff" : type === "production" ? "Production" : "Staff + production";

/** "paid" -> "Paid", "payment_pending" -> "Payment pending". */
export function words(value: string | null | undefined): string {
  if (!value) return dash;
  const text = value.replace(/[_-]+/g, " ").trim().toLowerCase();
  return text ? text[0].toUpperCase() + text.slice(1) : dash;
}

/** The payment of a slip as a chip: on hold first (it is not paid with the month), then what the slip says. */
export function paymentChip(
  paymentStatus: string | null | undefined,
  onHold: boolean,
): { text: string; tone: StatusTone } | null {
  if (onHold) return { text: "On hold", tone: "warning" };
  if (!paymentStatus) return null;
  const s = paymentStatus.toLowerCase();
  const tone: StatusTone =
    s === "paid" || s === "cleared"
      ? "success"
      : s.includes("pend") || s.includes("unpaid") || s === "not_paid" || s.includes("due")
        ? "warning"
        : "neutral";
  return { text: words(paymentStatus), tone };
}

/** True when a month's status already says what a payment chip would ("Paid" / "Generated, not paid" vs "Not paid"). */
export function saysAlready(statusLabel: string, text: string): boolean {
  const said = statusLabel
    .toLowerCase()
    .split(/[,;:·]\s*/)
    .map((s) => s.trim());
  return said.includes(text.toLowerCase().trim());
}

/** The employee's own status today: active in sage, anything else quiet. */
export const employeeStatusTone = (status: string): StatusTone =>
  status.toLowerCase() === "active" ? "success" : "neutral";

/** The month-on-month lines of the comparison card, in reading order. */
export type CompareLine = {
  id: KpiKey | "overtime" | "bonus" | "lossOfPay" | "lateDeduction";
  label: string;
  current: number | null;
  previous: number | null;
  change: PayChange;
  kind: "money" | "count" | "days";
};

export function compareLines(current: PayFigures | null, previous: PayFigures | null): CompareLine[] {
  if (!current) return [];
  const line = (
    id: CompareLine["id"],
    label: string,
    get: (f: PayFigures) => number | null,
    kind: CompareLine["kind"] = "money",
  ): CompareLine => {
    const c = get(current);
    const p = previous ? get(previous) : null;
    return { id, label, current: c, previous: p, change: changeBetween(c, p), kind };
  };
  return [
    line("employees", "Employees paid", (f) => f.employees, "count"),
    line("actualSalary", "Actual salary", (f) => f.actualSalary),
    line("earnedSalary", "Earned salary", (f) => f.earnedSalary),
    line("lossOfPay", "Loss of pay", (f) => f.lossOfPay),
    line("lateDeduction", "Late / early-out penalties", (f) => f.lateDeduction),
    line("overtime", "Overtime", (f) => f.overtime),
    line("bonus", "Bonus", (f) => f.bonus),
    line("otherDeductions", "Other deductions", (f) => otherDeductions(f)),
    line("netPaid", "Net paid", (f) => f.netPaid),
    line("companyCost", "Company cost", (f) => f.companyCost),
    line("clDays", "CL days", (f) => f.clDays, "days"),
    line("clAmount", "CL amount", (f) => f.clAmount),
  ];
}

/** "₹12.4 L (+3.1%)": a figure with its change, for the assistant. */
export function withChange(value: number | null | undefined, change: PayChange | undefined): string {
  const v = inrCompact(value);
  if (!change) return v;
  const c = change.pct != null ? `${signed(change.pct, 1)}%` : signedRupees(change.abs);
  return `${v} (${c} on the month before)`;
}

/** The headline figures of a block, in words the assistant can quote. */
export function figuresSummary(f: PayFigures): Record<string, string> {
  return {
    Employees: num(f.employees),
    "Actual salary": inrCompact(f.actualSalary),
    "Earned salary": inrCompact(f.earnedSalary),
    "Attendance deductions": inrCompact(f.attendanceDeduction),
    "Other deductions": inrCompact(otherDeductions(f)),
    "Net paid": inrCompact(f.netPaid),
    "Company cost": inrCompact(f.companyCost),
    "CL days": daysText(f.clDays),
    "CL amount": inrCompact(f.clAmount),
  };
}
