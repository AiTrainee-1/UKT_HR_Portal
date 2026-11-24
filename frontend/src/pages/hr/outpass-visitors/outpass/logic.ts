import type { OutpassRequestItem, OutpassScanStatus } from "@/lib/api-client/custom-hooks";
import { dayInRange, istDayOf, type RangeDays } from "@/lib/date-range";
import type { KitTone } from "../kit";

/** The day a pass is for (the date filter, as the server's outpass-requests?from=&to=): the day the employee went out,
 *  or the day it was asked for while they have not gone out. */
export const passDay = (r: Pick<OutpassRequestItem, "createdAt" | "exitedAt">): string =>
  istDayOf(r.exitedAt || r.createdAt);

/** The passes for the filter's days, newest first (the server already sent only those; an older server sent every pass). */
export const passesForDays = <T extends Pick<OutpassRequestItem, "createdAt" | "exitedAt">>(
  rows: readonly T[] | undefined,
  days: RangeDays,
): T[] =>
  (rows ?? [])
    .filter((r) => dayInRange(passDay(r), days))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

/** Where a pass stands at the gate (backend outpass_request_views._outpass_scan_status), as a chip: a tone and a word. */
export const SCAN_STATUS_CHIP: Record<OutpassScanStatus, { label: string; tone: KitTone } | null> = {
  not_applicable: null,
  pending_exit: { label: "Not out yet", tone: "indigo" },
  exited: { label: "Out", tone: "amber" },
  expired_unscanned: { label: "Expired, not used", tone: "slate" },
  // the return leg
  pending_return: { label: "Coming back", tone: "amber" },
  return_expired: { label: "Return code expired", tone: "rose" },
  completed: { label: "Back", tone: "teal" },
};

/** The decision on a pass, as a chip. */
export const APPROVAL_CHIP: Record<string, { label: string; tone: KitTone }> = {
  pending: { label: "Waiting", tone: "indigo" },
  approved: { label: "Approved", tone: "teal" },
  rejected: { label: "Rejected", tone: "rose" },
};

// "hr" -> "HR"; "dept_head" -> "HOD – <name>", the name coming straight from OutpassRequest.approved_by, never hardcoded;
// "system" is an On-Duty session's auto-approval (geo_attendance_views.py::_create_outpass_from_on_duty). The gate monitor
// words it the same way (pages/gate/monitor/scan-result.ts).
export function formatApprover(approverRole?: string | null, approvedBy?: string | null): string {
  if (!approvedBy && !approverRole) return "—";
  if (approverRole === "hr") return approvedBy ? `HR – ${approvedBy}` : "HR";
  if (approverRole === "dept_head") return approvedBy ? `HOD – ${approvedBy}` : "HOD";
  if (approverRole === "system") return "On-Duty approval";
  return approvedBy ?? "—";
}

/** The Passes list's status filter: the decision, or where an approved pass stands at the gate. */
export type PassFilterStatus = "" | "pending" | "approved" | "rejected" | "out" | "back" | "expired";

export const PASS_STATUS_OPTIONS: readonly { value: Exclude<PassFilterStatus, "">; label: string }[] = [
  { value: "pending", label: "Waiting for approval" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "out", label: "Out now" },
  { value: "back", label: "Came back" },
  { value: "expired", label: "Expired, not used" },
];

export function matchesPassStatus(r: OutpassRequestItem, status: PassFilterStatus): boolean {
  switch (status) {
    case "":
      return true;
    case "pending":
    case "approved":
    case "rejected":
      return r.status === status;
    case "out":
      return !!r.exitedAt && !r.enteredAt;
    case "back":
      return !!r.enteredAt;
    case "expired":
      return r.scanStatus === "expired_unscanned";
  }
}

/** Every word of `q` is somewhere in the name, the code, the department, the destination or the reason. */
export function matchesPassSearch(r: OutpassRequestItem, q: string): boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = [r.employee?.name, r.employee?.employeeCode, r.employee?.department, r.destination, r.reason]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}
