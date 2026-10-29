// The Production Employees page without React: which tab opens, what the list request carries, the selection, how an
// assignment is planned and worded (the confirmation, the one toast), and how a row's cells read. Everything here is
// unit-tested in logic.test.ts; the page only wires it to the hooks and the DOM.

import {
  PAY_CYCLES,
  PAY_CYCLE_INFO,
  isPayCycle,
  type AssignProductionCycleResult,
  type PayCycle,
  type ProductionEmployeeCounts,
  type ProductionEmployeeFilters,
  type ProductionEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

// ── tabs ──

export type Tab = "all" | "unassigned" | PayCycle;

export const TABS: readonly Tab[] = ["all", "unassigned", ...PAY_CYCLES];

export const isTab = (value: unknown): value is Tab => value === "all" || value === "unassigned" || isPayCycle(value);

export function tabLabel(tab: Tab): string {
  if (tab === "all") return "All";
  if (tab === "unassigned") return "Unassigned";
  return PAY_CYCLE_INFO[tab].label;
}

export const tabCount = (counts: ProductionEmployeeCounts, tab: Tab): number =>
  tab === "all" ? counts.total : counts[tab];

/** The tab the page opens on: the people no payroll includes yet, when there are any; otherwise everyone. */
export const chooseDefaultTab = (counts: ProductionEmployeeCounts): Tab =>
  counts.unassigned > 0 ? "unassigned" : "all";

/** Whether a row belongs on a tab. The server filters too; this keeps the previous list honest while a new tab loads. */
export function matchesTab(row: Pick<ProductionEmployeeRow, "payCycle">, tab: Tab): boolean {
  if (tab === "all") return true;
  if (tab === "unassigned") return row.payCycle === null;
  return row.payCycle === tab;
}

// ── filters ──

export type StatusFilter = "active" | "inactive" | "all";

export const isStatusFilter = (value: unknown): value is StatusFilter =>
  value === "active" || value === "inactive" || value === "all";

export const ALL_DEPARTMENTS = "all";

export type Filters = {
  search: string;
  /** A department id as text, or ALL_DEPARTMENTS. */
  department: string;
  status: StatusFilter;
};

export const NO_FILTERS: Filters = { search: "", department: ALL_DEPARTMENTS, status: "active" };

export const filtersActive = (f: Filters): boolean =>
  f.search.trim() !== "" || f.department !== ALL_DEPARTMENTS || f.status !== "active";

/** What the list request carries: the tab is the cycle filter; a blank search and "all departments" are left out. */
export function requestFilters(tab: Tab, f: Filters, search: string = f.search): ProductionEmployeeFilters {
  const departmentId = f.department === ALL_DEPARTMENTS ? NaN : Number(f.department);
  return {
    cycle: tab,
    status: f.status,
    search: search.trim() || undefined,
    departmentId: Number.isInteger(departmentId) && departmentId > 0 ? departmentId : undefined,
  };
}

export const STATUS_LABEL: Record<StatusFilter, string> = {
  active: "Active",
  inactive: "Inactive",
  all: "Active and inactive",
};

// ── pages ──

export const PAGE_SIZE = 25;

export type PageOf<T> = { rows: T[]; page: number; totalPages: number; from: number; to: number; total: number };

/** The rows of one page. The page number is clamped, so a search that shrinks the list never strands the reader. */
export function paginate<T>(rows: readonly T[], page: number, pageSize: number = PAGE_SIZE): PageOf<T> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safe = Math.min(Math.max(1, Math.trunc(page) || 1), totalPages);
  const start = (safe - 1) * pageSize;
  const slice = rows.slice(start, start + pageSize);
  return { rows: slice, page: safe, totalPages, from: total === 0 ? 0 : start + 1, to: start + slice.length, total };
}

/** "Showing 1-25 of 87". */
export const showingText = (p: Pick<PageOf<unknown>, "from" | "to" | "total">): string =>
  p.total === 0 ? "Showing 0 of 0" : `Showing ${p.from}-${p.to} of ${p.total}`;

// ── selection ──

/** The selected employees by id. Whole rows are kept, so people ticked under one filter stay actionable after the
 *  filters change (search "ravi", tick, search "kumar", tick, assign both). */
export type Selection = ReadonlyMap<number, ProductionEmployeeRow>;

export const NO_SELECTION: Selection = new Map();

export function toggleRow(selection: Selection, row: ProductionEmployeeRow): Selection {
  const next = new Map(selection);
  if (next.has(row.id)) next.delete(row.id);
  else next.set(row.id, row);
  return next;
}

export function selectRows(selection: Selection, rows: readonly ProductionEmployeeRow[]): Selection {
  const next = new Map(selection);
  for (const row of rows) next.set(row.id, row);
  return next;
}

export function deselectRows(selection: Selection, rows: readonly ProductionEmployeeRow[]): Selection {
  const next = new Map(selection);
  for (const row of rows) next.delete(row.id);
  return next;
}

