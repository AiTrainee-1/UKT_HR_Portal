// Pure logic of the PRODUCTION side of the MD Payroll page: its state in the address, the chart rows it draws from the
// contract (../types.ts, the Prod* types), and small helpers. No React here (logic.test.ts).

import type { ScopeChoice } from "@/lib/md/period";
import { changeBetween, type SortDir, type StatusTone } from "../logic";
import type {
  PayChange,
  ProdChangeKey,
  ProdCycle,
  ProdDepartmentRow,
  ProdFigures,
  ProdMonthRow,
  ProdOverviewResponse,
  ProdPeriodRow,
  ProdPeriodState,
  ProdWorkerPeriod,
} from "../types";

export type ProdView = "overview" | "departments" | "workers";
export const PROD_VIEWS: ProdView[] = ["overview", "departments", "workers"];

export const CYCLES: ProdCycle[] = ["weekly", "biweekly", "monthly", "none"];
export const CYCLE_LABEL: Record<ProdCycle, string> = {
  weekly: "Weekly",
  biweekly: "BiWeekly",
  monthly: "Monthly",
  none: "No pay cycle",
};

/** The workers list's server-side sort keys (production/people). */
export type ProdSort =
  | "name"
  | "code"
  | "department"
  | "shifts"
  | "ratePerShift"
  | "grossPay"
  | "bonus"
  | "deductions"
  | "netPaid"
  | "companyCost"
  | "daysAbsent"
  | "lateDays";

export const PROD_SORTS: ProdSort[] = [
  "name",
  "code",
  "department",
  "shifts",
  "ratePerShift",
  "grossPay",
  "bonus",
  "deductions",
  "netPaid",
  "companyCost",
  "daysAbsent",
  "lateDays",
];

const TEXT_SORTS = new Set<ProdSort>(["name", "code", "department"]);
export const prodDefaultDir = (sort: ProdSort): SortDir => (TEXT_SORTS.has(sort) ? "asc" : "desc");

export type ProdState = {
  view: ProdView;
  /** "" = the cycle most workers are paid on (the server decides) */
  cycle: ProdCycle | "";
  /** "YYYY-MM-DD_YYYY-MM-DD"; "" = the cycle's latest ended period */
  period: string;
  branch: string;
  /** a department NAME */
  department: string;
  q: string;
  /** the worker whose pay periods are open */
  worker: number | null;
  sort: ProdSort;
  dir: SortDir;
  page: number;
};

export const PROD_DEFAULT: ProdState = {
  view: "overview",
  cycle: "",
  period: "",
  branch: "",
  department: "",
  q: "",
  worker: null,
  sort: "name",
  dir: "asc",
  page: 1,
};

const PERIOD_RE = /^\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}$/;

const positiveInt = (raw: string | null): number | null => {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
};

/** The address as the Production side's state; anything unknown falls back to its default. An open worker means the
 *  Workers tab. */
export function parseProdState(search: string): ProdState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const worker = positiveInt(p.get("worker"));
  const rawView = p.get("view") as ProdView;
  const cycle = p.get("cycle") as ProdCycle;
  const period = p.get("period") ?? "";
  const sort = PROD_SORTS.includes(p.get("sort") as ProdSort) ? (p.get("sort") as ProdSort) : "name";
  const dir = p.get("dir");
  return {
    view: worker ? "workers" : PROD_VIEWS.includes(rawView) ? rawView : "overview",
    cycle: CYCLES.includes(cycle) ? cycle : "",
    period: PERIOD_RE.test(period) ? period : "",
    branch: (p.get("branch") ?? "").trim(),
    department: (p.get("department") ?? "").trim(),
    q: (p.get("q") ?? "").trim(),
    worker,
    sort,
    dir: dir === "asc" || dir === "desc" ? dir : prodDefaultDir(sort),
    page: positiveInt(p.get("page")) ?? 1,
  };
}

