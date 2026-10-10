// Missing Punch: the rules behind the page, kept apart from the screens so they can be tested on their own. Who may decide a
// request is the approval pipeline's call (lib/approval-workflow.ts, which mirrors backend/api/approval_workflow.py); nothing
// here decides that, it only asks.

import { ROLE_LABEL, hrCanAct, hrCanReject, stepLabel, waitingText, type ApprovalRole } from "@/lib/approval-workflow";
import type { MissingPunchItem, MissingPunchSlot } from "@/lib/api-client/custom-hooks";
import { formatDate, formatDateTime, inDayRange, localDay, matchesWords, type ExportTable } from "../settlement/shared";

/** A request as the list sends it. The branch is an additive field: an older backend does not send it. */
export type MissingRow = MissingPunchItem & { branch?: string | null; branchId?: number | null };

/** The list endpoint returns at most this many requests (newest first). */
export const LIST_CAP = 300;

export const STAGE_LABEL: Record<string, string> = {
  pending_hod: "Awaiting Department Head",
  pending_hr: "Awaiting HR",
  approved: "Approved",
  rejected: "Rejected",
};

// Mirrors the employee-facing apps: purely descriptive, never the source of truth for real P1-P4 identity (the
// attendance engine derives that from punch time, not a stored label).
export const PUNCH_SLOT_LABEL: Record<MissingPunchSlot, string> = {
  morning_in: "Morning Check-In",
  lunch_out: "Lunch Check-Out",
  lunch_in: "Lunch Check-In",
  evening_out: "Evening Check-Out",
};

export function punchLabel(r: Pick<MissingPunchItem, "punchSlot" | "punchType">): string {
  return r.punchSlot ? PUNCH_SLOT_LABEL[r.punchSlot] : r.punchType === "IN" ? "Check-In" : "Check-Out";
}

/** "9:05 am" from the "09:05" the server sends. */
export function formatPunchTime(time: string | null | undefined): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(time ?? "");
  if (!m) return time || "-";
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h >= 12 ? "pm" : "am"}`;
}

/** "Thu" for a "YYYY-MM-DD" day. */
export function weekdayOf(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  if (!y || !m || !d) return "";
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", { weekday: "short" });
}

export const isPending = (r: MissingRow): boolean => r.status === "pending_hod" || r.status === "pending_hr";

/** What HR may decide follows the approval pipeline (User Management -> Approval Workflow Control), not the status label:
 *  an older backend sends no pipeline, and then HR decides at "Awaiting HR" only, as it always did. */
export const hrDecides = (r: MissingRow): boolean => hrCanAct(r.approval, r.status === "pending_hr");
export const hrRejects = (r: MissingRow): boolean => hrCanReject(r.approval, r.status === "pending_hr");

/** The requests a bulk approval may include: pending ones HR may approve right now. */
export const bulkApprovable = (rows: MissingRow[]): MissingRow[] => rows.filter((r) => isPending(r) && hrDecides(r));

// ─── Who decided, and when ──────────────────────────────────────────────────────

export type DecisionLine = {
  role: string;
  outcome: "approved" | "rejected";
  by: string | null;
  at: string | null;
  comment: string | null;
};

/** The decisions made so far, oldest step first. Read from the pipeline when the server sent it (so a request that HR
 *  decided before the Department Head, or alone, is described correctly), and from the two review fields otherwise. */
export function decisionLines(r: MissingRow): DecisionLine[] {
  const fromRole = (role: ApprovalRole) =>
    role === "hod"
      ? { by: r.hodReviewedBy, at: r.hodReviewedAt, comment: r.hodReviewComment }
      : { by: r.hrReviewedBy, at: r.hrReviewedAt, comment: r.hrReviewComment };

  const steps = r.approval?.steps.filter((s) => s.state === "approved" || s.state === "rejected") ?? [];
  if (steps.length > 0) {
    return steps.map((s) => {
      const role = s.decidedBy ?? s.roles[0];
      const own = fromRole(role);
      return {
        role: ROLE_LABEL[role] ?? stepLabel(s),
        outcome: s.state === "rejected" ? "rejected" : "approved",
        by: s.by ?? own.by,
        at: s.at ?? own.at,
        comment: s.comment ?? own.comment,
      };
    });
  }

  const lines: DecisionLine[] = [];
  if (r.hodReviewedBy) {
    lines.push({
      role: "HOD",
      outcome: r.status === "rejected" && !r.hrReviewedBy ? "rejected" : "approved",
      ...fromRole("hod"),
    });
  }
  if (r.hrReviewedBy) {
    lines.push({ role: "HR", outcome: r.status === "rejected" ? "rejected" : "approved", ...fromRole("hr") });
  }
  return lines;
}

/** When the request was last decided (the later of the two review times), or null while nobody has. */
export function decidedAt(r: MissingRow): string | null {
  const times = [r.hodReviewedAt, r.hrReviewedAt].filter((t): t is string => !!t);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

// ─── Summary ────────────────────────────────────────────────────────────────────

export type Summary = {
  awaitingHr: number;
  /** Awaiting HR AND HR may decide now (the pipeline can let HR act at another status). */
  hrCanDecide: number;
  awaitingHod: number;
  approvedThisMonth: number;
  rejectedThisMonth: number;
};

const sameMonth = (iso: string | null | undefined, now: Date): boolean => {
  const day = localDay(iso);
  if (!day) return false;
  return day.slice(0, 7) === `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
};

