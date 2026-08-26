import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "./custom-fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Branch = {
  id: number;
  name: string;
  code?: string | null;
  location?: string | null;
  address?: string | null;
  managerName?: string | null;
  phone?: string | null;
  isHeadOffice: boolean;
  isActive: boolean;
  geofenceLat?: number | null;
  geofenceLng?: number | null;
  geofenceRadiusM?: number | null;
  createdAt?: string | null;
};

export type Designation = {
  id: number;
  title: string;
  departmentId?: number | null;
  departmentName?: string | null;
  level?: string | null;
  createdAt?: string | null;
};

export type ShiftTemplate = {
  id: number;
  name: string;
  shiftType: "production" | "staff";
  startTime?: string | null;
  endTime?: string | null;
  genderRule: string;
  gracePeriodMinutes: number;
  departmentId?: number | null;
  departmentName?: string | null;
  isDefault: boolean;
  isActive: boolean;
  createdAt?: string | null;
};

export type EmployeeRequest = {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  requestType: string;
  subject: string;
  description: string;
  status: "pending" | "in_review" | "approved" | "rejected" | "more_info";
  hrNotes?: string | null;
  handledBy?: string | null;
  handledAt?: string | null;
  createdAt?: string | null;
};

export type AdvanceRepaymentItem = {
  id: number;
  advanceId: number;
  month: number;
  year: number;
  amount: number;
  paymentMethod: "cash" | "gpay" | "payroll";
  isProcessed: boolean;
  payrollRunId?: number | null;
  notes?: string | null;
  createdAt?: string | null;
};

export type Advance = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  employeeDepartment?: string | null;
  employeeDesignation?: string | null;
  employeePhone?: string | null;
  employeeEmail?: string | null;
  advanceType: "general" | "term";
  amount: number;
  purpose: string;
  status: "pending" | "approved" | "rejected" | "closed";
  approvedBy?: string | null;
  approvedAt?: string | null;
  disbursedAt?: string | null;
  repaymentStartMonth?: number | null;
  repaymentStartYear?: number | null;
  repaymentMonths?: number | null;
  emiAmount: number;
  totalRepaid: number;
  outstanding: number;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  repayments?: AdvanceRepaymentItem[];
};

export type PermissionLevel = "hidden" | "view" | "edit";

export type Role = {
  id: number;
  name: string;
  description?: string | null;
  permissions: Record<string, PermissionLevel>;
  isSystem: boolean;
  createdAt?: string | null;
};

export type HrUserItem = {
  id: number;
  username: string;
  email?: string | null;
  fullName?: string | null;
  roleId?: number | null;
  roleName?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  branchId?: number | null;
  branchName?: string | null;
  isActive: boolean;
  isSuperAdmin: boolean;
  lastLogin?: string | null;
  createdAt?: string | null;
};

export type AuditLogEntry = {
  id: number;
  userType: string;
  userId?: number | null;
  userName: string;
  action: string;
  module: string;
  recordId?: number | null;
  recordDescription?: string | null;
  oldValues?: unknown;
  newValues?: unknown;
  ipAddress?: string | null;
  createdAt?: string | null;
};

export type AuditLogsResponse = {
  total: number;
  page: number;
  pageSize: number;
  results: AuditLogEntry[];
};

// ── Query Keys ────────────────────────────────────────────────────────────────

export const getListBranchesQueryKey = () => ["/api/branches"] as const;
export const getListDesignationsQueryKey = (params?: { departmentId?: number }) =>
  ["/api/designations", params] as const;
export const getListShiftsQueryKey = () => ["/api/shifts"] as const;
export const getListEmployeeRequestsQueryKey = (params?: Record<string, string>) =>
  ["/api/employee-requests", params] as const;
export const getListAdvancesQueryKey = (params?: Record<string, string>) =>
  ["/api/advances", params] as const;
export const getListRolesQueryKey = () => ["/api/roles"] as const;
export const getListHrUsersQueryKey = () => ["/api/hr-users"] as const;
export const getListAuditLogsQueryKey = (params?: Record<string, string | number>) =>
  ["/api/audit-logs", params] as const;
export const getSearchEmployeesQueryKey = (search: string) =>
  ["/api/employees", "search", search] as const;

// ── Branches ──────────────────────────────────────────────────────────────────

export const listBranches = () => customFetch<Branch[]>("/api/branches");

export const useListBranches = <TData = Branch[]>(
  options?: UseQueryOptions<Branch[], unknown, TData>,
) =>
  useQuery<Branch[], unknown, TData>({
    queryKey: getListBranchesQueryKey(),
    queryFn: listBranches,
    ...options,
  });

export const useCreateBranch = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      code?: string;
      location?: string;
      address?: string;
      managerName?: string;
      phone?: string;
      isHeadOffice?: boolean;
      geofenceLat?: number | null;
      geofenceLng?: number | null;
      geofenceRadiusM?: number | null;
    }) =>
      customFetch<Branch>("/api/branches", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateBranch = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Branch> }) =>
      customFetch<Branch>(`/api/branches/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteBranch = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/branches/${id}`, { method: "DELETE" }),
  });

// ── Designations ──────────────────────────────────────────────────────────────

export const listDesignations = (params?: { departmentId?: number }) => {
  const qs = params?.departmentId ? `?departmentId=${params.departmentId}` : "";
  return customFetch<Designation[]>(`/api/designations${qs}`);
};

export const useListDesignations = <TData = Designation[]>(
  params?: { departmentId?: number },
  options?: UseQueryOptions<Designation[], unknown, TData>,
) =>
  useQuery<Designation[], unknown, TData>({
    queryKey: getListDesignationsQueryKey(params),
    queryFn: () => listDesignations(params),
    ...options,
  });

export const useCreateDesignation = () =>
  useMutation({
    mutationFn: (data: { title: string; departmentId?: number | null; level?: string }) =>
      customFetch<Designation>("/api/designations", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteDesignation = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/designations/${id}`, { method: "DELETE" }),
  });

// ── Shift Templates ────────────────────────────────────────────────────────────

export const listShifts = () => customFetch<ShiftTemplate[]>("/api/shifts");

export const useListShifts = <TData = ShiftTemplate[]>(
  options?: UseQueryOptions<ShiftTemplate[], unknown, TData>,
) =>
  useQuery<ShiftTemplate[], unknown, TData>({
    queryKey: getListShiftsQueryKey(),
    queryFn: listShifts,
    ...options,
  });

export const useCreateShift = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      shiftType: string;
      startTime: string;
      endTime: string;
      genderRule?: string;
      gracePeriodMinutes?: number;
      departmentId?: number | null;
      isDefault?: boolean;
    }) =>
      customFetch<ShiftTemplate>("/api/shifts", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateShift = () =>
  useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<{
        name: string;
        shiftType: string;
        startTime: string;
        endTime: string;
        genderRule: string;
        gracePeriodMinutes: number;
        departmentId: number | null;
        isDefault: boolean;
        isActive: boolean;
      }>;
    }) =>
      customFetch<ShiftTemplate>(`/api/shifts/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteShift = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/shifts/${id}`, { method: "DELETE" }),
  });

// ── Employee Requests ─────────────────────────────────────────────────────────

export const listEmployeeRequests = (params?: {
  requestType?: string;
  status?: string;
}) => {
  const qs = new URLSearchParams();
  if (params?.requestType) qs.set("requestType", params.requestType);
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString();
  return customFetch<EmployeeRequest[]>(`/api/employee-requests${q ? `?${q}` : ""}`);
};

export const useListEmployeeRequests = <TData = EmployeeRequest[]>(
  params?: { requestType?: string; status?: string },
  options?: UseQueryOptions<EmployeeRequest[], unknown, TData>,
) =>
  useQuery<EmployeeRequest[], unknown, TData>({
    queryKey: getListEmployeeRequestsQueryKey(params as Record<string, string>),
    queryFn: () => listEmployeeRequests(params),
    ...options,
  });

export const useEmployeeRequestAction = () =>
  useMutation({
    mutationFn: ({
      id,
      status,
      hrNotes,
      handledBy,
    }: {
      id: number;
      status: string;
      hrNotes?: string;
      handledBy?: string;
    }) =>
      customFetch<{ id: number; status: string }>(
        `/api/employee-requests/${id}/action`,
        {
          method: "PUT",
          body: JSON.stringify({ status, hrNotes, handledBy }),
        },
      ),
  });

// ── Advances ──────────────────────────────────────────────────────────────────

export const listAdvances = (params?: { advanceType?: string; status?: string }) => {
  const qs = new URLSearchParams();
  if (params?.advanceType) qs.set("advanceType", params.advanceType);
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString();
  return customFetch<Advance[]>(`/api/advances${q ? `?${q}` : ""}`);
};

export const useListAdvances = <TData = Advance[]>(
  params?: { advanceType?: string; status?: string },
  options?: UseQueryOptions<Advance[], unknown, TData>,
) =>
  useQuery<Advance[], unknown, TData>({
    queryKey: getListAdvancesQueryKey(params as Record<string, string>),
    queryFn: () => listAdvances(params),
    ...options,
  });

export const useCreateAdvance = () =>
  useMutation({
    mutationFn: (data: {
      employeeId: number;
      advanceType: string;
      amount: number;
      purpose?: string;
      emiAmount?: number;
      repaymentMonths?: number;
      repaymentStartMonth?: number;
      repaymentStartYear?: number;
      notes?: string;
    }) =>
      customFetch<Advance>("/api/advances", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteAdvance = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/advances/${id}`, { method: "DELETE" }),
  });

export const useUpdateAdvance = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Advance> }) =>
      customFetch<Advance>(`/api/advances/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const getAdvanceDetailQueryKey = (id: number) => ["advance-detail", id];

export const useAdvanceDetail = (id: number | null) =>
  useQuery({
    queryKey: getAdvanceDetailQueryKey(id ?? 0),
    queryFn: () => customFetch<Advance>(`/api/advances/${id}`),
    enabled: id !== null && id > 0,
  });

export const useCreateAdvanceRepayment = () =>
  useMutation({
    mutationFn: ({
      advanceId, data,
    }: {
      advanceId: number;
      data: {
        month: number;
        year: number;
        amount: number;
        paymentMethod?: string;
        notes?: string;
      };
    }) =>
      customFetch<{ repayment: AdvanceRepaymentItem; advance: Advance }>(
        `/api/advances/${advanceId}/repayments`,
        { method: "POST", body: JSON.stringify(data) },
      ),
  });

// ── Roles ─────────────────────────────────────────────────────────────────────

export const listRoles = () => customFetch<Role[]>("/api/roles");

export const useListRoles = <TData = Role[]>(
  options?: UseQueryOptions<Role[], unknown, TData>,
) =>
  useQuery<Role[], unknown, TData>({
    queryKey: getListRolesQueryKey(),
    queryFn: listRoles,
    ...options,
  });

export const useCreateRole = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      permissions?: Record<string, PermissionLevel>;
    }) =>
      customFetch<Role>("/api/roles", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteRole = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/roles/${id}`, { method: "DELETE" }),
  });

export const useUpdateRole = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Role> }) =>
      customFetch<Role>(`/api/roles/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

// ── HR Users ──────────────────────────────────────────────────────────────────

export const listHrUsers = () => customFetch<HrUserItem[]>("/api/hr-users");

export const useListHrUsers = <TData = HrUserItem[]>(
  options?: UseQueryOptions<HrUserItem[], unknown, TData>,
) =>
  useQuery<HrUserItem[], unknown, TData>({
    queryKey: getListHrUsersQueryKey(),
    queryFn: listHrUsers,
    ...options,
  });

export const useCreateHrUser = () =>
  useMutation({
    mutationFn: (data: {
      username: string;
      password: string;
      email?: string;
      fullName?: string;
      roleId?: number;
      branchId?: number | null;
    }) =>
      customFetch<HrUserItem>("/api/hr-users", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateHrUser = () =>
  useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<HrUserItem & { password?: string }>;
    }) =>
      customFetch<HrUserItem>(`/api/hr-users/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteHrUser = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/hr-users/${id}`, { method: "DELETE" }),
  });

// ── Audit Logs ────────────────────────────────────────────────────────────────

export type AuditLogStats = {
  today: number;
  thisWeek: number;
  total: number;
  byModule: Record<string, number>;
  byAction: Record<string, number>;
  recentUsers: { name: string; at: string }[];
};

export const useAuditLogStats = () =>
  useQuery<AuditLogStats>({
    queryKey: ["/api/audit-logs/stats"],
    queryFn: () => customFetch<AuditLogStats>("/api/audit-logs/stats"),
    refetchInterval: 30000,
  });

export const listAuditLogs = (params?: {
  module?: string;
  action?: string;
  userName?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}) => {
  const qs = new URLSearchParams();
  if (params?.module && params.module !== "all") qs.set("module", params.module);
  if (params?.action && params.action !== "all") qs.set("action", params.action);
  if (params?.userName) qs.set("userName", params.userName);
  if (params?.dateFrom) qs.set("dateFrom", params.dateFrom);
  if (params?.dateTo) qs.set("dateTo", params.dateTo);
  if (params?.page) qs.set("page", String(params.page));
  if (params?.pageSize) qs.set("pageSize", String(params.pageSize));
  const q = qs.toString();
  return customFetch<AuditLogsResponse>(`/api/audit-logs${q ? `?${q}` : ""}`);
};

export const useListAuditLogs = <TData = AuditLogsResponse>(
  params?: Parameters<typeof listAuditLogs>[0],
  options?: UseQueryOptions<AuditLogsResponse, unknown, TData>,
) =>
  useQuery<AuditLogsResponse, unknown, TData>({
    queryKey: getListAuditLogsQueryKey(params as Record<string, string | number>),
    queryFn: () => listAuditLogs(params),
    ...options,
  });

// ── Login Devices ─────────────────────────────────────────────────────────────

export type LoginSessionEntry = {
  id: number;
  hrUserId: number;
  username: string;
  fullName: string;
  roleName?: string | null;
  deviceLabel: string;
  ipAddress?: string | null;
  createdAt: string;
  lastSeenAt: string;
  isCurrent: boolean;
};

export type LoginSessionsResponse = {
  total: number;
  results: LoginSessionEntry[];
};

export const getListLoginSessionsQueryKey = () => ["/api/login-sessions"] as const;

export const useListLoginSessions = (
  options?: UseQueryOptions<LoginSessionsResponse>,
) =>
  useQuery<LoginSessionsResponse>({
    queryKey: getListLoginSessionsQueryKey(),
    queryFn: () => customFetch<LoginSessionsResponse>("/api/login-sessions"),
    refetchInterval: 15000,
    ...options,
  });

export const useRevokeLoginSession = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId: number) =>
      customFetch<{ message: string }>(`/api/login-sessions/${sessionId}/revoke`, {
        method: "POST",
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getListLoginSessionsQueryKey() }),
  });
};

// ── Mobile App Login ──────────────────────────────────────────────────────────

export type MobileAppLoginEntry = {
  id: number;
  employeeCode: string;
  name: string;
  department: string | null;
  designation: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  employmentType: string;
  /** Has completed Set Password — i.e. an account exists they can log in with. */
  hasPassword: boolean;
  /** Only populated for sign-ins recorded since login tracking was added. */
  lastMobileLoginAt: string | null;
  deviceCount: number;
};

export type MobileAppLoginsResponse = {
  summary: {
    total: number;
    hasAccess: number;
    noAccess: number;
    signedIn: number;
    activeNoAccess: number;
  };
  results: MobileAppLoginEntry[];
};

export type MobileAppLoginFilters = {
  access?: "all" | "has_access" | "no_access" | "signed_in" | "never_signed_in";
  status?: "all" | "active" | "inactive";
  search?: string;
};

export const getMobileAppLoginsQueryKey = (f: MobileAppLoginFilters) =>
  ["/api/mobile-app-logins", f.access ?? "all", f.status ?? "all", f.search ?? ""] as const;

export const useMobileAppLogins = (filters: MobileAppLoginFilters) =>
  useQuery<MobileAppLoginsResponse>({
    queryKey: getMobileAppLoginsQueryKey(filters),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (filters.access) qs.set("access", filters.access);
      if (filters.status) qs.set("status", filters.status);
      if (filters.search) qs.set("search", filters.search);
      return customFetch<MobileAppLoginsResponse>(`/api/mobile-app-logins?${qs}`);
    },
  });

/**
 * Downloads the currently-filtered staff list as .xlsx. Sends the same
 * filters the list is showing, so the file matches what's on screen.
 * Uses a raw fetch rather than customFetch because the response is a binary
 * attachment, not JSON.
 */
export async function downloadMobileAppLoginsExcel(filters: MobileAppLoginFilters): Promise<void> {
  const qs = new URLSearchParams();
  if (filters.access) qs.set("access", filters.access);
  if (filters.status) qs.set("status", filters.status);
  if (filters.search) qs.set("search", filters.search);

  const token = typeof localStorage !== "undefined"
    ? localStorage.getItem("uk_textile_token")
    : null;

  const response = await fetch(`${getApiOrigin()}/api/mobile-app-logins/export?${qs}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);

  // Prefer the filename the server chose so the date/filter is baked in.
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="?([^"';]+)"?/i);
  const filename = match?.[1] ?? "mobile-app-login.xlsx";

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

