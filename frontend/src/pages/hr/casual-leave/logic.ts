// Casual Leave: the rules behind the page (who has taken CL in a month, who still can, who cannot and why), kept apart
// from the screens so they can be tested on their own. The rules themselves live in backend/api/casual_leave_views.py
// (staff only, six months of service, one a month, pending or approved counts); this only reads back what the API
// decided and words it.

import type { ApprovalProgress } from "@/lib/approval-workflow";
import {
  ALL,
  MONTHS,
  dateOnly,
  isoDate,
  daysInMonth,
  longDate,
  matchesPerson,
  personFiltersActive,
  shortDate,
  type PersonFields,
  type PersonFilters,
} from "../leave/logic";

export type ReasonCode = "not_staff" | "no_join_date" | "under_service" | "used_this_month";

/** One employee's standing for the month (GET /api/casual-leaves/eligibility?scope=all). */
export type BoardRow = PersonFields & {
  joinDate?: string | null;
  serviceMonths: number | null;
  eligible: boolean;
  reason?: string | null;
  reasonCode?: ReasonCode | null;
  /** The first day six months of service are complete (staff with a join date). */
  eligibleFrom?: string | null;
  lastClDate?: string | null;
  approvedThisYear?: number;
  usedThisMonth: boolean;
  usedStatus?: string | null;
  usedDate?: string | null;
  usedRequestId?: number | null;
  usedReviewedBy?: string | null;
  usedReviewerRole?: string | null;
  usedApproval?: ApprovalProgress | null;
};

export type ClBoard = {
  month: number;
  year: number;
  eligibilityMonths: number;
  referenceDate?: string;
  monthStart?: string;
  monthEnd?: string;
  counts?: { eligible: number; notEligible: number; usedThisMonth: number };
  employees: BoardRow[];
};

/** A casual leave request, as the list returns it (the employee fields beyond the name were added for the filters). */
export type ClRequest = PersonFields & {
  id: number;
  date: string;
  reason?: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: string | null;
  reviewerRole?: string | null;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  createdAt?: string | null;
  approval?: ApprovalProgress | null;
};

export const isCurrentMonth = (year: number, month: number, today: string) =>
  today.startsWith(`${year}-${String(month).padStart(2, "0")}-`);

/** "October 2026". */
export const monthTitle = (year: number, month: number) => `${MONTHS[month - 1]} ${year}`;

// ─── Wording ───

/** "7 months" -> "7 mo"; 31 months -> "2 yr 7 mo"; null -> "-". */
export function serviceText(months: number | null | undefined): string {
  if (months === null || months === undefined) return "-";
  if (months < 12) return `${months} mo`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return rest ? `${years} yr ${rest} mo` : `${years} yr`;
}

export type Why = {
  code: ReasonCode;
  /** The short answer: "Production employee". */
  title: string;
  /** The rest: what to do or when it changes. */
  detail: string;
  /** For ordering the list and tinting the chip. */
  tone: "info" | "warning" | "neutral" | "danger";
};

/** Why an employee cannot take Casual Leave this month, in words HR can read out; null when they can. Someone who is
 *  under six months is told the day they qualify. */
export function whyNot(row: BoardRow, months = 6): Why | null {
  if (row.eligible) return null;
  const code =
    row.reasonCode ??
    (row.usedThisMonth ? "used_this_month" : row.employmentType === "production" ? "not_staff" : null);
  switch (code) {
    case "not_staff":
      return {
        code,
        title: "Production employee",
        detail: "Casual Leave is only for staff. Production employees are not eligible.",
        tone: "neutral",
      };
    case "no_join_date":
      return {
        code,
        title: "Join date not set",
        detail: "Set the join date in the employee's profile so service length can be counted.",
        tone: "danger",
      };
    case "under_service": {
      const done = row.serviceMonths ?? 0;
      const from = row.eligibleFrom ? ` Becomes eligible on ${longDate(row.eligibleFrom)}.` : "";
      return {
        code,
        title: `Under ${months} months of service`,
        detail: `${done} of ${months} months completed.${from}`,
        tone: "warning",
      };
    }
    case "used_this_month": {
      const on = row.usedDate ? ` on ${shortDate(row.usedDate)}` : "";
      const state = row.usedStatus === "pending" ? "requested, waiting for a decision" : "approved";
      return {
        code,
        title: "Already used this month",
        detail: `One Casual Leave a month: CL${on} is ${state}.`,
        tone: "info",
      };
    }
    default:
      return { code: "under_service", title: row.reason ?? "Not eligible", detail: row.reason ?? "", tone: "neutral" };
  }
}

/** Does the employee complete six months on a day of this month (so they are not eligible yet, but will be)? */
export function becomesEligibleThisMonth(row: BoardRow, monthStart: string, monthEnd: string): boolean {
  const from = dateOnly(row.eligibleFrom);
  return row.reasonCode === "under_service" && from !== null && from >= monthStart && from <= monthEnd;
}

// ─── Filters ───

export type ClFilters = PersonFilters;
export const NO_CL_FILTERS: ClFilters = { query: "", branch: ALL, department: ALL, employeeType: ALL };

export const clFiltersActive = (f: ClFilters, extra: string[] = []) =>
  personFiltersActive(f) || extra.some((x) => x !== ALL);

export function filterBoard(rows: BoardRow[], f: ClFilters): BoardRow[] {
  return rows.filter((r) => matchesPerson(r, f));
}

export function filterRequests(rows: ClRequest[], f: ClFilters, status: string = ALL): ClRequest[] {
  return rows.filter((r) => (status === ALL || r.status === status) && matchesPerson(r, f));
}

// ─── Splits and orderings ───

