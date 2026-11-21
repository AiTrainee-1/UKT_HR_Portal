// The rule for every Reject in the HRMS (owner brief 2026-11-21): approving never needs a remark, rejecting always needs
// the reason. The server applies the same rule (backend/api/approval_workflow.py REJECT_REMARK_MIN, error code
// "remark_required"), so an old client that skips this check is refused with the same words.

export const REJECT_REMARK_MIN = 3;
export const REJECT_REMARK_MAX = 1000;

/** The words the employee will read: spaces collapsed, trimmed, at most REJECT_REMARK_MAX characters. */
export function cleanRejectRemark(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, REJECT_REMARK_MAX);
}

export const REJECT_REMARK_MESSAGE = `Write the reason for rejecting (at least ${REJECT_REMARK_MIN} characters).`;

/** Why this reason cannot be sent yet, or null when it is fine. */
export function rejectRemarkProblem(text: string | null | undefined): string | null {
  return cleanRejectRemark(text).length < REJECT_REMARK_MIN ? REJECT_REMARK_MESSAGE : null;
}

/** True when the server refused a rejection because its reason was missing (the shared error code). */
export function isRemarkRequiredError(err: unknown): boolean {
  const code =
    (err as { code?: unknown; data?: { code?: unknown } } | null)?.code ??
    (err as { data?: { code?: unknown } } | null)?.data?.code;
  return code === "remark_required" || code === "remark";
}