/**
 * Sets a new mobile-app password, or clears it so the employee runs Set
 * Password again. There is deliberately no "read password" counterpart —
 * the stored value is a bcrypt hash and cannot be reversed.
 */
export const useResetMobileAppPassword = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, password, clear }: { employeeId: number; password?: string; clear?: boolean }) =>
      customFetch<{ message: string; hasPassword: boolean }>(
        `/api/mobile-app-logins/${employeeId}/reset-password`,
        { method: "POST", body: JSON.stringify(clear ? { clear: true } : { password }) },
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/mobile-app-logins"] }),
  });
};

// ── Employee Search & Assignment ─────────────────────────────────────────────

export const useSearchEmployees = (search: string, enabled = true) =>
  useQuery({
    queryKey: getSearchEmployeesQueryKey(search),
    queryFn: () => {
      const qs = new URLSearchParams({ search, status: "active" });
      return customFetch<import("./generated/api.schemas").Employee[]>(`/api/employees?${qs}`);
    },
    enabled: enabled && search.trim().length >= 2,
    staleTime: 10_000,
  });

export const useAssignEmployee = () =>
  useMutation({
    mutationFn: ({ id, departmentId, designationId }: {
      id: number;
      departmentId?: number | null;
      designationId?: number | null;
    }) =>
      customFetch<import("./generated/api.schemas").Employee>(`/api/employees/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ departmentId, designationId }),
      }),
  });

export type ShiftAssignmentParams = {
  employeeId?: number;
  shiftId?: number;
  activeOnly?: boolean;
  employmentType?: "production" | "staff";
};

export const getShiftAssignmentsQueryKey = (params?: ShiftAssignmentParams) =>
  ["/api/shift-assignments", params] as const;

export type ShiftAssignment = {
  id: number;
  // employee
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  employmentType?: string | null;
  gender?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  designationId?: number | null;
  designationTitle?: string | null;
  // shift (embedded)
  shiftId: number;
  shiftName?: string | null;
  shiftType?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  genderRule?: string | null;
  gracePeriodMinutes?: number | null;
  // per-employee overrides
  customStartTime?: string | null;
  customEndTime?: string | null;
  saturdayOff: boolean;
  // effective (override ?? shift template)
  effectiveStartTime?: string | null;
  effectiveEndTime?: string | null;
  // assignment meta
  effectiveFrom: string;
  effectiveTo?: string | null;
  assignedBy?: string | null;
  notes?: string | null;
  createdAt?: string | null;
};

export const useListShiftAssignments = <TData = ShiftAssignment[]>(
  params?: ShiftAssignmentParams,
  options?: UseQueryOptions<ShiftAssignment[], unknown, TData>,
) =>
  useQuery<ShiftAssignment[], unknown, TData>({
    queryKey: getShiftAssignmentsQueryKey(params),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
      if (params?.shiftId) qs.set("shiftId", String(params.shiftId));
      if (params?.activeOnly) qs.set("activeOnly", "true");
      if (params?.employmentType) qs.set("employmentType", params.employmentType);
      const q = qs.toString();
      return customFetch<ShiftAssignment[]>(`/api/shift-assignments${q ? `?${q}` : ""}`);
    },
    ...options,
  });

export const useDeleteShiftAssignment = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/shift-assignments/${id}`, { method: "DELETE" }),
  });

