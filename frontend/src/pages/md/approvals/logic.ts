// Pure helpers of the HOD approvals page and of the sidebar's HOD sub-menu.
import { clockText, dayLong } from "@/lib/md/format";
import type { ApprovalGroup, ApprovalItem, ApprovalKind, Hod, RequestStatusFilter } from "./types";

export const APPROVALS_PATH = "/md/approvals";

/** "/md/approvals/12" for one Department Head's tab. */
export const hodPath = (id: number) => `${APPROVALS_PATH}/${id}`;

/** The Department Head the address names ("/md/approvals/12" -> 12), or null on the bare page. */
export function hodIdFromPath(path: string): number | null {
  const m = /^\/md\/approvals\/(\d+)\/?(?:[?#].*)?$/i.exec(path);
  return m ? Number(m[1]) : null;
}

/** The tab to show: the one in the address when that head is still listed, else the first head (or none). */
export function pickHod(hods: Hod[], fromPath: number | null): Hod | undefined {
  return hods.find((h) => h.id === fromPath) ?? hods[0];
}

/** What a tab and a sidebar entry are called: "HOD – Suresh Raj". */
export const hodLabel = (hod: Pick<Hod, "name">) => `HOD – ${hod.name}`;

export const STATUS_OPTIONS: { value: RequestStatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All" },
];

export type GroupFilter = ApprovalGroup | "all";

export const GROUP_LABELS: Record<GroupFilter, string> = {
  all: "All",
  leave: "Leave",
  permission: "Permission",
  other: "Other",
};

export function filterByGroup(items: ApprovalItem[], group: GroupFilter): ApprovalItem[] {
  return group === "all" ? items : items.filter((i) => i.group === group);
}

/** Kinds a head may not decide (their switch is off in User Management), as words: "missing punch, On-Duty". */
export function rightsOff(hod: Hod, labels: Record<ApprovalKind, string> = KIND_LABELS): string[] {
  return (Object.keys(hod.rights) as ApprovalKind[]).filter((k) => !hod.rights[k]).map((k) => labels[k] ?? k);
}

export const KIND_LABELS: Record<ApprovalKind, string> = {
  leave: "leave",
  casual_leave: "casual leave",
  permission: "permission",
  outpass: "outpass",
  missing_punch: "missing punch",
  on_duty: "On-Duty",
  attendance_correction: "attendance change",
  holiday_work: "compensation",
  birthday_compensation: "birthday compensation",
  resignation: "resignation",
};

/** "06 Sep 2026" or "06 Sep 2026 – 08 Sep 2026"; empty when the request has no date. */
export function whenText(item: Pick<ApprovalItem, "from" | "to">): string {
  if (!item.from) return "";
  return item.to ? `${dayLong(item.from)} – ${dayLong(item.to)}` : dayLong(item.from);
}

/** How long ago a request was sent: "today", "yesterday", "3 days ago", "5 weeks ago". */
export function agoText(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "";
  const sent = new Date(iso);
  if (Number.isNaN(sent.getTime())) return "";
  const startOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOf(now) - startOf(sent)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

const two = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of a moment, in this computer's time; null when it is not a date. */
function localDay(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
}

/** The exact moment the employee sent it, to the second, in this computer's time (as the HR Requests page shows it,
 *  owner brief 2026-11-21): "11 Nov 2026, 9:52:08 am"; empty when unknown. */
export function submittedText(iso: string | null | undefined): string {
  const day = localDay(iso);
  if (!day || !iso) return "";
  const at = new Date(iso);
  const clock = clockText(`${day}T${two(at.getHours())}:${two(at.getMinutes())}`);
  return `${dayLong(day)}, ${clock.replace(/ (am|pm)$/, `:${two(at.getSeconds())} $1`)}`;
}

/** The day the request was made: "11 Nov 2026"; empty when unknown. */
export function requestDayText(iso: string | null | undefined): string {
  const day = localDay(iso);
  return day ? dayLong(day) : "";
}

/** What the requested date is called on this request ("Requested date", "Last working day", "Going out on" ...). */
export const requestedLabel = (item: Pick<ApprovalItem, "requested">): string =>
  item.requested?.label ?? "Requested date";

/** The date(s) the request is for, with its note: "12 Nov 2026 – 13 Nov 2026 · 2 days"; null when it is for no date.
 *  An older server without `requested` falls back to the item's own from / to. */
export function requestedText(item: Pick<ApprovalItem, "requested" | "from" | "to">): string | null {
  const r = item.requested;
  if (r === undefined) return whenText(item) || null;
  if (!r?.from) return null;
  const span = r.to && r.to !== r.from ? `${dayLong(r.from)} – ${dayLong(r.to)}` : dayLong(r.from);
  return r.note ? `${span} · ${r.note}` : span;
}

/** The line shown when there is no reason. */
export function reasonMissingText(item: Pick<ApprovalItem, "kind">): string {
  return item.kind === "on_duty" ? "Not asked on this type of request" : "The employee gave no reason";
}

/** The decision a request carries: who approved or rejected it, when, and what they wrote (a rejection always has its
 *  reason since 2026-11-21). Null while nobody has decided a step. */
export function decisionOf(
  item: Pick<ApprovalItem, "steps" | "state">,
): { state: "approved" | "rejected"; by: string | null; at: string | null; comment: string | null } | null {
  const rejected = [...item.steps].reverse().find((s) => s.state === "rejected");
  if (rejected) return { state: "rejected", by: rejected.by, at: rejected.at, comment: rejected.comment };
  if (item.state !== "approved") return null;
  const done = [...item.steps].reverse().find((s) => s.state === "approved" && (s.by || s.comment));
  return done ? { state: "approved", by: done.by, at: done.at, comment: done.comment } : null;
}

/** The chip tone of a request's state. */
export function stateTone(state: ApprovalItem["state"]): "warning" | "success" | "danger" | "neutral" {
  if (state === "pending") return "warning";
  if (state === "approved") return "success";
  if (state === "rejected") return "danger";
  return "neutral";
}

const ROLE_NAMES: Record<string, string> = { hod: "Department Head", hr: "HR" };

/** A pipeline step's name: its own label, else the roles that decide it ("Department Head or HR"). */
export function stepName(step: { label: string | null; roles: string[] }): string {
  return step.label || step.roles.map((r) => ROLE_NAMES[r] ?? r).join(" or ") || "Step";
}

/** Only the final approval of a resignation deactivates the employee: say so before the MD approves one that is final. */
export function approvalWarning(item: ApprovalItem): string | null {
  if (item.kind !== "resignation") return null;
  const hrStillDecides = item.steps.some(
    (s, i) => i > 0 && s.roles.includes("hr") && (s.state === "waiting" || s.state === "pending"),
  );
  return hrStillDecides
    ? "HR still has to approve it after this step."
    : "If this is the last step, approving it makes the employee inactive straight away. There is no undo.";
}

// ─── pages of the request list ──────────────────────────────────────────────────────────────────────────────────

export const PAGE_SIZE = 10;

export const pageCount = (total: number, size = PAGE_SIZE) => Math.max(1, Math.ceil(total / size));

/** The rows of page `page` (1-based; a page past the end shows the last one). */
export function pageSlice<T>(rows: T[], page: number, size = PAGE_SIZE): T[] {
  const last = pageCount(rows.length, size);
  const p = Math.min(Math.max(1, page), last);
  return rows.slice((p - 1) * size, p * size);
}

/** "Showing 11–20 of 23". */
export function pageRangeText(total: number, page: number, size = PAGE_SIZE): string {
  if (total === 0) return "Nothing to show";
  const p = Math.min(Math.max(1, page), pageCount(total, size));
  return `Showing ${(p - 1) * size + 1}–${Math.min(p * size, total)} of ${total}`;
}

/** The page buttons: every page when there are few, else the first, the last and the ones around the current page, with
 *  "…" for the gaps (1 … 4 5 6 … 12). */
export function pageNumbers(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((n) => keep.add(n));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((n) => keep.add(n));
  const out: (number | "…")[] = [];
  let prev = 0;
  for (const n of [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b)) {
    if (n - prev > 1) out.push("…");
    out.push(n);
    prev = n;
  }
  return out;
}

/** The group counts as pill labels: "Leave (2)". */
export function groupOptions(counts: Record<ApprovalGroup, number> & { total: number }) {
  return (["all", "leave", "permission", "other"] as GroupFilter[]).map((g) => ({
    value: g,
    label: `${GROUP_LABELS[g]} (${g === "all" ? counts.total : counts[g]})`,
  }));
}

// ─── filters (kept in the address, 2026-11-21) ──────────────────────────────────────────────────────────────────

export type KindFilter = ApprovalKind | "all";

/** Every kind, in the order the filter lists them. */
export const KIND_ORDER: ApprovalKind[] = [
  "leave",
  "casual_leave",
  "permission",
  "outpass",
  "missing_punch",
  "on_duty",
  "attendance_correction",
  "holiday_work",
  "birthday_compensation",
  "resignation",
];

/** A kind's name on a pill or a chart (the server's own labels). */
export const KIND_NAMES: Record<ApprovalKind, string> = {
  leave: "Leave",
  casual_leave: "Casual leave",
  permission: "Permission",
  outpass: "Outpass",
  missing_punch: "Missing punch",
  on_duty: "On-Duty",
  attendance_correction: "Attendance change",
  holiday_work: "Compensation",
  birthday_compensation: "Birthday compensation",
  resignation: "Resignation",
};

/** A request's kind in words: the page's own name for a kind it knows (sentence case, as on the pills), else the server's. */
export const kindName = (item: Pick<ApprovalItem, "kind" | "kindLabel">): string =>
  KIND_NAMES[item.kind] ?? item.kindLabel;

export const isKindFilter = (value: string | null): value is KindFilter =>
  value === "all" || KIND_ORDER.includes(value as ApprovalKind);

/** The first and last day ("YYYY-MM-DD") a request covers: its requested date(s), else the day it was made. */
export function itemSpan(
  item: Pick<ApprovalItem, "requested" | "from" | "to" | "submittedAt">,
): [string, string] | null {
  const from = item.requested?.from ?? (item.requested === undefined ? item.from : null);
  const to = item.requested ? item.requested.to : item.requested === undefined ? item.to : null;
  const start = from ?? localDay(item.submittedAt);
  if (!start) return null;
  return [start, to && to > start ? to : start];
}

/** Whether a request belongs to `month` ("YYYY-MM"): the dates it is for touch the month (a leave across the month end
 *  is in both), or, for one with no date, it was made in the month. Every request belongs to "all months" (null). */
export function inMonth(item: ApprovalItem, month: string | null): boolean {
  if (!month) return true;
  const span = itemSpan(item);
  if (!span) return false;
  return span[0].slice(0, 7) <= month && span[1].slice(0, 7) >= month;
}

/** The search box: the employee's name, code and department, the kind, the title and the reason. */
export function matchesSearch(item: ApprovalItem, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [
    item.employee.name,
    item.employee.code,
    item.employee.department,
    item.kindLabel,
    item.title,
    item.detail,
    item.reason,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}

export type ListFilters = { kind: KindFilter; month: string | null; q: string };

/** The list after the kind, month and search filters (the status is the server's). */
export function filterItems(items: ApprovalItem[], f: ListFilters): ApprovalItem[] {
  return items.filter(
    (i) => (f.kind === "all" || i.kind === f.kind) && inMonth(i, f.month) && matchesSearch(i, f.q.trim()),
  );
}

/** The kind pills: "All (n)", then every kind that has a request in the month, with its count. A chosen kind stays
 *  listed (with 0) so it can be switched back off. */
export function kindOptions(items: ApprovalItem[], chosen: KindFilter = "all"): { value: KindFilter; label: string }[] {
  const counts = new Map<ApprovalKind, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return [
    { value: "all" as KindFilter, label: `All (${items.length})` },
    ...KIND_ORDER.filter((k) => counts.has(k) || k === chosen).map((k) => ({
      value: k as KindFilter,
      label: `${KIND_NAMES[k]} (${counts.get(k) ?? 0})`,
    })),
  ];
}

// ─── the overview of one Department Head (from the whole history) ─────────────────────────────────────────────

export type ApprovalsOverview = {
  /** Requests in the month (all months when none is chosen). */
  received: number;
  approved: number;
  rejected: number;
  /** Still waiting (at the head's step or a later one). */
  open: number;
  /** approved / (approved + rejected), 0-100; null before anything is decided. */
  approvalRatePct: number | null;
  /** Average days from sending to the decision; null before anything is decided. */
  avgDecisionDays: number | null;
  /** Days the oldest request waiting at the head's step has waited (null when none waits). */
  oldestWaitingDays: number | null;
  byKind: { kind: ApprovalKind; label: string; count: number }[];
  /** The six months up to the chosen (or current) one: requests and decisions in each. */
  months: { month: string; label: string; received: number; decided: number }[];
};

const MONTHS_SHOWN = 6;
const DAY_MS = 86_400_000;
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${two((index % 12) + 1)}`;
}

/** Waiting at the Department Head's step (what the head, or the MD for them, can decide). */
export const waitsForHead = (i: ApprovalItem) =>
  i.state === "pending" && (i.canApprove || i.canReject || !!i.blockedReason);

export function overviewOf(items: ApprovalItem[], month: string | null, now: Date = new Date()): ApprovalsOverview {
  const scoped = items.filter((i) => inMonth(i, month));
  const approved = scoped.filter((i) => i.state === "approved").length;
  const rejected = scoped.filter((i) => i.state === "rejected").length;
  const spans: number[] = [];
  for (const i of scoped) {
    const decision = decisionOf(i);
    const sent = i.submittedAt ? new Date(i.submittedAt).getTime() : NaN;
    const at = decision?.at ? new Date(decision.at).getTime() : NaN;
    if (!Number.isNaN(sent) && !Number.isNaN(at) && at >= sent) spans.push((at - sent) / DAY_MS);
  }
  const waiting = items
    .filter(waitsForHead)
    .map((i) => (i.submittedAt ? new Date(i.submittedAt).getTime() : NaN))
    .filter((t) => !Number.isNaN(t));
  const counts = new Map<ApprovalKind, number>();
  for (const i of scoped) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  const last = month ?? `${now.getFullYear()}-${two(now.getMonth() + 1)}`;
  const months = Array.from({ length: MONTHS_SHOWN }, (_, n) => monthShift(last, n - (MONTHS_SHOWN - 1))).map((m) => {
    const [y, mm] = m.split("-").map(Number);
    return {
      month: m,
      label: `${MONTH_SHORT[mm - 1]} ${String(y).slice(2)}`,
      received: items.filter((i) => inMonth(i, m)).length,
      decided: items.filter((i) => {
        const at = decisionOf(i)?.at;
        return !!at && localDay(at)?.slice(0, 7) === m;
      }).length,
    };
  });
  return {
    received: scoped.length,
    approved,
    rejected,
    open: scoped.filter((i) => i.state === "pending").length,
    approvalRatePct: approved + rejected ? Math.round((approved / (approved + rejected)) * 100) : null,
    avgDecisionDays: spans.length ? Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10 : null,
    oldestWaitingDays: waiting.length ? Math.max(0, Math.floor((now.getTime() - Math.min(...waiting)) / DAY_MS)) : null,
    byKind: KIND_ORDER.filter((k) => counts.has(k)).map((k) => ({
      kind: k,
      label: KIND_NAMES[k],
      count: counts.get(k) ?? 0,
    })),
    months,
  };
}
