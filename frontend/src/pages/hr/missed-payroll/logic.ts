// The Missed Payroll page's rules, as pure functions (tested in logic.test.ts): the state in the address, the views and
// their pills, the filters, which ticked rows each action may take (and why not), the wording after an action, file names,
// the paid-on date and the attendance calendar. Nothing here touches React or the network. The month, paging and
// selection helpers are the Salary Slip page's own (the same page shape).
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  MissedPayrollDownloadError,
  type MissedBankCheck,
  type MissedCategory,
  type MissedFileRequest,
  type MissedGenerateResult,
  type MissedKind,
  type MissedRefusal,
  type MissedRow,
  type MissedStatus,
  type MissedStatusAction,
} from "@/lib/api-client/custom-hooks/missed-payroll";
import { MONTHS_LONG, type Option } from "../salary-slip-center/logic";

export const MISSED_PAYROLL_PATH = "/hr/missed-payroll";
/** The page's permission key (view = list, figures, files; edit = Generate and every status change). */
export const MISSED_PAYROLL_MODULE = "missed_payroll";

// ── Tabs, views and pills ───────────────────────────────────────────────────

export const KINDS = ["staff", "production"] as const;
export const isKind = (v: string): v is MissedKind => (KINDS as readonly string[]).includes(v);
export const KIND_LABEL: Record<MissedKind, string> = { staff: "Staff", production: "Production" };
/** "Staff Payroll" / "Production Payroll": the regular payroll of the tab. */
export const MAIN_PAYROLL: Record<MissedKind, string> = { staff: "Staff Payroll", production: "Production Payroll" };

/**
 * The views of a tab. Missed = active employees the payroll missed (the four reasons); Inactive = inactive employees, never
 * mixed into Missed; Not cleared = in the month's payroll but not marked Cleared (to check, never generated here);
 * Processed = everyone with an entry on this page, by status.
 */
export const VIEWS = ["missed", "inactive", "not_cleared", "processed"] as const;
export type MissedView = (typeof VIEWS)[number];
export const isView = (v: string): v is MissedView => (VIEWS as readonly string[]).includes(v);
export const VIEW_LABEL: Record<MissedView, string> = {
  missed: "Missed",
  inactive: "Inactive",
  not_cleared: "Not cleared",
  processed: "Processed",
};

/** The reasons the Missed view lists (its pills, in this order). */
export const MISSED_CATEGORIES = ["not_generated", "no_salary", "on_hold", "new_joiner"] as const;
export type MissedReason = (typeof MISSED_CATEGORIES)[number];
export type CategoryPill = "all" | MissedReason;
export const isCategoryPill = (v: string): v is CategoryPill =>
  v === "all" || (MISSED_CATEGORIES as readonly string[]).includes(v);

export const STATUSES = ["generated", "cleared", "done", "paid"] as const;
export type StatusPill = "all" | MissedStatus;
export const isStatusPill = (v: string): v is StatusPill => v === "all" || (STATUSES as readonly string[]).includes(v);

export const STATUS_LABEL: Record<MissedStatus, string> = {
  generated: "Generated",
  cleared: "Cleared",
  done: "Done",
  paid: "Paid",
};

/** The server's own labels (lists.py CATEGORY_LABELS); used when the list has not come yet. */
export const CATEGORY_LABEL: Record<MissedCategory, string> = {
  not_generated: "Not generated",
  no_salary: "Salary not fixed",
  on_hold: "On hold",
  new_joiner: "New joiners",
  not_cleared: "Not cleared",
  inactive: "Inactive",
};

/** The labels the server sent, over the built-in ones. */
export function categoryLabels(list: readonly { value: string; label: string }[] | undefined) {
  const out: Record<MissedCategory, string> = { ...CATEGORY_LABEL };
  for (const c of list ?? []) if (c.value in out && c.label) out[c.value as MissedCategory] = c.label;
  return out;
}

// ── The address ─────────────────────────────────────────────────────────────

export const ALL = "all";

/** The page's state in the address. A value equal to its default is left out, so a fresh page keeps a clean URL. */
export const URL_DEFAULTS: Record<string, string> = {
  month: "",
  year: "",
  tab: "staff",
  view: "missed",
  cat: ALL,
  st: ALL,
  q: "",
  dept: ALL,
  unit: ALL,
  page: "1",
};

export type MissedFilters = {
  search: string;
  /** A department name, or "all" (by name: each unit has its own department of the same name). */
  department: string;
  /** A unit (branch) id, or "all". */
  unit: string;
};

