// compensation: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation -read-only CTC breakdown (Compensation.tsx)
// ═══════════════════════════════════════════════════════════════════════════

export type CompensationRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  branch: string | null;
  employmentType: string | null;
  basic: number;
  hra: number;
  allowances: number;
  employerPf: number;
  employerEsi: number;
  grossMonthly: number;
  annualCtc: number;
};

export type CompensationParams = {
  departmentId?: number;
  branchId?: number;
  employmentType?: string;
  status?: string;
  search?: string;
};

export const useCompensation = (params: CompensationParams) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  return useQuery<{ results: CompensationRow[]; count: number }>({
    queryKey: ["/api/compensation", params],
    queryFn: () => customFetch<{ results: CompensationRow[]; count: number }>(`/api/compensation?${qs.toString()}`),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation: OT detection + Compensation-Leave announcements
// ═══════════════════════════════════════════════════════════════════════════

export type OvertimeRow = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  date: string;
  shiftEndTime: string | null;
  lastPunchOut: string | null;
  otMinutes: number;
  status: "detected" | "announced" | "rejected";
  compensationType: "pay" | "relaxation" | null;
  announcedBy: string | null;
  announcedAt: string | null;
};

export type OvertimeListResponse = {
  results: OvertimeRow[];
  count: number;
  settings: { otDetectionEnabled: boolean; otThresholdMinutes: number; otCompensationType: "pay" | "relaxation" };
};

export const getOvertimeListQueryKey = (month: number, year: number, status?: string) =>
  ["/api/compensation/ot", month, year, status] as const;

export const useOvertimeList = (month: number, year: number, status?: string) =>
  useQuery<OvertimeListResponse>({
    queryKey: getOvertimeListQueryKey(month, year, status),
    queryFn: () => {
      const qs = new URLSearchParams({ month: String(month), year: String(year) });
      if (status) qs.set("status", status);
      return customFetch<OvertimeListResponse>(`/api/compensation/ot?${qs.toString()}`);
    },
  });

export const useAnnounceOvertime = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { records: { employeeId: number; date: string }[]; compensationType?: "pay" | "relaxation" }) =>
      customFetch<{ announced: number; results: OvertimeRow[] }>("/api/compensation/ot/announce", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/compensation/ot"] });
      queryClient.invalidateQueries({ queryKey: ["/api/compensation/credits"] });
    },
  });
};

export const useRejectOvertime = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { records: { employeeId: number; date: string }[] }) =>
      customFetch<{ rejected: number }>("/api/compensation/ot/reject", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/compensation/ot"] }),
  });
};

export type CompensationCreditRow = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  status: "available" | "used";
  usedDate: string | null;
  sourceDate: string | null;
  createdAt: string | null;
};

export const useCompensationCredits = (params: { employeeId?: number; status?: string } = {}) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  return useQuery<{ results: CompensationCreditRow[]; count: number }>({
    queryKey: ["/api/compensation/credits", params],
    queryFn: () => customFetch(`/api/compensation/credits?${qs.toString()}`),
  });
};

export const useRedeemCompensationCredit = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, date }: { id: number; date: string }) =>
      customFetch(`/api/compensation/credits/${id}/redeem`, { method: "POST", body: JSON.stringify({ date }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/compensation/credits"] }),
  });
};

export type CompensationLeaveDayRow = {
  id: number;
  date: string;
  leaveUntilTime: string | null;
  branch: string | null;
  department: string | null;
  employeeIds: number[];
  employeeCount: number;
  reason: string | null;
  announcedBy: string | null;
  createdAt: string | null;
};

export const useCompensationLeaveDays = (params: { month?: number; year?: number } = {}) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) qs.set(key, String(value));
  }
  return useQuery<{ results: CompensationLeaveDayRow[]; count: number }>({
    queryKey: ["/api/compensation/leave-days", params],
    queryFn: () => customFetch(`/api/compensation/leave-days?${qs.toString()}`),
  });
};

export const useCreateCompensationLeaveDay = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      date: string;
      leaveUntilTime?: string | null;
      branchId?: number | null;
      departmentId?: number | null;
      employeeIds?: number[];
      reason?: string;
    }) => customFetch("/api/compensation/leave-days", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/compensation/leave-days"] }),
  });
};

export const useDeleteCompensationLeaveDay = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/compensation/leave-days/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/compensation/leave-days"] }),
  });
};

export type CompensationBenefitRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  type: "pay" | "relaxation";
  date: string;
  detail: string;
};

export type CompensationSummaryResponse = {
  month: number;
  year: number;
  paidCost: number;
  pendingCostEstimate: number;
  benefiting: CompensationBenefitRow[];
  notBenefiting: CompensationBenefitRow[];
};

export const useCompensationSummary = (month: number, year: number) =>
  useQuery<CompensationSummaryResponse>({
    queryKey: ["/api/compensation/summary", month, year],
    queryFn: () => customFetch<CompensationSummaryResponse>(`/api/compensation/summary?month=${month}&year=${year}`),
  });
