// gate: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ── Outpass / Visitors -pure gate data-collection, see backend/api/outpass_visitor_views.py ──

export type GateRange = "today" | "week" | "month";

export type GateQr = { token: string; branchId: number; branchName: string };
export type GateSummary = { today: number; thisWeek: number; thisMonth: number };

export const getOutpassQrQueryKey = (branchId?: number | null) => ["/api/outpass/qr", branchId] as const;
export const useOutpassQr = (branchId?: number | null) =>
  useQuery<GateQr>({
    queryKey: getOutpassQrQueryKey(branchId),
    queryFn: () => customFetch<GateQr>(`/api/outpass/qr${branchId ? `?branchId=${branchId}` : ""}`),
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
export const useVisitorQr = (branchId?: number | null) =>
  useQuery<GateQr>({
    queryKey: getVisitorQrQueryKey(branchId),
    queryFn: () => customFetch<GateQr>(`/api/visitor/qr${branchId ? `?branchId=${branchId}` : ""}`),
  });

export const getVisitorSummaryQueryKey = () => ["/api/visitor/summary"] as const;
export const useVisitorSummary = () =>
  useQuery<GateSummary>({
    queryKey: getVisitorSummaryQueryKey(),
    queryFn: () => customFetch<GateSummary>("/api/visitor/summary"),
  });

// The employee a visitor came to meet, resolved by phone-matching against
// Employee (see backend/api/outpass_visitor_views.py::_employee_contact_json).
// Shared by the visitor-gate-form lookup result and every visit list that
// shows who a visit was for (VisitorRecordRow below, ReceptionVisit).
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

export const getVisitorRecordsQueryKey = (range: GateRange, page: number) =>
  ["/api/visitor/records", range, page] as const;
export const useVisitorRecords = (range: GateRange, page: number, pageSize = 20) =>
  useQuery<PaginatedRecords<VisitorRecordRow>>({
    queryKey: getVisitorRecordsQueryKey(range, page),
    queryFn: () =>
      customFetch<PaginatedRecords<VisitorRecordRow>>(
        `/api/visitor/records?range=${range}&page=${page}&pageSize=${pageSize}`,
      ),
    placeholderData: keepPreviousData,
  });

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
    refetchInterval: 30_000,
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

export const getListGateDevicesQueryKey = () => ["/api/gate-devices"] as const;
export const useListGateDevices = () =>
  useQuery<GateDevice[]>({
    queryKey: getListGateDevicesQueryKey(),
    queryFn: () => customFetch<GateDevice[]>("/api/gate-devices"),
  });

export const useCreateGateDevice = () =>
  useMutation({
    mutationFn: (data: { name: string; branchId?: number; username: string; password: string }) =>
      customFetch<GateDevice>("/api/gate-devices", { method: "POST", body: JSON.stringify(data) }),
  });

export const useUpdateGateDevice = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; isActive?: boolean; password?: string } }) =>
      customFetch<GateDevice>(`/api/gate-devices/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  });

export const useDeleteGateDevice = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/gate-devices/${id}`, { method: "DELETE" }),
  });

// ── Gate Scanner kiosk auth -public login-info, public login ───────────────
// The kiosk itself (POST /api/gate-devices/scan) is deliberately NOT a hook
// here -it authenticates with a gate_device token stored under its own
// localStorage key, not the HR "uk_textile_token" customFetch auto-attaches,
// so that one call is made directly from the kiosk page with an explicit
// Authorization header instead.

export const useGateLoginInfo = (loginToken: string) =>
  useQuery<{ gateName: string; branchName: string; isActive: boolean }>({
    queryKey: ["/api/gate-devices/login-info", loginToken],
    queryFn: () => customFetch(`/api/gate-devices/login-info/${encodeURIComponent(loginToken)}`),
    enabled: !!loginToken,
    retry: false,
  });

