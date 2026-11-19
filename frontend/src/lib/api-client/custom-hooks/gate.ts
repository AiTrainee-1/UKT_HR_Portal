// gate: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ApprovalProgress } from "../../approval-workflow";

// ── Outpass / Visitors -pure gate data-collection, see backend/api/outpass_visitor_views.py ──

export type GateRange = "today" | "week" | "month";

export type GateQr = { token: string; branchId: number; branchName: string };
export type GateSummary = { today: number; thisWeek: number; thisMonth: number };

export const getOutpassQrQueryKey = (branchId?: number | null) => ["/api/outpass/qr", branchId] as const;
// `enabled: false` until there is a branch to ask for: an admin's page used to ask before its branch list had loaded
// and got a 400 "No branch selected" every time it opened.
export const useOutpassQr = (branchId?: number | null, options?: { enabled?: boolean }) =>
  useQuery<GateQr>({
    queryKey: getOutpassQrQueryKey(branchId),
    queryFn: () => customFetch<GateQr>(`/api/outpass/qr${branchId ? `?branchId=${branchId}` : ""}`),
    enabled: options?.enabled ?? true,
  });

export const getOutpassSummaryQueryKey = () => ["/api/outpass/summary"] as const;
export const useOutpassSummary = () =>
  useQuery<GateSummary>({
    queryKey: getOutpassSummaryQueryKey(),
    queryFn: () => customFetch<GateSummary>("/api/outpass/summary"),
  });

export type OutpassRecordRow = {
  id: number;
  employeeName: string;
  employeeCode: string;
  destination: string;
  branchName: string | null;
  submittedAt: string;
};

export type PaginatedRecords<T> = { items: T[]; total: number; page: number; pageSize: number };

export const getOutpassRecordsQueryKey = (range: GateRange, page: number) =>
  ["/api/outpass/records", range, page] as const;
export const useOutpassRecords = (range: GateRange, page: number, pageSize = 20) =>
  useQuery<PaginatedRecords<OutpassRecordRow>>({
    queryKey: getOutpassRecordsQueryKey(range, page),
    queryFn: () =>
      customFetch<PaginatedRecords<OutpassRecordRow>>(
        `/api/outpass/records?range=${range}&page=${page}&pageSize=${pageSize}`,
      ),
    placeholderData: keepPreviousData,
  });

