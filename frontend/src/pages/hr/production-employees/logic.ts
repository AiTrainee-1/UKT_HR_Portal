// The Production Employees page without React: which tab opens, what the list request carries, the selection, how an
// assignment is planned and worded (the confirmation, the one toast), and how a row's cells read. Everything here is
// unit-tested in logic.test.ts; the page only wires it to the hooks and the DOM.

import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  PAY_CYCLES,
  PAY_CYCLE_INFO,
  isPayCycle,
  type AssignProductionCycleResult,
  type CycleChangePreview,
  type CycleChangePreviewEmployee,
  type CycleMove,
  type PayCycle,
  type ProductionEmployeeCounts,
  type ProductionEmployeeFilters,
  type ProductionEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import { departmentOptions, type OrgDepartment, type OrgOption } from "@/lib/departments";
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
export const ALL_BRANCHES = "all";

export type Filters = {
  search: string;
  /** A department id as text, or ALL_DEPARTMENTS. */
  department: string;
  status: StatusFilter;
  /** A branch (unit) id as text, or ALL_BRANCHES. */
  branch: string;
};

export const NO_FILTERS: Filters = { search: "", department: ALL_DEPARTMENTS, status: "active", branch: ALL_BRANCHES };

export const filtersActive = (f: Filters): boolean =>
  f.search.trim() !== "" ||
  f.department !== ALL_DEPARTMENTS ||
  f.status !== "active" ||
  (f.branch ?? ALL_BRANCHES) !== ALL_BRANCHES;

const idOf = (value: string | undefined, all: string): number | undefined => {
  const id = value === undefined || value === all ? NaN : Number(value);
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/** What the list request carries: the tab is the cycle filter; a blank search, "all departments" and "all units" are
 *  left out. */
export function requestFilters(tab: Tab, f: Filters, search: string = f.search): ProductionEmployeeFilters {
  return {
    cycle: tab,
    status: f.status,
    search: search.trim() || undefined,
    departmentId: idOf(f.department, ALL_DEPARTMENTS),
    branchId: idOf(f.branch, ALL_BRANCHES),
  };
}

/**
 * The departments the filter offers: production departments only (owner 2026-11-16, every department is Staff or
 * Production), sorted by name, and only the chosen unit's when a unit is picked. A server from before the split sends no
 * `category` at all: then every department is offered, as before.
 */
export function productionDepartmentOptions(
  rows: readonly OrgDepartment[] | null | undefined,
  branch: string = ALL_BRANCHES,
): OrgOption[] {
  const list = rows ?? [];
  const split = list.some((d) => d.category !== undefined);
  return departmentOptions(list, {
    category: split ? "production" : null,
    branchId: idOf(branch, ALL_BRANCHES) ?? null,
  });
}

/** The units (branches) the filter offers, by name; the filter is shown only when there is more than one. */
export function branchOptions(
  rows: readonly { id: number; name: string }[] | null | undefined,
): { value: string; label: string }[] {
  return [...(rows ?? [])]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id - b.id)
    .map((b) => ({ value: String(b.id), label: b.name }));
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
  /** Unassigned people joining the target cycle: nothing to confirm, unless they were paid before. */
  fromNone: number;
  /** Of those, the ones who already have payroll (they are warned that days already paid are never paid again). */
  fromNoneWithHistory: number;
};

/** What assigning `rows` to `target` (null = take them off their cycle) would do. */
export function planAssignment(rows: readonly ProductionEmployeeRow[], target: PayCycle | null): Plan {
  const byCycle = new Map<PayCycle, number>();
  let alreadyThere = 0;
  let fromNone = 0;
  let fromNoneWithHistory = 0;
  for (const row of rows) {
    if (row.payCycle === target) alreadyThere++;
    else if (row.payCycle === null) {
      fromNone++;
      if (row.lastPayroll) fromNoneWithHistory++;
    } else byCycle.set(row.payCycle, (byCycle.get(row.payCycle) ?? 0) + 1);
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
    fromNoneWithHistory,
  };
}

/**
 * Moving someone off a cycle (or off all of them) is confirmed first, and so is putting an unassigned employee who was
 * paid before on a cycle (the confirmation carries the payroll warning). Adding people with no payroll yet is not.
 */
export const needsConfirmation = (plan: Plan): boolean =>
  plan.movingCount > 0 || (plan.target !== null && plan.fromNoneWithHistory > 0);

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
    plan.moving.length === 0
      ? `Assign ${employees(plan.fromNone)} to ${to}?`
      : plan.moving.length === 1
        ? `Move ${employees(n)} from ${PAY_CYCLE_INFO[plan.moving[0].from].label} to ${to}?`
        : `Move ${employees(n)} to ${to}?`;
  if (plan.moving.length > 1) {
    lines.push(`${joinWithAnd(plan.moving.map((m) => `${m.count} from ${PAY_CYCLE_INFO[m.from].label}`))}.`);
  }
  lines.push(
    plan.moving.length === 0
      ? `From the next ${to} period they are paid on the ${to} page.`
      : `From the next ${to} period they are paid on the ${to} page. Payroll that was already generated on their previous cycle stays there until it is paid.`,
  );
  if (plan.fromNone > 0 && plan.moving.length > 0)
    lines.push(`${employees(plan.fromNone)} with no cycle yet will simply join ${to}.`);
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

// ── the payroll warning of a move (GET /api/employees/production/cycle-change-preview) ──

/** The employees the move warns about: only those who change cycle AND already have payroll, in the order sent. */
export const previewWarnings = (preview: CycleChangePreview | undefined | null): CycleChangePreviewEmployee[] =>
  (preview?.employees ?? []).filter((e) => e.warn && !!e.message);