export type ListSelection = "none" | "some" | "all";

/** The header checkbox: how much of the listed rows (every page of the current list) is selected. */
export function listSelection(selection: Selection, rows: readonly ProductionEmployeeRow[]): ListSelection {
  if (rows.length === 0) return "none";
  const selected = rows.filter((r) => selection.has(r.id)).length;
  return selected === 0 ? "none" : selected === rows.length ? "all" : "some";
}

/** How many selected employees the current filters do not show. */
export function hiddenSelected(selection: Selection, rows: readonly ProductionEmployeeRow[]): number {
  const shown = new Set(rows.map((r) => r.id));
  let hidden = 0;
  for (const id of selection.keys()) if (!shown.has(id)) hidden++;
  return hidden;
}

/** The selected rows, refreshed from the current list where it has them (a cycle may have changed since the tick). */
export function selectedRows(selection: Selection, rows: readonly ProductionEmployeeRow[]): ProductionEmployeeRow[] {
  const current = new Map(rows.map((r) => [r.id, r]));
  return [...selection.values()].map((r) => current.get(r.id) ?? r);
}

/** "All 87 selected" when the whole list is ticked, else "12 selected". */
export function selectionText(count: number, list: ListSelection, hidden: number): string {
  return list === "all" && hidden === 0 ? `All ${count} selected` : `${count} selected`;
}

// ── an assignment ──

export type Plan = {
  target: PayCycle | null;
  rows: ProductionEmployeeRow[];
  ids: number[];
  /** Who changes cycle (or, for a removal, who leaves one), by the cycle they leave, in cycle order. */
  moving: { from: PayCycle; count: number }[];
  movingCount: number;
  /** Already on the target (or, for a removal, on no cycle): the server reports them as unchanged. */
  alreadyThere: number;
  /** Unassigned people joining the target cycle: nothing to confirm. */
  fromNone: number;
};

/** What assigning `rows` to `target` (null = take them off their cycle) would do. */
export function planAssignment(rows: readonly ProductionEmployeeRow[], target: PayCycle | null): Plan {
  const byCycle = new Map<PayCycle, number>();
  let alreadyThere = 0;
  let fromNone = 0;
  for (const row of rows) {
    if (row.payCycle === target) alreadyThere++;
    else if (row.payCycle === null) fromNone++;
    else byCycle.set(row.payCycle, (byCycle.get(row.payCycle) ?? 0) + 1);
  }
  const moving = PAY_CYCLES.filter((c) => byCycle.has(c)).map((c) => ({ from: c, count: byCycle.get(c)! }));
  return {
    target,
    rows: [...rows],
    ids: rows.map((r) => r.id),
    moving,
    movingCount: moving.reduce((n, m) => n + m.count, 0),
    alreadyThere,
    fromNone,
  };
}

/** Moving someone off a cycle (or off all of them) is confirmed first; adding unassigned people is not. */
export const needsConfirmation = (plan: Plan): boolean => plan.movingCount > 0;

export const employees = (n: number): string => `${n} ${n === 1 ? "employee" : "employees"}`;

const were = (n: number): string => (n === 1 ? "was" : "were");

const joinWithAnd = (parts: string[]): string =>
  parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;

/** The confirmation: "Move 4 employees from BiWeekly to Weekly?" with what else the selection holds. */
export function confirmWording(plan: Plan): { title: string; lines: string[] } {
  const n = plan.movingCount;
  const lines: string[] = [];
  if (plan.target === null) {
    lines.push("They will not be included in any payroll until they are assigned again.");
    lines.push("Payroll that was already generated for them stays on the cycle it was generated on.");
    if (plan.alreadyThere > 0)
      lines.push(`${employees(plan.alreadyThere)} in the selection ${were(plan.alreadyThere)} not on a cycle.`);
    return { title: `Remove ${employees(n)} from their pay cycle?`, lines };
  }
  const to = PAY_CYCLE_INFO[plan.target].label;
  const title =
    plan.moving.length === 1
      ? `Move ${employees(n)} from ${PAY_CYCLE_INFO[plan.moving[0].from].label} to ${to}?`
      : `Move ${employees(n)} to ${to}?`;
  if (plan.moving.length > 1) {
    lines.push(`${joinWithAnd(plan.moving.map((m) => `${m.count} from ${PAY_CYCLE_INFO[m.from].label}`))}.`);
  }
  lines.push(
    `From the next ${to} period they are paid on the ${to} page. Payroll that was already generated on their previous cycle stays there until it is paid.`,
  );
  if (plan.fromNone > 0) lines.push(`${employees(plan.fromNone)} with no cycle yet will simply join ${to}.`);
  if (plan.alreadyThere > 0) lines.push(`${employees(plan.alreadyThere)} already on ${to} stay as they are.`);
  return { title, lines };
}

export type ToastWording = { title: string; lines: string[]; variant?: "destructive" };