export const NO_FILTERS: MissedFilters = { search: "", department: ALL, unit: ALL };

export function filtersFromUrl(url: Record<string, string>): MissedFilters {
  return { search: url.q ?? "", department: url.dept || ALL, unit: url.unit || ALL };
}

/** The address keys for a change of filters (page 1 again: a narrower list must not strand the reader). */
export function filtersToUrl(f: Partial<MissedFilters>): Record<string, string> {
  const out: Record<string, string> = { page: "1" };
  if (f.search !== undefined) out.q = f.search;
  if (f.department !== undefined) out.dept = f.department;
  if (f.unit !== undefined) out.unit = f.unit;
  return out;
}

export const filtersActive = (f: MissedFilters): boolean =>
  f.search.trim() !== "" || f.department !== ALL || f.unit !== ALL;

/** The tab, view and pills in the address (anything unknown falls back to its default). */
export function stateFromUrl(url: Record<string, string>): {
  kind: MissedKind;
  view: MissedView;
  category: CategoryPill;
  status: StatusPill;
} {
  return {
    kind: isKind(url.tab ?? "") ? (url.tab as MissedKind) : "staff",
    view: isView(url.view ?? "") ? (url.view as MissedView) : "missed",
    category: isCategoryPill(url.cat ?? "") ? (url.cat as CategoryPill) : ALL,
    status: isStatusPill(url.st ?? "") ? (url.st as StatusPill) : ALL,
  };
}

// ── Which rows a view shows ─────────────────────────────────────────────────

export const isActive = (r: Pick<MissedRow, "status">): boolean => (r.status ?? "").toLowerCase() === "active";

const MISSED_SET: ReadonlySet<string> = new Set(MISSED_CATEGORIES);

export function inView(r: MissedRow, view: MissedView): boolean {
  switch (view) {
    case "missed":
      return isActive(r) && MISSED_SET.has(r.category);
    case "inactive":
      return r.category === "inactive";
    case "not_cleared":
      return r.category === "not_cleared";
    case "processed":
      return r.entry !== null;
  }
}

