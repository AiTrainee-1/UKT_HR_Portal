// Settlement (salary advances and term loans): the rules behind the page, kept apart from the screens so they can be
// tested on their own. Nothing here decides or changes a real amount: the server creates the repayment schedule and
// payroll deducts it. The schedule preview is a twin of settlement_views._auto_create_repayments, only to show HR what an
// approval will create.

import type { Advance } from "@/lib/api-client";
import type { Tone } from "@/lib/statusTones";
import {
  MONTHS,
  formatDate,
  formatMoney,
  inDayRange,
  localDay,
  matchesWords,
  monthLabel,
  type ExportTable,
} from "./shared";

/** An advance as the list sends it. The branch, employee type and employee status are additive fields: an older
 *  backend does not send them, and the page then simply has nothing to filter those by. */
export type SettlementRow = Advance & {
  employeeBranchId?: number | null;
  employeeBranch?: string | null;
  employeeType?: string | null;
  employeeStatus?: string | null;
};

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

export const TYPE_LABEL: Record<Advance["advanceType"], string> = { general: "General", term: "Term loan" };

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
      s.pendingAmount += a.amount;
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

/** Every word typed must appear in the employee's name, code, department, designation, branch, or the purpose. */
export function filterRows(rows: SettlementRow[], f: Filters, ignoreStatus = false): SettlementRow[] {
  return rows.filter((a) => {
    if (!ignoreStatus && f.status !== "all" && a.status !== f.status) return false;
    if (f.type !== "all" && a.advanceType !== f.type) return false;
    if (f.branch !== "all" && (a.employeeBranch ?? "") !== f.branch) return false;
    if (f.department !== "all" && (a.employeeDepartment ?? "") !== f.department) return false;
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

/** "amount:desc" from the sort dropdown. */
export function parseSort(value: string): Sort {
  const [key, dir] = value.split(":");
  return { key: key as SortKey, dir: dir === "asc" ? "asc" : "desc" };
}

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

// ─── The repayment schedule an approval creates ─────────────────────────────────

export type ScheduleItem = { month: number; year: number; amount: number };

export type SchedulePreview = {
  items: ScheduleItem[];
  total: number;
  /** What the schedule does not cover (rounding of an EMI worked out from a number of months). */
  shortfall: number;
};

/** Twin of settlement_views._auto_create_repayments: a general advance is one deduction in its start month; a term
 *  loan is a monthly EMI (the last one smaller) for `months`, or for as many months as it takes. */
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

/** A blank form; payroll deducts from next month unless HR says otherwise. */
export function emptyForm(now = new Date()): AdvanceForm {
  const nextMonth = now.getMonth() + 2 > 12 ? 1 : now.getMonth() + 2;
  return {
    employeeId: "",
    advanceType: "general",
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

// ─── Export ─────────────────────────────────────────────────────────────────────

export function exportTable(rows: SettlementRow[]): ExportTable {
  return {
    sheet: "Advances",
    title: "Settlement: advances and term loans",
    headers: [
      "Employee code",
      "Employee",
      "Department",
      "Branch",
      "Employee type",
      "Employee status",
      "Advance type",
      "Status",
      "Amount",
      "Repaid",
      "Outstanding",
      "Recovered %",
      "Monthly EMI",
      "Months",
      "Deduction starts",
      "Purpose",
      "Raised on",
      "Approved by",
      "Approved on",
    ],
    rows: rows.map((a) => [
      a.employeeCode,
      a.employeeName,
      a.employeeDepartment ?? "",
      a.employeeBranch ?? "",
      a.employeeType ?? "",
      a.employeeStatus ?? "",
      TYPE_LABEL[a.advanceType],
      STATUS_LABEL[a.status],
      a.amount,
      a.totalRepaid,
      a.outstanding,
      progressPct(a),
      a.advanceType === "term" ? a.emiAmount : "",
      a.repaymentMonths ?? "",
      a.repaymentStartMonth && a.repaymentStartYear
        ? `${MONTHS[a.repaymentStartMonth - 1]} ${a.repaymentStartYear}`
        : "",
      a.purpose ?? "",
      formatDate(a.createdAt),
      a.approvedBy ?? "",
      formatDate(a.approvedAt),
    ]),
  };
}
