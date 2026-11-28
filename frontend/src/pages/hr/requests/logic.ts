// Requests hub: the rules behind the page, kept apart from the screens so they can be tested on their own.
//
// The server (GET /api/hr-requests, backend/api/hr_requests_views.py) sends every kind of request in one shape; this file
// decides what the page shows from it: the sub-tabs and their badges, the filters, the search, the order, who may decide
// what, and what an export holds.

import { hrCanAct, hrCanReject, waitingText, type ApprovalProgress } from "@/lib/approval-workflow";
import type { RangeDays } from "@/lib/date-range";
import { permissionOutcome, permissionTypeKey } from "@/lib/late-detection";
import type { Tone } from "@/lib/statusTones";
import { leavePath } from "@/pages/hr/compensation/routes";

export type KindKey =
  | "leave"
  | "permission"
  | "casual_leave"
  | "missing_punch"
  | "on_duty"
  | "on_duty_punch"
  | "outpass"
  | "request"
  | "attendance_correction"
  | "holiday_work"
  | "compensation_placement"
  | "birthday_compensation"
  | "resignation"
  | "advance";

/** Every kind the page knows, for checking a `?kind=` from the address before it is sent to the server. */
export const KIND_KEYS = [
  "leave",
  "permission",
  "casual_leave",
  "missing_punch",
  "on_duty",
  "on_duty_punch",
  "outpass",
  "request",
  "attendance_correction",
  "holiday_work",
  "compensation_placement",
  "birthday_compensation",
  "resignation",
  "advance",
] as const satisfies readonly KindKey[];

/** quick: Approve / Reject here. notes: HR sets a status and notes here. link: the decision needs its own page. */
export type DecideMode = "quick" | "notes" | "link";
export type Access = "view" | "edit";
export type Queue = "hr" | "hod" | "other";
export type RequestStatus = "pending" | "approved" | "rejected";

export type HubEmployee = {
  id: number;
  code: string;
  name: string;
  department: string | null;
  departmentId: number | null;
  designation: string | null;
  branch: string | null;
  branchId: number | null;
  type: string;
  photoUrl: string | null;
};

export type HubDecision = {
  by: string | null;
  role: "hr" | "hod" | "system" | null;
  at: string | null;
  comment: string | null;
};

/** The date (or range) a request is FOR (2026-11-21): `label` says what it is ("Requested date", "Last working day",
 *  "Deduct from" ...), `note` adds the time or part of the day, `precision` "month" for an advance's deduction month. */
export type HubRequested = {
  from: string;
  to: string | null;
  note: string | null;
  label: string;
  precision: "day" | "month";
};

export type HubItem = {
  key: string;
  kind: KindKey;
  id: number;
  employee: HubEmployee;
  label: string;
  summary: string;
  reason: string | null;
  /** What the reason is called on this kind ("Reason", "Description", "Purpose"); an older server sends none. */
  reasonLabel?: string;
  /** The date(s) the request is for; null when it is not for a date (a general request), absent on an older server. */
  requested?: HubRequested | null;
  date: string | null;
  details: { label: string; value: string }[];
  status: RequestStatus;
  rawStatus: string;
  statusLabel: string | null;
  queue: Queue | null;
  approval: ApprovalProgress | null;
  submittedAt: string | null;
  decided: HubDecision | null;
  extra: Record<string, unknown>;
};

export type HubKind = {
  key: KindKey;
  label: string;
  group: string;
  access: Access;
  /** Whether this account may approve / reject this kind, apart from its access level (HR Manager / HR Assistant
   *  categories, lib/hr-access.ts). An older backend does not send it: the access level decides, as before. */
  canApprove?: boolean;
  mode: DecideMode;
  openPath: string | null;
  openLabel: string | null;
  pipeline: string;
  enabled: boolean;
  waiting: number;
  waitingHr: number;
  waitingHod: number;
  matched: number | null;
  truncated: boolean;
};

export type HubStats = {
  waiting: number;
  waitingHr: number;
  waitingHod: number;
  waitingOther: number;
  /** Decided this month; with the date filter (from / to): the requests FOR those days that ended approved / rejected. */
  approvedThisMonth: number;
  rejectedThisMonth: number;
  oldestWaiting: { kind: KindKey; id: number; employeeName: string; label: string; submittedAt: string } | null;
  /** Only with the date filter (2026-11-24): the days the figures are about, every waiting request whatever its day, the
   *  waiting ones for other days and the earliest day one of those is for. */
  range?: { from: string | null; to: string | null };
  allWaiting?: number;
  outsideWaiting?: number;
  outsideEarliest?: string | null;
};