/** The state as a query string, always starting with kind=production, defaults left out, in a fixed order. */
export function prodSearch(state: ProdState): string {
  const p = new URLSearchParams();
  p.set("kind", "production");
  if (state.view !== "overview" && !state.worker) p.set("view", state.view);
  if (state.worker) p.set("worker", String(state.worker));
  if (state.cycle) p.set("cycle", state.cycle);
  if (state.period) p.set("period", state.period);
  if (state.branch) p.set("branch", state.branch);
  if (state.department) p.set("department", state.department);
  if (state.q) p.set("q", state.q);
  if (state.sort !== "name") p.set("sort", state.sort);
  if (state.dir !== prodDefaultDir(state.sort)) p.set("dir", state.dir);
  if (state.page > 1) p.set("page", String(state.page));
  return `?${p.toString()}`;
}

export type ProdPatch = Partial<ProdState>;

const LIST_KEYS: (keyof ProdState)[] = ["cycle", "period", "branch", "department", "q", "sort", "dir"];

/** A change as the page means it: another cycle starts at its own latest period; a new filter, search or sort starts the
 *  list at page 1; leaving the Workers tab closes the open worker. */
export function applyProdPatch(state: ProdState, patch: ProdPatch): ProdState {
  const next: ProdState = { ...state, ...patch };
  if ("cycle" in patch && patch.cycle !== state.cycle && !("period" in patch)) next.period = "";
  const listChanged = LIST_KEYS.some((k) => k in patch && patch[k] !== state[k]);
  if (listChanged && !("page" in patch)) next.page = 1;
  if (patch.worker) next.view = "workers";
  else if (next.view !== "workers") next.worker = null;
  next.page = Math.max(1, Math.floor(next.page || 1));
  return next;
}

export function nextProdSort(state: Pick<ProdState, "sort" | "dir">, key: ProdSort): { sort: ProdSort; dir: SortDir } {
  if (state.sort === key) return { sort: key, dir: state.dir === "asc" ? "desc" : "asc" };
  return { sort: key, dir: prodDefaultDir(key) };
}

export const prodScopeOf = (s: Pick<ProdState, "branch" | "department">): ScopeChoice => ({
  branch: s.branch,
  department: s.department,
  type: "production",
});

/** "2026-10-22_2026-11-04" -> { periodStart, periodEnd }; {} for "". */
export function periodParams(key: string): { periodStart?: string; periodEnd?: string } {
  if (!PERIOD_RE.test(key)) return {};
  const [periodStart, periodEnd] = key.split("_");
  return { periodStart, periodEnd };
}

// ── words and tones ──────────────────────────────────────────────────────────────────────────────────────────────

