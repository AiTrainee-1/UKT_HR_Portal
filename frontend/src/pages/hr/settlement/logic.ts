// Settlement (term loans and term advances): the rules behind the page, kept apart from the screens so they can be
// tested on their own. Nothing here decides or changes a real amount: the server creates the repayment schedule and
// payroll deducts it. The schedule preview is a twin of settlement_views._auto_create_repayments, only to show HR what an
// approval will create.

import { matchesNamedOrgOption } from "@/lib/departments";
import type { Advance, AdvanceDecisionItem } from "@/lib/api-client";
import { ApiError } from "@/lib/api-client/custom-fetch";
import type { Tone } from "@/lib/statusTones";
import { MONTH_FULL, formatDate, formatMoney, inDayRange, localDay, matchesWords, monthLabel } from "./shared";

/** An advance as the list sends it. The branch, employee type and employee status are additive fields: an older
 *  backend does not send them, and the page then simply has nothing to filter those by. */
export type SettlementRow = Advance & {
  employeeBranchId?: number | null;
  employeeBranch?: string | null;
  employeeType?: string | null;
  employeeStatus?: string | null;
  /** What was asked for (the employee in the app, or HR when recording it; null on an older advance HR recorded).
   *  `amount` is what is approved. */
  requestedAmount?: number | null;
  /** The monthly salary the 60 % Salary Advance limit was taken from, when the employee applied. */
  salaryAtRequest?: number | null;
  /** "employee" when the employee applied from the app, "hr" (or absent on an older backend) when HR recorded it. */
  appliedBy?: "hr" | "employee" | null;
};

/** The employee applied for this advance themselves (mobile app), rather than HR recording it. */
export const appliedByEmployee = (a: SettlementRow): boolean => a.appliedBy === "employee";

/** What was asked for: `requestedAmount`, or the amount itself on an older advance HR recorded. */
export const requestedOf = (a: SettlementRow): number => a.requestedAmount ?? a.amount;

/** HR approved less than was asked for. */
export const approvedLess = (a: SettlementRow): boolean =>
  a.requestedAmount != null && a.status !== "pending" && a.status !== "rejected" && a.amount < a.requestedAmount;

/** The approved amount: `amount` once the advance is approved (active or completed); null while it waits or when it was
 *  rejected (nothing was approved then). */
export const approvedOf = (a: SettlementRow): number | null =>
  a.status === "approved" || a.status === "closed" ? a.amount : null;

/** When the advance was approved / rejected: `decidedAt`, or `approvedAt` on an advance decided before 2026-11-20.
 *  Null while it waits (a reopened advance waits again). */
export const decidedAtOf = (a: SettlementRow): string | null =>
  a.status === "pending" ? null : (a.decidedAt ?? a.approvedAt ?? null);

/** Who approved / rejected it; "" while it waits. */
export const decidedByOf = (a: SettlementRow): string => (a.status === "pending" ? "" : (a.approvedBy ?? ""));

export type AdvanceStatus = Advance["status"];

export const STATUS_LABEL: Record<AdvanceStatus, string> = {
  pending: "Pending approval",
  approved: "Active",
  rejected: "Rejected",
  closed: "Completed",
};

export const STATUS_TONE: Record<AdvanceStatus, Tone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  closed: "neutral",
};

/** The owner's names (2026-11-20): a Term Loan is repaid in monthly EMIs, a Term Advance (the salary advance, stored as
 *  "general") is deducted once. */
export const TYPE_LABEL: Record<Advance["advanceType"], string> = { general: "Term advance", term: "Term loan" };

// ─── Tabs: Overview (both kinds), Term Loan, Term Advance ────────────────────────

export type SettlementTab = "overview" | "loan" | "advance";

export const SETTLEMENT_TABS: { value: SettlementTab; label: string; hint: string }[] = [
  { value: "overview", label: "Overview", hint: "Term loans and term advances together" },
  { value: "loan", label: "Term Loan", hint: "Repaid in monthly EMIs" },
  { value: "advance", label: "Term Advance", hint: "Deducted once, in one month's salary" },
];

/** The kind of advance a tab lists; null on Overview (both). */
export const TAB_TYPE: Record<SettlementTab, Advance["advanceType"] | null> = {
  overview: null,
  loan: "term",
  advance: "general",
};

export const parseTab = (value: string | null | undefined): SettlementTab =>
  value === "loan" || value === "advance" ? value : "overview";

export const tabLabel = (tab: SettlementTab): string => SETTLEMENT_TABS.find((t) => t.value === tab)!.label;

/** The tab that lists this kind of advance. */
export const tabOfType = (type: Advance["advanceType"]): SettlementTab => (type === "term" ? "loan" : "advance");

/** What a tab's list holds, for the figures and the empty states: "advances", "term loans", "term advances". */
export const TAB_NOUN: Record<SettlementTab, { one: string; many: string }> = {
  overview: { one: "advance", many: "advances" },
  loan: { one: "term loan", many: "term loans" },
  advance: { one: "term advance", many: "term advances" },
};

export const countOf = (n: number, tab: SettlementTab): string =>
  `${n} ${n === 1 ? TAB_NOUN[tab].one : TAB_NOUN[tab].many}`;

/** The advances a tab lists: Term Loan the term loans, Term Advance the others, Overview all of them. */
export function rowsOfTab(rows: SettlementRow[], tab: SettlementTab): SettlementRow[] {
  const type = TAB_TYPE[tab];
  return type ? rows.filter((a) => a.advanceType === type) : rows;
}