export function summarize(rows: MissingRow[], now = new Date()): Summary {
  const s: Summary = { awaitingHr: 0, hrCanDecide: 0, awaitingHod: 0, approvedThisMonth: 0, rejectedThisMonth: 0 };
  for (const r of rows) {
    if (r.status === "pending_hr") s.awaitingHr += 1;
    if (r.status === "pending_hod") s.awaitingHod += 1;
    if (isPending(r) && hrDecides(r)) s.hrCanDecide += 1;
    // a request counts in the month it was decided (or, if that is not recorded, the month it was raised)
    if ((r.status === "approved" || r.status === "rejected") && sameMonth(decidedAt(r) ?? r.createdAt, now)) {
      if (r.status === "approved") s.approvedThisMonth += 1;
      else s.rejectedThisMonth += 1;
    }
  }
  return s;
}

// ─── Filters ────────────────────────────────────────────────────────────────────

export type StatusFilter = "all" | "pending" | "pending_hr" | "pending_hod" | "approved" | "rejected";
/** "all", a slot, or "other" (a request that names no slot: only a check-in or check-out). */
export type SlotFilter = "all" | MissingPunchSlot | "other";

export type Filters = {
  query: string;
  status: StatusFilter;
  slot: SlotFilter;
  branch: string;
  department: string;
  /** The date the punch was missed, from / to ("YYYY-MM-DD", empty = open). */
  from: string;
  to: string;
};

export const NO_FILTERS: Filters = {
  query: "",
  status: "all",
  slot: "all",
  branch: "all",
  department: "all",
  from: "",
  to: "",
};

/** The page opens on the requests still waiting for someone, as it always did. */
export const DEFAULT_FILTERS: Filters = { ...NO_FILTERS, status: "pending" };

export const filtersActive = (f: Filters): boolean =>
  f.query.trim() !== "" ||
  f.status !== "all" ||
  f.slot !== "all" ||
  f.branch !== "all" ||
  f.department !== "all" ||
  f.from !== "" ||
  f.to !== "";

const statusMatches = (r: MissingRow, status: StatusFilter): boolean =>
  status === "all" || (status === "pending" ? isPending(r) : r.status === status);

/** Every word typed must appear in the employee's name, code, department, branch, the reason, the date or the punch slot. */
export function filterRows(rows: MissingRow[], f: Filters, ignoreStatus = false): MissingRow[] {
  return rows.filter((r) => {
    if (!ignoreStatus && !statusMatches(r, f.status)) return false;
    if (f.slot !== "all" && (f.slot === "other" ? r.punchSlot !== null : r.punchSlot !== f.slot)) return false;
    if (f.branch !== "all" && (r.branch ?? "") !== f.branch) return false;
    if (f.department !== "all" && (r.department ?? "") !== f.department) return false;
    if (!inDayRange(r.date, f.from, f.to)) return false;
    const haystack = [
      r.employeeName,
      r.employeeCode,
      r.department,
      r.designation,
      r.branch,
      punchLabel(r),
      r.reason,
      r.date,
      formatDate(r.date),
      r.punchTime,
      formatPunchTime(r.punchTime),
    ]
      .filter(Boolean)
      .join(" ");
    return matchesWords(f.query, haystack);
  });
}

