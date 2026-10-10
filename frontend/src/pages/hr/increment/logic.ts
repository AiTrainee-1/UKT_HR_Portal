// Increment: the rules behind the page (filters, summary figures, who is due, the checks on the form), apart from the
// screens so they can be tested on their own. Nothing here works out what an increment does to the salary on the
// server: the one calculation the page shows, the preview, is `projectSalary` in ../career/common, which is that same
// arithmetic.

import type { Employee } from "@/lib/api-client";
import type { IncrementItem } from "@/lib/api-client/custom-hooks";
import {
  checkPercent,
  compareNumber,
  compareText,
  distinct,
  HIGH_INCREMENT_PERCENT,
  matchesWords,
  projectSalary,
  sortBy,
  type SortDir,
} from "../career/common";
import { inRange, monthKey, monthsBetween, parseYmd, periodRange, formatMonth, type Period } from "../career/dates";

/** An increment as the history endpoint sends it: the employee's department, designation, branch and type come with it. */
export type IncrementRecord = IncrementItem & {
  department?: string | null;
  designation?: string | null;
  branchName?: string | null;
  employmentType?: string | null;
};

export type IncrementEmployee = Pick<
  Employee,
  | "id"
  | "employeeCode"
  | "firstName"
  | "lastName"
  | "photoUrl"
  | "departmentName"
  | "designationTitle"
  | "branchName"
  | "employmentType"
  | "joinDate"
  | "salaryAmount"
  | "salaryType"
  | "status"
>;

export const fullName = (e: Pick<Employee, "firstName" | "lastName">) => `${e.firstName} ${e.lastName}`.trim();

/** How much a single increment added to the salary. */
export const amountOf = (r: Pick<IncrementItem, "previousSalary" | "newSalary">) =>
  Math.round((r.newSalary - r.previousSalary) * 100) / 100;

export { distinct };

// ─── Filters and sorting ────────────────────────────────────────────────────────────────────────────────────────────

export type Band = "all" | "under_5" | "5_to_10" | "10_to_15" | "over_15";

export const BAND_OPTIONS: { value: Band; label: string }[] = [
  { value: "under_5", label: "Under 5%" },
  { value: "5_to_10", label: "5% to 10%" },
  { value: "10_to_15", label: "10% to 15%" },
  { value: "over_15", label: "Over 15%" },
];

/** Does a percentage fall in the band? The lower edge belongs to the higher band: 5 is "5% to 10%". */
export function inBand(percent: number, band: Band): boolean {
  switch (band) {
    case "under_5":
      return percent < 5;
    case "5_to_10":
      return percent >= 5 && percent < 10;
    case "10_to_15":
      return percent >= 10 && percent < 15;
    case "over_15":
      return percent >= 15;
    default:
      return true;
  }
}

export type HistoryFilters = {
  query: string;
  department: string;
  designation: string;
  branch: string;
  type: string;
  band: Band;
  period: Period;
  from: string;
  to: string;
};

export const NO_FILTERS: HistoryFilters = {
  query: "",
  department: "all",
  designation: "all",
  branch: "all",
  type: "all",
  band: "all",
  period: "all",
  from: "",
  to: "",
};

export const filtersActive = (f: HistoryFilters) =>
  f.query.trim() !== "" ||
  f.department !== "all" ||
  f.designation !== "all" ||
  f.branch !== "all" ||
  f.type !== "all" ||
  f.band !== "all" ||
  f.period !== "all";

export function filterIncrements(rows: IncrementRecord[], f: HistoryFilters, today: string): IncrementRecord[] {
  const range = periodRange(f.period, today, { from: f.from, to: f.to });
  return rows.filter((r) => {
    if (f.department !== "all" && r.department !== f.department) return false;
    if (f.designation !== "all" && r.designation !== f.designation) return false;
    if (f.branch !== "all" && r.branchName !== f.branch) return false;
    if (f.type !== "all" && r.employmentType !== f.type) return false;
    if (!inBand(r.percent, f.band)) return false;
    if (!inRange(r.effectiveDate, range)) return false;
    return matchesWords(f.query, r.employeeName, r.employeeCode, r.department, r.designation, r.notes, r.addedBy);
  });
}

export type SortKey = "date" | "employee" | "percent" | "amount" | "salary";

export function sortIncrements(rows: IncrementRecord[], key: SortKey, dir: SortDir): IncrementRecord[] {
  const compare: Record<SortKey, (a: IncrementRecord, b: IncrementRecord) => number> = {
    date: (a, b) => compareText(a.effectiveDate, b.effectiveDate) || compareNumber(a.id, b.id),
    employee: (a, b) => compareText(a.employeeName, b.employeeName),
    percent: (a, b) => compareNumber(a.percent, b.percent),
    amount: (a, b) => compareNumber(amountOf(a), amountOf(b)),
    salary: (a, b) => compareNumber(a.newSalary, b.newSalary),
  };
  return sortBy(rows, compare[key], dir);
}