export type HubOptions = {
  branches: { id: number; name: string }[];
  /** `category`: Staff or Production (staff and production have departments of their own); a server that does not
   *  send it leaves every department Staff for the filter. */
  departments: { id: number; name: string; branchId: number | null; category?: "staff" | "production" | null }[];
};

export type HubResponse = {
  kinds: HubKind[];
  stats: HubStats;
  /** One page of the list (the server filters, sorts and pages it since 2026-11-21). */
  items: HubItem[];
  limit: number;
  options: HubOptions;
  page: number;
  pageSize: number;
  /** Every request that matches the tab, the filters and the search, over all pages. */
  total: number;
  pages: number;
  /** The request a link asked to open (`focus=`), whatever page or filter it is on; null when none or not found. */
  focusItem: HubItem | null;
};

export const EMPTY_STATS: HubStats = {
  waiting: 0,
  waitingHr: 0,
  waitingHod: 0,
  waitingOther: 0,
  approvedThisMonth: 0,
  rejectedThisMonth: 0,
  oldestWaiting: null,
};

/**
 * Where "Open in ..." goes for a kind whose server address is only the page: straight to the part of the page that decides
 * it. Holiday / Sunday work is raised and approved in Compensation -> Compensation Leave -> Sunday & holiday work -> Claims (the server
 * sends the page, /hr/compensation); an address the server already narrowed is left alone.
 */
const OPEN_PATH_DEEP_LINKS: Partial<Record<KindKey, { page: string; to: string }>> = {
  holiday_work: { page: "/hr/compensation", to: leavePath("holiday-work", "claims") },
};

const withDeepLink = (kind: HubKind): HubKind => {
  const link = OPEN_PATH_DEEP_LINKS[kind.key];
  return link && kind.openPath === link.page ? { ...kind, openPath: link.to } : kind;
};

/** Birthday Compensation (2026-11-25) in the page's own sentence case: the server calls it "Birthday Compensation". */
const BIRTHDAY_COMP_LABEL = "Birthday compensation";
const sentenceCaseBirthday = (label: string) => label.replace(/^Birthday Compensation\b/, BIRTHDAY_COMP_LABEL);

const kindLabelled = (kind: HubKind): HubKind =>
  kind.key === "birthday_compensation" ? { ...kind, label: BIRTHDAY_COMP_LABEL } : kind;

const itemLabelled = (item: HubItem): HubItem =>
  item.kind === "birthday_compensation" ? { ...item, label: sentenceCaseBirthday(item.label) } : item;

/** The response with every list present, whatever an older or partial backend left out. */
export function normalizeHub(raw: Partial<HubResponse> | null | undefined): HubResponse {
  const items = (raw?.items ?? []).map(itemLabelled);
  return {
    kinds: (raw?.kinds ?? []).map(withDeepLink).map(kindLabelled),
    stats: { ...EMPTY_STATS, ...(raw?.stats ?? {}) },
    items,
    limit: raw?.limit ?? 0,
    options: { branches: raw?.options?.branches ?? [], departments: raw?.options?.departments ?? [] },
    page: raw?.page ?? 1,
    pageSize: raw?.pageSize ?? items.length,
    total: raw?.total ?? items.length,
    pages: raw?.pages ?? 1,
    focusItem: raw?.focusItem ? itemLabelled(raw.focusItem) : null,
  };
}

/** The birthday a Birthday Compensation request belongs to ("2026-03-05"), or null for any other request. */
export const birthdayOf = (item: Pick<HubItem, "kind" | "extra">): string | null =>
  item.kind === "birthday_compensation" && typeof item.extra.birthday === "string" ? item.extra.birthday : null;

// ─── filters ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type StatusFilter = "any" | "waiting" | "waiting_hr" | "waiting_hod" | "decided" | "approved" | "rejected";
export type SortKey = "latest" | "oldest" | "waiting" | "employee" | "kind";