export const useUpdateShiftAssignment = () =>
  useMutation({
    mutationFn: ({ id, data }: {
      id: number;
      data: Partial<{
        customStartTime: string | null;
        customEndTime: string | null;
        saturdayOff: boolean;
        notes: string;
        effectiveTo: string | null;
      }>;
    }) =>
      customFetch<ShiftAssignment>(`/api/shift-assignments/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export type BulkAssignPayload = {
  shiftId: number;
  effectiveFrom: string;
  employeeIds?: number[];
  departmentId?: number;
  designationId?: number;
  employmentType?: "production" | "staff";
  genderRule?: "all" | "male" | "female";
  notes?: string;
  customStartTime?: string | null;
  customEndTime?: string | null;
  saturdayOff?: boolean;
};

export const useBulkAssignShift = () =>
  useMutation({
    mutationFn: (data: BulkAssignPayload) =>
      customFetch<{ assigned: number; shiftName: string }>("/api/shift-assignments/bulk", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useSyncProductionShifts = () =>
  useMutation({
    mutationFn: () =>
      customFetch<{ synced: number; skipped: number }>("/api/shift-assignments/sync-production", {
        method: "POST",
      }),
  });

// ── Holidays ──────────────────────────────────────────────────────────────────

export type HolidayItem = {
  id: number;
  name: string;
  date: string;
  holidayType: string;
  branchId?: number | null;
  branchName?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  isRecurring: boolean;
  description?: string | null;
};

export const getListHolidaysQueryKey = (params?: { year?: number }) =>
  ["/api/holidays", params] as const;

export const useListHolidays = <TData = HolidayItem[]>(
  params?: { year?: number },
  options?: UseQueryOptions<HolidayItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.year) qs.set("year", String(params.year));
  const q = qs.toString();
  return useQuery<HolidayItem[], unknown, TData>({
    queryKey: getListHolidaysQueryKey(params),
    queryFn: () => customFetch<HolidayItem[]>(`/api/holidays${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useCreateHoliday = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      date: string;
      holidayType?: string;
      description?: string;
      isRecurring?: boolean;
    }) =>
      customFetch<HolidayItem>("/api/holidays", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteHoliday = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/holidays/${id}`, { method: "DELETE" }),
  });

// ── Attendance (enhanced) ─────────────────────────────────────────────────────

export type AttendanceSummary = {
  date: string;
  totalEmployees: number;
  productionTotal: number;
  staffTotal: number;
  presentToday: number;
  biometricPresent: number;
  manualPresent: number;
  productionPresent: number;
  staffPresent: number;
  notPunched: number;
  productionNotPunched: number;
  staffNotPunched: number;
  yesterday: {
    date: string;
    present: number;
    absent: number;
    late: number;
    onLeave: number;
  };
};

export type AttendanceDailyRecord = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  employmentType: "production" | "staff";
  status: "present" | "manual" | "on_leave" | "absent";
  firstPunch?: string | null;
  lastPunch?: string | null;
  source?: string | null;
  sourceLabel?: string | null;
  totalPunches: number;
};

export type AttendanceMonthlyTrendItem = {
  date: string;
  day: number;
  label: string;
  present: number;
  absent: number;
};

export type AttendanceEmployeeHistory = {
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType: string;
  };
  month: number;
  year: number;
  summary: { present: number; halfShift: number; absent: number; onLeave: number; late: number };
  records: {
    date: string;
    day: string;
    status: string;
    isLate: boolean;
    isHalfShift: boolean;
    present: boolean;
    firstPunch?: string | null;
    lastPunch?: string | null;
    totalPunches: number;
    punches: { time: string; type: string; source: string; sourceLabel: string }[];
    hoursWorked?: string | null;
    source?: string | null;
    sourceLabel?: string | null;
    notes?: string | null;
    leaveType?: string | null;
  }[];
  totalPresent: number;
  totalAbsent: number;
};

export const getAttendanceSummaryQueryKey = (date?: string) =>
  ["/api/attendance/summary", date] as const;

export const useAttendanceSummary = (date?: string) =>
  useQuery<AttendanceSummary>({
    queryKey: getAttendanceSummaryQueryKey(date),
    queryFn: () => {
      const q = date ? `?date=${date}` : "";
      return customFetch<AttendanceSummary>(`/api/attendance/summary${q}`);
    },
    refetchInterval: 60_000,
  });

export interface AttendanceCompanySummary {
  date: string;
  totalEmployees: number;
  present: number;
  halfShift: number;
  absent: number;
  onLeave: number;
  late: number;
  permission: number;
  totalShiftsEarned: number;
}

export const getAttendanceCompanySummaryQueryKey = () =>
  ["/api/attendance/company-summary"] as const;

export const useAttendanceCompanySummary = () =>
  useQuery<AttendanceCompanySummary>({
    queryKey: getAttendanceCompanySummaryQueryKey(),
    queryFn: () => customFetch<AttendanceCompanySummary>("/api/attendance/company-summary"),
    refetchInterval: 60_000,
  });

export const getAttendanceDailyQueryKey = (date?: string) =>
  ["/api/attendance/daily", date] as const;

export const useAttendanceDaily = (date?: string) =>
  useQuery<AttendanceDailyRecord[]>({
    queryKey: getAttendanceDailyQueryKey(date),
    queryFn: () => {
      const q = date ? `?date=${date}` : "";
      return customFetch<AttendanceDailyRecord[]>(`/api/attendance/daily${q}`);
    },
    refetchInterval: 60_000,
  });

export const getAttendanceMonthlyTrendQueryKey = (year?: number, month?: number) =>
  ["/api/attendance/monthly-trend", year, month] as const;

export const useAttendanceMonthlyTrend = (year?: number, month?: number) =>
  useQuery<AttendanceMonthlyTrendItem[]>({
    queryKey: getAttendanceMonthlyTrendQueryKey(year, month),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (year) qs.set("year", String(year));
      if (month) qs.set("month", String(month));
      const q = qs.toString();
      return customFetch<AttendanceMonthlyTrendItem[]>(`/api/attendance/monthly-trend${q ? `?${q}` : ""}`);
    },
  });

export const getAttendanceEmployeeHistoryQueryKey = (id: number, month?: number, year?: number) =>
  ["/api/attendance/employee", id, month, year] as const;

export const useAttendanceEmployeeHistory = (
  id: number | null,
  month?: number,
  year?: number,
) =>
  useQuery<AttendanceEmployeeHistory>({
    queryKey: getAttendanceEmployeeHistoryQueryKey(id ?? 0, month, year),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (month) qs.set("month", String(month));
      if (year) qs.set("year", String(year));
      const q = qs.toString();
      return customFetch<AttendanceEmployeeHistory>(`/api/attendance/employee/${id}${q ? `?${q}` : ""}`);
    },
    enabled: !!id,
  });

export const useCreateManualAttendance = () =>
  useMutation({
    mutationFn: (data: {
      employeeId: number;
      date: string;
      punchTime?: string;
      punchType?: string;
      notes?: string;
      hoursWorked?: number;
    }) =>
      customFetch<{ ok: boolean; attendanceId: number; logId?: number }>("/api/attendance/manual", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

// ── Employee Permissions ───────────────────────────────────────────────────────

export type PermissionItem = {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  date: string;
  permissionTime?: string | null;
  reason?: string | null;
  status: string;
  hrComment?: string | null;
  approvedBy?: string | null;
  approverRole?: string | null;
  createdAt?: string | null;
  monthlyUsed?: number | null;
  monthlyLimit: number;
};

export const getListPermissionsQueryKey = (params?: {
  employeeId?: number;
  status?: string;
  month?: number;
  year?: number;
}) => ["/api/permissions", params] as const;

export const useListPermissions = <TData = PermissionItem[]>(
  params?: { employeeId?: number; status?: string; month?: number; year?: number },
  options?: UseQueryOptions<PermissionItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.status) qs.set("status", params.status);
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  const q = qs.toString();
  return useQuery<PermissionItem[], unknown, TData>({
    queryKey: getListPermissionsQueryKey(params),
    queryFn: () => customFetch<PermissionItem[]>(`/api/permissions${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useCreatePermission = () =>
  useMutation({
    mutationFn: (data: {
      employeeId: number;
      date: string;
      permissionTime?: string;
      reason?: string;
      status?: string;
    }) =>
      customFetch<PermissionItem>("/api/permissions", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdatePermissionStatus = () =>
  useMutation({
    // approvedBy is never client-sendable -it's always server-derived from
    // the logged-in HR user (a client-supplied name could be spoofed).
    mutationFn: ({ id, data }: { id: number; data: { status: string; hrComment?: string } }) =>
      customFetch<PermissionItem>(`/api/permissions/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const useDeletePermission = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/permissions/${id}`, { method: "DELETE" }),
  });

export const useDeleteLeaveRequest = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/leave-requests/${id}`, { method: "DELETE" }),
  });

// ── Biometric Sync ────────────────────────────────────────────────────────────

export type SyncResult = {
  ok: boolean;
  created?: number;
  output?: string;
  syncedAt?: string;
  error?: string;
  unmatchedDeviceIds?: string[];
  deviceErrors?: string[];
};

// ── Report Log types ──────────────────────────────────────────────────────────

export type ShiftLogEntry = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  date: string;
  assignedShift: { name: string; startTime: string | null; endTime: string | null; gracePeriodMinutes: number } | null;
  punch1?: string | null;   // morning IN
  punch2?: string | null;   // lunch OUT
  punch3?: string | null;   // lunch IN
  punch4?: string | null;   // evening OUT
  totalPunches: number;
  status: "present" | "half_shift" | "absent" | "on_leave" | "holiday";
  isLate: boolean;
  isHalfShift: boolean;
  earlyLeave: boolean;
  shiftsCompleted: string;  // Decimal as string, e.g. "1.00"
  lateMorning: boolean;
  lateReturn: boolean;
  lateReason?: string | null;
  casualLeave: { status: "pending" | "approved" | "rejected"; reason: string | null } | null;
  permission: { status: "pending" | "approved" | "rejected"; time: string | null; reason: string | null } | null;
  leave: { status: "pending" | "approved" | "rejected"; type: string | null; reason: string | null } | null;
  source: "auto" | "manual";
};

export type MonthlySummaryRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  totalDays: number;
  workingDays: number;
  effectiveDays: string;   // Decimal as string
  presentDays: number;
  halfShiftDays: number;
  absentDays: number;
  onLeaveDays: number;
  casualLeaveCount: number;
  permissionCount: number;
  holidays: number;
  lateCount: number;
  totalShifts: string;     // Decimal as string
};

export type ReportLogSummaryResponse = {
  month: number;
  year: number;
  employees: MonthlySummaryRow[];
};

export type ReportLogDetailResponse = {
  month: number;
  year: number;
  employee: {
    id: number;
    code: string;
    name: string;
    department: string | null;
    designation: string | null;
  };
  days: ShiftLogEntry[];
};

export type LateSummaryEmployee = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  totalShifts: string;
  halfShiftDays: number;
  totalLateCount: number;
  permissionsUsed: number;
  billableLateCount: number;
  shiftDeductions: string;
  salaryDeductionAmount: string;
};

export type EmployeeShiftMonthlyStats = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  employmentType?: string | null;
  month: number;
  year: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  halfShiftDays: number;
  fullShiftDays: number;
  totalEffectiveShifts: string;
  lateMorningDays: number;
  lateReturnDays: number;
  totalLateCount: number;
  summary?: {
    totalShifts: string;
    totalLateCount: number;
    billableLateCount: number;
    shiftDeductions: string;
    salaryDeductionAmount: string;
  } | null;
  dailyLogs: {
    date: string;
    day: string;
    status: "present" | "absent" | "on_leave" | "holiday" | "future";
    firstPunch?: string | null;
    lastPunch?: string | null;
    totalPunches: number;
    source?: string | null;
    leaveType?: string | null;
    shiftsCompleted?: string | null;
    isHalfShift: boolean;
    lateMorning: boolean;
    lateReturn: boolean;
  }[];
};

export type LateSummaryResponse = {
  month: number;
  year: number;
  employees: LateSummaryEmployee[];
};

export type SyncBiometricMode = "day" | "week" | "month" | "all";
export type SyncDeviceId = number | "all" | "env" | (number | "env")[];

export const useSyncBiometric = () =>
  useMutation({
    mutationFn: (params: { mode?: SyncBiometricMode; deviceId?: SyncDeviceId } | SyncBiometricMode = "day") => {
      const { mode = "day", deviceId } = typeof params === "string" ? { mode: params } : params;
      return customFetch<SyncResult>("/api/attendance/sync-biometric", {
        method: "POST",
        body: JSON.stringify({ mode, deviceId }),
      });
    },
  });

// ── Biometric Sync Pipeline Progress ──────────────────────────────────────────

export type SyncDeviceStatus = "pending" | "syncing" | "completed" | "failed";
export type SyncProgressDevice = { id: number | string; label: string; status: SyncDeviceStatus };
export type SyncProgress = {
  stage: "idle" | "running" | "completed";
  devices: SyncProgressDevice[];
  startedAt: string | null;
  finishedAt: string | null;
};

export const useSyncBiometricProgress = (enabled: boolean) =>
  useQuery<SyncProgress>({
    queryKey: ["/api/attendance/sync-biometric-progress"],
    queryFn: () => customFetch<SyncProgress>("/api/attendance/sync-biometric-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    // The pipeline only cares about the freshest snapshot -never serve a stale one.
    staleTime: 0,
  });

export type ReportLogSummaryParams = {
  month: number;
  year: number;
  department?: number;
  search?: string;
};

export type ReportLogDetailParams = {
  month: number;
  year: number;
  employeeId: number;
};

const reportLogQueryString = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  return qs.toString();
};

export const getReportLogSummaryQueryKey = (params: ReportLogSummaryParams) =>
  ["/api/attendance/report-log", "summary", params] as const;

// Mode A -one row per employee for the month, optionally narrowed by
// department and/or an employee code/name search.
export const useAttendanceReportSummary = (params: ReportLogSummaryParams, enabled = true) =>
  useQuery<ReportLogSummaryResponse>({
    queryKey: getReportLogSummaryQueryKey(params),
    queryFn: () => customFetch<ReportLogSummaryResponse>(
      `/api/attendance/report-log?${reportLogQueryString(params)}`,
    ),
    enabled,
  });

export const getReportLogDetailQueryKey = (params: ReportLogDetailParams) =>
  ["/api/attendance/report-log", "detail", params] as const;

// Mode B -one employee's full day-by-day month.
export const useAttendanceReportDetail = (params: ReportLogDetailParams, enabled = true) =>
  useQuery<ReportLogDetailResponse>({
    queryKey: getReportLogDetailQueryKey(params),
    queryFn: () => customFetch<ReportLogDetailResponse>(
      `/api/attendance/report-log?${reportLogQueryString(params)}`,
    ),
    enabled,
  });

export type AttendanceSearchPunch = {
  time: string;
  type: "IN" | "OUT";
  source: string;
  sourceLabel: string;
} | null;

export type AttendanceSearchResult = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  shift: { name: string; startTime: string | null; endTime: string | null; gracePeriodMinutes: number | null } | null;
  punches: AttendanceSearchPunch[];
  totalPunches: number;
};

export const useAttendanceSearch = (query: string, date: string, enabled = true) =>
  useQuery<{ date: string; query: string; count: number; results: AttendanceSearchResult[] }>({
    queryKey: ["/api/attendance/search", query, date],
    queryFn: () => customFetch(`/api/attendance/search?query=${encodeURIComponent(query)}&date=${date}`),
    enabled: enabled && query.trim().length > 0,
  });

// One employee's full day-by-day attendance across an arbitrary range —
// same punch shape as attendance_search above, plus each day's computed
// status/late flag and any approved Leave or Permission covering that date.
export type AttendanceSearchDay = {
  date: string;
  status: "present" | "half_shift" | "absent" | "on_leave" | "holiday";
  isLate: boolean;
  isHalfShift: boolean;
  totalPunches: number;
  punches: AttendanceSearchPunch[];
  casualLeave: { status: string; reason: string | null } | null;
  leave: { status: string; type: string; reason: string | null } | null;
  permission: { status: string; time: string | null; reason: string | null } | null;
};

export type AttendanceSearchRangeResponse = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  shift: { name: string; startTime: string | null; endTime: string | null; gracePeriodMinutes: number | null } | null;
  startDate: string;
  endDate: string;
  days: AttendanceSearchDay[];
};

export const useAttendanceSearchRange = (employeeId: number | null, startDate: string, endDate: string, enabled = true) =>
  useQuery<AttendanceSearchRangeResponse>({
    queryKey: ["/api/attendance/search/range", employeeId, startDate, endDate],
    queryFn: () => customFetch(
      `/api/attendance/search/range?employeeId=${employeeId}&startDate=${startDate}&endDate=${endDate}`,
    ),
    enabled: enabled && employeeId != null && !!startDate && !!endDate,
  });

export const useComputeShiftLogs = () =>
  useMutation({
    mutationFn: (data: { date?: string; month?: number; year?: number; employeeId?: number }) =>
      customFetch<{ ok: boolean; computed: number }>("/api/attendance/compute-shifts", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const getLateSummaryQueryKey = (month: number, year: number) =>
  ["/api/attendance/late-summary", month, year] as const;

export const useAttendanceLateSummary = (month: number, year: number, enabled = true) =>
  useQuery<LateSummaryResponse>({
    queryKey: getLateSummaryQueryKey(month, year),
    queryFn: () =>
      customFetch<LateSummaryResponse>(`/api/attendance/late-summary?month=${month}&year=${year}`),
    enabled,
  });

export const useEmployeeShiftMonthlyStats = (
  employeeId: number | null,
  month: number,
  year: number,
  enabled = true,
) =>
  useQuery<EmployeeShiftMonthlyStats>({
    queryKey: ["/api/attendance/employee-shift-stats", employeeId, month, year],
    queryFn: () =>
      customFetch<EmployeeShiftMonthlyStats>(
        `/api/attendance/employee-shift-stats?employee_id=${employeeId}&month=${month}&year=${year}`,
      ),
    enabled: !!employeeId && enabled,
  });

// ── Salary Slips ──────────────────────────────────────────────────────────────

export type SlipLeaveBalance = {
  leaveType: string;
  leaveCode: string;
  allocated: number;
  used: number;
  remaining: number;
};

export type SalarySlipItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  departmentName?: string | null;
  designationTitle?: string | null;
  fatherName?: string;
  motherName?: string;
  joinDate?: string;
  pfNumber?: string;
  esiNumber?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankName?: string;
  employmentType?: string;
  payrollRunId?: number | null;
  month: number;
  year: number;
  weekNumber?: number | null;
  slipNumber: string;
  basic: number;
  hra: number;
  allowances: number;
  incentives: number;
  bonuses: number;
  otAmount: number;
  grossSalary: number;
  pfDeduction: number;
  esiDeduction: number;
  advanceDeduction: number;
  otherDeductions: number;
  totalDeductions: number;
  netSalary: number;
  workingDays: number;
  presentDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  lateDays: number;
  completedSessions: number;
  leaveBalances?: SlipLeaveBalance[];
  breakdownDetails?: PayrollBreakdown | null;
  // Company/slip settings (injected by backend)
  slipCompanyName?: string;
  slipCompanyAddress?: string;
  minWageRate?: number;
  signatureImage?: string;
  generatedAt?: string | null;
  emailedAt?: string | null;
};

// ── Payroll Breakdown (full traceability) ─────────────────────────────────────

export type PayrollBreakdownDay = {
  date: string;
  day: string;
  // staff-only fields
  status?: "present" | "absent" | "paid_leave" | "unpaid_leave";
  isLate?: boolean;
  // Set only when isLate/half-shift-late is true — the specific rule and
  // times that fired it, e.g. "Late morning (Without Permission): arrived
  // 09:40, deadline 09:15". See AttendanceDayRecord.late_reason.
  lateReason?: string | null;
  // True when the day's lateness is specifically a Without Permission
  // occurrence (see Settings → Late Detection) rather than ordinary Late
  // Attendance — lateReason explains which.
  withoutPermission?: boolean;
  isHalfShift?: boolean;
  shiftsCompleted?: number;
  firstIn?: string | null;
  lastOut?: string | null;
  leaveType?: string | null;
  // production-only fields (legacy session-based payroll)
  sessions?: { sessionId: number; sessionName: string; completed: boolean; rate: number }[];
  totalSessions?: number;
  sessionAmount?: number;
  present?: boolean;
  // production-only fields (current shift-based payroll)
  shiftsEarned?: number;
  firstPunch?: string | null;
  lastPunch?: string | null;
};

export type PayrollBreakdown = {
  type: "staff" | "production";
  // Which attendance calculation produced this payroll (strict | simple)
  attendanceMode?: "strict" | "simple" | null;
  simpleHalfShiftCutoff?: string | null;
  shiftPunctualityWindowMinutes?: number | null;
  // staff
  shift?: {
    id?: number | null;
    name: string;
    startTime: string;
    gracePeriodMinutes: number;
    saturdayOff: boolean;
  };
  // production
  weekNumber?: number;
  dateFrom?: string;
  dateTo?: string;
  // legacy session-based payroll only
  sessionConfigs?: {
    id: number; name: string; startTime: string; endTime: string; minCheckout: string; rate: number;
  }[];
  // current shift-based payroll only
  salaryPerShift?: number;
  days: PayrollBreakdownDay[];
  summary: {
    // staff
    totalWorkingDays?: number;
    presentDays?: number;
    paidLeaveDays?: number;
    unpaidLeaveDays?: number;
    absentDays?: number;
    lateDays?: number;
    withoutPermissionDays?: number;
    halfShiftDays?: number;
    fullShiftDays?: number;
    effectivePaidDays?: number;
    // production
    totalDays?: number;
    daysWorked?: number;
    daysAbsent?: number;
    totalSessions?: number;
    totalShifts?: number;
  };
  earnings: {
    monthlySalary?: number;
    dailyRate?: number;
    effectiveDays?: number;
    basic?: number;
    hra?: number;
    allowances?: number;
    grossSalary: number;
    totalSessions?: number;
    totalShifts?: number;
    salaryPerShift?: number;
  };
  deductions: {
    pf?: number;
    pfRate?: number;
    esi?: number;
    esiRate?: number;
    // Salary-range rule applied to production PF/EF (null/absent = flat rates)
    pfEfRule?: { label: string; pfRate: number; efRate: number } | null;
    advances: number;
    advanceDetails: { advanceId: number; repaymentId: number; amount: number; notes?: string | null }[];
    lateShiftPenalty?: number;
    lateSummary?: {
      totalLateCount: number;
      permissionsUsed: number;
      billableLateCount: number;
      shiftDeductions: number;
    } | null;
    withoutPermissionPenalty?: number;
    withoutPermissionSummary?: {
      totalCount: number;
      freeAllowanceUsed: number;
      billableCount: number;
      shiftDeductions: number;
    } | null;
    total: number;
  };
  netSalary: number;
};

export type PayrollBreakdownResponse = {
  payrollId: number;
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType: string;
    salary: number;
  };
  month: number;
  year: number;
  weekNumber?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  salaryMode: string;
  status: string;
  summary: {
    grossSalary: number;
    deductions: number;
    bonus: number;
    netSalary: number;
  };
  breakdown: PayrollBreakdown | null;
};

export const getListSalarySlipsQueryKey = (params?: {
  employeeId?: number;
  month?: number;
  year?: number;
  weekNumber?: number;
  employmentType?: string;
}) => ["/api/salary-slips", params] as const;

export const useListSalarySlips = <TData = SalarySlipItem[]>(
  params?: { employeeId?: number; month?: number; year?: number; weekNumber?: number; employmentType?: string },
  options?: UseQueryOptions<SalarySlipItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId)     qs.set("employeeId",      String(params.employeeId));
  if (params?.month)          qs.set("month",            String(params.month));
  if (params?.year)           qs.set("year",             String(params.year));
  if (params?.weekNumber)     qs.set("weekNumber",       String(params.weekNumber));
  if (params?.employmentType) qs.set("employmentType",   params.employmentType);
  const q = qs.toString();
  return useQuery<SalarySlipItem[], unknown, TData>({
    queryKey: getListSalarySlipsQueryKey(params),
    queryFn: () => customFetch<SalarySlipItem[]>(`/api/salary-slips${q ? `?${q}` : ""}`),
    ...options,
  });
};

// ── Payroll Runs ──────────────────────────────────────────────────────────────

export type PayrollRunItem = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  email?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  salaryMode: string;
  month: number;
  year: number;
  weekNumber?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
  completedSessions?: number | null;
  otHours: number;
  otAmount: number;
  baseSalary: number;
  grossSalary: number;
  deductions: number;
  bonus: number;
  finalSalary: number;
  status: string;
  notes?: string | null;
  createdAt?: string | null;
};

export const getListPayrollRunsQueryKey = (params?: {
  employeeId?: number;
  month?: number;
  year?: number;
  status?: string;
}) => ["/api/payroll", params] as const;

export const useListPayrollRuns = <TData = PayrollRunItem[]>(
  params?: { employeeId?: number; month?: number; year?: number; status?: string },
  options?: UseQueryOptions<PayrollRunItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString();
  return useQuery<PayrollRunItem[], unknown, TData>({
    queryKey: getListPayrollRunsQueryKey(params),
    queryFn: () => customFetch<PayrollRunItem[]>(`/api/payroll${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useGeneratePayroll = () =>
  useMutation({
    mutationFn: (data: {
      month: number;
      year: number;
      runType?: "monthly" | "biweekly" | "all";
      weekNumber?: number;
    }) =>
      customFetch<{ message: string; generated: number; skipped: number; skippedDetails: { employeeId: number; name: string; reason: string }[] }>("/api/payroll/generate", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

// ── Payroll Skip Check (read-only, on-demand -no generation required) ─────

export type PayrollSkipReason = {
  employeeId: number;
  employeeCode: string;
  name: string;
  reason: string;
};

export type PayrollSkipCheckResult = {
  totalChecked: number;
  skippedCount: number;
  skipped: PayrollSkipReason[];
};

export const getPayrollSkipCheckQueryKey = (params: {
  month: number; year: number; runType: "monthly" | "biweekly"; weekNumber?: number;
}) => ["/api/payroll/skip-check", params] as const;

export const usePayrollSkipCheck = (
  params: { month: number; year: number; runType: "monthly" | "biweekly"; weekNumber?: number } | null,
) => {
  const qs = new URLSearchParams();
  if (params) {
    qs.set("month", String(params.month));
    qs.set("year", String(params.year));
    qs.set("runType", params.runType);
    if (params.weekNumber) qs.set("weekNumber", String(params.weekNumber));
  }
  return useQuery<PayrollSkipCheckResult>({
    queryKey: getPayrollSkipCheckQueryKey(params ?? { month: 0, year: 0, runType: "monthly" }),
    queryFn: () => customFetch<PayrollSkipCheckResult>(`/api/payroll/skip-check?${qs.toString()}`),
    enabled: !!params,
  });
};

// ── Payroll Generation Progress ─────────────────────────────────────────────

export type PayrollGenerateProgress = {
  stage: "idle" | "running" | "completed";
  total: number;
  completed: number;
  generated: number;
  skipped: number;
  currentEmployee: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const useGeneratePayrollProgress = (enabled: boolean) =>
  useQuery<PayrollGenerateProgress>({
    queryKey: ["/api/payroll/generate-progress"],
    queryFn: () => customFetch<PayrollGenerateProgress>("/api/payroll/generate-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    // The pipeline only cares about the freshest snapshot -never serve a stale one.
    staleTime: 0,
  });

// ── Salary Slip Bulk Download/Email Progress ──────────────────────────────────

export type SalarySlipBulkProgress = {
  stage: "idle" | "running" | "completed";
  kind: "pdf" | "email" | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentEmployee: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const useSalarySlipBulkProgress = (enabled: boolean) =>
  useQuery<SalarySlipBulkProgress>({
    queryKey: ["/api/salary-slips/bulk-progress"],
    queryFn: () => customFetch<SalarySlipBulkProgress>("/api/salary-slips/bulk-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    staleTime: 0,
  });

export type SalarySlipBulkEmailResult = {
  ok: boolean;
  sent: number;
  failed: number;
  failures: { employeeName: string; employeeCode: string; error: string }[];
};

// ── WhatsApp (Settings, single-send mutations, bulk-send progress) ─────────

export type WhatsAppDocumentType =
  | "salary_slip" | "id_card" | "offer_letter" | "experience_letter" | "resignation_letter" | "other";

export type WhatsAppStatus = { configured: boolean; phoneNumberId: string | null; apiVersion: string };

export const useWhatsAppStatus = () =>
  useQuery<WhatsAppStatus>({
    queryKey: ["/api/whatsapp/status"],
    queryFn: () => customFetch<WhatsAppStatus>("/api/whatsapp/status"),
  });

export type WhatsAppTemplate = {
  documentType: WhatsAppDocumentType;
  metaTemplateName: string;
  metaLanguageCode: string;
  variableNote: string;
  isEnabled: boolean;
};

export const useWhatsAppTemplates = () =>
  useQuery<WhatsAppTemplate[]>({
    queryKey: ["/api/whatsapp/templates"],
    queryFn: () => customFetch<WhatsAppTemplate[]>("/api/whatsapp/templates"),
  });

export const useUpdateWhatsAppTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ documentType, data }: { documentType: WhatsAppDocumentType; data: Partial<WhatsAppTemplate> }) =>
      customFetch<WhatsAppTemplate>(`/api/whatsapp/templates/${documentType}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/whatsapp/templates"] }),
  });
};

// Single-document sends -one mutation per document type, same {ok, sentTo}
// shape as the equivalent email mutations above.
export const useWhatsAppSalarySlip = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/salary-slips/${id}/whatsapp`, { method: "POST" }),
  });

export const useWhatsAppIdCard = () =>
  useMutation({
    mutationFn: (employeeId: number) =>
      customFetch<{ ok: boolean; sentTo: string }>("/api/idcard/whatsapp", {
        method: "POST",
        body: JSON.stringify({ employeeId }),
      }),
  });

export const useWhatsAppOfferLetter = () =>
  useMutation({
    mutationFn: (employeeId: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/employees/${employeeId}/offer-letter/whatsapp`, { method: "POST" }),
  });

export const useWhatsAppExperienceLetter = () =>
  useMutation({
    mutationFn: ({ employeeId, lastWorkingDate }: { employeeId: number; lastWorkingDate?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/employees/${employeeId}/experience-letter/whatsapp`, {
        method: "POST",
        body: JSON.stringify({ lastWorkingDate }),
      }),
  });

export const useWhatsAppResignation = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/recruitment/resignations/${id}/whatsapp`, { method: "POST" }),
  });

export const useWhatsAppEmployeeDocument = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/employee-documents/${id}/whatsapp`, { method: "POST" }),
  });

// Bulk WhatsApp send (Salary Slip only, mirroring salary_slip_bulk_email 1:1)
export type WhatsAppBulkFailure = { employeeName: string; employeeCode: string; error: string };

export type WhatsAppBulkProgress = {
  stage: "idle" | "running" | "completed";
  documentType: WhatsAppDocumentType | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentEmployee: string | null;
  failures: WhatsAppBulkFailure[];
  startedAt: string | null;
  finishedAt: string | null;
};

export const useWhatsAppBulkProgress = (enabled: boolean) =>
  useQuery<WhatsAppBulkProgress>({
    queryKey: ["/api/salary-slips/bulk-whatsapp-progress"],
    queryFn: () => customFetch<WhatsAppBulkProgress>("/api/salary-slips/bulk-whatsapp-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    staleTime: 0,
  });

export type WhatsAppBulkResult = { ok: boolean; sent: number; failed: number; failures: WhatsAppBulkFailure[] };

export const useUpdatePayrollRecord = () =>
  useMutation({
    mutationFn: ({ id, data }: {
      id: number;
      data: Partial<{ status: string; bonus: number; deductions: number; notes: string }>;
    }) =>
      customFetch<PayrollRunItem>(`/api/payroll/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const getPayrollBreakdownQueryKey = (id: number) =>
  ["/api/payroll", id, "breakdown"] as const;

export const usePayrollBreakdown = (id: number | null) =>
  useQuery<PayrollBreakdownResponse>({
    queryKey: getPayrollBreakdownQueryKey(id ?? 0),
    queryFn: () => customFetch<PayrollBreakdownResponse>(`/api/payroll/${id}/breakdown`),
    enabled: !!id,
  });

// ── Production Payroll (period-driven, fully separate from Staff Payroll) ─────
// Periods come entirely from Settings → Payroll → Production
// (PayrollSettingsItem.prodPeriod*); these endpoints never take a
// month/year/weekNumber input -only an optional explicit periodStart/
// periodEnd pair for backfilling a past period.

export type ProductionNextPeriod = {
  periodStart: string;
  periodEnd: string;
  periodEnded: boolean;
  frequency: PayrollSettingsItem["prodPeriodFrequency"];
  style: PayrollSettingsItem["prodPeriodStyle"];
};

export const getProductionNextPeriodQueryKey = () => ["/api/payroll/production/next-period"] as const;

export const useProductionNextPeriod = () =>
  useQuery<ProductionNextPeriod>({
    queryKey: getProductionNextPeriodQueryKey(),
    queryFn: () => customFetch<ProductionNextPeriod>("/api/payroll/production/next-period"),
  });

export const getProductionSkipCheckQueryKey = (params: { periodStart: string; periodEnd: string } | null) =>
  ["/api/payroll/production/skip-check", params] as const;

export const useProductionSkipCheck = (params: { periodStart: string; periodEnd: string } | null) => {
  const qs = new URLSearchParams();
  if (params) {
    qs.set("periodStart", params.periodStart);
    qs.set("periodEnd", params.periodEnd);
  }
  return useQuery<PayrollSkipCheckResult & { periodStart: string; periodEnd: string }>({
    queryKey: getProductionSkipCheckQueryKey(params),
    queryFn: () =>
      customFetch<PayrollSkipCheckResult & { periodStart: string; periodEnd: string }>(
        `/api/payroll/production/skip-check?${qs.toString()}`,
      ),
    enabled: !!params,
  });
};

export const useGenerateProductionPayroll = () =>
  useMutation({
    mutationFn: (data?: { periodStart: string; periodEnd: string }) =>
      customFetch<{
        message: string;
        periodStart: string;
        periodEnd: string;
        generated: number;
        skipped: number;
        skippedDetails: { employeeId: number; name: string; reason: string }[];
      }>("/api/payroll/production/generate", {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });

export type ProductionPayrollItem = PayrollRunItem & {
  employeeCode: string;
  bankAccount: string;
  bankIfsc: string;
  bankName: string;
  email: string;
  departmentId: number | null;
  departmentName: string | null;
};

export const getListProductionPayrollQueryKey = (params?: {
  employeeId?: number;
  status?: string;
  limit?: number;
}) => ["/api/payroll/production", params] as const;

export const useListProductionPayroll = <TData = ProductionPayrollItem[]>(
  params?: { employeeId?: number; status?: string; limit?: number },
  options?: UseQueryOptions<ProductionPayrollItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return useQuery<ProductionPayrollItem[], unknown, TData>({
    queryKey: getListProductionPayrollQueryKey(params),
    queryFn: () => customFetch<ProductionPayrollItem[]>(`/api/payroll/production${q ? `?${q}` : ""}`),
    ...options,
  });
};

// ── Session Configs ───────────────────────────────────────────────────────────

export type SessionConfigItem = {
  id: number;
  name: string;
  startTime: string;
  endTime: string;
  minimumCheckoutTime?: string | null;
  payAmount: number;
  isOvertime: boolean;
  order: number;
};

export const getSessionConfigsQueryKey = () => ["/api/session-configs"] as const;

export const useSessionConfigs = () =>
  useQuery<SessionConfigItem[]>({
    queryKey: getSessionConfigsQueryKey(),
    queryFn: () => customFetch<SessionConfigItem[]>("/api/session-configs"),
  });

export const useCreateSessionConfig = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      startTime: string;
      endTime: string;
      minimumCheckoutTime?: string | null;
      payAmount: number;
      isOvertime?: boolean;
      order?: number;
    }) =>
      customFetch<SessionConfigItem>("/api/session-configs", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateSessionConfig = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<SessionConfigItem> }) =>
      customFetch<SessionConfigItem>(`/api/session-configs/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteSessionConfig = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/session-configs/${id}`, { method: "DELETE" }),
  });

// ── Payroll Settings (singleton -PF/ESI rates) ───────────────────────────────

export type PayrollSettingsItem = {
  // Company profile -drives branding across the whole portal
  companyName: string;
  companyTagline: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string;
  companyGstin: string;
  companyPan: string;
  companyAddress: string;
  companyRegistration: string;
  // Staff deductions
  pfRate: number;
  esiRate: number;
  esiApplicableBelow: number;
  // Production deductions
  prodPfRate: number;
  prodEsiRate: number;
  prodEsiApplicableBelow: number;
  // General
  payDay: number;
  productionPayType: string;
  defaultSalaryPerShift?: number;
  // Production Payroll period configuration (Settings → Payroll → Production)
  prodPeriodFrequency: "weekly" | "2weeks" | "3weeks" | "monthly";
  prodPeriodStyle: "calendar_month" | "weekday_anchored" | "custom_recurring";
  prodPeriodWeekdayAnchor?: "mon_sat" | "sun_sat" | null;
  prodPeriodAnchorDate?: string | null;
  prodPeriodCustomDays?: number | null;
  // Production attendance mode + Late Detection (Settings → Payroll → Production)
  prodAttendanceMode: "simple" | "strict";
  prodLateDetectionEnabled?: boolean;
  prodLateFreeAllowance?: number;
  prodLateDeductionSlabs?: { fromLates: number; deductionShifts: number }[];
  // Salary slip header & signature
  slipCompanyName: string;
  slipCompanyAddress: string;
  minWageRate: number;
  signatureImage: string | null;
  // Resignation letter assets
  companyLogo: string | null;
  authorizedSignature: string | null;
  // Attendance calculation mode
  attendanceMode: "strict" | "simple";
  simpleHalfShiftCutoff: string;
  simpleGraceMinutes: number;
  shiftPunctualityWindowMinutes: number;
  lastPunchPostShiftGraceHours: number;
  firstPunchPreShiftBufferHours: number;
  // Production attendance windows (1.5-shift day)
  prodFirstHalfStart: string;
  prodFirstHalfEnd: string;
  prodSecondHalfStart: string;
  prodSecondHalfEnd: string;
  prodExtraStart: string;
  prodExtraEnd: string;
  // Half Shift late reference (staff) -a Half Shift day is only additionally
  // flagged Late when the first punch is strictly after this time.
  halfShiftLateReferenceTime?: string;
  // Defaults pre-filled into a NEW shift; Manage Shift still owns the real
  // per-shift times (including start/end), so these never retro-change
  // existing shifts.
  defaultShiftGraceMinutes?: number;
  defaultShiftFirstHalfEnd?: string;
  defaultShiftLunchDurationMinutes?: number;
  defaultShiftLunchGraceMinutes?: number;
  // Late Detection policy -lates and approved permissions share one pool.
  lateFreeAllowance?: number;
  lateDeductionSlabs?: { fromLates: number; deductionShifts: number }[];
  // Without Permission policy -separate pool: late-in/early-out occurrences
  // inside the 1-hour permission window with no approved Permission covering
  // them.
  withoutPermissionFreeAllowance?: number;
  withoutPermissionDeductionSlabs?: { fromLates: number; deductionShifts: number }[];
  prodPfEfEnabled?: boolean;
  prodPfEfRules: { label: string; minSalary: number; maxSalary: number; pfRate: number; efRate: number }[];
  // Feature toggles (Settings master switches)
  staffPayrollRulesEnabled?: boolean;
  prodPayrollRulesEnabled?: boolean;
  nightShiftEnabled?: boolean;
  // Backup
  backupDirectory?: string;
  // SMTP / Email
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  smtpFromEmail: string;
  smtpFromName: string;
  updatedAt: string | null;
};

export const getPayrollSettingsQueryKey = () => ["/api/payroll-settings"] as const;

export const usePayrollSettings = () =>
  useQuery<PayrollSettingsItem>({
    queryKey: getPayrollSettingsQueryKey(),
    queryFn: () => customFetch<PayrollSettingsItem>("/api/payroll-settings"),
  });

export const useUpdatePayrollSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<PayrollSettingsItem>) =>
      customFetch<PayrollSettingsItem>("/api/payroll-settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getPayrollSettingsQueryKey() });
    },
  });
};

// ── Biometric Device Management ───────────────────────────────────────────────

export type BiometricDeviceItem = {
  id: number | "env";
  name: string;
  deviceType: string;
  host: string;
  port: number | null;
  hasApiKey: boolean;
  connectionConfig: Record<string, unknown>;
  isActive: boolean;
  isDefault: boolean;
  /** true for the read-only device configured via backend/.env */
  isEnv?: boolean;
  lastSyncedAt: string | null;
  notes: string | null;
  createdAt: string | null;
};

export const getBiometricDevicesQueryKey = () => ["/api/biometric-devices"] as const;

export const useListBiometricDevices = () =>
  useQuery<BiometricDeviceItem[]>({
    queryKey: getBiometricDevicesQueryKey(),
    queryFn: () => customFetch<BiometricDeviceItem[]>("/api/biometric-devices"),
  });

export const useCreateBiometricDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      name: string; deviceType?: string; host?: string; port?: number | null;
      apiKey?: string; isActive?: boolean; isDefault?: boolean; notes?: string;
      connectionConfig?: Record<string, unknown>;
    }) =>
      customFetch<BiometricDeviceItem>("/api/biometric-devices", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getBiometricDevicesQueryKey() }),
  });
};

export const useUpdateBiometricDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: {
      id: number;
      data: Partial<{
        name: string; deviceType: string; host: string; port: number | null;
        apiKey: string; isActive: boolean; isDefault: boolean; notes: string;
        connectionConfig: Record<string, unknown>;
      }>;
    }) =>
      customFetch<BiometricDeviceItem>(`/api/biometric-devices/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getBiometricDevicesQueryKey() }),
  });
};

export const useDeleteBiometricDevice = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/biometric-devices/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getBiometricDevicesQueryKey() }),
  });
};

// ── Auto Sync (configurable background biometric sync rules) ─────────────────

export type AutoSyncRuleItem = {
  id: number;
  name: string;
  /** "HH:MM", Asia/Kolkata */
  time: string;
  /** cron-compatible: "*" (every day) or e.g. "mon,tue,wed,thu,fri" */
  daysOfWeek: string;
  /** empty = every enabled device, same convention as manual Sync Biometric */
  deviceSelection: (number | "env")[];
  mode: SyncBiometricMode;
  isEnabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: "success" | "failed" | null;
  lastRunSummary: string | null;
  createdAt: string | null;
};

export type AutoSyncRuleInput = Partial<{
  name: string;
  time: string;
  daysOfWeek: string;
  deviceSelection: (number | "env")[];
  mode: SyncBiometricMode;
  isEnabled: boolean;
}>;

export const getAutoSyncRulesQueryKey = () => ["/api/auto-sync-rules"] as const;

export const useListAutoSyncRules = () =>
  useQuery<AutoSyncRuleItem[]>({
    queryKey: getAutoSyncRulesQueryKey(),
    queryFn: () => customFetch<AutoSyncRuleItem[]>("/api/auto-sync-rules"),
    refetchInterval: 60_000,
  });

export const useCreateAutoSyncRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AutoSyncRuleInput) =>
      customFetch<AutoSyncRuleItem>("/api/auto-sync-rules", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getAutoSyncRulesQueryKey() }),
  });
};

