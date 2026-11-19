// tea-break-admin: Tea Break (/hr/outpass-visitors/tea-break/records and /rule; Breaks / By employee is a `?view=`
// switch). OWNER: slice D. HR token, permission key outpass_visitors.tea_break.records (it owns every
// "tea-break/records/*" path) and .rule. Backend: tea_break_admin_views.py (the list's URL stays tea_break_views.py) on
// the gate_visitor_tea_common helpers, so the numbers match the Report Center and the MD portal.
//
//   GET /api/tea-break/records?range|from&to&departmentId&employeeId&gateId&status&q&branchId&page&pageSize
//                                                   -> TeaBreakRecordsPage (`range` + `filter` still work)
//   GET /api/tea-break/records/summary?<filters>    -> TeaBreakRecordsSummary
//   GET /api/tea-break/records/<id>                 -> TeaBreakRecordDetail
//   GET /api/tea-break/records/employees?<filters>&page&pageSize&sort -> TeaBreakEmployeesPage
//   GET /api/tea-break/records/export?fmt=xlsx|pdf&view=breaks|employees&<filters>   (kit/download.ts)
//   GET /api/tea-break/records/options[?branchId]   -> TeaBreakOptions
//
// Kept unchanged on the server (the mobile and employee web apps use them): /api/tea-break/summary, my-status, qr-token.
// Every key here starts with "/api/tea-break/records", so useUpdateTeaBreakRule (gate.ts) refreshes all of them with one
// invalidation after a save.

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { PaginatedRecords, TeaBreakRecord } from "./gate";
import type { GatePerson } from "./gate-records";

/** on_break: still out (up to an hour); on_time / overtime: came back within / over the rule; not_returned: out for over
 *  an hour. The old `remark` of a row says the same in the apps' words (in_progress = on_break). */
export type TeaBreakStatus = "on_break" | "on_time" | "overtime" | "not_returned";

/** One break: the old row's keys (remark included) plus the new ones. */
export type TeaBreakAdminRecord = TeaBreakRecord & {
  designation: string | null;
  branchName: string | null;
  /** Minutes beyond the allowance of a finished break (0 within it); null while the break is open. */
  overMinutes: number | null;
  /** long: a finished break over an hour (likely a missed scan); left_open: not scanned back in for over 12 hours. */
  flag: "long" | "left_open" | null;
  flagLabel: string | null;
  allowedMinutes: number;
  status: TeaBreakStatus;
  statusLabel: string;
  outGateId: number | null;
  inGateId: number | null;
};

export type TeaBreakRecordsPage = PaginatedRecords<TeaBreakAdminRecord> & { allowedMinutes: number };

export type TeaBreakRecordsSummary = {
  breaks: number;
  onBreakNow: number;
  onTime: number;
  overtime: number;
  notReturned: number;
  /** Over finished breaks; null when none finished. */
  avgMinutes: number | null;
  longestMinutes: number | null;
  employees: number;
  overMinutesTotal: number;
  allowedMinutes: number;
  completed: number;
  totalMinutes: number;
  /** Breaks flagged long or left open. */
  longOrOpen: number;
  from: string | null;
  to: string | null;
};

export type TeaBreakEmployeeMonth = {
  /** "2026-11": the India month the break started in. */
  month: string;
  label: string;
  breaks: number;
  onTime: number;
  overtime: number;
  notReturned: number;
  avgMinutes: number | null;
  totalMinutes: number;
  overMinutesTotal: number;
};

export type TeaBreakRecordDetail = TeaBreakAdminRecord & {
  employeeMonth: TeaBreakEmployeeMonth;
  /** The employee's latest 10 breaks, newest first (this one included). */
  recent: TeaBreakAdminRecord[];
};

export type TeaBreakEmployeeRow = {
  employee: GatePerson & { branchName?: string | null };
  breaks: number;
  completed: number;
  onTime: number;
  totalMinutes: number;
  avgMinutes: number | null;
  longestMinutes: number | null;
  overtime: number;
  overMinutesTotal: number;
  notReturned: number;
  /** How many of their breaks are going on now (0 or 1 in practice). */
  onBreak: number;
  onBreakNow: boolean;
};

export type TeaBreakEmployeesPage = PaginatedRecords<TeaBreakEmployeeRow> & { allowedMinutes: number };

export type TeaBreakOption = { id: number; name: string };

export type TeaBreakOptions = {
  departments: TeaBreakOption[];
  gates: TeaBreakOption[];
  /** The branches an account that is not bound to one may pick (empty for a bound account). */
  branches: TeaBreakOption[];
  branchScoped: boolean;
  allowedMinutes: number;
  ruleUpdatedAt: string | null;
};