/** The list's own filters. Its dates are the HR portal's date filter (the days requests are FOR, in the address:
 *  components/date-range useDateRange), sent beside these as from / to. */
export type Filters = {
  query: string;
  status: StatusFilter;
  /** "all" or a branch id. */
  branch: string;
  department: string;
  /** "all" | "staff" | "production". */
  type: string;
  /** Only on the Other requests tab: "all" or a request type (salary_enquiry ...). */
  requestType: string;
  sort: SortKey;
};

export const NO_FILTERS: Filters = {
  query: "",
  status: "any",
  branch: "all",
  department: "all",
  type: "all",
  requestType: "all",
  sort: "latest",
};

export const STATUS_LABELS: Record<StatusFilter, string> = {
  any: "Any status",
  waiting: "Waiting (anyone)",
  waiting_hr: "Waiting for HR",
  waiting_hod: "Waiting for HOD",
  decided: "Decided",
  approved: "Approved",
  rejected: "Rejected",
};

export const SORT_LABELS: Record<SortKey, string> = {
  latest: "Latest submitted",
  oldest: "Oldest submitted",
  waiting: "Longest waiting first",
  employee: "Employee A to Z",
  kind: "Request type",
};

/** How many filters (not the search box, not the sort) are narrowing the list. */
export function activeFilterCount(f: Filters): number {
  return [
    f.status !== "any",
    f.branch !== "all",
    f.department !== "all",
    f.type !== "all",
    f.requestType !== "all",
  ].filter(Boolean).length;
}

export const filtersActive = (f: Filters) => f.query.trim() !== "" || activeFilterCount(f) > 0;

const two = (n: number) => String(n).padStart(2, "0");
/** YYYY-MM-DD of a local date. */
export const dayStamp = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

/** Which page of which tab the list shows (2026-11-21: the server pages the list). */
export type PageView = { tab: string; page: number; pageSize: number };

/** Rows per page HR can pick, and the first one. */
export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

/** The most one export asks the server for (backend EXPORT_MAX). */
export const EXPORT_MAX = 5000;

/**
 * The query string the server filters on. With a `view` (the page since 2026-11-21) the server also searches, narrows to
 * the tab and to "waiting for HR / HOD", sorts and pages; without one it returns the whole list as before. `days` (the date
 * filter, 2026-11-24) asks only for the requests FOR those days, and makes the figures follow them.
 */
export function serverParams(f: Filters, view?: PageView, days?: RangeDays): Record<string, string> {
  const params: Record<string, string> = { kind: view && view.tab !== "all" ? view.tab : "all" };
  if (view) {
    if (f.status !== "any") params.status = f.status;
  } else if (f.status === "waiting" || f.status === "waiting_hr" || f.status === "waiting_hod")
    params.status = "waiting";
  else if (f.status !== "any") params.status = f.status;
  if (days) {
    params.from = days.from;
    params.to = days.to;
  }
  if (f.branch !== "all") params.branchId = f.branch;
  if (f.department !== "all") params.departmentId = f.department;
  if (f.type !== "all") params.employeeType = f.type;
  if (view) {
    const q = f.query.trim().replace(/\s+/g, " ");
    if (q) params.q = q;
    if (view.tab === "request" && f.requestType !== "all") params.requestType = f.requestType;
    params.sort = f.sort;
    params.page = String(Math.max(1, view.page));
    params.pageSize = String(view.pageSize);
  }
  return params;
}

/** The same filters for an export: every matching request in one call (up to EXPORT_MAX), not one page. */
export function exportParams(params: Record<string, string>): Record<string, string> {
  const { focus: _focus, ...rest } = params;
  return { ...rest, page: "1", pageSize: String(EXPORT_MAX), export: "1" };
}

/** "Showing 26-50 of 212": the first and last row number of this page (0-0 when there is nothing). */
export function pageRange(page: number, pageSize: number, total: number): { first: number; last: number } {
  if (total <= 0) return { first: 0, last: 0 };
  const first = (Math.max(1, page) - 1) * pageSize + 1;
  return { first: Math.min(first, total), last: Math.min(total, first + pageSize - 1) };
}

/** The page buttons to draw: the first, the last and the ones around the current page, "gap" where pages are skipped. */
export function pageButtons(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const wanted = new Set([1, pages, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4].forEach((n) => wanted.add(n));
  if (page >= pages - 2) [pages - 3, pages - 2, pages - 1].forEach((n) => wanted.add(n));
  const sorted = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | "gap")[] = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) out.push("gap");
    out.push(n);
  });
  return out;
}