export const useGateLogin = () =>
  useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      customFetch<{ token: string; gateId: number; gateName: string }>("/api/gate-devices/login", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

// ── Reception device management (HR side) -see backend/api/reception_views.py ──
// A per-desk login onto the existing VisitorVisit data -mirrors GateDevice's
// shape exactly, just for Reception instead of the gate kiosk. It never
// scans anything itself: the visitor's own phone scanning the permanent
// Visitor QR (useVisitorQr above) remains the only way a visit is recorded.

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

export const getListReceptionDevicesQueryKey = () => ["/api/reception-devices"] as const;
export const useListReceptionDevices = () =>
  useQuery<ReceptionDevice[]>({
    queryKey: getListReceptionDevicesQueryKey(),
    queryFn: () => customFetch<ReceptionDevice[]>("/api/reception-devices"),
  });

export const useCreateReceptionDevice = () =>
  useMutation({
    mutationFn: (data: { name: string; branchId?: number; username: string; password: string }) =>
      customFetch<ReceptionDevice>("/api/reception-devices", { method: "POST", body: JSON.stringify(data) }),
  });

export const useUpdateReceptionDevice = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: { name?: string; isActive?: boolean; password?: string } }) =>
      customFetch<ReceptionDevice>(`/api/reception-devices/${id}`, { method: "PUT", body: JSON.stringify(data) }),
  });

export const useDeleteReceptionDevice = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/reception-devices/${id}`, { method: "DELETE" }),
  });

// ── Reception desk auth + dashboard -public login-info/login, desk-token-
//    authenticated summary/visits. Same "own localStorage key, explicit
//    Authorization header" reasoning as the Gate Scanner kiosk above. ──────

export const useReceptionLoginInfo = (loginToken: string) =>
  useQuery<{ deskName: string; branchName: string; isActive: boolean }>({
    queryKey: ["/api/reception-devices/login-info", loginToken],
    queryFn: () => customFetch(`/api/reception-devices/login-info/${encodeURIComponent(loginToken)}`),
    enabled: !!loginToken,
    retry: false,
  });

export const useReceptionLogin = () =>
  useMutation({
    mutationFn: (body: { username: string; password: string }) =>
      customFetch<{ token: string; deviceId: number; deskName: string }>("/api/reception-devices/login", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  });

function receptionAuthHeader(): HeadersInit | undefined {
  const token = localStorage.getItem("reception_device_token");
  return token ? { Authorization: `Bearer ${token}` } : undefined;
}

export const useReceptionSummary = () =>
  useQuery<GateSummary>({
    queryKey: ["/api/reception-devices/summary"],
    queryFn: () => customFetch<GateSummary>("/api/reception-devices/summary", { headers: receptionAuthHeader() }),
    refetchInterval: 30_000,
  });

export type ReceptionVisit = VisitorRecordRow;

export const useReceptionVisits = (range: GateRange, page: number, pageSize = 20) =>
  useQuery<PaginatedRecords<ReceptionVisit>>({
    queryKey: ["/api/reception-devices/visits", range, page],
    queryFn: () =>
      customFetch<PaginatedRecords<ReceptionVisit>>(
        `/api/reception-devices/visits?range=${range}&page=${page}&pageSize=${pageSize}`,
        { headers: receptionAuthHeader() },
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
  });

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
export const useTeaBreakRule = () =>
  useQuery<TeaBreakRule>({
    queryKey: getTeaBreakRuleQueryKey(),
    queryFn: () => customFetch<TeaBreakRule>("/api/tea-break/rule"),
  });

export const useUpdateTeaBreakRule = () =>
  useMutation({
    mutationFn: (allowedMinutes: number) =>
      customFetch<TeaBreakRule>("/api/tea-break/rule", {
        method: "PUT",
        body: JSON.stringify({ allowedMinutes }),
      }),
  });

export const getTeaBreakSummaryQueryKey = () => ["/api/tea-break/summary"] as const;
export const useTeaBreakSummary = () =>
  useQuery<GateSummary>({
    queryKey: getTeaBreakSummaryQueryKey(),
    queryFn: () => customFetch<GateSummary>("/api/tea-break/summary"),
    refetchInterval: 30_000,
  });

export type TeaBreakFilter = "overtime" | "not_returned" | null;

export const getTeaBreakRecordsQueryKey = (range: GateRange, page: number, filter: TeaBreakFilter) =>
  ["/api/tea-break/records", range, page, filter] as const;
export const useTeaBreakRecords = (range: GateRange, page: number, filter: TeaBreakFilter, pageSize = 20) =>
  useQuery<PaginatedRecords<TeaBreakRecord>>({
    queryKey: getTeaBreakRecordsQueryKey(range, page, filter),
    queryFn: () =>
      customFetch<PaginatedRecords<TeaBreakRecord>>(
        `/api/tea-break/records?range=${range}&page=${page}&pageSize=${pageSize}${filter ? `&filter=${filter}` : ""}`,
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