const sameName = (a: string | null | undefined, b: string): boolean =>
  (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();

export function matchesFilters(r: MissedRow, f: MissedFilters): boolean {
  const q = f.search.trim().toLowerCase();
  if (q && !r.name.toLowerCase().includes(q) && !(r.code ?? "").toLowerCase().includes(q)) return false;
  if (f.department !== ALL && !sameName(r.department, f.department)) return false;
  if (f.unit !== ALL && String(r.branchId ?? "") !== f.unit) return false;
  return true;
}

const matchesPill = (r: MissedRow, view: MissedView, category: CategoryPill, status: StatusPill): boolean => {
  if (view === "missed" && category !== ALL) return r.category === category;
  if (view === "processed" && status !== ALL) return r.entry?.status === status;
  return true;
};

/** The rows of the list: the view, its pill, then the filters, in the server's order. */
export function visibleRows(
  rows: readonly MissedRow[],
  view: MissedView,
  category: CategoryPill,
  status: StatusPill,
  f: MissedFilters,
): MissedRow[] {
  return rows.filter((r) => inView(r, view) && matchesPill(r, view, category, status) && matchesFilters(r, f));
}

/** How many rows each view holds under the current filters (pills aside). */
export function viewCounts(rows: readonly MissedRow[], f: MissedFilters): Record<MissedView, number> {
  const out: Record<MissedView, number> = { missed: 0, inactive: 0, not_cleared: 0, processed: 0 };
  for (const r of rows) {
    if (!matchesFilters(r, f)) continue;
    for (const v of VIEWS) if (inView(r, v)) out[v] += 1;
  }
  return out;
}

/** The Missed view's pills: how many rows of each reason (under the filters). */
export function categoryCounts(rows: readonly MissedRow[], f: MissedFilters): Record<CategoryPill, number> {
  const out: Record<CategoryPill, number> = { all: 0, not_generated: 0, no_salary: 0, on_hold: 0, new_joiner: 0 };
  for (const r of rows) {
    if (!inView(r, "missed") || !matchesFilters(r, f)) continue;
    out.all += 1;
    out[r.category as MissedReason] += 1;
  }
  return out;
}

/** The Processed view's pills: how many entries in each status (under the filters). */
export function statusCounts(rows: readonly MissedRow[], f: MissedFilters): Record<StatusPill, number> {
  const out: Record<StatusPill, number> = { all: 0, generated: 0, cleared: 0, done: 0, paid: 0 };
  for (const r of rows) {
    if (!r.entry || !matchesFilters(r, f)) continue;
    out.all += 1;
    out[r.entry.status] += 1;
  }
  return out;
}

/** Not cleared is only a list to check: nothing there is ticked or generated. */
export const selectable = (view: MissedView): boolean => view !== "not_cleared";

export function departmentOptions(list: readonly { name: string }[]): Option[] {
  const byName = new Map<string, Option>();
  for (const d of list) {
    const name = (d.name ?? "").trim();
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { value: name, label: name });
  }
  return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export const unitOptions = (list: readonly { id: number; name: string }[]): Option[] =>
  list.map((u) => ({ value: String(u.id), label: u.name })).sort((a, b) => a.label.localeCompare(b.label));

// ── Actions ─────────────────────────────────────────────────────────────────

export type MissedAction = "generate" | MissedStatusAction;

/** The status an entry must be in for each status change (service.py). */
export const ACTION_FROM: Record<MissedStatusAction, MissedStatus> = {
  clear: "generated",
  unclear: "cleared",
  discard: "generated",
  done: "cleared",
  paid: "done",
};

export const ACTION_LABEL: Record<MissedAction, string> = {
  generate: "Generate",
  clear: "Clear",
  unclear: "Undo clear",
  discard: "Remove",
  done: "Done",
  paid: "Paid",
};

/** The rows an action can take: Generate the rows the server allows; a status change the entries in its starting status. */
export function eligible(rows: readonly MissedRow[], action: MissedAction): MissedRow[] {
  if (action === "generate") return rows.filter((r) => r.canGenerate);
  const from = ACTION_FROM[action];
  return rows.filter((r) => r.entry?.status === from);
}

/** Every action's rows at once (the bulk bar's counts). */
export function actionSplit(rows: readonly MissedRow[]): Record<MissedAction, MissedRow[]> {
  return {
    generate: eligible(rows, "generate"),
    clear: eligible(rows, "clear"),
    unclear: eligible(rows, "unclear"),
    discard: eligible(rows, "discard"),
    done: eligible(rows, "done"),
    paid: eligible(rows, "paid"),
  };
}

/** The rows that have an entry (what the files are made of). */
export const withEntries = (rows: readonly MissedRow[]): MissedRow[] => rows.filter((r) => r.entry !== null);

export type Rights = {
  /** The page's edit right (the server's canEdit and the role's). */
  canEdit: boolean;
  /** A login for all units. */
  wholeCompany: boolean;
  /** May mark payroll Cleared (approval payroll_mark_cleared). */
  mayClear: boolean;
  /** May finalize payroll (approval payroll_finalize). */
  mayDone: boolean;
  /** May mark payroll paid (approval payroll_mark_paid). */
  mayPay: boolean;
};

export const WHOLE_COMPANY_ONLY =
  "Done and Paid change the month's payroll for the whole company: only a login for all units can do them.";

/** Why this login may not run an action at all (null = it may). */
export function rightsBlock(action: MissedAction, rights: Rights): string | null {
  if (!rights.canEdit) return "Needs edit rights on Missed Payroll.";
  if ((action === "done" || action === "paid") && !rights.wholeCompany) return WHOLE_COMPANY_ONLY;
  if (action === "clear" && !rights.mayClear) return "Your account may not mark payroll Cleared.";
  if (action === "done" && !rights.mayDone) return "Your account may not finalize payroll (Done).";
  if (action === "paid" && !rights.mayPay) return "Your account may not mark payroll paid.";
  return null;
}

/** Why none of the ticked rows can take the action (null = some can). */
export function selectionBlock(action: MissedAction, rows: readonly MissedRow[]): string | null {
  if (eligible(rows, action).length > 0) return null;
  if (action === "generate") {
    const why = rows.find((r) => r.cannotGenerate)?.cannotGenerate;
    return why ? `None of the selected can be generated. ${why}` : "None of the selected can be generated.";
  }
  const from = STATUS_LABEL[ACTION_FROM[action]];
  return `Only ${from.toLowerCase()} entries can take ${ACTION_LABEL[action]}: none of the selected is ${from}.`;
}

/** Why an action's button is off (rights first, then the selection), or null. */
export const actionBlock = (action: MissedAction, rows: readonly MissedRow[], rights: Rights): string | null =>
  rightsBlock(action, rights) ?? selectionBlock(action, rows);

// ── Wording ─────────────────────────────────────────────────────────────────

export const employeeCount = (n: number): string => `${n} employee${n === 1 ? "" : "s"}`;

export type Wording = { title: string; description?: string; variant?: "default" | "destructive" };

export const EMPTY_GENERATE: MissedGenerateResult = { generated: [], skipped: [] };

export function mergeGenerate(a: MissedGenerateResult, b: MissedGenerateResult): MissedGenerateResult {
  return { generated: [...a.generated, ...b.generated], skipped: [...a.skipped, ...b.skipped] };
}

/** The toast after a Generate run (all batches). */
export function generateWording(
  result: MissedGenerateResult,
  requested: number,
  period: string,
  failed: string | null,
): Wording {
  const made = result.generated.length;
  const skipped = result.skipped.length;
  const notRun = Math.max(0, requested - made - skipped);
  const parts: string[] = [];
  if (skipped > 0) parts.push(`${skipped} could not be worked out (see the list on the page)`);
  if (failed) parts.push(`${notRun} not done: ${failed}`);
  if (made === 0) {
    return {
      title: failed ? "Nothing was generated" : `Nothing generated for ${period}`,
      description: parts.join(". ") || undefined,
      variant: "destructive",
    };
  }
  return {
    title: `${employeeCount(made)} generated for ${period}`,
    description:
      parts.length > 0 ? parts.join(". ") : "Check the figures, then Clear them. Done adds them to the payroll.",
    variant: failed ? "destructive" : "default",
  };
}

const DONE_TEXT: Record<MissedStatusAction, (period: string) => string> = {
  clear: () => "cleared",
  unclear: () => "put back to Generated",
  discard: () => "removed",
  done: (period) => `added to the ${period} payroll (Done)`,
  paid: () => "marked paid",
};

/** The toast after a status change (all batches): how many changed, how many were refused, whether it stopped early. */
export function statusWording(
  action: MissedStatusAction,
  changed: number,
  refused: number,
  period: string,
  failed: string | null,
  notified = 0,
): Wording {
  const parts: string[] = [];
  if (refused > 0) parts.push(`${refused} not changed (see the list on the page)`);
  if (failed) parts.push(`Stopped: ${failed}`);
  if (action === "paid" && notified > 0) {
    parts.push(`${notified} salary-paid notification${notified === 1 ? "" : "s"} on the way`);
  }
  if (changed === 0) {
    return {
      title: `Nothing ${DONE_TEXT[action](period)}`,
      description: parts.join(". ") || undefined,
      variant: "destructive",
    };
  }
  return {
    title: `${employeeCount(changed)} ${DONE_TEXT[action](period)}`,
    description: parts.join(". ") || undefined,
    variant: failed ? "destructive" : "default",
  };
}

/** A report shown on the page after an action, until closed: who was not changed and why. */
export type ResultReport = {
  title: string;
  items: MissedRefusal[];
  /** The batch the server refused outright (a payroll run in progress ...). */
  failed: string | null;
  notRun: number;
};

/** "3 employees not generated" / "2 employees not cleared". */
export function reportTitle(action: MissedAction, count: number): string {
  const what: Record<MissedAction, string> = {
    generate: "could not be worked out",
    clear: "not cleared",
    unclear: "not put back to Generated",
    discard: "not removed",
    done: "not added to the payroll",
    paid: "not marked paid",
  };
  return `${employeeCount(count)} ${what[action]}`;
}

// ── Files ───────────────────────────────────────────────────────────────────

/** The file name used when the server's own name (Content-Disposition) cannot be read. */
export function fallbackFileName(request: MissedFileRequest, kind: MissedKind, month: number, year: number): string {
  const stem = `Missed-Payroll-${KIND_LABEL[kind]}-${MONTHS_LONG[month - 1] ?? month}-${year}`;
  if (request.kind === "report") return `${stem}.xlsx`;
  if (request.kind === "statement") return `${stem}-Salary-Statement.${request.fmt}`;
  return `${stem}-Bank-File.xlsx`;
}

/** What the progress panel says while a file is being made. */
export function fileLabel(request: MissedFileRequest, count: number): string {
  if (request.kind === "report") return `Making the payroll report (Excel, ${employeeCount(count)})`;
  if (request.kind === "statement") {
    return `Making the salary statement (${request.fmt === "pdf" ? "PDF" : "Excel"}, ${employeeCount(count)})`;
  }
  return `Making the bank file (${employeeCount(count)})`;
}

/** The bank check grouped by reason: "Not Done yet ... (2)", "No IFSC code (1)". */
export function leftOutByReason(check: MissedBankCheck): { reason: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of check.leftOut) counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1);
  return [...counts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
}