// ─── The month filter ────────────────────────────────────────────────────────────

/** Which activity puts an advance in a month: any of them, the application, the decision or a deduction. */
export type MonthBasis = "any" | "applied" | "decided" | "deducted";

export const BASIS_OPTIONS: { value: MonthBasis; label: string }[] = [
  { value: "any", label: "Any activity in the month" },
  { value: "applied", label: "Applied in the month" },
  { value: "decided", label: "Approved or rejected in the month" },
  { value: "deducted", label: "Deducted in the month" },
];

export const parseBasis = (value: string | null | undefined): MonthBasis =>
  value === "applied" || value === "decided" || value === "deducted" ? value : "any";

/** A month of a year; null = all months. */
export type Period = { month: number; year: number } | null;

/** The month from the address ("11", "2026"); null for "All months" or anything that is not a month. A month without a
 *  usable year is in this year. */
export function parsePeriod(
  month: string | null | undefined,
  year: string | null | undefined,
  now = new Date(),
): Period {
  const m = Number(month);
  if (!month || !Number.isInteger(m) || m < 1 || m > 12) return null;
  const y = Number(year);
  return { month: m, year: year && Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.getFullYear() };
}

/** "2026-11", as the server writes a deduction month. */
export const periodKey = (p: { month: number; year: number }): string =>
  `${p.year}-${String(p.month).padStart(2, "0")}`;

/** "November 2026" or "All months". */
export const periodLabel = (p: Period): string => (p ? `${MONTH_FULL[p.month - 1]} ${p.year}` : "All months");

/** The month the advance was applied in ("2026-11"), from the day it was raised. */
export const appliedMonth = (a: SettlementRow): string => localDay(a.createdAt).slice(0, 7);

/** The month it was approved / rejected; "" while it waits. */
export const decidedMonth = (a: SettlementRow): string => localDay(decidedAtOf(a)).slice(0, 7);

/** The months a deduction is scheduled in. An older backend does not send `scheduleMonths`: the schedule an approval
 *  made is then worked out from the advance, as the server does. */
export function deductionMonths(a: SettlementRow): string[] {
  if (a.scheduleMonths) return a.scheduleMonths;
  if ((a.status !== "approved" && a.status !== "closed") || !a.repaymentStartMonth || !a.repaymentStartYear) return [];
  return previewForAdvance(a).items.map((i) => periodKey(i));
}

/** Does the advance belong to the month on this basis? Everything belongs to "All months". */
export function inPeriod(a: SettlementRow, period: Period, basis: MonthBasis): boolean {
  if (!period) return true;
  const key = periodKey(period);
  const applied = appliedMonth(a) === key;
  const decided = decidedMonth(a) === key;
  const deducted = deductionMonths(a).includes(key);
  if (basis === "applied") return applied;
  if (basis === "decided") return decided;
  if (basis === "deducted") return deducted;
  return applied || decided || deducted;
}

/** The years the year select offers, newest first: last year to next year, widened to every year an advance was applied
 *  or is deducted in, and to the year chosen. */