export const useUpdateAutoSyncRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: AutoSyncRuleInput }) =>
      customFetch<AutoSyncRuleItem>(`/api/auto-sync-rules/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getAutoSyncRulesQueryKey() }),
  });
};

export const useDeleteAutoSyncRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/auto-sync-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getAutoSyncRulesQueryKey() }),
  });
};

// ── Production Shift Workflow (punch times + dynamic shift-value segments) ────

export type ProductionShiftSegment = {
  id: number;
  label: string;
  startTime: string;
  endTime: string;
  shiftValue: number;
  order: number;
  isActive: boolean;
};

export type ProductionShiftConfigResponse = {
  punch1Time: string;
  punch2Time: string;
  punch3Time: string;
  punch4Time: string;
  graceMinutes: number;
  updatedAt: string | null;
  segments: ProductionShiftSegment[];
};

export const getProductionShiftConfigQueryKey = () => ["/api/production-shift-config"] as const;

export const useProductionShiftConfig = () =>
  useQuery<ProductionShiftConfigResponse>({
    queryKey: getProductionShiftConfigQueryKey(),
    queryFn: () => customFetch<ProductionShiftConfigResponse>("/api/production-shift-config"),
  });

export const useUpdateProductionShiftConfig = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<{
      punch1Time: string; punch2Time: string; punch3Time: string; punch4Time: string; graceMinutes: number;
    }>) =>
      customFetch("/api/production-shift-config", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

export const useCreateProductionShiftSegment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { label: string; startTime: string; endTime: string; shiftValue: number; order?: number; isActive?: boolean }) =>
      customFetch<ProductionShiftSegment>("/api/production-shift-segments", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

export const useUpdateProductionShiftSegment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<{ label: string; startTime: string; endTime: string; shiftValue: number; order: number; isActive: boolean }> }) =>
      customFetch<ProductionShiftSegment>(`/api/production-shift-segments/${id}`, { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

export const useDeleteProductionShiftSegment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/production-shift-segments/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getProductionShiftConfigQueryKey() }),
  });
};

// ── ID Card Template Settings ─────────────────────────────────────────────────

export type IdCardSettingsItem = {
  primaryColor: string;
  secondaryColor: string;
  textColor: string;
  fontFamily: string;
  backgroundStyle: string;
  logoPosition: string;
  cornerStyle: string;
  showQrOnBack: boolean;
  footerText: string;
  updatedAt: string | null;
};

export const getIdCardSettingsQueryKey = () => ["/api/idcard-settings"] as const;

export const useIdCardSettings = () =>
  useQuery<IdCardSettingsItem>({
    queryKey: getIdCardSettingsQueryKey(),
    queryFn: () => customFetch<IdCardSettingsItem>("/api/idcard-settings"),
  });

export const useUpdateIdCardSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<IdCardSettingsItem>) =>
      customFetch<IdCardSettingsItem>("/api/idcard-settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getIdCardSettingsQueryKey() }),
  });
};

export const useEmailSalarySlip = () =>
  useMutation({
    mutationFn: ({ id, toEmail }: { id: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/salary-slips/${id}/email`, {
        method: "POST",
        body: JSON.stringify({ toEmail }),
      }),
  });