export function periodTone(state: ProdPeriodState | string | null | undefined): StatusTone {
  switch (state) {
    case "paid":
      return "success";
    case "finalized":
    case "part_paid":
      return "warning";
    case "generated":
      return "info";
    default:
      return "neutral";
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-10-22" -> "22 Oct". */
export function dayMonth(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m || 1) - 1]}`;
}

/** A period on a chart axis: "22 Oct". */
export const periodTick = (start: string) => dayMonth(start);

export function paymentWords(paymentStatus: string | null, cleared: boolean): { label: string; tone: StatusTone } {
  if (paymentStatus === "paid") return { label: "Paid", tone: "success" };
  if (cleared) return { label: "Cleared, not paid", tone: "info" };
  return { label: "Not paid", tone: "warning" };
}

// ── changes ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ProdKpiKey =
  | "companyCost"
  | "grossPay"
  | "shifts"
  | "employees"
  | "bonus"
  | "deductions"
  | "netPaid"
  | "averageRatePerShift"
  | "averageNetPerWorker"
  | "attendancePct";

export function prodValue(f: ProdFigures | null | undefined, key: ProdKpiKey): number | null {
  if (!f) return null;
  if (key === "deductions") return f.deductions.total;
  return f[key];
}

const SERVER_KEYS = new Set<string>([
  "companyCost",
  "grossPay",
  "netPaid",
  "deductions",
  "bonus",
  "shifts",
  "employees",
]);

/** The chosen period against the one before: the server's change when it sends one, else worked out here. */
export function prodChange(data: ProdOverviewResponse | undefined, key: ProdKpiKey): PayChange {
  if (!data?.current) return null;
  if (SERVER_KEYS.has(key)) {
    const server = data.change?.[key as ProdChangeKey];
    if (server !== undefined) return server;
  }
  if (!data.previous) return null;
  return changeBetween(prodValue(data.current, key), prodValue(data.previous, key));
}

// ── chart rows ───────────────────────────────────────────────────────────────────────────────────────────────────

export type PeriodChartRow = {
  key: string;
  label: string;
  tick: string;
  selected: boolean;
  state: ProdPeriodState;
  netPaid: number;
  deductions: number;
  grossPay: number;
  bonus: number;
  companyCost: number;
  shifts: number;
  employees: number;
};

export function periodRows(trend: ProdPeriodRow[], selected: string | null | undefined): PeriodChartRow[] {
  return trend.map((t) => ({
    key: t.key,
    label: t.label,
    tick: periodTick(t.start),
    selected: t.key === selected,
    state: t.state,
    netPaid: t.netPaid,
    deductions: t.deductions.total,
    grossPay: t.grossPay,
    bonus: t.bonus,
    companyCost: t.companyCost,
    shifts: t.shifts,
    employees: t.employees,
  }));
}

export type MonthCycleRow = {
  key: string;
  label: string;
  companyCost: number;
  netPaid: number;
  employees: number;
  periods: number;
} & Partial<Record<ProdCycle, number>>;

/** The production months (every cycle together) with each cycle's company cost as its own stacked part. */
export function monthCycleRows(months: ProdMonthRow[]): MonthCycleRow[] {
  return months.map((m) => {
    const row: MonthCycleRow = {
      key: m.month,
      label: m.label,
      companyCost: m.companyCost,
      netPaid: m.netPaid,
      employees: m.employees,
      periods: m.periods,
    };
    for (const c of m.cycles) row[c.cycle] = c.companyCost;
    return row;
  });
}

/** The cycles that appear in some month, in their usual order (the chart draws one stacked part for each). */
export const cyclesIn = (months: ProdMonthRow[]): ProdCycle[] =>
  CYCLES.filter((c) => months.some((m) => m.cycles.some((x) => x.cycle === c)));

export type ProdDeptBar = { key: string; name: string; companyCost: number; netPaid: number; sharePct: number };

/** "Cutting (Unit 2)" when the name is in several units of the answer. */
export function prodDepartmentName(row: ProdDepartmentRow, rows: ProdDepartmentRow[]): string {
  const repeated = rows.filter((r) => r.department === row.department).length > 1;
  return repeated && row.unit ? `${row.department} (${row.unit})` : row.department;
}

export function prodDepartmentBars(rows: ProdDepartmentRow[]): ProdDeptBar[] {
  return rows.map((r) => ({
    key: `${r.department}|${r.unit ?? ""}`,
    name: prodDepartmentName(r, rows),
    companyCost: r.companyCost,
    netPaid: r.netPaid,
    sharePct: r.sharePct,
  }));
}

export type WorkerChartRow = {
  key: string;
  label: string;
  tick: string;
  netPaid: number;
  deductions: number;
  shifts: number;
  state: ProdPeriodState;
};

/** A worker's periods for the chart, oldest first (the server sends newest first). */
export function workerChartRows(periods: ProdWorkerPeriod[]): WorkerChartRow[] {
  return [...periods].reverse().map((p) => ({
    key: p.key,
    label: p.label,
    tick: periodTick(p.start),
    netPaid: p.netPaid,
    deductions: p.deductions.total,
    shifts: p.shifts,
    state: p.state,
  }));
}

/** The deduction lines of a block, biggest first, with their share of the total (lines that are nil are left out). */
export function deductionLines(f: ProdFigures): { key: string; label: string; amount: number; share: number }[] {
  const d = f.deductions;
  const lines = [
    { key: "pf", label: "PF", amount: d.pf },
    { key: "esi", label: "ESI", amount: d.esi },
    { key: "tds", label: "TDS", amount: d.tds },
    { key: "advance", label: "Advance recovery", amount: d.advance },
    { key: "late", label: "Late penalty", amount: d.late },
    { key: "other", label: "Other", amount: d.other },
  ].filter((l) => l.amount !== 0);
  return lines
    .map((l) => ({ ...l, share: d.total ? (l.amount / d.total) * 100 : 0 }))
    .sort((a, b) => b.amount - a.amount);
}