export function yearOptions(rows: SettlementRow[], chosen: Period, now = new Date()): number[] {
  let first = now.getFullYear() - 1;
  let last = now.getFullYear() + 1;
  const widen = (y: number) => {
    if (!(y >= 2000 && y <= 2100)) return;
    first = Math.min(first, y);
    last = Math.max(last, y);
  };
  for (const a of rows) {
    widen(Number(appliedMonth(a).slice(0, 4)));
    for (const m of deductionMonths(a)) widen(Number(m.slice(0, 4)));
  }
  if (chosen) widen(chosen.year);
  const years: number[] = [];
  for (let y = last; y >= first; y -= 1) years.push(y);
  return years;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The employee has left (or is otherwise not active): what they still owe is for the final settlement. */
export const hasLeft = (a: SettlementRow): boolean => !!a.employeeStatus && a.employeeStatus !== "active";

/** How much of the advance is recovered, 0-100. */
export function progressPct(a: Pick<Advance, "amount" | "totalRepaid">): number {
  if (!(a.amount > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((a.totalRepaid / a.amount) * 100)));
}

// ─── Summary ────────────────────────────────────────────────────────────────────

export type Summary = {
  pendingCount: number;
  pendingAmount: number;
  activeCount: number;
  /** Still to recover on active advances. */
  outstanding: number;
  /** Monthly EMI of the active term loans. */
  monthlyEmi: number;
  /** Recovered through payroll so far, on active and completed advances. */
  recovered: number;
  completedCount: number;
  /** Active advances of employees who have left. */
  leftCount: number;
  leftOutstanding: number;
};

export function summarize(rows: SettlementRow[]): Summary {
  const s: Summary = {
    pendingCount: 0,
    pendingAmount: 0,
    activeCount: 0,
    outstanding: 0,
    monthlyEmi: 0,
    recovered: 0,
    completedCount: 0,
    leftCount: 0,
    leftOutstanding: 0,
  };
  for (const a of rows) {
    if (a.status === "pending") {
      s.pendingCount += 1;
      s.pendingAmount += requestedOf(a);
    } else if (a.status === "approved") {
      s.activeCount += 1;
      s.outstanding += a.outstanding;
      s.recovered += a.totalRepaid;
      if (a.advanceType === "term") s.monthlyEmi += a.emiAmount;
      if (hasLeft(a) && a.outstanding > 0) {
        s.leftCount += 1;
        s.leftOutstanding += a.outstanding;
      }
    } else if (a.status === "closed") {
      s.completedCount += 1;
      s.recovered += a.totalRepaid;
    }
  }
  s.pendingAmount = round2(s.pendingAmount);
  s.outstanding = round2(s.outstanding);
  s.monthlyEmi = round2(s.monthlyEmi);
  s.recovered = round2(s.recovered);
  s.leftOutstanding = round2(s.leftOutstanding);
  return s;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

export type StatusFilter = "all" | AdvanceStatus;

export type Filters = {
  query: string;
  status: StatusFilter;
  type: "all" | Advance["advanceType"];
  branch: string;
  department: string;
  /** "all", "staff" or "production". */
  employeeType: string;
  /** "all", "active" (still employed) or "left". */
  employee: "all" | "active" | "left";
  /** The day the advance was raised, from / to ("YYYY-MM-DD", empty = open). */
  from: string;
  to: string;
};

export const NO_FILTERS: Filters = {
  query: "",
  status: "all",
  type: "all",
  branch: "all",
  department: "all",
  employeeType: "all",
  employee: "all",
  from: "",
  to: "",
};

/** The page opens on the approvals waiting for HR, as it always did. */
export const DEFAULT_FILTERS: Filters = { ...NO_FILTERS, status: "pending" };

export const filtersActive = (f: Filters): boolean =>
  f.query.trim() !== "" ||
  f.status !== "all" ||
  f.type !== "all" ||
  f.branch !== "all" ||
  f.department !== "all" ||
  f.employeeType !== "all" ||
  f.employee !== "all" ||
  f.from !== "" ||
  f.to !== "";

/** The filters a tab applies: the Term Loan and Term Advance tabs already are one type, so the type choice is Overview's. */
export const tabFilters = (f: Filters, tab: SettlementTab): Filters =>
  tab === "overview" || f.type === "all" ? f : { ...f, type: "all" };

/** Every word typed must appear in the employee's name, code, department, designation, branch, the purpose or HR's
 *  decision remark. */
export function filterRows(rows: SettlementRow[], f: Filters, ignoreStatus = false): SettlementRow[] {
  return rows.filter((a) => {
    if (!ignoreStatus && f.status !== "all" && a.status !== f.status) return false;
    if (f.type !== "all" && a.advanceType !== f.type) return false;
    if (f.branch !== "all" && (a.employeeBranch ?? "") !== f.branch) return false;
    // a department choice is "<staff|production>|<name>" (lib/departments.ts): staff and production have their own
    if (!matchesNamedOrgOption(f.department, a.employeeDepartment, a.employeeType)) return false;
    if (f.employeeType !== "all" && (a.employeeType ?? "") !== f.employeeType) return false;
    if (f.employee === "left" && !hasLeft(a)) return false;
    if (f.employee === "active" && hasLeft(a)) return false;
    if (!inDayRange(localDay(a.createdAt), f.from, f.to)) return false;
    const haystack = [
      a.employeeName,
      a.employeeCode,
      a.employeeDepartment,
      a.employeeDesignation,
      a.employeeBranch,
      a.purpose,
      a.decisionRemark,
    ]
      .filter(Boolean)
      .join(" ");
    return matchesWords(f.query, haystack);
  });
}

/** How many advances each status tab would show with the other filters applied. */
export function statusCounts(rows: SettlementRow[], f: Filters): Record<StatusFilter, number> {
  const base = filterRows(rows, f, true);
  const counts: Record<StatusFilter, number> = { all: base.length, pending: 0, approved: 0, rejected: 0, closed: 0 };
  for (const a of base) counts[a.status] += 1;
  return counts;
}

// ─── Sorting ────────────────────────────────────────────────────────────────────

export type SortKey = "created" | "employee" | "amount" | "outstanding" | "recovery" | "start" | "status";
export type SortDir = "asc" | "desc";
export type Sort = { key: SortKey; dir: SortDir };

export const DEFAULT_SORT: Sort = { key: "created", dir: "desc" };

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "created:desc", label: "Newest first" },
  { value: "created:asc", label: "Oldest first" },
  { value: "employee:asc", label: "Employee A to Z" },
  { value: "employee:desc", label: "Employee Z to A" },
  { value: "amount:desc", label: "Amount: high to low" },
  { value: "amount:asc", label: "Amount: low to high" },
  { value: "outstanding:desc", label: "Outstanding: high to low" },
  { value: "outstanding:asc", label: "Outstanding: low to high" },
  { value: "recovery:desc", label: "Most recovered" },
  { value: "recovery:asc", label: "Least recovered" },
  { value: "start:asc", label: "Deduction starts: earliest" },
  { value: "start:desc", label: "Deduction starts: latest" },
  { value: "status:asc", label: "Status: pending first" },
];

const SORT_KEYS: readonly SortKey[] = ["created", "employee", "amount", "outstanding", "recovery", "start", "status"];

/** "amount:desc" from the sort dropdown or the address; anything unknown is the default order. */
export function parseSort(value: string): Sort {
  const [key, dir] = value.split(":");
  if (!SORT_KEYS.includes(key as SortKey)) return DEFAULT_SORT;
  return { key: key as SortKey, dir: dir === "asc" ? "asc" : "desc" };
}

export const sortValue = (s: Sort): string => `${s.key}:${s.dir}`;