/** Eligible first-come by name, for the Eligible tab. */
export function eligibleRows(rows: BoardRow[]): BoardRow[] {
  return rows
    .filter((r) => r.eligible)
    .sort((a, b) => (a.employeeName ?? "").localeCompare(b.employeeName ?? "") || a.employeeId - b.employeeId);
}

const REASON_ORDER: Record<string, number> = { used_this_month: 0, under_service: 1, no_join_date: 2, not_staff: 3 };

/** Everyone who cannot take CL: already used first, then soonest to qualify, then the rest, then production. */
export function notEligibleRows(rows: BoardRow[]): BoardRow[] {
  return rows
    .filter((r) => !r.eligible)
    .sort((a, b) => {
      const oa = REASON_ORDER[a.reasonCode ?? ""] ?? 9;
      const ob = REASON_ORDER[b.reasonCode ?? ""] ?? 9;
      if (oa !== ob) return oa - ob;
      if (a.reasonCode === "under_service" && b.reasonCode === "under_service") {
        const byDate = (a.eligibleFrom ?? "9999").localeCompare(b.eligibleFrom ?? "9999");
        if (byDate) return byDate;
      }
      return (a.employeeName ?? "").localeCompare(b.employeeName ?? "") || a.employeeId - b.employeeId;
    });
}

export function countByReason(rows: BoardRow[]): Record<ReasonCode, number> {
  const out: Record<ReasonCode, number> = { not_staff: 0, no_join_date: 0, under_service: 0, used_this_month: 0 };
  for (const r of rows) {
    if (r.eligible) continue;
    const code = whyNot(r)?.code;
    if (code) out[code] += 1;
  }
  return out;
}

/** Who took CL (approved) or is waiting for it (pending) this month, by date. A rejected request is not CL. */
export function takenRows(requests: ClRequest[]): ClRequest[] {
  return requests
    .filter((r) => r.status === "approved" || r.status === "pending")
    .sort(
      (a, b) =>
        (dateOnly(a.date) ?? "").localeCompare(dateOnly(b.date) ?? "") ||
        (a.employeeName ?? "").localeCompare(b.employeeName ?? "") ||
        a.id - b.id,
    );
}

/** Every request: what needs a decision first (the longest-waiting first), then the rest by date, newest first. */
export function sortRequests(rows: ClRequest[]): ClRequest[] {
  return [...rows].sort((a, b) => {
    const pa = a.status === "pending" ? 0 : 1;
    const pb = b.status === "pending" ? 0 : 1;
    if (pa !== pb) return pa - pb;
    if (pa === 0) return (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.id - b.id;
    return (dateOnly(b.date) ?? "").localeCompare(dateOnly(a.date) ?? "") || b.id - a.id;
  });
}

export type ClSummary = {
  /** Approved Casual Leave this month. */
  taken: number;
  /** Requested and waiting for a decision. */
  pending: number;
  rejected: number;
  eligible: number;
  notEligible: number;
  /** Staff on the board (eligible + not eligible among staff). */
  staff: number;
  production: number;
  byReason: Record<ReasonCode, number>;
};

export function summarize(board: BoardRow[], requests: ClRequest[]): ClSummary {
  const byReason = countByReason(board);
  return {
    taken: requests.filter((r) => r.status === "approved").length,
    pending: requests.filter((r) => r.status === "pending").length,
    rejected: requests.filter((r) => r.status === "rejected").length,
    eligible: board.filter((r) => r.eligible).length,
    notEligible: board.filter((r) => !r.eligible).length,
    staff: board.filter((r) => r.employmentType !== "production").length,
    production: board.filter((r) => r.employmentType === "production").length,
    byReason,
  };
}

// ─── Applying on someone's behalf ───

/** The date the apply dialog opens on: today when it is in the month, else the month's first day. */
export function defaultApplyDate(year: number, month: number, today: string): string {
  return isCurrentMonth(year, month, today) ? today : isoDate(year, month, 1);
}

export function monthBounds(year: number, month: number) {
  return { first: isoDate(year, month, 1), last: isoDate(year, month, daysInMonth(year, month)) };
}

/** Is `date` a day of the month? (Casual Leave counts per calendar month of the date, so the dialog keeps to it.) */
export function inMonth(date: string, year: number, month: number): boolean {
  const { first, last } = monthBounds(year, month);
  return date >= first && date <= last;
}

// ─── Export ───

export const REQUEST_EXPORT_HEADERS = [
  "Employee code",
  "Employee",
  "Branch",
  "Department",
  "CL date",
  "Status",
  "Decided by",
  "Decided on",
  "Reason",
];

export function requestExportRows(rows: ClRequest[]): (string | number)[][] {
  return rows.map((r) => [
    r.employeeCode ?? "",
    r.employeeName ?? "",
    r.branch ?? "",
    r.department ?? "",
    dateOnly(r.date) ?? "",
    r.status,
    r.reviewedBy ?? "",
    dateOnly(r.reviewedAt) ?? "",
    r.reason ?? "",
  ]);
}

export const BOARD_EXPORT_HEADERS = [
  "Employee code",
  "Employee",
  "Branch",
  "Department",
  "Type",
  "Joined",
  "Service (months)",
  "Eligible",
  "Why not",
  "Eligible from",
  "Last CL",
];

export function boardExportRows(rows: BoardRow[]): (string | number)[][] {
  return rows.map((r) => {
    const why = whyNot(r);
    return [
      r.employeeCode ?? "",
      r.employeeName ?? "",
      r.branch ?? "",
      r.department ?? "",
      r.employmentType ?? "",
      r.joinDate ?? "",
      r.serviceMonths ?? "",
      r.eligible ? "Yes" : "No",
      why ? `${why.title}. ${why.detail}` : "",
      r.eligibleFrom ?? "",
      r.lastClDate ?? "",
    ];
  });
}