/** How many requests each status pill would show with the other filters applied. */
export function statusCounts(rows: MissingRow[], f: Filters): Record<StatusFilter, number> {
  const base = filterRows(rows, f, true);
  const counts: Record<StatusFilter, number> = {
    all: base.length,
    pending: 0,
    pending_hr: 0,
    pending_hod: 0,
    approved: 0,
    rejected: 0,
  };
  for (const r of base) {
    counts[r.status] += 1;
    if (isPending(r)) counts.pending += 1;
  }
  return counts;
}

// ─── Sorting ────────────────────────────────────────────────────────────────────

export type SortKey = "created" | "date" | "employee" | "status";
export type Sort = { key: SortKey; dir: "asc" | "desc" };

export const DEFAULT_SORT: Sort = { key: "created", dir: "desc" };

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "created:desc", label: "Newest request first" },
  { value: "created:asc", label: "Oldest request first" },
  { value: "date:desc", label: "Missed date: latest first" },
  { value: "date:asc", label: "Missed date: earliest first" },
  { value: "employee:asc", label: "Employee A to Z" },
  { value: "employee:desc", label: "Employee Z to A" },
  { value: "status:asc", label: "Waiting first" },
];

export function parseSort(value: string): Sort {
  const [key, dir] = value.split(":");
  return { key: key as SortKey, dir: dir === "asc" ? "asc" : "desc" };
}

const STATUS_ORDER: Record<MissingRow["status"], number> = { pending_hr: 0, pending_hod: 1, approved: 2, rejected: 3 };

/** A sorted copy. Ties fall back to the newest request first, so the order never jumps around. */
export function sortRows(rows: MissingRow[], sort: Sort): MissingRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const created = (r: MissingRow) => (r.createdAt ? Date.parse(r.createdAt) : 0);
  const compare = (a: MissingRow, b: MissingRow): number => {
    switch (sort.key) {
      case "date":
        return a.date.localeCompare(b.date) || a.punchTime.localeCompare(b.punchTime);
      case "employee":
        return a.employeeName.localeCompare(b.employeeName);
      case "status":
        return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
      default:
        return created(a) - created(b);
    }
  };
  return [...rows].sort((a, b) => sign * compare(a, b) || created(b) - created(a) || b.id - a.id);
}

// ─── Waiting text for a row ─────────────────────────────────────────────────────

/** Who the request is waiting for, as one line ("Waiting for HOD"), or the plain stage when no pipeline came. */
export const waitingLine = (r: MissingRow): string => waitingText(r.approval) ?? STAGE_LABEL[r.status] ?? r.status;

// ─── Export ─────────────────────────────────────────────────────────────────────

export function exportTable(rows: MissingRow[]): ExportTable {
  const line = (r: MissingRow, role: string) => decisionLines(r).find((d) => d.role === role);
  return {
    sheet: "Missing punches",
    title: "Missing Punch requests",
    headers: [
      "Employee code",
      "Employee",
      "Department",
      "Branch",
      "Missed date",
      "Punch",
      "Time",
      "Reason",
      "Status",
      "Waiting for",
      "HOD decision",
      "HOD by",
      "HOD on",
      "HOD comment",
      "HR decision",
      "HR by",
      "HR on",
      "HR comment",
      "Requested on",
    ],
    rows: rows.map((r) => {
      const hod = line(r, "HOD");
      const hr = line(r, "HR");
      return [
        r.employeeCode,
        r.employeeName,
        r.department ?? "",
        r.branch ?? "",
        formatDate(r.date),
        punchLabel(r),
        formatPunchTime(r.punchTime),
        r.reason,
        STAGE_LABEL[r.status] ?? r.status,
        isPending(r) ? waitingLine(r) : "",
        hod?.outcome ?? "",
        hod?.by ?? "",
        hod?.at ? formatDateTime(hod.at) : "",
        hod?.comment ?? "",
        hr?.outcome ?? "",
        hr?.by ?? "",
        hr?.at ? formatDateTime(hr.at) : "",
        hr?.comment ?? "",
        formatDateTime(r.createdAt),
      ];
    }),
  };
}