// ── Company Documents (Offer Letter / Experience Letter / Salary Slip theming) ──

export type DocumentType = "offer_letter" | "experience_letter" | "salary_slip" | "resignation_letter";

export type DocumentSettingsItem = {
  docType: DocumentType;
  primaryColor: string;
  accentColor: string;
  headingStyle: "serif" | "sans";
  showWatermark: boolean;
  footerTagline: string;
  logoOverride: string;
  updatedAt: string | null;
};

export const getDocumentSettingsQueryKey = (docType: DocumentType) => ["/api/document-settings", docType] as const;

export const useDocumentSettings = (docType: DocumentType) =>
  useQuery<DocumentSettingsItem>({
    queryKey: getDocumentSettingsQueryKey(docType),
    queryFn: () => customFetch<DocumentSettingsItem>(`/api/document-settings/${docType}`),
  });

export const useUpdateDocumentSettings = (docType: DocumentType) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<DocumentSettingsItem>) =>
      customFetch<DocumentSettingsItem>(`/api/document-settings/${docType}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getDocumentSettingsQueryKey(docType) }),
  });
};

const _fetchPdfBlob = async (url: string, getToken: () => string | null): Promise<{ blob: Blob; filename: string }> => {
  const token = getToken();
  // Every caller (PDF preview/download across Employee Detail, Payroll,
  // Recruitment Documents, New Joinees, Settings, Salary Slip bulk) passes a
  // relative /api/... path, same as customFetch's own calls -this needs the
  // same origin prefix customFetch applies automatically, since a raw
  // fetch() here has no base-URL handling of its own.
  const response = await fetch(`${getApiOrigin()}${url}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to generate PDF");
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  return { blob, filename: match ? match[1] : "document.pdf" };
};

export const previewDocumentPdf = async (url: string, getToken: () => string | null) => {
  const sep = url.includes("?") ? "&" : "?";
  const { blob } = await _fetchPdfBlob(`${url}${sep}preview=1`, getToken);
  const objectUrl = URL.createObjectURL(blob);
  window.open(objectUrl, "_blank");
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
};

export const downloadDocumentPdf = async (url: string, getToken: () => string | null) => {
  const { blob, filename } = await _fetchPdfBlob(url, getToken);
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
};

// ── New Joinees ─────────────────────────────────────────────────────────

export type NewJoineeItem = {
  id: number;
  employeeCode: string;
  name: string;
  email: string | null;
  phone: string | null;
  department: string | null;
  designation: string | null;
  branchName: string | null;
  employmentType: string;
  joinDate: string | null;
  photoUrl: string | null;
};

export const getNewJoineesQueryKey = (days: number) => ["/api/recruitment/new-joinees", days] as const;

export const useListNewJoinees = (days: number = 30) =>
  useQuery<NewJoineeItem[]>({
    queryKey: getNewJoineesQueryKey(days),
    queryFn: () => customFetch<NewJoineeItem[]>(`/api/recruitment/new-joinees?days=${days}`),
  });

export const useSendOfferLetterEmail = () =>
  useMutation({
    mutationFn: ({ employeeId, toEmail }: { employeeId: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string; pdfAttached: boolean }>(`/api/employees/${employeeId}/offer-letter/email`, {
        method: "POST",
        body: JSON.stringify({ toEmail }),
      }),
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Typed attendance dashboard (staff / production filtered)
// ═══════════════════════════════════════════════════════════════════════════

export type TypedAttendanceSummary = {
  date: string;
  totalEmployees: number;
  productionTotal: number;
  staffTotal: number;
  presentToday: number;
  biometricPresent: number;
  manualPresent: number;
  notPunched: number;
  productionNotPunched: number;
  staffNotPunched: number;
  yesterday: { date: string; present: number; absent: number; late: number; onLeave: number };
};

export const useAttendanceSummaryTyped = (date: string, employmentType?: string) =>
  useQuery<TypedAttendanceSummary>({
    queryKey: ["/api/attendance/summary", date, employmentType ?? "all"],
    queryFn: () =>
      customFetch<TypedAttendanceSummary>(
        `/api/attendance/summary?date=${date}${employmentType ? `&employmentType=${employmentType}` : ""}`,
      ),
  });

export type TrendPoint = { date: string; day: number; label: string; present: number; absent: number };

export const useAttendanceTrendTyped = (year: number, month: number, employmentType?: string) =>
  useQuery<TrendPoint[]>({
    queryKey: ["/api/attendance/monthly-trend", year, month, employmentType ?? "all"],
    queryFn: () =>
      customFetch<TrendPoint[]>(
        `/api/attendance/monthly-trend?year=${year}&month=${month}${employmentType ? `&employmentType=${employmentType}` : ""}`,
      ),
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Final Attendance (weekly search + manual overrides)
// ═══════════════════════════════════════════════════════════════════════════

export type FinalAttendanceDay = {
  date: string;
  day: string;
  status: "present" | "absent" | "half_shift" | "on_leave" | "holiday";
  isLate: boolean;
  isHalfShift: boolean;
  earlyLeave: boolean;
  shiftsEarned: string;
  firstPunch?: string | null;
  lastPunch?: string | null;
  totalPunches: number;
  source: "auto" | "manual";
  overrideBy?: string | null;
  overrideNote?: string | null;
  computedMode?: string | null;
};

export type EmployeeMonthlyAttendance = {
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType?: string | null;
    photoUrl?: string | null;
  };
  assignedShift?: {
    name: string;
    startTime: string | null;
    endTime: string | null;
    gracePeriodMinutes: number;
  } | null;
  month: number;
  year: number;
  attendanceMode: string;
  weeks: { week: number; days: FinalAttendanceDay[] }[];
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
  };
};

export const getEmployeeMonthlyAttendanceKey = (code: string, month: number, year: number) =>
  ["/api/attendance/employee-monthly", code, month, year] as const;

export const useEmployeeMonthlyAttendance = (
  code: string, month: number, year: number, enabled = true,
) =>
  useQuery<EmployeeMonthlyAttendance>({
    queryKey: getEmployeeMonthlyAttendanceKey(code, month, year),
    queryFn: () =>
      customFetch<EmployeeMonthlyAttendance>(
        `/api/attendance/employee-monthly?code=${encodeURIComponent(code)}&month=${month}&year=${year}`,
      ),
    enabled: enabled && !!code.trim(),
    retry: false,
  });

export type AttendanceOverrideRequest = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  date: string;
  previousValues: Record<string, unknown>;
  requestedValues: Record<string, unknown>;
  reason?: string | null;
  status: "pending" | "approved" | "rejected";
  requestedBy?: string | null;
  reviewedBy?: string | null;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  createdAt?: string | null;
};

/**
 * Submitting an override does NOT apply it immediately -it creates a
 * pending AttendanceOverrideRequest that a Department Head must approve
 * (via the mobile app) before the attendance record is actually changed.
 * reset=true is the only path that applies instantly (reverts to auto).
 */
export const useAttendanceOverride = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      employeeId: number;
      date: string;
      status?: string;
      isLate?: boolean;
      isHalfShift?: boolean;
      firstPunch?: string | null;
      lastPunch?: string | null;
      note?: string;
      reset?: boolean;
    }) =>
      customFetch<{
        ok: boolean;
        record: FinalAttendanceDay;
        pendingApproval?: boolean;
        request?: AttendanceOverrideRequest;
        reset?: boolean;
      }>("/api/attendance/override", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/employee-monthly"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/override-requests"] });
    },
  });
};