/**
 * Does the move need a reason? Yes when anyone in it already has payroll (owner 2026-11-16: paying under one cycle and
 * then another could pay twice, so such a move is made only on purpose, with a short reason the server keeps), or when
 * the server already refused the move for that (`conflict`).
 */
export const reasonRequired = (
  preview: CycleChangePreview | undefined | null,
  conflict: readonly CycleChangePreviewEmployee[] | null = null,
): boolean => (conflict?.length ?? 0) > 0 || !!preview?.needsReason || previewWarnings(preview).length > 0;

/** The reason box's limit: what the server keeps (500 characters unless it says otherwise). */
export const reasonLimit = (preview: CycleChangePreview | undefined | null): number => preview?.reasonMax ?? 500;

/** The body of an assignment: confirmed with the reason when one was asked for, the plain move otherwise. */
export function assignBody(
  plan: Pick<Plan, "ids" | "target">,
  reason: string | null,
): { employeeIds: number[]; cycle: PayCycle | null; confirm?: boolean; reason?: string } {
  const text = (reason ?? "").trim();
  return text
    ? { employeeIds: plan.ids, cycle: plan.target, confirm: true, reason: text }
    : { employeeIds: plan.ids, cycle: plan.target };
}

type ConflictBody = { code?: string; employees?: Partial<CycleChangePreviewEmployee>[] };

/**
 * The server refused the move because someone in it already has payroll and no confirmation / reason came with it (409,
 * code "confirm_cycle_change"): the facts of each such worker, shaped like the preview's warnings, so the confirmation can
 * open again with them and ask for the reason. Null for any other failure.
 */
export function moveConflict(e: unknown): CycleChangePreviewEmployee[] | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const body = e.data as ConflictBody | null;
  if (body?.code !== "confirm_cycle_change") return null;
  return (body.employees ?? []).map((f) => ({
    employeeId: f.employeeId ?? 0,
    employeeCode: f.employeeCode ?? "",
    name: f.name ?? "",
    fromCycle: f.fromCycle ?? null,
    toCycle: f.toCycle ?? null,
    changes: f.changes ?? true,
    warn: true,
    needsConfirmation: true,
    lastPayroll: null,
    nextPeriod: f.firstPeriod ?? null,
    payRanges: f.payRanges ?? [],
    alreadyPaid: f.alreadyPaid ?? [],
    catchUp: f.catchUp ?? [],
    legacyGap: f.legacyGap ?? null,
    refused: f.refused ?? false,
    message:
      f.message ??
      `${f.name ?? "This worker"} has already received salary on their pay cycle. The salary already paid for that time will not be paid again.`,
    paidThrough: f.paidThrough ?? null,
    paysFrom: f.paysFrom ?? null,
    oldCycle: f.oldCycle,
    firstPeriod: f.firstPeriod ?? null,
  }));
}

/** "Payroll already generated for 3 of these employees" (the heading over the warnings). */
export function warningsHeading(count: number, total: number): string {
  if (total <= 1 || count === total)
    return count === 1 ? "Payroll already generated" : `Payroll already generated for ${count} employees`;
  return `Payroll already generated for ${count} of these ${total} employees`;
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

/** "10 Nov" (this year) or "10 Nov 2025"; unreadable dates are shown as sent. */
export function shortDay(iso: string | null | undefined, now: Date = new Date()): string {
  const d = parseDay(iso ?? "");
  if (!d) return iso ?? "";
  return d.y === now.getFullYear() ? `${d.d} ${MONTHS[d.m - 1]}` : `${d.d} ${MONTHS[d.m - 1]} ${d.y}`;
}

/** "10 Nov 2026". */
export function longDay(iso: string | null | undefined): string {
  const d = parseDay(iso ?? "");
  return d ? `${d.d} ${MONTHS[d.m - 1]} ${d.y}` : (iso ?? "");
}

/** A worker's latest move on their row: "Moved from Weekly · 10 Nov", "Assigned from Unassigned · 10 Nov",
 *  "Taken off Weekly · 10 Nov". */
export function moveText(move: CycleMove, now: Date = new Date()): string {
  const when = shortDay(move.changedOn, now);
  if (move.toCycle === null) return `Taken off ${move.fromLabel} · ${when}`;
  if (move.fromCycle === null) return `Assigned from Unassigned · ${when}`;
  return `Moved from ${move.fromLabel} · ${when}`;
}

/** The whole move in one sentence (the chip's tooltip). */
export function moveSentence(move: CycleMove): string {
  const parts = [`${move.fromLabel} → ${move.toLabel} on ${longDay(move.changedOn)}`];
  if (move.changedBy) parts.push(`by ${move.changedBy}`);
  let text = parts.join(" ");
  if (move.reason) text += `. Reason: ${move.reason}`;
  return text;
}

/** What one move of the history says, line by line: when and by whom, why, what the old cycle had paid, from when the
 *  new one pays. */
export function moveDetails(move: CycleMove): string[] {
  const lines: string[] = [];
  if (move.reason) lines.push(`Reason: ${move.reason}`);
  if (move.lastPaidThrough) {
    const where = move.fromCycle ? `on ${move.fromLabel}` : "before the move";
    const periods = `${move.paidPeriods} pay ${move.paidPeriods === 1 ? "period" : "periods"}`;
    lines.push(
      `Salary already paid ${where} up to ${longDay(move.lastPaidThrough)}: ${periods}, ${formatRupees(move.paidNet) ?? "₹0"} net. It is never paid again.`,
    );
  } else {
    lines.push("No salary had been paid to this worker before the move.");
  }
  if (move.toCycle && move.paysFrom) lines.push(`${move.toLabel} pays from ${longDay(move.paysFrom)}.`);
  if (!move.toCycle) lines.push("Not in any payroll until assigned to a cycle again.");
  return lines;
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
