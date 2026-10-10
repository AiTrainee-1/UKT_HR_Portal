// Requests hub: the rules behind the page, kept apart from the screens so they can be tested on their own.
//
// The server (GET /api/hr-requests, backend/api/hr_requests_views.py) sends every kind of request in one shape; this file
// decides what the page shows from it: the sub-tabs and their badges, the filters, the search, the order, who may decide
// what, and what an export holds.

import { hrCanAct, hrCanReject, waitingText, type ApprovalProgress } from "@/lib/approval-workflow";
import { permissionOutcome, permissionTypeKey } from "@/lib/late-detection";
import type { Tone } from "@/lib/statusTones";

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
  | "resignation"
  | "advance";

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

export type HubItem = {
  key: string;
  kind: KindKey;
  id: number;
  employee: HubEmployee;
  label: string;
  summary: string;
  reason: string | null;
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
  approvedThisMonth: number;
  rejectedThisMonth: number;
  oldestWaiting: { kind: KindKey; id: number; employeeName: string; label: string; submittedAt: string } | null;
};

export type HubOptions = {
  branches: { id: number; name: string }[];
  departments: { id: number; name: string; branchId: number | null }[];
};

export type HubResponse = {
  kinds: HubKind[];
  stats: HubStats;
  items: HubItem[];
  limit: number;
  options: HubOptions;
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

/** The response with every list present, whatever an older or partial backend left out. */
export function normalizeHub(raw: Partial<HubResponse> | null | undefined): HubResponse {
  return {
    kinds: raw?.kinds ?? [],
    stats: { ...EMPTY_STATS, ...(raw?.stats ?? {}) },
    items: raw?.items ?? [],
    limit: raw?.limit ?? 0,
    options: { branches: raw?.options?.branches ?? [], departments: raw?.options?.departments ?? [] },
  };
}

// ─── filters ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type Period = "all" | "today" | "week" | "month" | "custom";
export type StatusFilter = "any" | "waiting" | "waiting_hr" | "waiting_hod" | "decided" | "approved" | "rejected";
export type SortKey = "latest" | "oldest" | "waiting" | "employee" | "kind";

export type Filters = {
  query: string;
  status: StatusFilter;
  period: Period;
  /** YYYY-MM-DD, used when period is "custom". */
  from: string;
  to: string;
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
  period: "all",
  from: "",
  to: "",
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

export const PERIOD_LABELS: Record<Period, string> = {
  all: "All time",
  today: "Today",
  week: "Last 7 days",
  month: "This month",
  custom: "Custom range",
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
    f.period !== "all",
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

/** The submitted-date window (YYYY-MM-DD, both ends included) a period stands for; empty ends are open. */
export function periodRange(period: Period, now: Date, from = "", to = ""): { since?: string; until?: string } {
  if (period === "today") return { since: dayStamp(now), until: dayStamp(now) };
  if (period === "week") {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    return { since: dayStamp(start), until: dayStamp(now) };
  }
  if (period === "month") return { since: `${now.getFullYear()}-${two(now.getMonth() + 1)}-01`, until: dayStamp(now) };
  if (period === "custom") {
    const range: { since?: string; until?: string } = {};
    if (from) range.since = from;
    if (to) range.until = to;
    return range;
  }
  return {};
}

/** The query string the server filters on. Search, the tab, the order and "waiting for HR / HOD" are the page's own. */
export function serverParams(f: Filters, now: Date): Record<string, string> {
  const params: Record<string, string> = { kind: "all" };
  if (f.status === "waiting" || f.status === "waiting_hr" || f.status === "waiting_hod") params.status = "waiting";
  else if (f.status !== "any") params.status = f.status;
  const { since, until } = periodRange(f.period, now, f.from, f.to);
  if (since) params.since = since;
  if (until) params.until = until;
  if (f.branch !== "all") params.branchId = f.branch;
  if (f.department !== "all") params.departmentId = f.department;
  if (f.type !== "all") params.employeeType = f.type;
  return params;
}

/** A custom range that ends before it starts is not a range: the page says so instead of showing an empty list. */
export const rangeInvalid = (f: Filters) => f.period === "custom" && !!f.from && !!f.to && f.from > f.to;

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
  if (!kind || kind.access !== "edit") return none("You can view this kind of request but not decide it.");
  if (kind.mode === "link") return none(null);
  const pending = true;
  if (kind.mode === "notes") {
    // a general request is HR's alone: no pipeline to wait for, but the lock for a view-only viewer still applies
    return hrCanAct(item.approval, pending)
      ? { approve: false, reject: false, needsType: false, notes: true, why: null }
      : none("You can view this request but not handle it.");
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
  "Details",
  "Reason",
  "Submitted",
  "Status",
  "Waiting for",
  "Decided by",
  "Decided on",
  "Decision note",
];

const stamp = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace("T", " ") : "");

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
    i.summary,
    i.reason ?? "",
    stamp(i.submittedAt),
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