// ─── request date, requested date(s), reason, timestamp (owner brief 2026-11-21) ──────────────────────────────────

const DAY_FORMAT: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

/** A YYYY-MM-DD date as "20 Nov 2026" (read as a local day, never shifted by the time zone). */
export function dayText(ymd: string | null | undefined): string {
  if (!ymd) return "";
  const [y, m, d] = ymd.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return ymd;
  return new Date(y, m - 1, d).toLocaleDateString("en-IN", DAY_FORMAT);
}

/** The date(s) the request is for, as the page shows them: "20 Nov 2026 to 22 Nov 2026 · 3 days", "Nov 2026". */
export function requestedText(item: Pick<HubItem, "requested">): string | null {
  const r = item.requested;
  if (!r?.from) return null;
  if (r.precision === "month") {
    const [y, m] = r.from.split("-").map(Number);
    return new Date(y, (m || 1) - 1, 1).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
  }
  const span = r.to && r.to !== r.from ? `${dayText(r.from)} to ${dayText(r.to)}` : dayText(r.from);
  return r.note ? `${span} · ${r.note}` : span;
}

/** What the requested date is called on this request ("Requested date", "Last working day", "Deduct from" ...). */
export const requestedLabel = (item: Pick<HubItem, "requested">): string => item.requested?.label ?? "Requested date";

/** The day the employee submitted the request: "21 Nov 2026". */
export const requestDayText = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString("en-IN", DAY_FORMAT) : "";

/** The exact moment it was submitted: "21 Nov 2026, 9:50:08 am". */
export const submittedText = (iso: string | null | undefined): string =>
  iso
    ? new Date(iso).toLocaleString("en-IN", {
        ...DAY_FORMAT,
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      })
    : "";

/** What the reason is called, and a plain line when the request type has none. */
export const reasonLabel = (item: Pick<HubItem, "reasonLabel">): string => item.reasonLabel || "Reason";
export function reasonMissingText(item: Pick<HubItem, "kind">): string {
  return item.kind === "on_duty" || item.kind === "on_duty_punch"
    ? "Not asked on this type of request"
    : "The employee gave no reason";
}

/** A custom range that ends before it starts is not a range: the page says so instead of showing an empty list. */

// ─── search, filter, sort ──────────────────────────────────────────────────────────────────────────────────────────

const text = (v: string | null | undefined) => (v ?? "").toLowerCase();