export const useAttendanceOverrideRequests = (params?: { employeeId?: number; code?: string; status?: string }) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.code) qs.set("code", params.code);
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery<AttendanceOverrideRequest[]>({
    queryKey: ["/api/attendance/override-requests", params?.employeeId ?? null, params?.code ?? null, params?.status ?? null],
    queryFn: () => customFetch<AttendanceOverrideRequest[]>(`/api/attendance/override-requests${q}`),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Promotions
// ═══════════════════════════════════════════════════════════════════════════

export type PromotionItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  previousDepartment?: string | null;
  previousDesignation?: string | null;
  newDepartment?: string | null;
  newDesignation?: string | null;
  effectiveDate: string;
  notes?: string | null;
  promotedBy?: string | null;
  createdAt?: string | null;
};

export const useListPromotions = (params?: { employeeId?: number; code?: string }) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.code) qs.set("code", params.code);
  const q = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery<PromotionItem[]>({
    queryKey: ["/api/promotions", params?.employeeId ?? null, params?.code ?? null],
    queryFn: () => customFetch<PromotionItem[]>(`/api/promotions${q}`),
  });
};

export const useCreatePromotion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      employeeId: number;
      newDepartmentId?: number | null;
      newDesignationId?: number | null;
      effectiveDate?: string;
      notes?: string;
    }) =>
      customFetch<PromotionItem>("/api/promotions", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/promotions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
    },
  });
};

export const useDeletePromotion = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`/api/promotions/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/promotions"] }),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Salary Increments
// ═══════════════════════════════════════════════════════════════════════════

export type IncrementItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  previousSalary: number;
  newSalary: number;
  percent: number;
  effectiveDate: string;
  notes?: string | null;
  addedBy?: string | null;
  createdAt?: string | null;
};

export type IncrementSummary = {
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType?: string | null;
  };
  currentSalary: number;
  initialSalary: number;
  totalIncrementAmount: number;
  totalIncrements: number;
  history: IncrementItem[];
};

export type IncrementDashboard = {
  totalIncrements: number;
  totalEmployeesIncremented: number;
  totalIncrementAmount: number;
  avgIncrementPercent: number;
  departmentBreakdown: {
    department: string;
    incrementCount: number;
    employeeCount: number;
    avgPercent: number;
    totalAmount: number;
  }[];
  recentIncrements: IncrementItem[];
  topIncrements: IncrementItem[];
};

export const useIncrementDashboard = () =>
  useQuery<IncrementDashboard>({
    queryKey: ["/api/increments/dashboard"],
    queryFn: () => customFetch<IncrementDashboard>("/api/increments/dashboard"),
  });

export const useIncrementSummary = (code: string, enabled = true) =>
  useQuery<IncrementSummary>({
    queryKey: ["/api/increments/summary", code],
    queryFn: () =>
      customFetch<IncrementSummary>(`/api/increments/summary?code=${encodeURIComponent(code)}`),
    enabled: enabled && !!code.trim(),
    retry: false,
  });

export const useAddIncrement = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      employeeId: number;
      percent?: number;
      amount?: number;
      effectiveDate?: string;
      notes?: string;
    }) =>
      customFetch<IncrementItem>("/api/increments", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/increments/summary"] });
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  ID Cards + QR Verification
// ═══════════════════════════════════════════════════════════════════════════

export type IdCardData = {
  id: number;
  code: string;
  name: string;
  designation?: string | null;
  department?: string | null;
  branchName?: string | null;
  branchCode?: string | null;
  unitCode?: string | null;
  employmentType?: string | null;
  photoUrl?: string | null;
  bloodGroup?: string | null;
  dateOfBirth?: string | null;
  emergencyContact?: string | null;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  joinDate?: string | null;
  status: string;
  company: {
    name: string;
    address: string;
    logo?: string | null;
    signature?: string | null;
  };
  template?: {
    primaryColor: string;
    secondaryColor: string;
    textColor: string;
    fontFamily: string;
    backgroundStyle: string;
    logoPosition: string;
    cornerStyle: string;
    showQrOnBack: boolean;
    footerText: string;
  };
};

export const useIdCards = (ids: number[], enabled = true) =>
  useQuery<IdCardData[]>({
    queryKey: ["/api/idcard", ids.join(",")],
    queryFn: () => customFetch<IdCardData[]>(`/api/idcard?ids=${ids.join(",")}`),
    enabled: enabled && ids.length > 0,
  });

export const useEmailIdCard = () =>
  useMutation({
    mutationFn: (data: { employeeId: number; image?: string; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>("/api/idcard/email", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export type VerifyEmployeeResult = {
  verified: boolean;
  status?: string;
  employee?: {
    code: string;
    name: string;
    designation?: string | null;
    department?: string | null;
    employmentType?: string | null;
    photoUrl?: string | null;
    bloodGroup?: string | null;
    joinDate?: string | null;
  };
  company: { name: string; address?: string; logo?: string | null };
};

export const useVerifyEmployee = (code: string) =>
  useQuery<VerifyEmployeeResult>({
    queryKey: ["/api/verify-employee", code],
    queryFn: () => customFetch<VerifyEmployeeResult>(`/api/verify-employee/${encodeURIComponent(code)}`),
    enabled: !!code,
    retry: false,
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Casual Leave (CL)
// ═══════════════════════════════════════════════════════════════════════════

export type CasualLeaveItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  date: string;
  reason?: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: string | null;
  reviewerRole?: string | null;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  createdAt?: string | null;
};

export type CasualLeaveEligibility = {
  month: number;
  year: number;
  eligibilityMonths: number;
  employees: {
    employeeId: number;
    employeeCode: string;
    employeeName: string;
    department?: string | null;
    designation?: string | null;
    joinDate?: string | null;
    serviceMonths: number | null;
    eligible: boolean;
    reason?: string | null;
    usedThisMonth: boolean;
    usedStatus?: string | null;
    usedDate?: string | null;
  }[];
};

export const getCasualLeavesQueryKey = () => ["/api/casual-leaves"] as const;

export const useListCasualLeaves = (
  params?: { status?: string; month?: number; year?: number },
  enabled = true,
) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  const q = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery<CasualLeaveItem[]>({
    queryKey: ["/api/casual-leaves", params?.status ?? null, params?.month ?? null, params?.year ?? null],
    queryFn: () => customFetch<CasualLeaveItem[]>(`/api/casual-leaves${q}`),
    enabled,
  });
};

export const useCasualLeaveEligibility = (month: number, year: number) =>
  useQuery<CasualLeaveEligibility>({
    queryKey: ["/api/casual-leaves/eligibility", month, year],
    queryFn: () =>
      customFetch<CasualLeaveEligibility>(`/api/casual-leaves/eligibility?month=${month}&year=${year}`),
  });

export const useCreateCasualLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { employeeId: number; date: string; reason?: string }) =>
      customFetch<CasualLeaveItem>("/api/casual-leaves", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
    },
  });
};

export const useDecideCasualLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<CasualLeaveItem>(`/api/casual-leaves/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/employee-monthly"] });
    },
  });
};

export const useDeleteCasualLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`/api/casual-leaves/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Missing Punch (two-stage: Department Head, then HR -same status machine
//  as OnDutySession; HR approval writes a real AttendanceLog row)
// ═══════════════════════════════════════════════════════════════════════════

// Which of the day's 4 punches this request represents -purely descriptive
// (maps onto punchType: morning_in/lunch_in -> IN, lunch_out/evening_out ->
// OUT). Never the source of truth for real P1-P4 identity, which the
// attendance engine derives from punch time, not a stored label.
export type MissingPunchSlot = "morning_in" | "lunch_out" | "lunch_in" | "evening_out";

export type MissingPunchItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  date: string;
  punchTime: string;
  punchType: "IN" | "OUT";
  punchSlot: MissingPunchSlot | null;
  reason: string;
  status: "pending_hod" | "pending_hr" | "approved" | "rejected";
  hodReviewedBy: string | null;
  hodReviewComment: string | null;
  hodReviewedAt: string | null;
  hrReviewedBy: string | null;
  hrReviewComment: string | null;
  hrReviewedAt: string | null;
  createdAt: string | null;
};

export const getMissingPunchRequestsQueryKey = () => ["/api/missing-punch-requests"] as const;

export const useMissingPunchRequestsHR = (
  status: "pending" | "pending_hod" | "pending_hr" | "approved" | "rejected" | "all" = "pending",
  enabled = true,
) =>
  useQuery<MissingPunchItem[]>({
    queryKey: ["/api/missing-punch-requests", status],
    queryFn: () => customFetch<MissingPunchItem[]>(`/api/missing-punch-requests?status=${status}`),
    refetchInterval: 30_000,
    enabled,
  });

export const useUpdateMissingPunchHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<MissingPunchItem>(`/api/missing-punch-requests/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getMissingPunchRequestsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/employee-monthly"] });
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Night Shift Relaxation
// ═══════════════════════════════════════════════════════════════════════════

export type NightShiftRecord = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  nightDate: string;
  relaxationDate: string;
  lastPunchOut: string;
  crossedMidnight: boolean;
  allowedUntil: string;
  ruleName?: string | null;
  reportedAt?: string | null;
  withinAllowance?: boolean | null;
  status: "reported_within" | "reported_late" | "waiting" | "window_expired" | "no_report";
  remainingMinutes?: number | null;
};

export type NightShiftDashboard = {
  detected: number | null;
  count: number;
  summary: { reportedWithin: number; reportedLate: number; waiting: number; noReport: number };
  records: NightShiftRecord[];
};

export const useNightShiftDashboard = (params: {
  date?: string; month?: number; year?: number; employeeId?: number; departmentId?: number;
}) => {
  const qs = new URLSearchParams();
  if (params.date) qs.set("date", params.date);
  if (params.month) qs.set("month", String(params.month));
  if (params.year) qs.set("year", String(params.year));
  if (params.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params.departmentId) qs.set("departmentId", String(params.departmentId));
  return useQuery<NightShiftDashboard>({
    queryKey: ["/api/night-shift/dashboard", qs.toString()],
    queryFn: () => customFetch<NightShiftDashboard>(`/api/night-shift/dashboard?${qs.toString()}`),
  });
};

export const useNightShiftRecompute = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { date?: string; month?: number; year?: number }) =>
      customFetch<{ ok: boolean; detected: number }>("/api/night-shift/recompute", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/night-shift/dashboard"] }),
  });
};

export type NightShiftRuleItem = {
  id: number;
  name: string;
  workedUntil: string;
  crossesMidnight: boolean;
  allowedFirstPunch: string;
  order: number;
  isActive: boolean;
};

export const useNightShiftRules = () =>
  useQuery<NightShiftRuleItem[]>({
    queryKey: ["/api/night-shift/rules"],
    queryFn: () => customFetch<NightShiftRuleItem[]>("/api/night-shift/rules"),
  });

export const useSaveNightShiftRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<NightShiftRuleItem> & { id?: number }) =>
      data.id
        ? customFetch<NightShiftRuleItem>(`/api/night-shift/rules/${data.id}`, {
            method: "PUT", body: JSON.stringify(data),
          })
        : customFetch<NightShiftRuleItem>("/api/night-shift/rules", {
            method: "POST", body: JSON.stringify(data),
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/night-shift/rules"] });
      queryClient.invalidateQueries({ queryKey: ["/api/night-shift/dashboard"] });
    },
  });
};

export const useDeleteNightShiftRule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`/api/night-shift/rules/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/night-shift/rules"] }),
  });
};

// ── Department Manager Types ──────────────────────────────────────────────────

export type AssignedDepartment = {
  id: number;
  name: string;
  assignedAt?: string | null;
};

export type AssignedEmployee = {
  id: number;
  employeeCode: string;
  name: string;
  department?: string | null;
  designation?: string | null;
  assignedAt?: string | null;
};

export type DepartmentManagerItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  canApproveLeaves: boolean;
  canApprovePermissions: boolean;
  canApproveResignations: boolean;
  canApproveAttendance: boolean;
  canApproveCasualLeave: boolean;
  canApproveOnDuty: boolean;
  isActive: boolean;
  notes?: string | null;
  createdAt?: string | null;
  departmentCount: number;
  employeeCount: number;
  assignedDepartments?: AssignedDepartment[];
  assignedEmployees?: AssignedEmployee[];
  // mobile-only fields
  isManager?: boolean;
  canSubmitLeave?: boolean;
  pendingApprovalsCount?: number;
  pendingResignationsCount?: number;
  pendingAttendanceCount?: number;
};

export const getDepartmentManagersQueryKey = () => ["department-managers"] as const;
export const getDepartmentManagerQueryKey = (id: number) => ["department-managers", id] as const;

export const useListDepartmentManagers = () =>
  useQuery({
    queryKey: getDepartmentManagersQueryKey(),
    queryFn: () => customFetch<DepartmentManagerItem[]>("/api/department-managers"),
  });

export const useGetDepartmentManager = (id: number | null) =>
  useQuery({
    queryKey: getDepartmentManagerQueryKey(id!),
    queryFn: () => customFetch<DepartmentManagerItem>(`/api/department-managers/${id}`),
    enabled: !!id,
  });

export const useCreateDepartmentManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      employeeCode: string;
      canApproveLeaves?: boolean;
      canApprovePermissions?: boolean;
      canApproveResignations?: boolean;
      canApproveAttendance?: boolean;
      canApproveCasualLeave?: boolean;
      canApproveOnDuty?: boolean;
      notes?: string;
    }) =>
      customFetch<DepartmentManagerItem>("/api/department-managers", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
    },
  });
};

export const useUpdateDepartmentManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: Partial<{
        canApproveLeaves: boolean;
        canApprovePermissions: boolean;
        canApproveResignations: boolean;
        canApproveAttendance: boolean;
        canApproveCasualLeave: boolean;
        canApproveOnDuty: boolean;
        isActive: boolean;
        notes: string;
      }>;
    }) =>
      customFetch<DepartmentManagerItem>(`/api/department-managers/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: (_r, { id }) => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
      queryClient.invalidateQueries({ queryKey: getDepartmentManagerQueryKey(id) });
    },
  });
};