/** One toast for the server's answer (the toaster shows one at a time, so every notice is a line of it). */
export function assignmentToast(
  result: AssignProductionCycleResult,
  target: PayCycle | null,
  names: ReadonlyMap<number, string> = new Map(),
): ToastWording {
  const to = target ? PAY_CYCLE_INFO[target].label : null;
  const lines: string[] = [];
  const title =
    result.updated > 0
      ? to
        ? `${employees(result.updated)} assigned to ${to}`
        : `${employees(result.updated)} removed from their pay cycle`
      : to
        ? `Nobody was assigned to ${to}`
        : "Nobody was removed from a pay cycle";
  if (result.unchanged > 0) {
    lines.push(
      to
        ? `${result.unchanged} ${were(result.unchanged)} already on it.`
        : `${result.unchanged} ${were(result.unchanged)} not on a cycle.`,
    );
  }
  if (result.pendingOnOtherCycle > 0) {
    const n = result.pendingOnOtherCycle;
    lines.push(
      `${n} of them still ${n === 1 ? "has" : "have"} unpaid payroll on their previous cycle; it stays on that cycle's page until it is paid.`,
    );
  }
  if (result.skipped.length > 0) {
    const shown = result.skipped
      .slice(0, 3)
      .map((s) => `${names.get(s.employeeId) ?? `#${s.employeeId}`}: ${s.reason}`);
    const more = result.skipped.length - shown.length;
    lines.push(
      `Skipped ${employees(result.skipped.length)}. ${shown.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
    );
  }
  return { title, lines, variant: result.skipped.length > 0 ? "destructive" : undefined };
}

/** "Ravi Kumar (E0123)" for the toast and the confirmation. */
export const nameMap = (rows: readonly ProductionEmployeeRow[]): Map<number, string> =>
  new Map(rows.map((r) => [r.id, `${r.name} (${r.employeeCode})`]));

/** The message of a failed request: the server's own words when it gave any. */
export function errorText(e: unknown): string {
  if (e instanceof Error && e.message) {
    // ApiError builds "HTTP 400 Bad Request: <message>"; keep just the message when there is one
    const m = /^HTTP \d+ [^:]*: (.+)$/s.exec(e.message);
    return m ? m[1] : e.message;
  }
  return "Could not reach the server. Check the connection and try again.";
}

// ── a row's cells ──

/** "₹650" / "₹650.5"; null when the rate is not set. */
export function formatRupees(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const parseDay = (iso: string): { y: number; m: number; d: number } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const day = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  return day.m >= 1 && day.m <= 12 && day.d >= 1 && day.d <= 31 ? day : null;
};

/** "2 Feb - 8 Feb 2026", or "29 Dec 2025 - 4 Jan 2026" across a year end. Unreadable dates are shown as sent. */
export function formatPeriod(start: string, end: string): string {
  const a = parseDay(start);
  const b = parseDay(end);
  if (!a || !b) return `${start} - ${end}`;
  const from = a.y === b.y ? `${a.d} ${MONTHS[a.m - 1]}` : `${a.d} ${MONTHS[a.m - 1]} ${a.y}`;
  return `${from} - ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

/** A payslip's status as a label and a colour. */
export function payrollStatus(status: string): { label: string; tone: Tone } {
  const s = status.trim().toLowerCase();
  if (s === "paid") return { label: "Cleared", tone: "success" };
  if (s === "pending") return { label: "Pending", tone: "warning" };
  return { label: s ? s.charAt(0).toUpperCase() + s.slice(1) : "Unknown", tone: "neutral" };
}

// ── empty states ──

export type EmptyInfo = {
  kind: "none" | "filtered" | "tab";
  title: string;
  hint: string;
  /** The button under the words: clear the filters, go to Unassigned, or nothing. */
  action: "clear" | "open-unassigned" | null;
};

/** Why the list is empty, in words that say what to do next. */
export function emptyInfo(tab: Tab, filtered: boolean, total: number): EmptyInfo {
  if (filtered) {
    return {
      kind: "filtered",
      title: "Nothing matches",
      hint: "Try fewer words, or clear the filters.",
      action: "clear",
    };
  }
  if (total === 0) {
    return {
      kind: "none",
      title: "No production employees yet",
      hint: "Production employees are created on Employees (employment type Production); they appear here as soon as they exist.",
      action: null,
    };
  }
  if (tab === "unassigned") {
    return {
      kind: "tab",
      title: "Everyone is assigned",
      hint: "Every active production employee is on a pay cycle. New production employees will appear here.",
      action: null,
    };
  }
  if (isPayCycle(tab)) {
    const label = PAY_CYCLE_INFO[tab].label;
    return {
      kind: "tab",
      title: `Nobody is on the ${label} cycle yet`,
      hint: `Open Unassigned, select employees and assign them to ${label}.`,
      action: "open-unassigned",
    };
  }
  return { kind: "none", title: "No production employees", hint: "Nobody matches this view.", action: null };
}