export const useOutpassGateInfo = (token: string) =>
  useQuery<{ branchName: string }>({
    queryKey: ["/api/outpass/gate", token],
    queryFn: () => customFetch<{ branchName: string }>(`/api/outpass/gate/${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });

export const useOutpassGateSubmit = (token: string) =>
  useMutation({
    mutationFn: (body: { name: string; employeeCode: string; destination: string }) =>
      customFetch<{ submitted: boolean }>(`/api/outpass/gate/${encodeURIComponent(token)}/submit`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

export const getVisitorQrQueryKey = (branchId?: number | null) => ["/api/visitor/qr", branchId] as const;
export const useVisitorQr = (branchId?: number | null, options?: { enabled?: boolean }) =>
  useQuery<GateQr>({
    queryKey: getVisitorQrQueryKey(branchId),
    queryFn: () => customFetch<GateQr>(`/api/visitor/qr${branchId ? `?branchId=${branchId}` : ""}`),
    enabled: options?.enabled ?? true,
  });

// The employee a visitor came to meet, resolved by phone-matching against
// Employee (see backend/api/outpass_visitor_views.py::_employee_contact_json).
// Shared by the visitor-gate-form lookup result and every visit list that
// shows who a visit was for (VisitorRecordRow below).
export type EmployeeContact = {
  id: number;
  employeeCode: string;
  name: string;
  department: string | null;
  designation: string | null;
  phone: string | null;
  email: string | null;
  photoUrl: string | null;
};

export type VisitorRecordRow = {
  id: number;
  name: string;
  phone: string;
  aadhaar: string | null;
  aadhaarLast4: string | null;
  whyCame: string | null;
  whomToMeet: string;
  purpose: string;
  branchName: string | null;
  visitedAt: string;
  // Additive -null for a visit not tied to a specific employee, or where the
  // phone lookup found no match (whomToMeet above still carries whatever
  // free text was entered either way).
  meetingEmployee: EmployeeContact | null;
  notifiedEmailAt: string | null;
  notifiedWhatsappAt: string | null;
};

export const useVisitorGateInfo = (token: string) =>
  useQuery<{ branchName: string }>({
    queryKey: ["/api/visitor/gate", token],
    queryFn: () => customFetch<{ branchName: string }>(`/api/visitor/gate/${encodeURIComponent(token)}`),
    enabled: !!token,
    retry: false,
  });

export const useVisitorCheckPhone = (token: string) =>
  useMutation({
    mutationFn: (body: { phone: string }) =>
      customFetch<{ found: boolean; name?: string }>(`/api/visitor/gate/${encodeURIComponent(token)}/check-phone`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

// "Are you meeting a specific employee?" -> Yes step: looks up the employee
// being visited by phone (see backend/api/outpass_visitor_views.py::
// visitor_check_employee_phone) -entirely separate from useVisitorCheckPhone
// above, which looks up the VISITOR's own phone for the "Already Visited" flow.
export const useVisitorCheckEmployeePhone = (token: string) =>
  useMutation({
    mutationFn: (body: { phone: string }) =>
      customFetch<{ found: boolean; employee?: EmployeeContact }>(
        `/api/visitor/gate/${encodeURIComponent(token)}/check-employee-phone`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  });

export const useVisitorGateNew = (token: string) =>
  useMutation({
    mutationFn: (body: {
      name: string;
      phone: string;
      aadhaarNumber?: string;
      whyCame?: string;
      whomToMeet: string;
      purpose: string;
      meetingEmployeeId?: number;
    }) =>
      customFetch<{ submitted: boolean }>(`/api/visitor/gate/${encodeURIComponent(token)}/new`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

export const useVisitorGateRepeat = (token: string) =>
  useMutation({
    mutationFn: (body: { phone: string; whomToMeet: string; purpose: string; meetingEmployeeId?: number }) =>
      customFetch<{ submitted: boolean }>(`/api/visitor/gate/${encodeURIComponent(token)}/repeat`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

// ── Outpass Approval (HR side) -see backend/api/outpass_request_views.py ──
// Employee-side submission happens in the Mobile App / Employee Web App
// (separate repos, separate API clients); this HR portal only ever reads and
// approves/rejects, same split as Permissions above.

export type OutpassScanStatus =
  | "not_applicable"
  | "pending_exit"
  | "exited"
  | "expired_unscanned"
  // The return/re-entry leg -see backend/api/outpass_request_views.py::_outpass_scan_status.
  // "exited" now specifically means "exited, return QR not yet generated".
  | "pending_return"
  | "return_expired"
  | "completed";

export type OutpassRequestItem = {
  id: number;
  employeeId: number;
  destination: string;
  reason: string;
  status: string;
  source: "manual" | "on_duty";
  approverRole?: string | null;
  approvedBy?: string | null;
  reviewComment?: string | null;
  approvedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  /** Where the request is in its approval pipeline and who can act on it (see lib/approval-workflow.ts). */
  approval?: ApprovalProgress | null;
  // Gate Scanner fields -see backend/api/gate_scanner_views.py. qrToken is
  // only ever present while the pass is actually presentable at a gate
  // (approved, unexpired, not yet exited); HR never needs it, only the
  // employee-facing apps that render it as a QR code.
  qrToken?: string | null;
  exitGateName?: string | null;
  exitedAt?: string | null;
  // Return/re-entry leg -returnQrToken mirrors qrToken's "only present when
  // actually presentable" rule (generated, unexpired, not yet returned).
  // HR never needs it either; only the employee-facing apps render it.
  entryGateName?: string | null;
  enteredAt?: string | null;
  returnQrToken?: string | null;
  returnQrExpiresAt?: string | null;
  canGenerateReturnQr?: boolean;
  scanStatus: OutpassScanStatus;
  employee?: {
    id: number;
    employeeCode: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    photoUrl?: string | null;
  };
};

export const getListOutpassRequestsQueryKey = (status?: string) => ["/api/outpass-requests", status] as const;
export const useListOutpassRequests = (status?: string, options?: { enabled?: boolean }) =>
  useQuery<OutpassRequestItem[]>({
    queryKey: getListOutpassRequestsQueryKey(status),
    queryFn: () => customFetch<OutpassRequestItem[]>(`/api/outpass-requests${status ? `?status=${status}` : ""}`),
    refetchInterval: 60_000,
    enabled: options?.enabled,
  });

export const useUpdateOutpassRequestStatus = () =>
  useMutation({
    // approvedBy is never client-sendable -always server-derived from the
    // logged-in HR user, same convention as useUpdatePermissionStatus.
    mutationFn: ({ id, data }: { id: number; data: { status: string; comment?: string } }) =>
      customFetch<OutpassRequestItem>(`/api/outpass-requests/${id}/hr-status`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

// ── Gate Scanner device management (HR side) -see backend/api/gate_scanner_views.py ──
// Deliberately separate from the GateQr/GateSummary/GateRecords hooks above:
// those cover the permanent, unauthenticated per-branch QR (outpass/visitor
// entry forms); this is a real username/password login for a kiosk device
// that verifies an approved OutpassRequest's QR and records the exit.

export type GateDevice = {
  id: number;
  name: string;
  branchId: number | null;
  branchName: string | null;
  username: string;
  isActive: boolean;
  loginToken: string;
  createdBy: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

// The gate list and its changes are Manage Gates' hooks (./gate-admin.ts: useManagedGates and the rest).

// ── Gate kiosk ────────────────────────────────────────────────────────────────
// The gate monitor (/gatemonitor: sign-in, login-info hint, scan, records) has NO hooks here on purpose: customFetch
// attaches the HR "uk_textile_token" to any call without its own Authorization header, and a gate must never send it.
// Its calls go through pages/gate/monitor/client.ts with the gate token only (types in ./gate-monitor).

// ── Reception desks (HR side) -see backend/api/reception_admin_views.py ──
// Only the ReceptionDevice type is left here (Manage Reception's ManagedDesk builds on it): the desk list and its
// changes are ./reception-admin.ts, and the desk's own sign-in and console calls go through
// pages/gate/reception/desk-api.ts with the desk token only (customFetch would fall back to the HR token).

export type ReceptionDevice = {
  id: number;
  name: string;
  branchId: number | null;
  branchName: string | null;
  username: string;
  isActive: boolean;
  loginToken: string;
  createdBy: string | null;
  createdAt: string;
  lastLoginAt: string | null;
};

// ── Tea Break (HR side) -see backend/api/tea_break_views.py ────────────────
// A permanent per-employee QR, no approval, toggled OUT/IN at any active
// GateDevice (same gate logins as Outpass -see gate_scanner_views.py's role
// dispatch). This section is the HR dashboard's read/config surface; the
// employee-facing QR + own-status hooks live in the mobile/web apps' own
// API clients, not here.

export type TeaBreakRemark = "overtime" | "on_time" | "in_progress" | "not_returned";

export type TeaBreakEmployee = {
  id: number;
  employeeCode: string;
  name: string;
  department: string | null;
  photoUrl: string | null;
};

export type TeaBreakRecord = {
  id: number;
  employee: TeaBreakEmployee;
  outGateName: string | null;
  outAt: string;
  inGateName: string | null;
  inAt: string | null;
  takenMinutes: number;
  remark: TeaBreakRemark;
};

export type TeaBreakRule = { allowedMinutes: number; updatedAt: string };

export const getTeaBreakRuleQueryKey = () => ["/api/tea-break/rule"] as const;
export const useTeaBreakRule = (options?: { enabled?: boolean }) =>
  useQuery<TeaBreakRule>({
    queryKey: getTeaBreakRuleQueryKey(),
    queryFn: () => customFetch<TeaBreakRule>("/api/tea-break/rule"),
    enabled: options?.enabled ?? true,
  });

/**
 * Saves the allowed minutes. Every overtime / on-time figure is worked out from the rule as it stands, so a save refreshes
 * the rule, every Tea Break list, summary, detail and option (all keys under "/api/tea-break/records") and
 * /api/tea-break/summary.
 */
export const useUpdateTeaBreakRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (allowedMinutes: number) =>
      customFetch<TeaBreakRule>("/api/tea-break/rule", {
        method: "PUT",
        body: JSON.stringify({ allowedMinutes }),
      }),
    onSuccess: (rule) => {
      queryClient.setQueryData(getTeaBreakRuleQueryKey(), rule);
      void queryClient.invalidateQueries({ queryKey: getTeaBreakRuleQueryKey() });
      void queryClient.invalidateQueries({ queryKey: ["/api/tea-break/records"] });
      void queryClient.invalidateQueries({ queryKey: getTeaBreakSummaryQueryKey() });
    },
  });
};

// /api/tea-break/summary (the counts the mobile and employee web apps read); the HR page's lists, figures and files are
// ./tea-break-admin.ts.
export const getTeaBreakSummaryQueryKey = () => ["/api/tea-break/summary"] as const;
