// Promotion: the rules behind the page (filters, summary, who is due, the checks on the form), apart from the screens so
// they can be tested on their own. Nothing here decides what a promotion does: the server records it and updates the
// employee; this only helps HR find, check and read them.

import type { Employee } from "@/lib/api-client";
import type { PromotionItem } from "@/lib/api-client/custom-hooks";
import { compareNumber, compareText, distinct, matchesWords, sortBy, type SortDir } from "../career/common";
import { inRange, monthsBetween, parseYmd, periodRange, type Period } from "../career/dates";

/** A promotion as the list endpoint sends it: the branch and employment type are additive fields. */
export type PromotionRecord = PromotionItem & {
  branchName?: string | null;
  employmentType?: string | null;
};

/** What an employee row needs for the due list and the form. */
export type PromoEmployee = Pick<
  Employee,
  | "id"
  | "employeeCode"
  | "firstName"
  | "lastName"
  | "photoUrl"
  | "departmentId"
  | "departmentName"
  | "designationId"
  | "designationTitle"
  | "branchId"
  | "branchName"
  | "employmentType"
  | "joinDate"
  | "status"
>;

export const fullName = (e: Pick<Employee, "firstName" | "lastName">) => `${e.firstName} ${e.lastName}`.trim();

// ─── Kind ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PromotionKind = "designation" | "department" | "both";

/** What the record changed. A record where neither differs (old data) is read as a designation change. */
export function promotionKind(p: PromotionRecord): PromotionKind {
  const desig = (p.previousDesignation ?? null) !== (p.newDesignation ?? null);
  const dept = (p.previousDepartment ?? null) !== (p.newDepartment ?? null);
  if (desig && dept) return "both";
  if (dept) return "department";
  return "designation";
}

export { distinct };

export const KIND_LABEL: Record<PromotionKind, string> = {
  designation: "Designation",
  department: "Department",
  both: "Designation + department",
};

// ─── Filters and sorting ────────────────────────────────────────────────────────────────────────────────────────────

export type HistoryFilters = {
  query: string;
  /** "all" or a department name: either side of the move. */
  department: string;
  /** "all" or a designation title: what they were promoted to. */
  designation: string;
  branch: string;
  type: string;
  kind: "all" | PromotionKind;
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
  kind: "all",
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
  f.kind !== "all" ||
  f.period !== "all";

/** Every word typed must be in the name, code, designations, departments, notes or the person who recorded it. */
export function filterPromotions(rows: PromotionRecord[], f: HistoryFilters, today: string): PromotionRecord[] {
  const range = periodRange(f.period, today, { from: f.from, to: f.to });
  return rows.filter((p) => {
    if (f.department !== "all" && p.previousDepartment !== f.department && p.newDepartment !== f.department)
      return false;
    if (f.designation !== "all" && p.newDesignation !== f.designation) return false;
    if (f.branch !== "all" && p.branchName !== f.branch) return false;
    if (f.type !== "all" && p.employmentType !== f.type) return false;
    if (f.kind !== "all" && promotionKind(p) !== f.kind) return false;
    if (!inRange(p.effectiveDate, range)) return false;
    return matchesWords(
      f.query,
      p.employeeName,
      p.employeeCode,
      p.previousDesignation,
      p.newDesignation,
      p.previousDepartment,
      p.newDepartment,
      p.notes,
      p.promotedBy,
    );
  });
}

export type SortKey = "date" | "employee" | "designation" | "department";

export function sortPromotions(rows: PromotionRecord[], key: SortKey, dir: SortDir): PromotionRecord[] {
  const compare: Record<SortKey, (a: PromotionRecord, b: PromotionRecord) => number> = {
    date: (a, b) => compareText(a.effectiveDate, b.effectiveDate) || compareNumber(a.id, b.id),
    employee: (a, b) => compareText(a.employeeName, b.employeeName),
    designation: (a, b) => compareText(a.newDesignation, b.newDesignation),
    department: (a, b) => compareText(a.newDepartment, b.newDepartment),
  };
  return sortBy(rows, compare[key], dir);
}

// ─── Summary ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type PromotionSummary = {
  total: number;
  thisYear: number;
  thisMonth: number;
  /** Different people promoted at least once (all time). */
  employees: number;
  /** Promotions this year that moved the person to another department. */
  departmentMoves: number;
};

export function summarizePromotions(rows: PromotionRecord[], today: string): PromotionSummary {
  const t = parseYmd(today);
  let thisYear = 0;
  let thisMonth = 0;
  let departmentMoves = 0;
  for (const p of rows) {
    const d = parseYmd(p.effectiveDate);
    if (!d || !t || d.y !== t.y) continue;
    thisYear += 1;
    if (d.m === t.m) thisMonth += 1;
    if (promotionKind(p) !== "designation") departmentMoves += 1;
  }
  return {
    total: rows.length,
    thisYear,
    thisMonth,
    employees: new Set(rows.map((p) => p.employeeId)).size,
    departmentMoves,
  };
}

// ─── Who is due ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The newest effective date of each employee's promotions. */
export function lastPromotionDates(rows: PromotionRecord[]): Map<number, string> {
  const last = new Map<number, string>();
  for (const p of rows) {
    const known = last.get(p.employeeId);
    if (!known || p.effectiveDate > known) last.set(p.employeeId, p.effectiveDate);
  }
  return last;
}