export const useDeleteDepartmentManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch(`/api/department-managers/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
    },
  });
};

export const useAssignDepartmentToManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ managerId, departmentId }: { managerId: number; departmentId: number }) =>
      customFetch(`/api/department-managers/${managerId}/departments`, {
        method: "POST",
        body: JSON.stringify({ departmentId }),
      }),
    onSuccess: (_r, { managerId }) => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagerQueryKey(managerId) });
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
    },
  });
};

export const useRemoveDepartmentFromManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ managerId, departmentId }: { managerId: number; departmentId: number }) =>
      customFetch(`/api/department-managers/${managerId}/departments`, {
        method: "DELETE",
        body: JSON.stringify({ departmentId }),
      }),
    onSuccess: (_r, { managerId }) => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagerQueryKey(managerId) });
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
    },
  });
};

export const useAssignEmployeeToManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ managerId, employeeCode }: { managerId: number; employeeCode: string }) =>
      customFetch(`/api/department-managers/${managerId}/employees`, {
        method: "POST",
        body: JSON.stringify({ employeeCode }),
      }),
    onSuccess: (_r, { managerId }) => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagerQueryKey(managerId) });
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
    },
  });
};

export const useRemoveEmployeeFromManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ managerId, employeeId }: { managerId: number; employeeId: number }) =>
      customFetch(`/api/department-managers/${managerId}/employees`, {
        method: "DELETE",
        body: JSON.stringify({ employeeId }),
      }),
    onSuccess: (_r, { managerId }) => {
      queryClient.invalidateQueries({ queryKey: getDepartmentManagerQueryKey(managerId) });
      queryClient.invalidateQueries({ queryKey: getDepartmentManagersQueryKey() });
    },
  });
};

// ── Report Download Utility ───────────────────────────────────────────────────

export async function downloadReportCsv(
  reportId: string,
  params: Record<string, string>,
): Promise<void> {
  const endpointMap: Record<string, string> = {
    attendance: "/api/reports/attendance",
    leave: "/api/reports/leave",
    payroll: "/api/reports/payroll",
    employees: "/api/reports/employees",
  };

  const endpoint = endpointMap[reportId];
  if (!endpoint) throw new Error("Unsupported report type");

  const qs = new URLSearchParams({ ...params, format: "csv" });
  const url = `${getApiOrigin()}${endpoint}?${qs.toString()}`;

  const token = typeof localStorage !== "undefined"
    ? localStorage.getItem("uk_textile_token")
    : null;

  const response = await fetch(url, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) throw new Error(`Download failed: ${response.statusText}`);

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = `${reportId}_report.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(objectUrl);
}

// ── Recruitment ───────────────────────────────────────────────────────────────

export type DeptAnalysisItem = {
  departmentId: number;
  departmentName: string;
  currentCount: number;
  requiredCount: number;
  vacancy: number;
};

export type RecentJoineeItem = {
  id: number;
  name: string;
  employeeCode: string;
  department?: string | null;
  designation?: string | null;
  joinDate?: string | null;
  photoUrl?: string | null;
};

export type RecentLeaveItem = {
  id: number;
  employeeName: string;
  employeeCode: string;
  department?: string | null;
  type: string;
  startDate: string;
  endDate: string;
  status: string;
};

export type RecruitmentDashboard = {
  totalStaffEmployees: number;
  totalDepartments: number;
  recentLeaves: number;
  newJoinees: number;
  openRoles: number;
  pendingResignations: number;
  positionsNeedingStaff: number;
  departmentAnalysis: DeptAnalysisItem[];
  recentJoineeList: RecentJoineeItem[];
  recentLeavesList: RecentLeaveItem[];
};

export type ResignationRequest = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  reason?: string | null;
  lastWorkingDate?: string | null;
  surveyQ1Answer?: string | null;
  surveyQ2Answer?: string | null;
  surveyQ3Answer?: string | null;
  // Status flow: pending → dept_approved → approved | rejected
  status: "pending" | "dept_approved" | "approved" | "rejected";
  // Dept head stage
  deptHeadId?: number | null;
  deptHeadName?: string | null;
  deptHeadStatus?: "approved" | "rejected" | null;
  deptHeadComment?: string | null;
  deptHeadApprovedAt?: string | null;
  // HR stage
  hrComment?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  rejectedBy?: "dept_head" | "hr" | null;
  createdAt?: string | null;
};

export type DepartmentHeadcountItem = {
  id?: number | null;
  departmentId: number;
  departmentName: string;
  currentCount: number;
  requiredCount: number;
  vacancy: number;
  notes?: string | null;
};

export const getRecruitmentDashboardQueryKey = () => ["/api/recruitment/dashboard"] as const;

export const useGetRecruitmentDashboard = (
  options?: UseQueryOptions<RecruitmentDashboard>,
) =>
  useQuery<RecruitmentDashboard>({
    queryKey: getRecruitmentDashboardQueryKey(),
    queryFn: () => customFetch<RecruitmentDashboard>("/api/recruitment/dashboard"),
    ...options,
  });

export const getListResignationsQueryKey = (status?: string) =>
  ["/api/recruitment/resignations", status] as const;

export const useListResignations = (
  statusFilter?: string,
  options?: UseQueryOptions<ResignationRequest[]>,
) => {
  const qs = statusFilter ? `?status=${statusFilter}` : "";
  return useQuery<ResignationRequest[]>({
    queryKey: getListResignationsQueryKey(statusFilter),
    queryFn: () => customFetch<ResignationRequest[]>(`/api/recruitment/resignations${qs}`),
    ...options,
  });
};

export const useSubmitResignation = () =>
  useMutation({
    mutationFn: (data: {
      reason?: string;
      lastWorkingDate?: string;
      surveyQ1Answer?: string;
      surveyQ2Answer?: string;
      surveyQ3Answer?: string;
    }) =>
      customFetch<ResignationRequest>("/api/recruitment/resignations", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useResignationAction = () =>
  useMutation({
    mutationFn: ({ id, action, hrComment }: { id: number; action: "approve" | "reject"; hrComment?: string }) =>
      customFetch<ResignationRequest>(`/api/recruitment/resignations/${id}/action`, {
        method: "PATCH",
        body: JSON.stringify({ action, hrComment }),
      }),
  });

export const getMyResignationQueryKey = () => ["/api/my/resignation"] as const;

export const useMyResignation = (options?: UseQueryOptions<ResignationRequest | null>) =>
  useQuery<ResignationRequest | null>({
    queryKey: getMyResignationQueryKey(),
    queryFn: () => customFetch<ResignationRequest | null>("/api/my/resignation"),
    ...options,
  });

export const getListDepartmentHeadcountQueryKey = () =>
  ["/api/recruitment/department-headcount"] as const;

export const useListDepartmentHeadcount = (
  options?: UseQueryOptions<DepartmentHeadcountItem[]>,
) =>
  useQuery<DepartmentHeadcountItem[]>({
    queryKey: getListDepartmentHeadcountQueryKey(),
    queryFn: () => customFetch<DepartmentHeadcountItem[]>("/api/recruitment/department-headcount"),
    ...options,
  });

export const useSetDepartmentHeadcount = () =>
  useMutation({
    mutationFn: (data: { departmentId: number; requiredCount: number; notes?: string }) =>
      customFetch<DepartmentHeadcountItem>("/api/recruitment/department-headcount", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateDepartmentHeadcount = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: { requiredCount?: number; notes?: string } }) =>
      customFetch<DepartmentHeadcountItem>(`/api/recruitment/department-headcount/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

// ── Resume Screening (ATS) ──────────────────────────────────────────────────

export type HiringRuleSetItem = {
  id: number;
  name: string;
  departmentId: number;
  departmentName: string | null;
  requiredSkills: string[];
  softSkills: string[];
  educationQualification: string | null;
  minExperienceYears: number;
  preferredCity: string | null;
  otherRequirements: string | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

export type ScreeningCandidateStatus =
  | "uploaded" | "screened" | "shortlisted" | "not_shortlisted" | "selected" | "rejected";

export const EDUCATION_LEVEL_OPTIONS = [
  "10th", "12th", "Diploma", "B.E.", "B.Tech", "UG", "PG",
  "More than 10th", "More than 12th", "More than Diploma", "More than B.E.",
  "More than B.Sc.", "More than B.Tech.", "More than M.Sc.",
] as const;

export type ScoreBreakdown = {
  total: number;
  components: {
    skills: { score: number; weight: number; matched: string[]; missing: string[] };
    softSkills: { score: number; weight: number; matched: string[]; missing: string[] };
    similarity: { score: number; weight: number; rawCosine?: number; raw_cosine?: number };
    experience: { score: number; weight: number; required: number; extracted: number | null };
    education: { score: number; weight: number; required: string | null; extracted: string | null; meets: boolean };
    location: { score: number; weight: number; preferred: string | null; extracted: string | null; meets: boolean };
  };
};

export type ScreeningCandidateItem = {
  id: number;
  ruleSetId: number;
  ruleSetName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  originalFilename: string;
  hasResume: boolean;
  source: "single" | "bulk";
  candidateName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  extractedSkills: string[];
  extractedSoftSkills: string[];
  extractedExperienceYears: number | null;
  extractedEducation: string | null;
  matchScore: number | null;
  scoreBreakdown: ScoreBreakdown | null;
  rankInBatch: number | null;
  status: ScreeningCandidateStatus;
  screenedAt: string | null;
  interviewInvitedAt: string | null;
  interviewDatetime: string | null;
  rejectionEmailedAt: string | null;
  notes: string | null;
  createdAt: string | null;
  resumeUrl: string;
};

const RESUME_SCREENING_BASE = "/api/recruitment/resume-screening";

export const getListHiringRuleSetsQueryKey = (params?: { departmentId?: number; isActive?: boolean }) =>
  [`${RESUME_SCREENING_BASE}/rule-sets`, params] as const;

export const useListHiringRuleSets = (
  params?: { departmentId?: number; isActive?: boolean },
  options?: UseQueryOptions<HiringRuleSetItem[]>,
) => {
  const qs = new URLSearchParams();
  if (params?.departmentId) qs.set("departmentId", String(params.departmentId));
  if (params?.isActive !== undefined) qs.set("isActive", String(params.isActive));
  const q = qs.toString();
  return useQuery<HiringRuleSetItem[]>({
    queryKey: getListHiringRuleSetsQueryKey(params),
    queryFn: () => customFetch<HiringRuleSetItem[]>(`${RESUME_SCREENING_BASE}/rule-sets${q ? `?${q}` : ""}`),
    ...options,
  });
};

export type HiringRuleSetInput = {
  name: string;
  departmentId: number;
  requiredSkills: string[];
  softSkills?: string[];
  educationQualification?: string;
  minExperienceYears?: number;
  preferredCity?: string;
  otherRequirements?: string;
  isActive?: boolean;
};

export const useCreateHiringRuleSet = () =>
  useMutation({
    mutationFn: (data: HiringRuleSetInput) =>
      customFetch<HiringRuleSetItem>(`${RESUME_SCREENING_BASE}/rule-sets`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateHiringRuleSet = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<HiringRuleSetInput> }) =>
      customFetch<HiringRuleSetItem>(`${RESUME_SCREENING_BASE}/rule-sets/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteHiringRuleSet = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`${RESUME_SCREENING_BASE}/rule-sets/${id}`, { method: "DELETE" }),
  });

export const useUploadSingleResume = () =>
  useMutation({
    mutationFn: ({ file, ruleSetId }: { file: File; ruleSetId: number }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("ruleSetId", String(ruleSetId));
      return customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/upload-single`, {
        method: "POST",
        body: formData,
      });
    },
  });

export const useShortlistCandidate = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/candidates/${id}/shortlist`, {
        method: "POST",
      }),
  });

export const getListScreeningCandidatesQueryKey = (params?: {
  status?: ScreeningCandidateStatus; ruleSetId?: number; departmentId?: number; search?: string;
}) => [`${RESUME_SCREENING_BASE}/candidates`, params] as const;

export const useListScreeningCandidates = (
  params?: { status?: ScreeningCandidateStatus; ruleSetId?: number; departmentId?: number; search?: string },
  options?: UseQueryOptions<ScreeningCandidateItem[]>,
) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.ruleSetId) qs.set("ruleSetId", String(params.ruleSetId));
  if (params?.departmentId) qs.set("departmentId", String(params.departmentId));
  if (params?.search) qs.set("search", params.search);
  const q = qs.toString();
  return useQuery<ScreeningCandidateItem[]>({
    queryKey: getListScreeningCandidatesQueryKey(params),
    queryFn: () => customFetch<ScreeningCandidateItem[]>(`${RESUME_SCREENING_BASE}/candidates${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useUpdateCandidateStatus = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: { status?: ScreeningCandidateStatus; notes?: string } }) =>
      customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/candidates/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteScreeningCandidate = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`${RESUME_SCREENING_BASE}/candidates/${id}`, { method: "DELETE" }),
  });

export const useSendRejectionEmailsAll = () =>
  useMutation({
    mutationFn: () =>
      customFetch<{ sent: number; failed: { candidateId: number; name: string | null; error: string }[] }>(
        `${RESUME_SCREENING_BASE}/candidates/reject-email-all`,
        { method: "POST" },
      ),
  });

export const useSendInterviewInvite = () =>
  useMutation({
    mutationFn: ({ id, interviewDateTime }: { id: number; interviewDateTime: string }) =>
      customFetch<ScreeningCandidateItem>(`${RESUME_SCREENING_BASE}/candidates/${id}/interview-invite`, {
        method: "POST",
        body: JSON.stringify({ interviewDateTime }),
      }),
  });

export const useSendInterviewInviteBulk = () =>
  useMutation({
    mutationFn: (interviewDateTime: string) =>
      customFetch<{ sent: number; failed: { candidateId: number; name: string | null; error: string }[] }>(
        `${RESUME_SCREENING_BASE}/candidates/interview-invite-bulk`,
        { method: "POST", body: JSON.stringify({ interviewDateTime }) },
      ),
  });

// ── Resume Screening bulk upload progress ───────────────────────────────────

export type ResumeScreeningProgress = {
  stage: "idle" | "running" | "completed";
  total: number;
  completed: number;
  screened: number;
  failed: number;
  currentFile: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const useResumeScreeningProgress = (enabled: boolean) =>
  useQuery<ResumeScreeningProgress>({
    queryKey: [`${RESUME_SCREENING_BASE}/upload-bulk-progress`],
    queryFn: () => customFetch<ResumeScreeningProgress>(`${RESUME_SCREENING_BASE}/upload-bulk-progress`),
    enabled,
    refetchInterval: enabled ? 600 : false,
    staleTime: 0,
  });

export const useResignationEmail = () =>
  useMutation({
    mutationFn: ({ id, toEmail }: { id: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string; pdfAttached: boolean }>(
        `/api/recruitment/resignations/${id}/email`,
        { method: "POST", body: JSON.stringify({ toEmail }) },
      ),
  });

// ── Employee Documents ──────────────────────────────────────────────────────

export type EmployeeDocumentCategory =
  | "pan_card"
  | "aadhaar_card"
  | "educational_certificate"
  | "voter_id_or_birth_certificate"
  | "bank_passbook"
  | "offer_letter"
  | "experience_letter"
  | "resignation_letter"
  | "staff_letter"
  | "production_employee_documents";

export const EMPLOYEE_DOCUMENT_CATEGORIES: { value: EmployeeDocumentCategory; label: string }[] = [
  { value: "pan_card", label: "PAN Card" },
  { value: "aadhaar_card", label: "Aadhaar Card" },
  { value: "educational_certificate", label: "Educational Certificates" },
  { value: "voter_id_or_birth_certificate", label: "Voter ID or Birth Certificate" },
  { value: "bank_passbook", label: "Bank Passbook" },
  { value: "offer_letter", label: "Offer Letter" },
  { value: "experience_letter", label: "Experience Letter" },
  { value: "resignation_letter", label: "Resignation Letter" },
  { value: "staff_letter", label: "Staff Letter" },
  { value: "production_employee_documents", label: "Production Employee Documents" },
];

export type EmployeeDocumentItem = {
  id: number;
  employeeId: number;
  category: EmployeeDocumentCategory;
  categoryLabel: string;
  originalFilename: string;
  uploadedBy: string | null;
  uploadedAt: string | null;
  fileUrl: string;
};

export const getEmployeeDocumentsQueryKey = (employeeId: number | null) =>
  ["/api/recruitment/employee-documents", employeeId] as const;

export const useEmployeeDocuments = (employeeId: number | null, enabled = true) =>
  useQuery<EmployeeDocumentItem[]>({
    queryKey: getEmployeeDocumentsQueryKey(employeeId),
    queryFn: () => customFetch<EmployeeDocumentItem[]>(`/api/recruitment/employee-documents/${employeeId}`),
    enabled: enabled && !!employeeId,
  });

export const useUploadEmployeeDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, category, file }: { employeeId: number; category: EmployeeDocumentCategory; file: File }) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", category);
      return customFetch<EmployeeDocumentItem>(`/api/recruitment/employee-documents/${employeeId}/upload`, {
        method: "POST",
        body: formData,
      });
    },
    onSuccess: (_data, { employeeId }) =>
      queryClient.invalidateQueries({ queryKey: getEmployeeDocumentsQueryKey(employeeId) }),
  });
};

export const useDeleteEmployeeDocument = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) =>
      customFetch<{ ok: boolean }>(`/api/employee-documents/${id}`, { method: "DELETE" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["/api/recruitment/employee-documents"] }),
  });
};

export type DocumentCompletionEmployee = {
  id: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
};

export type DocumentCompletionStats = {
  totalCount: number;
  uploadedCount: number;
  pendingCount: number;
  uploadedEmployees: DocumentCompletionEmployee[];
  pendingEmployees: (DocumentCompletionEmployee & {
    missingCategories: { value: EmployeeDocumentCategory; label: string }[];
  })[];
};

export const getDocumentCompletionStatsQueryKey = (employmentType: "staff" | "production") =>
  ["/api/recruitment/employee-documents/completion-stats", employmentType] as const;

export const useDocumentCompletionStats = (employmentType: "staff" | "production", enabled = true) =>
  useQuery<DocumentCompletionStats>({
    queryKey: getDocumentCompletionStatsQueryKey(employmentType),
    queryFn: () =>
      customFetch<DocumentCompletionStats>(
        `/api/recruitment/employee-documents/completion-stats?employmentType=${employmentType}`,
      ),
    enabled,
  });

export const useDeleteResignation = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/recruitment/resignations/${id}/delete`, { method: "DELETE" }),
  });

export const downloadResignationPdf = async (id: number, getToken: () => string | null) => {
  const token = getToken();
  const response = await fetch(`${getApiOrigin()}/api/recruitment/resignations/${id}/pdf`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error((err as any).error ?? "Failed to download PDF");
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = disposition.match(/filename="([^"]+)"/);
  a.download = match ? match[1] : `resignation_${id}.pdf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// ── Database Backup (Settings → Backup) ───────────────────────────────────────

export type BackupFileItem = { file: string; sizeBytes: number; createdAt: string };

export type BackupScheduleInfo = {
  isEnabled: boolean;
  time: string | null;
  daysOfWeek: string;
  retentionCount: number;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunSummary: string | null;
};

export type BackupStatus = {
  backupDirectory: string;
  pgDumpAvailable: boolean;
  backups: BackupFileItem[];
  schedule: BackupScheduleInfo;
  driveConfigured: boolean;
};

export const getBackupStatusQueryKey = () => ["/api/backup"] as const;

export const useBackupStatus = () =>
  useQuery<BackupStatus>({
    queryKey: getBackupStatusQueryKey(),
    queryFn: () => customFetch<BackupStatus>("/api/backup"),
  });

export const useRunBackup = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (directory: string) =>
      customFetch<{ ok: boolean; file: string; path: string; sizeBytes: number; backups: BackupFileItem[] }>(
        "/api/backup/run",
        { method: "POST", body: JSON.stringify({ directory }) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
    },
  });
};

export const useUpdateBackupSchedule = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { isEnabled: boolean; time: string; daysOfWeek: string; retentionCount: number }) =>
      customFetch<BackupScheduleInfo>("/api/backup/schedule", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
    },
  });
};

export type BackupDriveInfo = {
  isEnabled: boolean;
  folderId: string;
  hasServiceAccountKey: boolean;
  lastUploadAt: string | null;
  lastUploadStatus: string | null;
  lastUploadSummary: string | null;
};

export const getBackupDriveQueryKey = () => ["/api/backup/drive"] as const;

export const useDriveConfig = () =>
  useQuery<BackupDriveInfo>({
    queryKey: getBackupDriveQueryKey(),
    queryFn: () => customFetch<BackupDriveInfo>("/api/backup/drive"),
  });

export const useUpdateDriveConfig = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { isEnabled: boolean; folderId: string; serviceAccountJson?: string }) =>
      customFetch<BackupDriveInfo>("/api/backup/drive", { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getBackupDriveQueryKey() });
      queryClient.invalidateQueries({ queryKey: getBackupStatusQueryKey() });
    },
  });
};

export const useTestDriveConnection = () =>
  useMutation({
    mutationFn: (data: { folderId?: string; serviceAccountJson?: string }) =>
      customFetch<{ ok: boolean; folderName?: string; warning?: string }>("/api/backup/drive/test", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export type RestoreStaleness = {
  backupCreatedAt?: string;
  backupCounts: { employees: number; payrollRecords: number; salarySlips: number };
  currentCounts: { employees: number; payrollRecords: number; salarySlips: number };
  isOlderThanCurrentData: boolean;
} | null;

export type RestoreValidateResult = {
  ok: boolean;
  stagedPath: string;
  manifest: { createdAt?: string; dbName?: string; mediaFileCount?: number };
  mediaFileCount: number;
  sizeBytes: number;
  warnings: string[];
  staleness: RestoreStaleness;
  guidedScript: string;
};

/** Raw fetch + FormData, not customFetch -multipart bodies aren't JSON.
 * Mirrors ManualPunchImport.tsx's handleUpload exactly. */
export const uploadRestoreFile = async (file: File, token: string | null): Promise<RestoreValidateResult> => {
  const formData = new FormData();
  formData.append("file", file);
  const response = await fetch(`${getApiOrigin()}/api/backup/restore/validate`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: formData,
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? "Failed to validate backup file");
  }
  return body as RestoreValidateResult;
};

export const runAutomatedRestore = async (stagedPath: string, token: string | null): Promise<{ ok: boolean; message: string }> => {
  const response = await fetch(`${getApiOrigin()}/api/backup/restore/run`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ stagedPath }),
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error((body as { error?: string }).error ?? "Failed to start restore");
  }
  return body as { ok: boolean; message: string };
};

export type RestoreStatus = {
  active: boolean;
  step?: string;
  detail?: string;
  ok?: boolean | null;
  updatedAt?: string;
};

export const useRestoreStatus = (enabled: boolean) =>
  useQuery<RestoreStatus>({
    queryKey: ["/api/backup/restore/status"],
    queryFn: () => customFetch<RestoreStatus>("/api/backup/restore/status"),
    enabled,
    refetchInterval: (query) => (query.state.data?.active ? 2000 : false),
  });

// ── Chat (HR portal -company channel) ────────────────────────────────────────

export type ChatChannelItem = {
  id: number;
  type: "company" | "department";
  departmentId: number | null;
  departmentName: string | null;
};

export type ChatMessageItem = {
  id: number;
  senderId: number | null;
  senderName: string;
  isHr?: boolean;
  text: string;
  replyTo: { id: number; senderName: string; text: string } | null;
  reactions: { emoji: string; count: number; reactedByMe: boolean }[];
  createdAt: string | null;
};

export const useChatChannels = () =>
  useQuery<ChatChannelItem[]>({
    queryKey: ["/api/chat/channels"],
    queryFn: () => customFetch<ChatChannelItem[]>("/api/chat/channels"),
  });

export const useChatMessages = (channelId: number | null) =>
  useQuery<ChatMessageItem[]>({
    queryKey: ["/api/chat/channels", channelId, "messages"],
    queryFn: () => customFetch<ChatMessageItem[]>(`/api/chat/channels/${channelId}/messages?limit=100`),
    enabled: channelId != null,
    refetchInterval: 4000,
  });

export const useSendChatMessage = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ channelId, text, replyToId }: { channelId: number; text: string; replyToId?: number }) =>
      customFetch<ChatMessageItem>(`/api/chat/channels/${channelId}/messages`, {
        method: "POST",
        body: JSON.stringify({ text, reply_to_id: replyToId }),
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/chat/channels", vars.channelId, "messages"] });
    },
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Geo Attendance (Office Geo Punch + On-Duty two-stage approval + live tracking)
// ═══════════════════════════════════════════════════════════════════════════

/** The destination-request gate -no photos/GPS at this stage, that
 * verification now happens per-punch (see OnDutyPunchVerificationItem
 * below). Two-stage HOD->HR chain same as before; approval flips status to
 * "active" (started_at stamped), and the session ends in "completed" either
 * automatically (4th punch approved) or manually (employee taps Done). */
export type OnDutySessionItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  destination: string;
  branchId: number | null;
  branchName: string | null;
  status: "pending_hod" | "pending_hr" | "active" | "completed" | "rejected";
  hodReviewedBy: string | null;
  hodReviewComment: string | null;
  hodReviewedAt: string | null;
  hrReviewedBy: string | null;
  hrReviewComment: string | null;
  hrReviewedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  completionReason: "manual" | "auto_4th_punch" | null;
  createdAt: string | null;
};

export const useOnDutySessionsHR = (
  status: "pending" | "pending_hod" | "pending_hr" | "active" | "completed" | "rejected" | "all" = "pending",
  enabled = true,
) =>
  useQuery<OnDutySessionItem[]>({
    queryKey: ["/api/on-duty-sessions", status],
    queryFn: () => customFetch<OnDutySessionItem[]>(`/api/on-duty-sessions?status=${status}`),
    refetchInterval: 30_000,
    enabled,
  });

export const useUpdateOnDutySessionHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<OnDutySessionItem>(`/api/on-duty-sessions/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/on-duty-sessions"] });
    },
  });
};