// ─── Summary ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type IncrementSummary = {
  total: number;
  employees: number;
  totalAmount: number;
  avgPercent: number;
  thisYear: { count: number; amount: number; avgPercent: number };
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeIncrements(rows: IncrementRecord[], today: string): IncrementSummary {
  const year = parseYmd(today)?.y;
  let totalAmount = 0;
  let percentSum = 0;
  const yearRows: IncrementRecord[] = [];
  for (const r of rows) {
    totalAmount += amountOf(r);
    percentSum += r.percent;
    if (parseYmd(r.effectiveDate)?.y === year) yearRows.push(r);
  }
  const yearAmount = yearRows.reduce((sum, r) => sum + amountOf(r), 0);
  const yearPercent = yearRows.reduce((sum, r) => sum + r.percent, 0);
  return {
    total: rows.length,
    employees: new Set(rows.map((r) => r.employeeId)).size,
    totalAmount: round2(totalAmount),
    avgPercent: rows.length ? round2(percentSum / rows.length) : 0,
    thisYear: {
      count: yearRows.length,
      amount: round2(yearAmount),
      avgPercent: yearRows.length ? round2(yearPercent / yearRows.length) : 0,
    },
  };
}

export type DepartmentRow = {
  department: string;
  incrementCount: number;
  employeeCount: number;
  avgPercent: number;
  totalAmount: number;
};

/** Per department (the employee's department today): the biggest total increase first. People with none are "Unassigned". */
export function departmentBreakdown(rows: IncrementRecord[]): DepartmentRow[] {
  const groups = new Map<string, { count: number; percent: number; amount: number; people: Set<number> }>();
  for (const r of rows) {
    const key = r.department || "Unassigned";
    const g = groups.get(key) ?? { count: 0, percent: 0, amount: 0, people: new Set<number>() };
    g.count += 1;
    g.percent += r.percent;
    g.amount += amountOf(r);
    g.people.add(r.employeeId);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([department, g]) => ({
      department,
      incrementCount: g.count,
      employeeCount: g.people.size,
      avgPercent: round2(g.percent / g.count),
      totalAmount: round2(g.amount),
    }))
    .sort((a, b) => b.totalAmount - a.totalAmount || compareText(a.department, b.department));
}

/** The largest percentages first; of two equal ones, the newer. */
export function topIncrements(rows: IncrementRecord[], n = 5): IncrementRecord[] {
  return sortBy(
    rows,
    (a, b) => compareNumber(a.percent, b.percent) || compareText(a.effectiveDate, b.effectiveDate),
    "desc",
  ).slice(0, n);
}

export type MonthBucket = { key: string; label: string; count: number; amount: number };

/** The last `months` calendar months, oldest first, each with how many increments took effect in it and what they added. */
export function monthlyTrend(rows: IncrementRecord[], today: string, months = 12): MonthBucket[] {
  const t = parseYmd(today);
  if (!t) return [];
  const buckets: MonthBucket[] = [];
  for (let i = months - 1; i >= 0; i--) {
    const total = t.y * 12 + (t.m - 1) - i;
    const y = Math.floor(total / 12);
    const m = (total % 12) + 1;
    const key = `${y}-${String(m).padStart(2, "0")}`;
    buckets.push({ key, label: formatMonth(`${key}-01`), count: 0, amount: 0 });
  }
  const byKey = new Map(buckets.map((b) => [b.key, b]));
  for (const r of rows) {
    const b = byKey.get(monthKey(r.effectiveDate) ?? "");
    if (b) {
      b.count += 1;
      b.amount = round2(b.amount + amountOf(r));
    }
  }
  return buckets;
}

// ─── Who is due ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type LastIncrement = { date: string; percent: number };

/** Each employee's newest increment (by effective date, then by when it was recorded). */
export function lastIncrements(rows: IncrementRecord[]): Map<number, LastIncrement & { id: number }> {
  const last = new Map<number, LastIncrement & { id: number }>();
  for (const r of rows) {
    const known = last.get(r.employeeId);
    if (!known || r.effectiveDate > known.date || (r.effectiveDate === known.date && r.id > known.id)) {
      last.set(r.employeeId, { date: r.effectiveDate, percent: r.percent, id: r.id });
    }
  }
  return last;
}

export type DueRow = {
  employee: IncrementEmployee;
  /** The day the wait started: their last increment, otherwise the day they joined. */
  since: string;
  months: number;
  basis: "increment" | "joining";
  lastPercent: number | null;
};

export const DUE_THRESHOLDS = [6, 9, 12, 18, 24];

/**
 * Active employees with a salary whose last increment (or, if they never had one, joining date) is at least
 * `thresholdMonths` ago, longest wait first. `unknown` counts those with neither date; `noSalary` those with no
 * salary on record, who cannot be given a percentage increment. A prompt to review, not a rule.
 */