// ── The paid-on day ─────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, "0");

/** Today as YYYY-MM-DD in the viewer's zone (the factory's, IST, for every HR login). */
export const todayIso = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

/** Why the paid-on day cannot be sent (null = it can): a real day, not after today. */
export function paidOnProblem(value: string, today: string): string | null {
  if (!value) return "Pick the day it was paid.";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return "Pick the day it was paid.";
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
    return "Pick the day it was paid.";
  }
  if (value > today) return "The day it was paid cannot be in the future.";
  return null;
}

// ── Links ───────────────────────────────────────────────────────────────────

/** Where the employee's salary is set: their profile's edit page. */
export const profileEditPath = (id: number): string => `/hr/employees/${id}/edit`;

const CYCLES = new Set(["weekly", "biweekly", "monthly"]);

/**
 * Where a Not cleared row is checked: the payroll's own details page when the list names it (staff), else the worker's
 * Production Payroll cycle page (a production row may have several payslips). Null when there is nowhere to send them.
 */
export function payrollLink(row: Pick<MissedRow, "payroll" | "payCycle">, kind: MissedKind): string | null {
  if (row.payroll?.id) {
    return kind === "production"
      ? `/hr/production-payroll/details/${row.payroll.id}`
      : `/hr/payroll/details/${row.payroll.id}`;
  }
  if (kind === "production") {
    const cycle = (row.payCycle ?? "").toLowerCase();
    return CYCLES.has(cycle) ? `/hr/production-payroll/${cycle}` : null;
  }
  return null;
}

