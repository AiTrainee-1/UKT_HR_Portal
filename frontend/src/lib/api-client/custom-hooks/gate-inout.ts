// gate-inout: Gate Pass -> In/Out (/hr/outpass-visitors/outpass/in-out). OWNER: slice B2. HR token, permission key
// outpass_visitors.outpass.in_out (its own API prefix "outpass/in-out", so In/Out no longer needs the Requests module).
// Rows are passes that went out (exited_at in the range); status follows gate_outpass_common.pass_state.
// Backend: backend/api/outpass_inout_views.py.
//
//   GET /api/outpass/in-out?from&to&gateId&employeeId&departmentId&status&q&branchId&page&pageSize -> InOutPage
//   GET /api/outpass/in-out/summary?<the same filters, no paging>                                -> InOutSummary
//   GET /api/outpass/in-out/<id>                                                                 -> InOutDetail
//   GET /api/outpass/in-out/export?fmt=xlsx|pdf&<filters>                                        (kit/download.ts)
//   GET /api/outpass/in-out/options                                                              -> InOutOptions
//
// No dates = today (India time). Never qrToken / returnQrToken in these payloads. The employee filter uses the app's
// existing employee search (useSearchEmployees in organization.ts: GET /api/employees?search=&status=active&lite=1),
// not a new endpoint. The old hooks in gate.ts (useListOutpassRequests / getListOutpassRequestsQueryKey) are used by the
// sidebar, the MD portal and the Requests tab: do not change them.
//
// The list and summary hooks take the query string of useGateFilters (pages/hr/outpass-visitors/kit), which is also
// their cache key: every filter change is its own entry, and the previous page stays on screen while the next loads.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ApprovalProgress } from "../../approval-workflow";
import type { PaginatedRecords } from "./gate";
import type { GatePerson } from "./gate-records";

/**
 * back = scanned back in; out = out today, within the expected return (or none was given); overdue = out today past the
 * expected return; not_returned = out on an earlier day and never scanned back; early_dismissal = an early-dismissal
 * pass that has left (not expected back).
 */
export type InOutStatus = "back" | "out" | "overdue" | "not_returned" | "early_dismissal";

export type InOutRow = {
  id: number;
  employee: GatePerson;
  passType: string | null;
  passTypeLabel: string | null;
  destination: string;
  reason: string | null;
  /** "manual" (asked for in the app) | "on_duty" (made by an On-Duty approval). */
  source?: string | null;
  sourceLabel?: string | null;
  /** Who approved it: "HR – Priya", "HOD – Mani", "On-Duty approval (Rita)". */
  approvedBy: string | null;
  approvedAt: string | null;
  expectedReturnAt: string | null;
  exitGateId?: number | null;
  exitGateName: string | null;
  exitedAt: string;
  entryGateId?: number | null;
  entryGateName: string | null;
  enteredAt: string | null;
  /** Out until back (or until now while still out today); null for an old open pass or an early dismissal. */
  minutesOut: number | null;
  /** From the exit to the expected return, when one was given. */
  allowedMinutes?: number | null;
  /** Minutes past the expected return (still out, or came back late); null when not past it. */
  overMinutes?: number | null;
  /** Past the expected return time: still out after it, or came back after it. */
  overdue: boolean;
  status: InOutStatus;
  statusLabel: string;
};

export type InOutPage = PaginatedRecords<InOutRow>;

export type InOutSummary = {
  wentOut: number;
  cameBack: number;
  /** Still out today, the overdue ones included. */
  stillOut: number;
  overdue: number;
  notReturned: number;
  earlyDismissal?: number;
  /** Door to door, over the passes that came back. */
  avgMinutesOut: number | null;
  longestMinutesOut: number | null;
  totalMinutesOut?: number | null;
};

/** Every gate scan of the pass, denied ones included. */
export type InOutScan = {
  id?: number;
  at: string;
  type: "exit" | "return";
  result: "allowed" | "denied";
  /** The OutpassGateScan result code when denied ("already_scanned", "expired" ...), else null. */
  reason?: string | null;
  reasonLabel: string | null;
  gateName: string | null;
  message: string | null;
};

export type InOutDetail = InOutRow & {
  requestedAt?: string | null;
  reviewComment?: string | null;
  /** The pass's approval pipeline, the same shape as OutpassRequestItem.approval (components/ApprovalTrail draws it);
   *  null for an On-Duty pass, which has no pipeline of its own. */
  approvalTrail: ApprovalProgress | null;
  scans: InOutScan[];
};

export type InOutOptions = {
  gates: { id: number; name: string; isActive?: boolean; branchName?: string | null }[];
  departments: { id: number; name: string; category?: string; branchName?: string | null }[];
};

export type InOutFilters = {
  from?: string;
  to?: string;
  gateId?: string;
  employeeId?: string;
  departmentId?: string;
  status?: InOutStatus | "";
  q?: string;
  branchId?: string;
  page?: number;
  pageSize?: number;
};

export const IN_OUT_API = {
  list: "/api/outpass/in-out",
  summary: "/api/outpass/in-out/summary",
  detail: (id: number) => `/api/outpass/in-out/${id}`,
  export: "/api/outpass/in-out/export",
  options: "/api/outpass/in-out/options",
} as const;

/** A still-out list goes stale by the minute: the list and the figures ask again every minute while on screen. */
const LIVE_MS = 60_000;

const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

export const getInOutQueryKey = (query: string) => [IN_OUT_API.list, query] as const;
/** One page of passes that went out. `query`: useGateFilters().queryKey (the filters and the page). */
export const useInOut = (query: string, options?: { enabled?: boolean }) =>
  useQuery<InOutPage>({
    queryKey: getInOutQueryKey(query),
    queryFn: ({ signal }) => customFetch<InOutPage>(withQuery(IN_OUT_API.list, query), { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_MS,
    enabled: options?.enabled ?? true,
  });

export const getInOutSummaryQueryKey = (query: string) => [IN_OUT_API.summary, query] as const;
/** The headline figures for the filters in `query` (no paging; leave `status` out for the tiles). */
export const useInOutSummary = (query: string, options?: { enabled?: boolean }) =>
  useQuery<InOutSummary>({
    queryKey: getInOutSummaryQueryKey(query),
    queryFn: ({ signal }) => customFetch<InOutSummary>(withQuery(IN_OUT_API.summary, query), { signal }),
    placeholderData: keepPreviousData,
    refetchInterval: LIVE_MS,
    enabled: options?.enabled ?? true,
  });

export const getInOutDetailQueryKey = (id: number | null) => [IN_OUT_API.list, "detail", id] as const;
/** One pass with its approval trail and every scan; nothing is asked for while `id` is null. */
export const useInOutDetail = (id: number | null) =>
  useQuery<InOutDetail>({
    queryKey: getInOutDetailQueryKey(id),
    queryFn: ({ signal }) => customFetch<InOutDetail>(IN_OUT_API.detail(id as number), { signal }),
    enabled: id !== null,
  });

export const getInOutOptionsQueryKey = () => [IN_OUT_API.options] as const;
/** The gates and departments of the user's branch, for the filter selects. */
export const useInOutOptions = (options?: { enabled?: boolean }) =>
  useQuery<InOutOptions>({
    queryKey: getInOutOptionsQueryKey(),
    queryFn: ({ signal }) => customFetch<InOutOptions>(IN_OUT_API.options, { signal }),
    staleTime: 5 * 60_000,
    enabled: options?.enabled ?? true,
  });