/** Everything the search box looks at: who, what, why. */
export function haystack(item: HubItem): string {
  return [
    item.employee.name,
    item.employee.code,
    item.employee.department,
    item.employee.designation,
    item.employee.branch,
    item.label,
    item.summary,
    item.reason,
    item.date,
    ...item.details.map((d) => d.value),
    item.decided?.by,
    item.decided?.comment,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Every word typed must appear somewhere in the request. */
export function matchesQuery(item: HubItem, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = haystack(item);
  return words.every((w) => hay.includes(w));
}

function matchesStatus(item: HubItem, status: StatusFilter): boolean {
  switch (status) {
    case "any":
      return true;
    case "waiting":
      return item.status === "pending";
    case "waiting_hr":
      return item.status === "pending" && item.queue === "hr";
    case "waiting_hod":
      return item.status === "pending" && item.queue === "hod";
    case "decided":
      return item.status !== "pending";
    default:
      return item.status === status;
  }
}

/** The requests of one tab ("all" or a kind) that pass every filter and the search. The period is the server's call. */
export function filterItems(items: HubItem[], f: Filters, tab: string): HubItem[] {
  return items.filter((item) => {
    if (tab !== "all" && item.kind !== tab) return false;
    if (!matchesStatus(item, f.status)) return false;
    if (f.branch !== "all" && String(item.employee.branchId ?? "") !== f.branch) return false;
    if (f.department !== "all" && String(item.employee.departmentId ?? "") !== f.department) return false;
    if (f.type !== "all" && item.employee.type !== f.type) return false;
    if (f.requestType !== "all" && item.kind === "request" && item.extra.requestType !== f.requestType) return false;
    return matchesQuery(item, f.query);
  });
}

const time = (v: string | null | undefined) => (v ? Date.parse(v) : 0);

/** A sorted copy. Ties fall back to the newest request so the order never jumps around. */
export function sortItems(items: HubItem[], sort: SortKey): HubItem[] {
  const newest = (a: HubItem, b: HubItem) => time(b.submittedAt) - time(a.submittedAt) || b.id - a.id;
  const compare = (a: HubItem, b: HubItem): number => {
    switch (sort) {
      case "oldest":
        return time(a.submittedAt) - time(b.submittedAt) || a.id - b.id;
      case "waiting": {
        // waiting requests first, the one that has waited longest on top; decided ones after, newest first
        const aw = a.status === "pending";
        const bw = b.status === "pending";
        if (aw !== bw) return aw ? -1 : 1;
        return aw ? time(a.submittedAt) - time(b.submittedAt) || a.id - b.id : newest(a, b);
      }
      case "employee":
        return text(a.employee.name).localeCompare(text(b.employee.name)) || newest(a, b);
      case "kind":
        return text(a.label).localeCompare(text(b.label)) || newest(a, b);
      default:
        return newest(a, b);
    }
  };
  return [...items].sort(compare);
}

// ─── tabs ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TabSpec = { value: string; label: string; count: number | undefined };

/** "All" and one tab per kind the caller can see, each with how many are waiting right now (no badge when none). */
export function buildTabs(kinds: HubKind[], stats: HubStats): TabSpec[] {
  const badge = (n: number) => (n > 0 ? n : undefined);
  return [
    { value: "all", label: "All", count: badge(stats.waiting) },
    ...kinds.map((k) => ({ value: k.key as string, label: k.label, count: badge(k.waiting) })),
  ];
}

/** A tab value from the address, only when it is one of the tabs on offer. */
export const tabFromAddress = (raw: string | null | undefined, kinds: HubKind[]): string =>
  raw && kinds.some((k) => k.key === raw) ? raw : "all";

// ─── one request's look ────────────────────────────────────────────────────────────────────────────────────────────

/** The status chip of a request: the words and the tone. A permission uses the policy's own words (Allowed, Excess ...). */
export function statusChip(item: HubItem): { label: string; tone: Tone } {
  if (item.kind === "permission") {
    const outcome = permissionOutcome({
      status: item.rawStatus,
      capStatus: item.extra.capStatus as string | null | undefined,
      statusLabel: item.extra.statusLabel as string | null | undefined,
      typeKey: item.extra.typeKey as string | null | undefined,
      monthlyLimit: item.extra.monthlyLimit as number | null | undefined,
    });
    return { label: outcome.label, tone: outcome.tone };
  }
  if (item.status === "approved") return { label: "approved", tone: "success" };
  if (item.status === "rejected") return { label: "rejected", tone: "danger" };
  return { label: item.statusLabel ?? "pending", tone: "warning" };
}

/** Whole days a request has been waiting (0 for one submitted today or already decided). */
export function waitingDays(item: HubItem, now: Date): number {
  if (item.status !== "pending" || !item.submittedAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - Date.parse(item.submittedAt)) / 86_400_000));
}

/** "3 days" / "today" for the oldest-waiting card. */
export function daysText(days: number): string {
  if (days <= 0) return "today";
  return days === 1 ? "1 day" : `${days} days`;
}

/** Who a waiting request is with, in words (the pipeline's own "Waiting for HOD"), or null when it is decided. */
export const waitingLine = (item: HubItem): string | null =>
  item.status === "pending" ? waitingText(item.approval) : null;

// ─── who may decide here ───────────────────────────────────────────────────────────────────────────────────────────

export type HereDecision = {
  /** Approve button. */
  approve: boolean;
  /** Reject button. */
  reject: boolean;
  /** A permission with no type: HR sets the type on the Leave page before an approval means anything. */
  needsType: boolean;
  /** The general-request form (status + notes). */
  notes: boolean;
  /** Why there is nothing to press, for the detail dialog; null when something can be pressed. */
  why: string | null;
};

/** What HR can do with this request on THIS page: the pipeline says whether it is HR's turn (lib/approval-workflow), the
 *  kind says whether a button is enough, and the role's access to the kind's module says whether it may change it. */