/** One of the day's (up to 4) attendance punches, captured with a selfie +
 * GPS while a session is active -held pending until HR approves it, then
 * written as a real punch. Single-stage (HR only), unlike the session gate. */
export type OnDutyPunchVerificationItem = {
  id: number;
  sessionId: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  punchDate: string;
  punchTime: string;
  punchType: "IN" | "OUT";
  punchNumber: number;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  isMocked: boolean;
  hasPhoto: boolean;
  status: "pending" | "approved" | "rejected";
  hrReviewedBy: string | null;
  hrReviewComment: string | null;
  hrReviewedAt: string | null;
  createdAt: string | null;
};

export const useOnDutyPunchVerificationsHR = (
  status: "pending" | "approved" | "rejected" | "all" = "pending",
  enabled = true,
) =>
  useQuery<OnDutyPunchVerificationItem[]>({
    queryKey: ["/api/on-duty-punch-verifications", status],
    queryFn: () => customFetch<OnDutyPunchVerificationItem[]>(`/api/on-duty-punch-verifications?status=${status}`),
    refetchInterval: 20_000,
    enabled,
  });

export const useUpdateOnDutyPunchVerificationHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<OnDutyPunchVerificationItem>(`/api/on-duty-punch-verifications/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/on-duty-punch-verifications"] });
    },
  });
};

/** Fetches an auth-protected image (geo-punch photos) and returns a blob
 * object URL -img src can't carry an Authorization header, so this mirrors
 * _fetchPdfBlob's fetch-then-objectURL pattern for images instead. Caller
 * owns revoking the URL when done with it. */
export const fetchAuthedImageObjectUrl = async (url: string, getToken: () => string | null): Promise<string> => {
  const token = getToken();
  // Same as _fetchPdfBlob above -callers pass a relative /api/... path.
  const response = await fetch(`${getApiOrigin()}${url}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error("Failed to load photo");
  const blob = await response.blob();
  return URL.createObjectURL(blob);
};

export type LiveLocationTeamMember = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  branchName: string | null;
  latitude: number | null;
  longitude: number | null;
  isMocked: boolean;
  lastSeenAt: string | null;
};

export const useLiveLocationTeam = (enabled = true) =>
  useQuery<LiveLocationTeamMember[]>({
    queryKey: ["/api/live-location/team"],
    queryFn: () => customFetch<LiveLocationTeamMember[]>("/api/live-location/team"),
    refetchInterval: 20_000,
    enabled,
  });

export type LiveLocationTrailPoint = { latitude: number; longitude: number; recordedAt: string; isMocked: boolean };

export const useLiveLocationTrail = (employeeId: number | null) =>
  useQuery<LiveLocationTrailPoint[]>({
    queryKey: ["/api/live-location/trail", employeeId],
    queryFn: () => customFetch<LiveLocationTrailPoint[]>(`/api/live-location/team/${employeeId}/trail`),
    enabled: employeeId != null,
    refetchInterval: 20_000,
  });

export type LiveLocationRoute = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  date: string;
  points: { latitude: number; longitude: number; recordedAt: string; isMocked: boolean }[];
};

export const useLiveLocationRoute = (employeeId: number | null, date: string) =>
  useQuery<LiveLocationRoute>({
    queryKey: ["/api/live-location/route", employeeId, date],
    queryFn: () => customFetch<LiveLocationRoute>(`/api/live-location/team/${employeeId}/route?date=${date}`),
    enabled: employeeId != null,
  });

export type OnDutyMapEmployee = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  locationTrackingEnabled: boolean;
  latitude: number | null;
  longitude: number | null;
  lastSeenAt: string | null;
  routePoints: { latitude: number; longitude: number; recordedAt: string }[];
  session: { id: number; destination: string; status: string };
  punches: { punchNumber: number; punchType: "IN" | "OUT"; punchTime: string; status: string }[];
};

export const useOnDutyMap = (date: string) =>
  useQuery<{ date: string; employees: OnDutyMapEmployee[] }>({
    queryKey: ["/api/on-duty-map", date],
    queryFn: () => customFetch<{ date: string; employees: OnDutyMapEmployee[] }>(`/api/on-duty-map?date=${date}`),
    refetchInterval: 20_000,
  });

export const useUpdateEmployeeLocationTracking = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, enabled }: { employeeId: number; enabled: boolean }) =>
      customFetch(`/api/employees/${employeeId}`, {
        method: "PATCH",
        body: JSON.stringify({ locationTrackingEnabled: enabled }),
      }),
    onSuccess: () => {
      // /api/employees list + /api/live-location/team both need a refetch —
      // matches by query-key prefix so every params variant is caught.
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/team"] });
    },
  });
};

export const useBulkUpdateLocationTracking = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ enabled, employeeIds }: { enabled: boolean; employeeIds?: number[] }) =>
      customFetch<{ updated: number; enabled: boolean }>("/api/employees/location-tracking/bulk", {
        method: "PATCH",
        body: JSON.stringify({ enabled, ...(employeeIds ? { employeeIds } : {}) }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/employees"] });
      queryClient.invalidateQueries({ queryKey: ["/api/live-location/team"] });
    },
  });
};
