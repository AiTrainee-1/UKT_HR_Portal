// growth: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

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
    mutationFn: (id: number) => customFetch<{ ok: boolean }>(`/api/promotions/${id}`, { method: "DELETE" }),
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
    queryFn: () => customFetch<IncrementSummary>(`/api/increments/summary?code=${encodeURIComponent(code)}`),
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
//  Statutory Bonus (Payment of Bonus Act) -Bonus.tsx
// ═══════════════════════════════════════════════════════════════════════════

export type BonusCalculationRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  employmentType: string | null;
  monthlyWage: number;
  eligible: boolean;
  reason: string | null;
  recordsConsidered: number;
  calculationBase: number;
  bonusPercent: number;
  bonusAmount: number;
};

export type BonusCalculateResult = {
  financialYear: string;
  results: BonusCalculationRow[];
  totalEmployees: number;
  totalEligible: number;
  totalBonusAmount: number;
  avgBonusAmount: number;
};

export type BonusItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  financialYear: string;
  recordsConsidered: number;
  calculationBase: number;
  bonusPercentApplied: number;
  bonusAmount: number;
  status: "calculated" | "approved" | "paid";
  notes: string | null;
  computedBy: string | null;
  createdAt: string | null;
};

export const useBonusCalculate = (financialYear: string, enabled = true) =>
  useQuery<BonusCalculateResult>({
    queryKey: ["/api/bonus/calculate", financialYear],
    queryFn: () =>
      customFetch<BonusCalculateResult>(`/api/bonus/calculate?financialYear=${encodeURIComponent(financialYear)}`),
    enabled: enabled && !!financialYear,
  });

export const useBonusList = (financialYear: string, enabled = true) =>
  useQuery<{ results: BonusItem[] }>({
    queryKey: ["/api/bonus", financialYear],
    queryFn: () =>
      customFetch<{ results: BonusItem[] }>(`/api/bonus?financialYear=${encodeURIComponent(financialYear)}`),
    enabled: enabled && !!financialYear,
  });

export const useGenerateBonus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (financialYear: string) =>
      customFetch<{ financialYear: string; generated: number }>("/api/bonus/generate", {
        method: "POST",
        body: JSON.stringify({ financialYear }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bonus"] });
      queryClient.invalidateQueries({ queryKey: ["/api/bonus/calculate"] });
    },
  });
};

export const useUpdateBonus = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: { status?: BonusItem["status"]; notes?: string } }) =>
      customFetch<BonusItem>(`/api/bonus/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bonus"] });
    },
  });
};
