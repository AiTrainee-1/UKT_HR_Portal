import type { OutpassScanStatus } from "@/lib/api-client/custom-hooks";

export const SCAN_STATUS_BADGE: Record<OutpassScanStatus, { label: string; cls: string }> = {
  not_applicable: { label: "—", cls: "bg-gray-50 text-gray-400 border-gray-200" },
  pending_exit: { label: "Awaiting Exit", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  exited: { label: "Exited", cls: "bg-green-50 text-green-700 border-green-200" },
  expired_unscanned: { label: "Expired, Not Scanned", cls: "bg-red-50 text-red-700 border-red-200" },
  // Return/re-entry leg -see backend/api/outpass_request_views.py::_outpass_scan_status.
  pending_return: { label: "Awaiting Return", cls: "bg-amber-50 text-amber-700 border-amber-200" },
  return_expired: { label: "Return QR Expired", cls: "bg-red-50 text-red-700 border-red-200" },
  completed: { label: "Returned", cls: "bg-teal-50 text-teal-700 border-teal-200" },
};

// Exit -> return, in minutes-and-hours. No end time yet means "still out" -
// measured against now, refreshed by useListOutpassRequests' own 30s poll.
export function fmtDuration(startIso: string, endIso?: string | null): string {
  const start = new Date(startIso).getTime();
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const totalMin = Math.max(0, Math.round((end - start) / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export const APPROVAL_STATUS_CLS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

// "hr" -> just "HR"; "dept_head" -> "HOD – <name>", the name coming straight
// from OutpassRequest.approved_by, never hardcoded; "system" is an On-Duty
// session's auto-approval (geo_attendance_views.py::_create_outpass_from_on_duty).
// Mirrors gate/GateScannerConsole.tsx's formatApprover so the same request
// reads the same way on both the gate console and this HR table.
export function formatApprover(approverRole?: string | null, approvedBy?: string | null): string {
  if (!approvedBy && !approverRole) return "—";
  if (approverRole === "hr") return "HR";
  if (approverRole === "dept_head") return approvedBy ? `HOD – ${approvedBy}` : "HOD";
  if (approverRole === "system") return "On-Duty approval";
  return approvedBy ?? "—";
}