// ── The page's figures ──────────────────────────────────────────────────────

export type EmptyInfo = { title: string; hint: string; action: "clear" | "previous" | null };

/** Why the list is empty, and the way out. */
export function emptyInfo(
  view: MissedView,
  filtered: boolean,
  total: number,
  period: string,
  kind: MissedKind,
): EmptyInfo {
  if (filtered) {
    return {
      title: "No employee matches these filters",
      hint: "Clear the filters, or try another name or employee code.",
      action: "clear",
    };
  }
  if (total === 0) {
    return {
      title: `Nobody was missed in ${period}`,
      hint: `The ${MAIN_PAYROLL[kind]} paid everyone it should for ${period}, as far as this list can see.`,
      action: "previous",
    };
  }
  const text: Record<MissedView, { title: string; hint: string }> = {
    missed: {
      title: `No active employee is waiting in ${period}`,
      hint: "Look at the other views: Inactive, Not cleared and Processed.",
    },
    inactive: {
      title: `No inactive employee to pay for ${period}`,
      hint: "Inactive employees appear here when they worked in the month or have a payroll of it.",
    },
    not_cleared: {
      title: "Nothing to check",
      hint: `Everyone in the ${period} payroll is marked Cleared.`,
    },
    processed: {
      title: "Nothing generated here yet",
      hint: "Tick employees in Missed or Inactive and press Generate.",
    },
  };
  return { ...text[view], action: null };
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** The server's own sentence (`{"error": "..."}`) when there is one, else a plain fallback. */
export function errorText(e: unknown): string {
  if (e instanceof MissedPayrollDownloadError) return e.message;
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

// ── The attendance calendar ─────────────────────────────────────────────────

const isoWeekday = (iso: string): number => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return 0;
  // Monday = 0 ... Sunday = 6; UTC so the day never shifts with the viewer's zone
  return (new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).getUTCDay() + 6) % 7;
};

/** The month's days as Monday-first weeks, with empty cells before the first day and after the last. */
export function monthWeeks<T extends { date: string }>(days: readonly T[]): (T | null)[][] {
  if (days.length === 0) return [];
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  const cells: (T | null)[] = Array.from({ length: isoWeekday(sorted[0].date) }, () => null);
  cells.push(...sorted);
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (T | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** "18" from "2026-11-18". */
export const dayOfMonth = (iso: string): string => String(Number(iso.slice(8, 10)) || "");

/** What the attendance sheet says about pressing Generate again after an approved change, by the entry's status. */
export function regenerateNote(status: MissedStatus | null): string {
  switch (status) {
    case "generated":
      return "Once the change is approved, press Generate again for this employee: the figures are worked out from the attendance as it then stands.";
    case "cleared":
      return "The figures are Cleared: to take an approved change in, press Undo clear first, then Generate again.";
    case "done":
    case "paid":
      return `The figures are ${STATUS_LABEL[status]} and in the month's payroll: an attendance change no longer changes them here.`;
    default:
      return "Generate works the pay out from the attendance as it stands then: send any change first and wait for the approval.";
  }
}
