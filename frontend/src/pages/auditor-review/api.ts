// The Auditor Review Portal's calls (owner 2026-11-27): a public page, no HRMS login. The token in the address (e-mailed
// only to the auditor addresses of Settings -> Loan & Advance) is the key. Backend: api/settlement_automation/views.py
// (auditor_portal_view, auditor_timecard_view, auditor_leave_view, auditor_item_view, auditor_bulk_view,
// auditor_submit_view) and service.py (portal_json, timecard_json, auditor_change, auditor_bulk, auditor_submit). Refusals: 404 link_invalid, 410 link_revoked | link_expired, 409
// submitted | stage, 400 for a change or an answer that is not allowed.
//
// The portal is read once (every read counts as an opening of the link for HR), not again on focus; every change and
// the answer reply with the whole portal, which replaces it in the cache.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LeaveCalendarData } from "@/components/leave-calendar/LeaveCalendar";
import type { AdvanceEarnings, AdvanceLeaveCheck } from "@/lib/api-client";
import { ApiError, getApiOrigin } from "@/lib/api-client/custom-fetch";

export type PortalDecision = "approved_send_accounts" | "approved_forward_hr" | "changes_forward_hr";
/** The auditor's answer on one request (2026-11-27: "approve" as HR settled it is explicit; null = not reviewed yet). */
export type PortalAuditorAction = "approve" | "reduce" | "reject";

/** Where a request stands with the auditor: waiting ones at the top, then approved, then rejected (owner 2026-11-27). */
export type PortalReviewState = "pending" | "approved" | "rejected";

/** An earlier round on a request: HR's final settlement ("hr_final") and the auditor's answer ("auditor") of a round the
 *  auditor returned to HR for rework. */
export type PortalTrailEntry = {
  at: string;
  by: string;
  role: "hr_final" | "auditor";
  round: number;
  action: string;
  amount: number | null;
  remark: string;
};

export type PortalAdvance = {
  id: number;
  employeeId?: number;
  employeeCode: string;
  employeeName: string;
  employeeDepartment?: string | null;
  employeeDesignation?: string | null;
  employeeBranch?: string | null;
  employeeType?: string | null;
  advanceType: "general" | "term";
  typeLabel?: string;
  purpose?: string | null;
  requestedAmount?: number | null;
  repaymentMonths?: number | null;
  emiAmount?: number | null;
  createdAt?: string | null;
  earnings?: AdvanceEarnings | null;
  leaveCheck?: AdvanceLeaveCheck | null;
  appliedBy?: "hr" | "employee" | null;
  /** A Term Loan's own figures (2026-11-27): the eligible limit when it was raised (Settings' % of the fixed monthly
   *  salary), that salary, and the first month of the schedule it asked for. */
  termLimit?: number | null;
  salaryAtRequest?: number | null;
  repaymentStartMonth?: number | null;
  repaymentStartYear?: number | null;
  /** Only on a request that is paid (its effective decision is approved): for the bank file. */
  bankAccount?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
};

export type PortalItem = {
  id: number;
  advance: PortalAdvance;
  requestedAmount: number;
  md: { decision: "approved" | "rejected" | null; amount: number | null; remark: string };
  /** HR's final settlement (what the auditor reviews). */
  final: {
    decision: "approved" | "rejected" | null;
    amount: number | null;
    startMonth: number | null;
    startYear: number | null;
    /** A Term Loan's months as HR finalized them (the request's own until HR changed them). */
    months?: number | null;
    remark: string;
  };
  /** The auditor's own answer: approve, a reduced amount or a rejection (a remark alone is not a change). */
  auditor: { action: PortalAuditorAction | null; amount: number | null; remark: string; at: string | null };
  /** The settlement as it will be paid. */
  effective: { decision: "approved" | "rejected" | null; amount: number | null; remark: string };
  /** Where it stands with the auditor (2026-11-27; absent from an older server). */
  review?: PortalReviewState;
  /** The earlier rounds on it (the auditor's earlier change and HR's settlement then). */
  trail?: PortalTrailEntry[];
};

export type PortalData = {
  company: {
    name: string;
    tagline?: string | null;
    address?: string | null;
    contact?: string | null;
    logo?: string | null;
  };
  settlement: {
    advanceType: "general" | "term";
    typeLabel: string;
    month: number;
    year: number;
    /** "November 2026". */
    period: string;
    number: number;
    /** "Salary Advance · Batch 1". */
    title: string;
    stage: string;
    stageLabel: string;
    finalizedAt: string | null;
    finalizedBy: string | null;
    finalNote: string;
    mdConfirmedBy: string | null;
    mdNote: string;
    /** The review round (2026-11-27): 2+ = HR reworked the auditor's changes and resubmitted the settlement. */
    round?: number;
    resubmittedAt?: string | null;
    resubmittedBy?: string | null;
    /** HR's note with the resubmission. */
    resubmitNote?: string;
  };
  items: PortalItem[];
  totals: {
    requests: number;
    approved: number;
    rejected: number;
    /** What is paid after the auditor's changes. */
    approvedAmount: number;
    /** HR's final approved total. */
    hrApprovedAmount: number;
    changes: number;
    remarks: number;
    /** Requests the auditor has not reviewed yet (2026-11-27). */
    pending?: number;
  };
  /** Where "Approve & Send to Accounts" e-mails the bank file. */
  accounts: { to: string[]; cc: string[] };
  link: { expiresAt: string; submittedAt: string | null; decision: PortalDecision | null };
  /** The auditor may still change and answer (the link is not answered, the settlement waits for the review). */
  canReview: boolean;
  /** The auditor reduced or rejected a request: only "Return to HR for rework" is open then (a remark or a note alone
   *  may also return it, 2026-11-27). */
  hasChanges: boolean;
  /** The answer's reply only: approved, but the e-mail to Accounts did not go (HR sends it). */
  warning?: string | null;
};