export type DueRow = {
  employee: PromoEmployee;
  /** The day the wait started: their last promotion, otherwise the day they joined. */
  since: string;
  months: number;
  basis: "promotion" | "joining";
};

export const DUE_THRESHOLDS = [12, 18, 24, 36, 48];

/**
 * Active employees whose last promotion (or, if they never had one, joining date) is at least `thresholdMonths` ago,
 * longest wait first. `unknown` counts the active employees with neither date, who cannot be placed on the list.
 * This is a prompt for a conversation, not a rule: nothing here promotes anyone.
 */
export function dueForReview(
  employees: PromoEmployee[],
  promotions: PromotionRecord[],
  thresholdMonths: number,
  today: string,
): { rows: DueRow[]; unknown: number } {
  const last = lastPromotionDates(promotions);
  const rows: DueRow[] = [];
  let unknown = 0;
  for (const employee of employees) {
    if (employee.status !== "active") continue;
    const promoted = last.get(employee.id);
    const since = promoted ?? employee.joinDate ?? null;
    const months = since ? monthsBetween(since, today) : null;
    if (!since || months == null) {
      unknown += 1;
      continue;
    }
    if (months >= thresholdMonths) rows.push({ employee, since, months, basis: promoted ? "promotion" : "joining" });
  }
  rows.sort((a, b) => b.months - a.months || compareText(fullName(a.employee), fullName(b.employee)));
  return { rows, unknown };
}

export type DueFilters = {
  query: string;
  department: string;
  branch: string;
  type: string;
  basis: "all" | "promotion" | "joining";
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

export type PromotionDraft = {
  /** "" keeps what they have now. */
  newDesignationId: string;
  newDepartmentId: string;
  effectiveDate: string;
};

export type PromotionCheck = {
  /** Why the form cannot be submitted yet. */
  errors: string[];
  /** Things worth a second look that do not stop it. */
  warnings: string[];
  designationChanges: boolean;
  departmentChanges: boolean;
};

/**
 * Checks the form against the employee's current position: the same refusals the server makes (nothing chosen,
 * nothing different), plus a missing date, and warnings for dates that look odd. A designation or department chosen
 * that equals the current one counts as "no change", because the server compares the final position.
 */
export function checkPromotion(
  employee: Pick<PromoEmployee, "designationId" | "departmentId" | "joinDate">,
  draft: PromotionDraft,
  today: string,
  lastPromotion?: string | null,
): PromotionCheck {
  const designationChanges = draft.newDesignationId !== "" && Number(draft.newDesignationId) !== employee.designationId;
  const departmentChanges = draft.newDepartmentId !== "" && Number(draft.newDepartmentId) !== employee.departmentId;
  const errors: string[] = [];
  const warnings: string[] = [];

  if (draft.newDesignationId === "" && draft.newDepartmentId === "") {
    errors.push("Choose a new designation or department.");
  } else if (!designationChanges && !departmentChanges) {
    errors.push("That is the position they already hold: choose a different designation or department.");
  }

  if (!parseYmd(draft.effectiveDate)) {
    errors.push("Pick the effective date.");
  } else {
    if (employee.joinDate && draft.effectiveDate < employee.joinDate.slice(0, 10)) {
      warnings.push("The effective date is before their joining date.");
    }
    if (lastPromotion && draft.effectiveDate < lastPromotion) {
      warnings.push("The effective date is earlier than their last promotion.");
    }
    if (draft.effectiveDate > today) {
      warnings.push("This date is in the future, but the employee's profile still changes as soon as you promote.");
    }
  }
  return { errors, warnings, designationChanges, departmentChanges };
}

// ─── One employee's story ───────────────────────────────────────────────────────────────────────────────────────────

export type TimelineEntry =
  | { kind: "promotion"; date: string; record: PromotionRecord }
  | { kind: "joined"; date: string | null; designation: string | null; department: string | null };

/**
 * Newest first: their promotions, then the day they joined (with the position they started in, which the oldest
 * promotion remembers as its "previous" position).
 */
export function employeeTimeline(
  employee: Pick<PromoEmployee, "joinDate" | "designationTitle" | "departmentName">,
  promotions: PromotionRecord[],
): TimelineEntry[] {
  const ordered = sortBy(
    promotions,
    (a, b) => compareText(a.effectiveDate, b.effectiveDate) || compareNumber(a.id, b.id),
    "desc",
  );
  const oldest = ordered[ordered.length - 1];
  const entries: TimelineEntry[] = ordered.map((record) => ({ kind: "promotion", date: record.effectiveDate, record }));
  entries.push({
    kind: "joined",
    date: employee.joinDate ?? null,
    designation: oldest ? (oldest.previousDesignation ?? null) : (employee.designationTitle ?? null),
    department: oldest ? (oldest.previousDepartment ?? null) : (employee.departmentName ?? null),
  });
  return entries;
}

/** Months in the current position: since the last promotion, or since joining when there was none. */
export function monthsInRole(
  joinDate: string | null | undefined,
  lastPromotion: string | null | undefined,
  today: string,
): number | null {
  const since = lastPromotion ?? joinDate ?? null;
  return since ? monthsBetween(since, today) : null;
}
