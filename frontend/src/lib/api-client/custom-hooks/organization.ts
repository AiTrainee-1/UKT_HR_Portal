// organization: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { Employee } from "../generated/api.schemas";

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

// ── Query Keys ────────────────────────────────────────────────────────────────

export const getListBranchesQueryKey = () => ["/api/branches"] as const;
export const getListDesignationsQueryKey = (params?: { departmentId?: number }) =>
  ["/api/designations", params] as const;
export const getListShiftsQueryKey = () => ["/api/shifts"] as const;
export const getSearchEmployeesQueryKey = (search: string) => ["/api/employees", "search", search] as const;

// ── Branches ──────────────────────────────────────────────────────────────────

export const listBranches = () => customFetch<Branch[]>("/api/branches");

export const useListBranches = <TData = Branch[]>(options?: UseQueryOptions<Branch[], unknown, TData>) =>
  useQuery<Branch[], unknown, TData>({
    queryKey: getListBranchesQueryKey(),
    queryFn: listBranches,
    ...options,
  });

// The orval-generated useCreateDepartment (generated/api.ts) types its body
// as DepartmentInput = {name, description} -stale against the backend,
// which has required an explicit branchId for any unscoped (super admin /
// branch-less) HR user ever since department creation became branch-scoped
// (views.py::_departments_create). Departments.tsx's create dialog never
// collected or sent one, so every unscoped user's "Add Department" silently
// 400'd with no branch field on screen to explain why. Named distinctly
// from the generated hook (not useCreateDepartment) -both are re-exported
// through the same `export *` barrel in index.ts, and two same-named
// exports there would silently shadow one another with no compile error.
export type CreateDepartmentInput = { name: string; description?: string; branchId?: number };

export const useCreateDepartmentWithBranch = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateDepartmentInput) =>
      customFetch<{ id: number; name: string; description: string | null; employeeCount: number }>("/api/departments", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/departments"] });
    },
  });
};

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
    mutationFn: (id: number) => customFetch<void>(`/api/branches/${id}`, { method: "DELETE" }),
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
    mutationFn: (id: number) => customFetch<void>(`/api/designations/${id}`, { method: "DELETE" }),
  });

// ── Shift Templates ────────────────────────────────────────────────────────────

export const listShifts = () => customFetch<ShiftTemplate[]>("/api/shifts");

export const useListShifts = <TData = ShiftTemplate[]>(options?: UseQueryOptions<ShiftTemplate[], unknown, TData>) =>
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
    mutationFn: (id: number) => customFetch<void>(`/api/shifts/${id}`, { method: "DELETE" }),
  });

// ── Employee Search & Assignment ─────────────────────────────────────────────

export const useSearchEmployees = (search: string, enabled = true) =>
  useQuery({
    queryKey: getSearchEmployeesQueryKey(search),
    queryFn: () => {
      const qs = new URLSearchParams({ search, status: "active" });
      return customFetch<import("../generated/api.schemas").Employee[]>(`/api/employees?${qs}`);
    },
    enabled: enabled && search.trim().length >= 2,
    staleTime: 10_000,
  });

export const useAssignEmployee = () =>
  useMutation({
    mutationFn: ({
      id,
      departmentId,
      designationId,
    }: {
      id: number;
      departmentId?: number | null;
      designationId?: number | null;
    }) =>
      customFetch<import("../generated/api.schemas").Employee>(`/api/employees/${id}`, {
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
    mutationFn: (id: number) => customFetch<void>(`/api/shift-assignments/${id}`, { method: "DELETE" }),
  });

export const useUpdateShiftAssignment = () =>
  useMutation({
    mutationFn: ({
      id,
      data,
    }: {
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

export const getListHolidaysQueryKey = (params?: { year?: number }) => ["/api/holidays", params] as const;

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
    mutationFn: (id: number) => customFetch<void>(`/api/holidays/${id}`, { method: "DELETE" }),
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
  canApproveAttendance: boolean;
  canApproveCasualLeave: boolean;
  canApproveOnDuty: boolean;
  isActive: boolean;
  notes?: string | null;
  createdAt?: string | null;
  departmentCount: number;
  employeeCount: number;
  /** IDs of the employees reporting to this manager. Used by User Management
   *  to work out which staff report to nobody. */
  assignedEmployeeIds?: number[];
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
    mutationFn: (id: number) => customFetch(`/api/department-managers/${id}`, { method: "DELETE" }),
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

// Thrown by manager_employee_assignments as a 409 (see ApiError.data) when
// the employee is already actively assigned to a DIFFERENT HOD -either
// directly, or via their department being assigned elsewhere. Not an error
// to just toast: the caller re-POSTs with force:true to confirm the
// reassignment, or leaves the existing assignment alone.
export type EmployeeAssignmentConflict = {
  conflict: true;
  conflictType: "direct" | "department";
  existingManager: { id: number; employeeId: number; employeeName: string; employeeCode: string };
  error: string;
};

export const useAssignEmployeeToManager = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ managerId, employeeCode, force }: { managerId: number; employeeCode: string; force?: boolean }) =>
      customFetch(`/api/department-managers/${managerId}/employees`, {
        method: "POST",
        body: JSON.stringify({ employeeCode, force }),
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

// ── Employees: real server-side pagination ──────────────────────────────────
// Separate from the generated useListEmployees (which still fetches every
// matching employee in one call, unpaginated -that hook's callers elsewhere
// are untouched) because /api/employees only returns the new paginated
// envelope when a `page` param is present; without one it replies with the
// exact same bare array it always has. This hook is what actually asks for
// a page, so only the employees the visible page needs -- their photos
// included -are ever fetched.

export type PaginatedEmployeesParams = {
  page: number;
  pageSize: number;
  employmentType?: "staff" | "production";
  status?: string;
  departmentId?: number;
  designationId?: number;
  branchId?: number;
  search?: string;
};

export type PaginatedEmployeesResult = {
  results: Employee[];
  count: number;
  staffCount: number;
  productionCount: number;
  page: number;
  pageSize: number;
};

function employeesQueryString(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      qs.set(key, String(value));
    }
  }
  return qs.toString();
}

export const getListEmployeesPaginatedQueryKey = (params: PaginatedEmployeesParams) =>
  ["/api/employees", "paginated", params] as const;

export const useListEmployeesPaginated = (params: PaginatedEmployeesParams) =>
  useQuery<PaginatedEmployeesResult>({
    queryKey: getListEmployeesPaginatedQueryKey(params),
    queryFn: () => customFetch<PaginatedEmployeesResult>(`/api/employees?${employeesQueryString(params)}`),
    // Keeps the previous page's rows on screen while the next page loads,
    // instead of the table flashing empty on every click -DataPagination's
    // Next/Previous should feel instant even though it now genuinely
    // triggers a network request.
    placeholderData: (prev) => prev,
  });

/** A bare count, for badges like "Inactive (12)" -avoids fetching every
 * inactive employee's full record (photo included) just to read `.length`. */
export const useEmployeeCount = (
  params: Omit<PaginatedEmployeesParams, "page" | "pageSize">,
  options?: { enabled?: boolean },
) =>
  useQuery<number>({
    queryKey: ["/api/employees", "countOnly", params] as const,
    queryFn: async () => {
      const body = await customFetch<{ count: number }>(
        `/api/employees?${employeesQueryString({ ...params, countOnly: 1 })}`,
      );
      return body.count;
    },
    enabled: options?.enabled ?? true,
  });

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