/** One day of the time card (growth_views._record_dict + the holiday's name and whether it is a Sunday). */
export type TimeCardDay = {
  date: string;
  day: string;
  status: string;
  isLate?: boolean;
  isHalfShift?: boolean;
  earlyLeave?: boolean;
  lateAfternoon?: boolean;
  morningPermissionApplied?: boolean;
  eveningPermissionApplied?: boolean;
  middlePermissionToday?: boolean;
  isCompensationDay?: boolean;
  shiftsEarned: string;
  firstPunch: string | null;
  lastPunch: string | null;
  totalPunches?: number;
  source?: string | null;
  inProgress?: boolean;
  holidayName?: string | null;
  isSunday?: boolean;
};

export type TimeCard = {
  employee: {
    code: string;
    name: string;
    department: string | null;
    designation: string | null;
    type: string | null;
    joinDate: string | null;
  };
  shift: { name: string; startTime: string | null; endTime: string | null } | null;
  month: number;
  year: number;
  days: TimeCardDay[];
  summary: {
    totalDays: number;
    workingDays: number;
    present: number;
    halfShift: number;
    absent: number;
    onLeave: number;
    holidays: number;
    late: number;
    totalShifts: string;
    effectiveDays: string;
    inProgressDays?: number;
  };
  earnings: AdvanceEarnings | null;
  leaveCheck: AdvanceLeaveCheck | null;
};

/** A change on one request: "" clears it (with an empty remark the row is as HR finalized it). */
export type PortalChangeInput = { action: "" | PortalAuditorAction; amount?: number; remark: string };

/** Several requests at once: approve (keep HR's settlement, clearing a change; a remark is optional) or reject (one
 *  reason for all; the server skips a request HR rejected). */
export type PortalBulkInput = { itemIds: number[]; action: "approve" | "reject"; remark: string };

const base = (token: string) => `/api/auditor-review/${encodeURIComponent(token)}`;

/**
 * The portal's own fetch: the e-mailed token is the only key, so NO Authorization header and no cookies go with it (an
 * HR session in the same browser never rides along to the public endpoints). A refusal is thrown as the same ApiError
 * the rest of the portal reads ({error, code}).
 */
export async function publicFetch<T>(path: string, init: { method?: string; body?: BodyInit } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (typeof init.body === "string") headers["content-type"] = "application/json";
  const url = `${getApiOrigin()}${path}`;
  const response = await fetch(url, { method, body: init.body, headers, credentials: "omit", cache: "no-store" });
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!response.ok) throw new ApiError(response, data, { method, url });
  return data as T;
}

export const portalQueryKey = (token: string) => ["auditor-review", token] as const;
export const timecardQueryKey = (token: string, itemId: number) =>
  ["auditor-review", token, "timecard", itemId] as const;

/** The settlement under review. Read once: every read is counted as an opening of the link. */
export const usePortal = (token: string) =>
  useQuery<PortalData>({
    queryKey: portalQueryKey(token),
    queryFn: () => publicFetch<PortalData>(base(token)),
    enabled: token.length > 0,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

/** One employee's time card for the settlement's month. */
export const useTimecard = (token: string, itemId: number | null) =>
  useQuery<TimeCard>({
    queryKey: timecardQueryKey(token, itemId ?? 0),
    queryFn: () => publicFetch<TimeCard>(`${base(token)}/timecard/${itemId}`),
    enabled: itemId != null && itemId > 0,
    retry: false,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

/** The Leave calendar of one request (the days of leave in the counted days of the month it was raised in), for
 *  LeaveCalendarDialog's `load`. */
export const fetchLeaveCalendar = (token: string, itemId: number): Promise<LeaveCalendarData> =>
  publicFetch<LeaveCalendarData>(`${base(token)}/leave/${itemId}`);

/** The auditor's change on one request; the reply (the whole portal) replaces it. */
export function useAuditorChange(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: number; body: PortalChangeInput }) =>
      publicFetch<PortalData>(`${base(token)}/items/${itemId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (data) => queryClient.setQueryData(portalQueryKey(token), data),
  });
}

/** The auditor's change on several requests at once (POST .../bulk); the reply (the whole portal) replaces it. */
export function useAuditorBulk(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: PortalBulkInput) =>
      publicFetch<PortalData>(`${base(token)}/bulk`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (data) => queryClient.setQueryData(portalQueryKey(token), data),
  });
}

/** The auditor's answer (with the bank file for "Approve & Send to Accounts"); the reply replaces the portal and its
 *  `warning` (the e-mail to Accounts did not go) is handed back. */
export function useAuditorSubmit(token: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ decision, note, bank }: { decision: PortalDecision; note: string; bank?: File }) => {
      const form = new FormData();
      form.append("decision", decision);
      form.append("note", note);
      if (bank) form.append("bank", bank, bank.name);
      return publicFetch<PortalData>(`${base(token)}/submit`, { method: "POST", body: form });
    },
    onSuccess: (data) => {
      const { warning: _warning, ...portal } = data;
      queryClient.setQueryData(portalQueryKey(token), portal);
    },
  });
}

/** Reads the portal again (after a refusal that says it changed: answered, closed, expired). */
export function useReloadPortal(token: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: portalQueryKey(token) });
}