const STATUS_ORDER: Record<AdvanceStatus, number> = { pending: 0, approved: 1, closed: 2, rejected: 3 };
const startKey = (a: SettlementRow) => (a.repaymentStartYear ?? 0) * 100 + (a.repaymentStartMonth ?? 0);

/** A sorted copy. Ties fall back to the newest first, so the order never jumps around. */
export function sortRows(rows: SettlementRow[], sort: Sort): SettlementRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const created = (a: SettlementRow) => (a.createdAt ? Date.parse(a.createdAt) : 0);
  const compare = (a: SettlementRow, b: SettlementRow): number => {
    switch (sort.key) {
      case "employee":
        return a.employeeName.localeCompare(b.employeeName);
      case "amount":
        return a.amount - b.amount;
      case "outstanding":
        return a.outstanding - b.outstanding;
      case "recovery":
        return progressPct(a) - progressPct(b);
      case "start":
        return startKey(a) - startKey(b);
      case "status":
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      default:
        return created(a) - created(b);
    }
  };
  return [...rows].sort((a, b) => sign * compare(a, b) || created(b) - created(a) || b.id - a.id);
}

// ─── The page's state in the address ────────────────────────────────────────────

/** Everything the page keeps in the address (?tab=loan&month=11&year=2026&status=all ...). A value equal to its default
 *  is left out, so a fresh page has a clean address. Module-level: useUrlParams needs one identity. */
export const SETTLEMENT_URL_DEFAULTS = {
  tab: "overview",
  month: "",
  year: "",
  basis: "any",
  q: "",
  status: "pending",
  type: "all",
  branch: "all",
  dept: "all",
  etype: "all",
  emp: "all",
  from: "",
  to: "",
  sort: "created:desc",
};

export type SettlementUrl = Record<keyof typeof SETTLEMENT_URL_DEFAULTS, string>;

/** The keys of one tab's own filters (the tab and the month are the page's). */
export const FILTER_URL_KEYS = ["q", "status", "type", "branch", "dept", "etype", "emp", "from", "to", "sort"] as const;
export type FilterUrl = Pick<SettlementUrl, (typeof FILTER_URL_KEYS)[number]>;

const STATUS_VALUES: readonly StatusFilter[] = ["all", "pending", "approved", "rejected", "closed"];
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** The filters the address names; an unknown value falls back to its default. */
export function filtersFromUrl(u: Partial<SettlementUrl>): Filters {
  const status = (u.status ?? "pending") as StatusFilter;
  return {
    query: u.q ?? "",
    status: STATUS_VALUES.includes(status) ? status : "pending",
    type: u.type === "general" || u.type === "term" ? u.type : "all",
    branch: u.branch || "all",
    department: u.dept || "all",
    employeeType: u.etype || "all",
    employee: u.emp === "active" || u.emp === "left" ? u.emp : "all",
    from: u.from && isDay(u.from) ? u.from : "",
    to: u.to && isDay(u.to) ? u.to : "",
  };
}

/** The address values of the filters and the sort. */
export function filtersToUrl(f: Filters, sort: Sort): FilterUrl {
  return {
    q: f.query,
    status: f.status,
    type: f.type,
    branch: f.branch,
    dept: f.department,
    etype: f.employeeType,
    emp: f.employee,
    from: f.from,
    to: f.to,
    sort: sortValue(sort),
  };
}

/** One tab's own part of the address, to put back when HR returns to that tab. */
export const pickFilterUrl = (u: SettlementUrl): FilterUrl =>
  Object.fromEntries(FILTER_URL_KEYS.map((k) => [k, u[k]])) as FilterUrl;

export const DEFAULT_FILTER_URL: FilterUrl = pickFilterUrl(SETTLEMENT_URL_DEFAULTS);

// ─── What the page shows: tab -> month -> filters -> sort ───────────────────────

export type PageState = { tab: SettlementTab; period: Period; basis: MonthBasis; filters: Filters; sort: Sort };

export type PageView = {
  /** The tab's advances (any month). */
  tabRows: SettlementRow[];
  /** ... in the chosen month. The status counts, the filter choices and "Showing x of y" read these. */
  periodRows: SettlementRow[];
  /** The filters as the tab applies them. */
  filters: Filters;
  /** The list, as filtered and sorted: what the screen shows and the export writes. */
  shown: SettlementRow[];
  /** The figures above the list: every filter but the status (the status tabs split them). */
  summary: Summary;
};

export function pageView(all: SettlementRow[], s: PageState): PageView {
  const tabRows = rowsOfTab(all, s.tab);
  const periodRows = s.period ? tabRows.filter((a) => inPeriod(a, s.period, s.basis)) : tabRows;
  const filters = tabFilters(s.filters, s.tab);
  return {
    tabRows,
    periodRows,
    filters,
    shown: sortRows(filterRows(periodRows, filters), s.sort),
    summary: summarize(filterRows(periodRows, filters, true)),
  };
}

/** "Applied in the month · Status: Pending approval · Search: "asha"": what narrows the list, for the export's subtitle;
 *  "" when nothing does. */