export type TeaBreakExportView = "breaks" | "employees";

/** The employees view's ?sort=: a key, "-" first for high to low. */
export type TeaBreakEmployeeSort =
  "name" | "code" | "breaks" | "total" | "avg" | "longest" | "overtime" | "notReturned" | "over";

export type TeaBreakFilters = {
  from?: string;
  to?: string;
  departmentId?: string;
  employeeId?: string;
  gateId?: string;
  status?: TeaBreakStatus | "";
  q?: string;
  branchId?: string;
  sort?: string;
  page?: number;
  pageSize?: number;
};

export const TEA_BREAK_ADMIN_API = {
  records: "/api/tea-break/records",
  summary: "/api/tea-break/records/summary",
  detail: (id: number) => `/api/tea-break/records/${id}`,
  employees: "/api/tea-break/records/employees",
  export: "/api/tea-break/records/export",
  options: "/api/tea-break/records/options",
} as const;

/** The first part of every key below: invalidate it to refresh them all. */
export const TEA_BREAK_RECORDS_ROOT = TEA_BREAK_ADMIN_API.records;

const withQuery = (path: string, query: string) => (query ? `${path}?${query}` : path);

export const getTeaBreakAdminRecordsQueryKey = (query: string) => [TEA_BREAK_RECORDS_ROOT, "list", query] as const;
/** One page of breaks for `query` (the filters as a query string). Refreshes every minute (open breaks keep running). */
export const useTeaBreakAdminRecords = (query: string, options?: { enabled?: boolean }) =>
  useQuery<TeaBreakRecordsPage>({
    queryKey: getTeaBreakAdminRecordsQueryKey(query),
    queryFn: ({ signal }) =>
      customFetch<TeaBreakRecordsPage>(withQuery(TEA_BREAK_ADMIN_API.records, query), { signal }),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const getTeaBreakRecordsSummaryQueryKey = (query: string) => [TEA_BREAK_RECORDS_ROOT, "summary", query] as const;
export const useTeaBreakRecordsSummary = (query: string, options?: { enabled?: boolean }) =>
  useQuery<TeaBreakRecordsSummary>({
    queryKey: getTeaBreakRecordsSummaryQueryKey(query),
    queryFn: ({ signal }) =>
      customFetch<TeaBreakRecordsSummary>(withQuery(TEA_BREAK_ADMIN_API.summary, query), { signal }),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

export const getTeaBreakEmployeesQueryKey = (query: string) => [TEA_BREAK_RECORDS_ROOT, "employees", query] as const;
export const useTeaBreakEmployees = (query: string, options?: { enabled?: boolean }) =>
  useQuery<TeaBreakEmployeesPage>({
    queryKey: getTeaBreakEmployeesQueryKey(query),
    queryFn: ({ signal }) =>
      customFetch<TeaBreakEmployeesPage>(withQuery(TEA_BREAK_ADMIN_API.employees, query), { signal }),
    enabled: options?.enabled ?? true,
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });

export const getTeaBreakRecordDetailQueryKey = (id: number | null) => [TEA_BREAK_RECORDS_ROOT, "detail", id] as const;
/** One break with the employee's month and latest breaks; nothing is asked for while `id` is null. */
export const useTeaBreakRecordDetail = (id: number | null) =>
  useQuery<TeaBreakRecordDetail>({
    queryKey: getTeaBreakRecordDetailQueryKey(id),
    queryFn: ({ signal }) => customFetch<TeaBreakRecordDetail>(TEA_BREAK_ADMIN_API.detail(id!), { signal }),
    enabled: id !== null,
  });

export const getTeaBreakOptionsQueryKey = (branchId = "") => [TEA_BREAK_RECORDS_ROOT, "options", branchId] as const;
/** The filter bar's departments and gates (of `branchId` for an account not bound to a branch), the branches it may
 *  pick and the allowed minutes. */
export const useTeaBreakOptions = (branchId = "", options?: { enabled?: boolean }) =>
  useQuery<TeaBreakOptions>({
    queryKey: getTeaBreakOptionsQueryKey(branchId),
    queryFn: ({ signal }) =>
      customFetch<TeaBreakOptions>(
        withQuery(TEA_BREAK_ADMIN_API.options, branchId ? `branchId=${encodeURIComponent(branchId)}` : ""),
        { signal },
      ),
    enabled: options?.enabled ?? true,
    staleTime: 5 * 60_000,
  });