export function decisionsHere(item: HubItem, kind: HubKind | undefined): HereDecision {
  const none = (why: string | null): HereDecision => ({
    approve: false,
    reject: false,
    needsType: false,
    notes: false,
    why,
  });
  if (item.status !== "pending") return none(null);
  // approving is a right of its own: an account may approve with View only, or edit without approving
  const mayApprove = kind?.canApprove ?? kind?.access === "edit";
  if (!kind || (kind.access !== "edit" && !mayApprove))
    return none("You can view this kind of request but not decide it.");
  if (kind.mode === "link") return none(null);
  const pending = true;
  if (kind.mode === "notes") {
    // a general request is HR's alone: no pipeline to wait for, but the lock for a view-only viewer still applies
    return hrCanAct(item.approval, pending) || (kind.access === "edit" && !mayApprove)
      ? { approve: false, reject: false, needsType: false, notes: true, why: null }
      : none("You can view this request but not handle it.");
  }
  if (!mayApprove || item.approval?.hrPermitted === false) {
    return none(
      `Your account can't approve or reject ${kind.label} requests. An HR Manager or the Super Admin decides them.`,
    );
  }
  const canApprove = hrCanAct(item.approval, pending);
  const canReject = hrCanReject(item.approval, pending);
  if (!canApprove && !canReject) {
    return none(
      waitingText(item.approval) ? `${waitingText(item.approval)}: HR cannot decide it until that step is done.` : null,
    );
  }
  const needsType =
    item.kind === "permission" && permissionTypeKey({ typeKey: item.extra.typeKey as string | null }) == null;
  return {
    approve: canApprove && !needsType,
    reject: canReject,
    needsType: canApprove && needsType,
    notes: false,
    why: null,
  };
}

/** The statuses HR can give a general request. */
export const REQUEST_STATUSES: { value: string; label: string }[] = [
  { value: "in_review", label: "In review" },
  { value: "more_info", label: "More info needed" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

// ─── export ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const EXPORT_HEADERS = [
  "Request type",
  "Request",
  "Employee code",
  "Employee",
  "Department",
  "Branch",
  "Employee type",
  "Request date",
  "Requested date(s)",
  "Details",
  "Reason",
  "Submitted at",
  "Status",
  "Waiting for",
  "Decided by",
  "Decided on",
  "Decision note",
];

/** A moment as local "YYYY-MM-DD HH:MM" (`seconds`: ":SS" too); the server sends UTC, HR reads factory time. */
function stamp(iso: string | null | undefined, seconds = false): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
  return `${dayStamp(d)} ${time}`;
}

/** The requested date(s) for a sheet: "2026-11-20 to 2026-11-22 · 3 days", "2026-11" for a month. */
function requestedCell(item: HubItem): string {
  const r = item.requested;
  if (!r?.from) return "";
  if (r.precision === "month") return r.from.slice(0, 7);
  const span = r.to && r.to !== r.from ? `${r.from} to ${r.to}` : r.from;
  return r.note ? `${span} · ${r.note}` : span;
}

/** One row per request, in the columns above, as plain text (so a CSV and a sheet agree). */
export function exportRows(items: HubItem[], kindLabels: Record<string, string> = {}): string[][] {
  return items.map((i) => [
    kindLabels[i.kind] ?? i.kind,
    i.label,
    i.employee.code,
    i.employee.name,
    i.employee.department ?? "",
    i.employee.branch ?? "",
    i.employee.type === "production" ? "Production" : "Staff",
    i.submittedAt ? stamp(i.submittedAt).slice(0, 10) : "",
    requestedCell(i),
    i.summary,
    i.reason ?? "",
    stamp(i.submittedAt, true),
    statusChip(i).label,
    waitingLine(i) ?? "",
    i.decided?.by ?? "",
    stamp(i.decided?.at),
    i.decided?.comment ?? "",
  ]);
}

/** Byte order mark: it lets Excel read the CSV as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** A CSV with a header row; the BOM lets Excel read the text as UTF-8. */
export function toCsv(rows: string[][]): string {
  return `${BOM}${[EXPORT_HEADERS, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

/** 'hr' -> 'HR', 'hod' -> 'HOD' for the Decided by column. */
export const roleText = (role: HubDecision["role"]): string =>
  role === "hr" ? "HR" : role === "hod" ? "HOD" : role === "system" ? "System" : "";