export function describeScope(s: PageState): string {
  const f = tabFilters(s.filters, s.tab);
  const parts: string[] = [];
  if (s.period && s.basis !== "any") parts.push(BASIS_OPTIONS.find((o) => o.value === s.basis)!.label);
  if (f.status !== "all") parts.push(`Status: ${STATUS_LABEL[f.status]}`);
  if (f.type !== "all") parts.push(`Type: ${TYPE_LABEL[f.type]}`);
  if (f.branch !== "all") parts.push(`Branch: ${f.branch}`);
  if (f.department !== "all") {
    const [kind, name] = f.department.includes("|") ? f.department.split("|", 2) : ["", f.department];
    parts.push(`Department: ${name}${kind ? ` (${kind === "production" ? "Production" : "Staff"})` : ""}`);
  }
  if (f.employeeType !== "all") parts.push(f.employeeType === "production" ? "Production employees" : "Staff");
  if (f.employee !== "all") parts.push(f.employee === "left" ? "Employees who left" : "Still employed");
  if (f.from || f.to)
    parts.push(
      `Raised ${f.from ? `from ${formatDate(f.from)}` : ""}${f.from && f.to ? " " : ""}${f.to ? `to ${formatDate(f.to)}` : ""}`,
    );
  if (f.query.trim()) parts.push(`Search: "${f.query.trim()}"`);
  if (s.sort.key !== DEFAULT_SORT.key || s.sort.dir !== DEFAULT_SORT.dir) {
    const label = SORT_OPTIONS.find((o) => o.value === sortValue(s.sort))?.label;
    if (label) parts.push(`Sorted: ${label}`);
  }
  return parts.join(" · ");
}

// ─── The repayment schedule an approval creates ─────────────────────────────────

export type ScheduleItem = { month: number; year: number; amount: number };

export type SchedulePreview = {
  items: ScheduleItem[];
  total: number;
  /** What the schedule does not cover (rounding of an EMI worked out from a number of months). */
  shortfall: number;
};

/** Twin of settlement_views._auto_create_repayments: a term advance ("general") is one deduction in its start month; a
 *  term loan is a monthly EMI (the last one smaller) for `months`, or for as many months as it takes. */
export function schedulePreview(input: {
  type: Advance["advanceType"];
  amount: number;
  months?: number | null;
  emi?: number | null;
  startMonth: number;
  startYear: number;
}): SchedulePreview {
  const { type, amount, startMonth, startYear } = input;
  const items: ScheduleItem[] = [];
  if (!(amount > 0)) return { items, total: 0, shortfall: 0 };
  if (type === "general") {
    items.push({ month: startMonth, year: startYear, amount });
  } else {
    // as saved: an EMI given wins, otherwise the amount over the months, to the paisa
    const emi =
      input.emi && input.emi > 0 ? input.emi : input.months && input.months > 0 ? round2(amount / input.months) : 0;
    if (emi > 0) {
      const count = input.months && input.months > 0 ? input.months : Math.ceil(amount / emi);
      let remaining = amount;
      let m = startMonth;
      let y = startYear;
      for (let i = 0; i < count && remaining > 0; i += 1) {
        const pay = Math.min(emi, remaining);
        items.push({ month: m, year: y, amount: round2(pay) });
        remaining -= pay;
        m += 1;
        if (m > 12) {
          m = 1;
          y += 1;
        }
      }
    }
  }
  const total = round2(items.reduce((s, i) => s + i.amount, 0));
  return { items, total, shortfall: items.length > 0 ? round2(amount - total) : 0 };
}

/** "12 deductions of ₹5,000 from Apr 2026 to Mar 2027 (the last ₹3,200)". */
export function describeSchedule(p: SchedulePreview): string {
  const { items } = p;
  if (items.length === 0) return "No deduction schedule yet.";
  const first = items[0];
  if (items.length === 1)
    return `1 deduction of ${formatMoney(first.amount)} in ${monthLabel(first.month, first.year)}`;
  const last = items[items.length - 1];
  const tail = last.amount !== first.amount ? ` (the last ${formatMoney(last.amount)})` : "";
  return `${items.length} deductions of ${formatMoney(first.amount)} from ${monthLabel(first.month, first.year)} to ${monthLabel(last.month, last.year)}${tail}`;
}

/** The schedule an approval of this advance creates, from what is stored on it. */
export function previewForAdvance(a: SettlementRow, now = new Date()): SchedulePreview {
  return schedulePreview({
    type: a.advanceType,
    amount: a.amount,
    months: a.repaymentMonths,
    emi: a.emiAmount,
    startMonth: a.repaymentStartMonth || now.getMonth() + 1,
    startYear: a.repaymentStartYear || now.getFullYear(),
  });
}

// ─── Deciding: the approved amount, the deduction month and the remark ─────────

/** The shortest remark the server takes (settlement_views.REMARK_MIN) and the longest it keeps. */
export const REMARK_MIN = 3;
export const REMARK_MAX = 1000;

/** The remark as the server keeps it: runs of spaces and line breaks become one space (clean_remark). */
export const cleanRemark = (text: string): string => text.split(/\s+/).filter(Boolean).join(" ");

/** What HR may change when approving: a smaller amount than was asked for, the month the deduction starts, and the
 *  remark (required when the amount is not the one asked for). */
export type ApprovalEdit = { amount: string; startMonth: number; startYear: number; remark: string };

/** The editor's starting values: the amount asked for and the start month already on the advance (a Salary Advance an
 *  employee applied for starts in the month of the application, a Term Loan the month after). */
export function approvalDefaults(a: SettlementRow, now = new Date()): ApprovalEdit {
  return {
    amount: String(requestedOf(a)),
    startMonth: a.repaymentStartMonth || now.getMonth() + 1,
    startYear: a.repaymentStartYear || now.getFullYear(),
    remark: "",
  };
}

