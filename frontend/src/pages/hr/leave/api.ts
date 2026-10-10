// Hooks only this page uses (leave balances and types, holiday edits). The generated client and custom-hooks files are
// shared, so what the redesigned Leave & Holiday page added lives here.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type { HolidayItem } from "@/lib/api-client";
import type { LeaveBalanceRow } from "./logic";

export type LeaveTypeItem = {
  id: number;
  name: string;
  code: string;
  maxDaysPerYear: number;
  carryForward: boolean;
  maxCarryForwardDays: number;
  isPaid: boolean;
  applicableGender: string;
  isActive: boolean;
};

export const useLeaveTypes = () =>
  useQuery<LeaveTypeItem[]>({
    queryKey: ["/api/leave-types"] as const,
    queryFn: () => customFetch<LeaveTypeItem[]>("/api/leave-types"),
  });

export const useLeaveBalances = (year: number) =>
  useQuery<LeaveBalanceRow[]>({
    queryKey: ["/api/leave-balances", year] as const,
    queryFn: () => customFetch<LeaveBalanceRow[]>(`/api/leave-balances?year=${year}`),
  });

export type AllocateInput = { employeeId: number; leaveTypeId: number; year: number; allocated: number };

export const useAllocateLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: AllocateInput) =>
      customFetch<LeaveBalanceRow>("/api/leave-balances/allocate", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/leave-balances"] }),
  });
};

export type LeaveTypeInput = {
  name: string;
  code: string;
  maxDaysPerYear: number;
  carryForward: boolean;
  maxCarryForwardDays: number;
  isPaid: boolean;
};

export const useCreateLeaveType = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: LeaveTypeInput) =>
      customFetch<LeaveTypeItem>("/api/leave-types", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/leave-types"] }),
  });
};

export type HolidayInput = {
  name: string;
  date: string;
  holidayType: string;
  description?: string;
  isRecurring: boolean;
  /** null = every branch. */
  branchId: number | null;
};

const refreshHolidays = (queryClient: ReturnType<typeof useQueryClient>) =>
  queryClient.invalidateQueries({ queryKey: ["/api/holidays"] });

/** Adds a holiday, or changes one when `id` is given. The shared hook cannot send a branch or the recurring flag. */
export const useSaveHoliday = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id?: number; data: HolidayInput }) =>
      customFetch<HolidayItem>(id ? `/api/holidays/${id}` : "/api/holidays", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => refreshHolidays(queryClient),
  });
};