export function dueForIncrement(
  employees: IncrementEmployee[],
  increments: IncrementRecord[],
  thresholdMonths: number,
  today: string,
): { rows: DueRow[]; unknown: number; noSalary: number } {
  const last = lastIncrements(increments);
  const rows: DueRow[] = [];
  let unknown = 0;
  let noSalary = 0;
  for (const employee of employees) {
    if (employee.status !== "active") continue;
    if (!employee.salaryAmount || employee.salaryAmount <= 0) {
      noSalary += 1;
      continue;
    }
    const given = last.get(employee.id);
    const since = given?.date ?? employee.joinDate ?? null;
    const months = since ? monthsBetween(since, today) : null;
    if (!since || months == null) {
      unknown += 1;
      continue;
    }
    if (months >= thresholdMonths) {
      rows.push({
        employee,
        since,
        months,
        basis: given ? "increment" : "joining",
        lastPercent: given?.percent ?? null,
      });
    }
  }
  rows.sort((a, b) => b.months - a.months || compareText(fullName(a.employee), fullName(b.employee)));
  return { rows, unknown, noSalary };
}

export type DueFilters = {
  query: string;
  department: string;
  branch: string;
  type: string;
  basis: "all" | "increment" | "joining";
};

export const NO_DUE_FILTERS: DueFilters = { query: "", department: "all", branch: "all", type: "all", basis: "all" };

export const dueFiltersActive = (f: DueFilters) =>
  f.query.trim() !== "" || f.department !== "all" || f.branch !== "all" || f.type !== "all" || f.basis !== "all";

export function filterDue(rows: DueRow[], f: DueFilters): DueRow[] {
  return rows.filter(({ employee: e, basis }) => {
    if (f.department !== "all" && e.departmentName !== f.department) return false;
    if (f.branch !== "all" && e.branchName !== f.branch) return false;
    if (f.type !== "all" && e.employmentType !== f.type) return false;
    if (f.basis !== "all" && basis !== f.basis) return false;
    return matchesWords(f.query, fullName(e), e.employeeCode, e.designationTitle, e.departmentName);
  });
}

// ─── The form ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** An increment this soon after the last one is worth a second look. */
export const RECENT_INCREMENT_MONTHS = 6;

export type IncrementCheck = {
  /** Why the form cannot be submitted yet. */
  errors: string[];
  /** Worth a second look; does not stop it. */
  warnings: string[];
  /** The salary after the increment, to the paisa, when the percentage is valid. */
  projection: { newSalary: number; increase: number } | null;
};

export function checkIncrement(
  input: { percent: string; effectiveDate: string; currentSalary: number; joinDate?: string | null },
  today: string,
  last?: LastIncrement | null,
): IncrementCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const percent = checkPercent(input.percent);
  if (!(input.currentSalary > 0)) {
    errors.push("This employee has no base salary on record. Set the salary on the employee's profile first.");
  } else if (!percent.ok) {
    errors.push(percent.message);
  }
  if (!parseYmd(input.effectiveDate)) {
    errors.push("Pick the effective date.");
  } else {
    if (input.joinDate && input.effectiveDate < input.joinDate.slice(0, 10)) {
      warnings.push("The effective date is before their joining date.");
    }
    if (last && input.effectiveDate < last.date)
      warnings.push("The effective date is earlier than their last increment.");
    if (input.effectiveDate > today) {
      warnings.push(
        "This date is in the future, but the salary on their record still changes as soon as you apply it.",
      );
    }
  }
  if (percent.ok && percent.value >= HIGH_INCREMENT_PERCENT) {
    warnings.push(`${percent.value}% is a large increase. Check the percentage before applying.`);
  }
  if (last) {
    const ago = monthsBetween(last.date, today);
    if (ago != null && ago >= 0 && ago < RECENT_INCREMENT_MONTHS) {
      warnings.push(
        `Their last increment (${last.percent}%) was only ${ago < 1 ? "this month" : `${ago} month${ago === 1 ? "" : "s"} ago`}.`,
      );
    }
  }
  const projection = input.currentSalary > 0 ? projectSalary(input.currentSalary, input.percent) : null;
  return { errors, warnings, projection };
}

export type SalaryStep = {
  id: number;
  date: string;
  from: number;
  to: number;
  percent: number;
  amount: number;
  notes: string | null;
  addedBy: string | null;
};

/** One employee's salary path, newest first, from their increments. */
export function salaryPath(rows: IncrementItem[]): SalaryStep[] {
  return sortBy(
    rows.map((r) => ({
      id: r.id,
      date: r.effectiveDate,
      from: r.previousSalary,
      to: r.newSalary,
      percent: r.percent,
      amount: amountOf(r),
      notes: r.notes ?? null,
      addedBy: r.addedBy ?? null,
    })),
    (a, b) => compareText(a.date, b.date) || compareNumber(a.id, b.id),
    "desc",
  );
}