/** The monthly EMI the server works out when the amount changes: a Term Loan an employee applied for rounds UP to
 *  whole rupees (the last EMI absorbs the rest: settlement_views.whole_rupee_emi); one HR recorded divides to the
 *  paisa, as the create call does. */
export function approvalEmi(a: SettlementRow, amount: number): number {
  if (a.advanceType !== "term") return 0;
  const months = a.repaymentMonths ?? 0;
  if (months > 0) return appliedByEmployee(a) ? Math.ceil(amount / months) : round2(amount / months);
  return a.emiAmount;
}

/** The message to show beside the approved amount or the month, or null when they can be sent. */
export function approvalProblem(a: SettlementRow, edit: ApprovalEdit): string | null {
  const text = edit.amount.trim();
  const amount = num(text);
  if (text === "") return "Enter the amount to approve.";
  if (!Number.isFinite(amount) || amount <= 0) return "The approved amount must be more than 0.";
  if (hasTooManyDecimals(text)) return "Use at most 2 decimal places.";
  if (amount > requestedOf(a)) return `You can approve at most the ${formatMoney(requestedOf(a))} asked for.`;
  if (!Number.isInteger(edit.startYear) || edit.startYear < 2000 || edit.startYear > 2100)
    return "Enter a 4-digit year.";
  return null;
}

/** Approving another amount than was asked for needs a remark (the server refuses it without one). */
export function remarkRequired(a: SettlementRow, edit: Pick<ApprovalEdit, "amount">): boolean {
  const amount = num(edit.amount);
  return Number.isFinite(amount) && amount > 0 && amount !== requestedOf(a);
}

/** "You are approving ₹700 of the ₹1,000 asked for - write why.", or null when the remark is not needed or is there. */
export function approvalRemarkProblem(a: SettlementRow, edit: ApprovalEdit): string | null {
  if (!remarkRequired(a, edit) || cleanRemark(edit.remark).length >= REMARK_MIN) return null;
  return `You are approving ${formatMoney(num(edit.amount))} of the ${formatMoney(requestedOf(a))} asked for - write why.`;
}

/** A rejection always needs its reason. */
export const rejectionProblem = (remark: string): string | null =>
  cleanRemark(remark).length >= REMARK_MIN ? null : "Write the reason for rejecting (at least 3 characters).";

/** The schedule this approval creates, with the amount and start month HR chose. */
export function approvalPreview(a: SettlementRow, edit: ApprovalEdit): SchedulePreview | null {
  const amount = num(edit.amount);
  if (!(amount > 0)) return null;
  const changed = amount !== a.amount;
  return schedulePreview({
    type: a.advanceType,
    amount,
    months: a.repaymentMonths,
    emi: changed ? approvalEmi(a, amount) : a.emiAmount,
    startMonth: edit.startMonth,
    startYear: edit.startYear,
  });
}

export type ApprovalPayload = {
  status: "approved";
  amount?: number;
  repaymentStartMonth?: number;
  repaymentStartYear?: number;
  decisionRemark?: string;
};

/** The body of the approve call: only what changed (an untouched approval without a remark sends `{status}` as it always
 *  did), plus the remark when there is one. */
export function approvalPayload(a: SettlementRow, edit: ApprovalEdit): ApprovalPayload {
  const body: ApprovalPayload = { status: "approved" };
  const amount = num(edit.amount);
  if (Number.isFinite(amount) && amount !== a.amount) body.amount = amount;
  if (edit.startMonth !== a.repaymentStartMonth || edit.startYear !== a.repaymentStartYear) {
    body.repaymentStartMonth = edit.startMonth;
    body.repaymentStartYear = edit.startYear;
  }
  const remark = cleanRemark(edit.remark);
  if (remark) body.decisionRemark = remark;
  return body;
}

export type RejectionPayload = { status: "rejected"; decisionRemark: string };

export const rejectionPayload = (remark: string): RejectionPayload => ({
  status: "rejected",
  decisionRemark: cleanRemark(remark),
});

/** The server's own words for a refused call ({"error", "code"}), without the "HTTP 400 Bad Request:" in front; `code`
 *  is "remark" when the remark was missing, "invalid" for a bad amount or month. */
export function serverError(err: unknown, fallback: string): { text: string; code: string | null } {
  if (err instanceof ApiError) {
    const data = (err.data ?? null) as { error?: unknown; code?: unknown } | null;
    const said = data && typeof data.error === "string" && data.error.trim() ? data.error.trim() : null;
    return { text: said ?? err.message ?? fallback, code: data && typeof data.code === "string" ? data.code : null };
  }
  return { text: err instanceof Error && err.message ? err.message : fallback, code: null };
}

// ─── The decision history (detail sheet) ────────────────────────────────────────

export const HISTORY_ACTION_LABEL: Record<AdvanceDecisionItem["action"], string> = {
  approved: "Approved",
  rejected: "Rejected",
  reopened: "Sent back to pending",
};

