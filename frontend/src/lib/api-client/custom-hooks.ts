import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

export type Branch = {
  id: number;
  name: string;
  location?: string | null;
  address?: string | null;
  managerName?: string | null;
  phone?: string | null;
  isActive: boolean;
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

export type Role = {
  id: number;
  name: string;
  description?: string | null;
  permissions: Record<string, Record<string, boolean>>;
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
      location?: string;
      address?: string;
      managerName?: string;
      phone?: string;
    }) =>
      customFetch<Branch>("/api/branches", {
        method: "POST",
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
      permissions?: Record<string, Record<string, boolean>>;
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
  summary: { present: number; absent: number; onLeave: number; late: number };
  records: {
    date: string;
    day: string;
    status: string;
    present: boolean;
    firstPunch?: string | null;
    lastPunch?: string | null;
    totalPunches: number;
    punches: { time: string; type: string; source: string }[];
    hoursWorked?: string | null;
    source?: string | null;
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
    mutationFn: ({ id, data }: { id: number; data: { status: string; hrComment?: string; approvedBy?: string } }) =>
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
};

// ── Report Log types ──────────────────────────────────────────────────────────

export type ShiftLogEntry = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  employmentType: string;
  date: string;
  shiftName?: string | null;
  punch1?: string | null;   // morning IN
  punch2?: string | null;   // lunch OUT
  punch3?: string | null;   // lunch IN
  punch4?: string | null;   // evening OUT
  totalPunches: number;
  firstHalf: boolean;
  secondHalf: boolean;
  shiftsCompleted: string;  // Decimal as string, e.g. "1.00"
  lateMorning: boolean;
  lateReturn: boolean;
  lateReason?: string | null;
  computedAt?: string | null;
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

export const useSyncBiometric = () =>
  useMutation({
    mutationFn: (mode: "today" | "days3" | "days7" | "month" | "prevmonth" | "all" = "today") =>
      customFetch<SyncResult>("/api/attendance/sync-biometric", {
        method: "POST",
        body: JSON.stringify({ mode }),
      }),
  });

export const getReportLogQueryKey = (params: { date?: string; month?: number; year?: number; employeeId?: number }) =>
  ["/api/attendance/report-log", params] as const;

export const useAttendanceReportLog = (params: { date?: string; month?: number; year?: number; employeeId?: number }, enabled = true) =>
  useQuery<ShiftLogEntry[]>({
    queryKey: getReportLogQueryKey(params),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (params.date) qs.set("date", params.date);
      if (params.month) qs.set("month", String(params.month));
      if (params.year) qs.set("year", String(params.year));
      if (params.employeeId) qs.set("employeeId", String(params.employeeId));
      return customFetch<ShiftLogEntry[]>(`/api/attendance/report-log?${qs}`);
    },
    enabled,
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
  isHalfShift?: boolean;
  shiftsCompleted?: number;
  firstIn?: string | null;
  lastOut?: string | null;
  leaveType?: string | null;
  // production-only fields
  sessions?: { sessionId: number; sessionName: string; completed: boolean; rate: number }[];
  totalSessions?: number;
  sessionAmount?: number;
  present?: boolean;
};

export type PayrollBreakdown = {
  type: "staff" | "production";
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
  sessionConfigs?: {
    id: number; name: string; startTime: string; endTime: string; minCheckout: string; rate: number;
  }[];
  days: PayrollBreakdownDay[];
  summary: {
    // staff
    totalWorkingDays?: number;
    presentDays?: number;
    paidLeaveDays?: number;
    unpaidLeaveDays?: number;
    absentDays?: number;
    lateDays?: number;
    halfShiftDays?: number;
    fullShiftDays?: number;
    effectivePaidDays?: number;
    // production
    totalDays?: number;
    daysWorked?: number;
    daysAbsent?: number;
    totalSessions?: number;
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
  };
  deductions: {
    pf?: number;
    esi?: number;
    advances: number;
    advanceDetails: { advanceId: number; repaymentId: number; amount: number; notes?: string | null }[];
    lateShiftPenalty?: number;
    lateSummary?: {
      totalLateCount: number;
      permissionsUsed: number;
      billableLateCount: number;
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
  salaryMode: string;
  month: number;
  year: number;
  weekNumber?: number | null;
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

// ── Payroll Settings (singleton — PF/ESI rates) ───────────────────────────────

export type PayrollSettingsItem = {
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
  // Salary slip header & signature
  slipCompanyName: string;
  slipCompanyAddress: string;
  minWageRate: number;
  signatureImage: string | null;
  // Resignation letter assets
  companyLogo: string | null;
  authorizedSignature: string | null;
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

export const useEmailSalarySlip = () =>
  useMutation({
    mutationFn: ({ id, toEmail }: { id: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string }>(`/api/salary-slips/${id}/email`, {
        method: "POST",
        body: JSON.stringify({ toEmail }),
      }),
  });

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
  const url = `${endpoint}?${qs.toString()}`;

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

export const useResignationEmail = () =>
  useMutation({
    mutationFn: ({ id, toEmail }: { id: number; toEmail?: string }) =>
      customFetch<{ ok: boolean; sentTo: string; pdfAttached: boolean }>(
        `/api/recruitment/resignations/${id}/email`,
        { method: "POST", body: JSON.stringify({ toEmail }) },
      ),
  });

export const useDeleteResignation = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<void>(`/api/recruitment/resignations/${id}/delete`, { method: "DELETE" }),
  });

export const downloadResignationPdf = async (id: number, getToken: () => string | null) => {
  const token = getToken();
  const response = await fetch(`/api/recruitment/resignations/${id}/pdf`, {
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
