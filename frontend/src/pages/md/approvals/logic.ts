// Pure helpers of the HOD approvals page and of the sidebar's HOD sub-menu.
import { dayLong } from "@/lib/md/format";
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
  holiday_work: "holiday work",
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
