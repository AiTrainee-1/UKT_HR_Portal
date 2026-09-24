// requests: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

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
export const getListEmployeeRequestsQueryKey = (params?: Record<string, string>) =>
  ["/api/employee-requests", params] as const;
export const getListAdvancesQueryKey = (params?: Record<string, string>) => ["/api/advances", params] as const;

// ── Employee Requests ─────────────────────────────────────────────────────────

export const listEmployeeRequests = (params?: { requestType?: string; status?: string }) => {
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
      customFetch<{ id: number; status: string }>(`/api/employee-requests/${id}/action`, {
        method: "PUT",
        body: JSON.stringify({ status, hrNotes, handledBy }),
      }),
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
    mutationFn: (id: number) => customFetch<void>(`/api/advances/${id}`, { method: "DELETE" }),
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
      advanceId,
      data,
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
      customFetch<{ repayment: AdvanceRepaymentItem; advance: Advance }>(`/api/advances/${advanceId}/repayments`, {
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
    mutationFn: (id: number) => customFetch<void>(`/api/permissions/${id}`, { method: "DELETE" }),
  });

export const useDeleteLeaveRequest = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/leave-requests/${id}`, { method: "DELETE" }),
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

export const useListCasualLeaves = (params?: { status?: string; month?: number; year?: number }, enabled = true) => {
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
    queryFn: () => customFetch<CasualLeaveEligibility>(`/api/casual-leaves/eligibility?month=${month}&year=${year}`),
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
    mutationFn: (id: number) => customFetch<{ ok: boolean }>(`/api/casual-leaves/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
    },
  });
};