/** One line of the history: "Approved ₹700 of the ₹1,000 asked for", and the deduction month it set. */
export function historyText(
  item: AdvanceDecisionItem,
  type: Advance["advanceType"],
): { title: string; detail: string | null } {
  const asked = item.requestedAmount;
  const approved = item.approvedAmount;
  if (item.action === "approved") {
    const title =
      approved != null && asked != null && approved !== asked
        ? `Approved ${formatMoney(approved)} of the ${formatMoney(asked)} asked for`
        : `Approved ${formatMoney(approved ?? asked)}`;
    const start =
      item.startMonth && item.startYear
        ? `${type === "term" ? "Deductions from" : "Deducted in"} ${monthLabel(item.startMonth, item.startYear)}`
        : null;
    return { title, detail: start };
  }
  if (item.action === "rejected")
    return { title: asked != null ? `Rejected (${formatMoney(asked)} asked for)` : "Rejected", detail: null };
  return { title: HISTORY_ACTION_LABEL.reopened, detail: null };
}

// ─── The "new advance" form ─────────────────────────────────────────────────────

export type AdvanceForm = {
  /** The employee's id, as text (EmployeeSearchSelect holds ids as text). */
  employeeId: string;
  advanceType: Advance["advanceType"];
  amount: string;
  purpose: string;
  repaymentMonths: string;
  emiAmount: string;
  repaymentStartMonth: number;
  repaymentStartYear: number;
};

/** A blank form; payroll deducts from next month unless HR says otherwise. The Term Loan tab opens it on a term loan. */
export function emptyForm(now = new Date(), advanceType: Advance["advanceType"] = "general"): AdvanceForm {
  const nextMonth = now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2;
  return {
    employeeId: "",
    advanceType,
    amount: "",
    purpose: "",
    repaymentMonths: "",
    emiAmount: "",
    repaymentStartMonth: nextMonth,
    repaymentStartYear: now.getMonth() + 2 > 12 ? now.getFullYear() + 1 : now.getFullYear(),
  };
}

export type FormErrors = Partial<Record<"employee" | "amount" | "repayment" | "months" | "emi" | "year", string>>;

export const MAX_AMOUNT = 99_999_999.99;
export const MAX_MONTHS = 120;

const num = (text: string): number => (text.trim() === "" ? NaN : Number(text));
const hasTooManyDecimals = (text: string) => /\.\d{3,}/.test(text.trim());

/** The messages to show next to the fields; empty when the form can be sent. */
export function validateForm(f: AdvanceForm): FormErrors {
  const e: FormErrors = {};
  if (!f.employeeId) e.employee = "Choose the employee this advance is for.";

  const amount = num(f.amount);
  if (f.amount.trim() === "") e.amount = "Enter the amount.";
  else if (!Number.isFinite(amount) || amount <= 0) e.amount = "The amount must be more than 0.";
  else if (hasTooManyDecimals(f.amount)) e.amount = "Use at most 2 decimal places.";
  else if (amount > MAX_AMOUNT) e.amount = "That amount is too large.";

  if (!Number.isInteger(f.repaymentStartYear) || f.repaymentStartYear < 2000 || f.repaymentStartYear > 2100) {
    e.year = "Enter a 4-digit year.";
  }

  if (f.advanceType === "term") {
    const months = num(f.repaymentMonths);
    const emi = num(f.emiAmount);
    if (f.repaymentMonths.trim() === "" && f.emiAmount.trim() === "") {
      e.repayment = "Enter the number of months or the monthly EMI.";
    } else if (f.repaymentMonths.trim() !== "") {
      if (!Number.isInteger(months) || months < 1) e.months = "Months must be a whole number, 1 or more.";
      else if (months > MAX_MONTHS) e.months = `A loan cannot run longer than ${MAX_MONTHS} months.`;
    } else if (!Number.isFinite(emi) || emi <= 0) {
      e.emi = "The EMI must be more than 0.";
    } else if (hasTooManyDecimals(f.emiAmount)) {
      e.emi = "Use at most 2 decimal places.";
    } else if (Number.isFinite(amount) && amount > 0 && emi > amount) {
      e.emi = "The monthly EMI cannot be more than the amount.";
    }
  }
  return e;
}

/** A warning that does not stop the advance: the first deduction month is already over. */
export function startWarning(f: AdvanceForm, now = new Date()): string | null {
  const start = f.repaymentStartYear * 12 + f.repaymentStartMonth;
  const current = now.getFullYear() * 12 + now.getMonth() + 1;
  return start < current
    ? `${monthLabel(f.repaymentStartMonth, f.repaymentStartYear)} is already over: check that its payroll has not been run.`
    : null;
}

/** What the create call sends: the same body the page always sent. */
export function toPayload(f: AdvanceForm) {
  const term = f.advanceType === "term";
  return {
    employeeId: Number(f.employeeId),
    advanceType: f.advanceType,
    amount: parseFloat(f.amount),
    purpose: f.purpose.trim() || undefined,
    repaymentMonths: term ? parseInt(f.repaymentMonths, 10) || undefined : undefined,
    emiAmount: term ? parseFloat(f.emiAmount) || undefined : undefined,
    repaymentStartMonth: f.repaymentStartMonth,
    repaymentStartYear: f.repaymentStartYear,
  };
}

/** The schedule the form would create once approved, or null while it is not complete enough to say. */
export function formPreview(f: AdvanceForm): SchedulePreview | null {
  const amount = num(f.amount);
  if (!(amount > 0)) return null;
  const p = toPayload(f);
  if (f.advanceType === "term" && !p.repaymentMonths && !p.emiAmount) return null;
  const preview = schedulePreview({
    type: f.advanceType,
    amount,
    months: p.repaymentMonths,
    emi: p.emiAmount,
    startMonth: f.repaymentStartMonth,
    startYear: f.repaymentStartYear,
  });
  return preview.items.length > 0 ? preview : null;
}

// ─── Export (Excel and PDF, per tab) ────────────────────────────────────────────

export type ExportCell = string | number;

export type ExportColumn = {
  key: string;
  header: string;
  /** Excel column width (characters) and the column's share of the PDF's width. */
  width: number;
  weight: number;
  /** A rupee amount: a number in Excel, summed in the totals row. */
  money?: boolean;
  value: (a: SettlementRow) => ExportCell;
};

/** Only an approved (active or completed) advance has anything repaid or outstanding. */
const recovering = (a: SettlementRow) => a.status === "approved" || a.status === "closed";

function emiText(a: SettlementRow): string {
  if (a.advanceType !== "term") return "Deducted once";
  if (!(a.emiAmount > 0)) return "";
  const emi = formatMoney(a.emiAmount);
  return a.repaymentMonths ? `${emi} x ${a.repaymentMonths} months` : `${emi} a month`;
}

/** The columns of a tab's export (owner 2026-11-20). Overview has both kinds, so it says which; Term Advance is deducted
 *  once, so it has no EMI column. */
export function exportColumns(tab: SettlementTab): ExportColumn[] {
  const cols: (ExportColumn | false)[] = [
    { key: "code", header: "Code", width: 11, weight: 13, value: (a) => a.employeeCode },
    { key: "employee", header: "Employee", width: 24, weight: 27, value: (a) => a.employeeName },
    { key: "department", header: "Department", width: 18, weight: 19, value: (a) => a.employeeDepartment ?? "" },
    tab === "overview" && {
      key: "type",
      header: "Type",
      width: 13,
      weight: 14,
      value: (a) => TYPE_LABEL[a.advanceType],
    },
    {
      key: "requested",
      header: "Requested amount",
      width: 13,
      weight: 16,
      money: true,
      value: (a) => requestedOf(a),
    },
    {
      key: "approved",
      header: "Approved amount",
      width: 13,
      weight: 16,
      money: true,
      value: (a) => approvedOf(a) ?? "",
    },
    tab !== "advance" && { key: "emi", header: "EMI / months", width: 20, weight: 19, value: emiText },
    {
      key: "start",
      header: tab === "advance" ? "Deducted in" : "Deduction start",
      width: 13,
      weight: 14,
      value: (a) =>
        a.repaymentStartMonth && a.repaymentStartYear ? monthLabel(a.repaymentStartMonth, a.repaymentStartYear) : "",
    },
    {
      key: "repaid",
      header: "Repaid",
      width: 12,
      weight: 14,
      money: true,
      value: (a) => (recovering(a) ? a.totalRepaid : ""),
    },
    {
      key: "outstanding",
      header: "Outstanding",
      width: 12,
      weight: 15,
      money: true,
      value: (a) => (recovering(a) ? a.outstanding : ""),
    },
    { key: "status", header: "Status", width: 16, weight: 16, value: (a) => STATUS_LABEL[a.status] },
    { key: "decidedBy", header: "Decided by", width: 16, weight: 16, value: decidedByOf },
    {
      key: "decidedOn",
      header: "Decided on",
      width: 12,
      weight: 14,
      value: (a) => (decidedAtOf(a) ? formatDate(decidedAtOf(a)) : ""),
    },
    { key: "remark", header: "Remark", width: 36, weight: 30, value: (a) => a.decisionRemark ?? "" },
    { key: "appliedOn", header: "Applied on", width: 12, weight: 14, value: (a) => formatDate(a.createdAt) },
    {
      key: "appliedBy",
      header: "Applied by",
      width: 14,
      weight: 13,
      value: (a) => (appliedByEmployee(a) ? "Employee (app)" : "HR"),
    },
  ];
  return cols.filter((c): c is ExportColumn => c !== false);
}

export type SettlementExport = {
  title: string;
  /** "12 of 40 term loans · Status: Active · Search: "asha"". */
  subtitle: string;
  sheet: string;
  /** The file name without the date and extension. */
  fileStem: string;
  columns: ExportColumn[];
  rows: ExportCell[][];
  /** The totals row (the rupee columns summed), as long as a row. */
  totals: ExportCell[];
};

/** A tab's export: the list exactly as the page shows it (tab, month, every filter, search and sort). `total` is how
 *  many the tab has in the month, to say "12 of 40". */
export function buildExport(rows: SettlementRow[], s: PageState, total: number): SettlementExport {
  const columns = exportColumns(s.tab);
  const lines = rows.map((a) => columns.map((c) => c.value(a)));
  const totals = columns.map((c, i): ExportCell => {
    if (c.money) return round2(lines.reduce((sum, line) => sum + (typeof line[i] === "number" ? line[i] : 0), 0));
    return c.key === "employee" ? `Total (${countOf(rows.length, s.tab)})` : "";
  });
  const scope = describeScope(s);
  const tab = tabLabel(s.tab);
  const when = periodLabel(s.period);
  return {
    title: `Settlement - ${tab} - ${when}`,
    subtitle: `${rows.length} of ${countOf(total, s.tab)}${scope ? ` · ${scope}` : ""}`,
    sheet: `${tab} ${s.period ? `${MONTH_FULL[s.period.month - 1].slice(0, 3)} ${s.period.year}` : "all months"}`,
    fileStem: `Settlement_${tab}_${when}`,
    columns,
    rows: lines,
    totals,
  };
}
