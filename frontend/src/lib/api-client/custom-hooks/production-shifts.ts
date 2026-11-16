// production-shifts: the Production shifts of Manage Shifts (backend/api/production_special_shifts_views.py, owner
// 2026-11-16). The DEFAULT production shifts are the groups of Settings -> Production Shifts (edited there only; every
// production worker is on them); a SPECIAL shift is a complete shift of its own (start, standard departure, the days it
// applies to, its Earned Shift table) made here for chosen workers, who are judged and paid by it on its dates and days.
// Shift values are JSON numbers both ways (0.25), like Settings. A refusal is {"error": "<one sentence>"}.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ProductionShiftAppliesOn, ProductionShiftBreak, ProductionShiftGroup } from "./production-shift-rules";

export type SpecialAssignmentState = "active" | "upcoming" | "ended";

export type SpecialShiftAssignment = {
  id: number;
  groupId: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  effectiveFrom: string;
  /** The last day on it (included); null = until further notice. */
  effectiveTo: string | null;
  note: string;
  state: SpecialAssignmentState;
};

export type SpecialProductionShift = ProductionShiftGroup & {
  assignments: SpecialShiftAssignment[];
  /** Workers on it today. */
  activeCount: number;
  /** Anybody was ever put on it: it can no longer be deleted (switch it off instead). */
  everAssigned: boolean;
};

export type ProductionShifts = {
  enabled: boolean;
  effectiveFrom: string | null;
  graceMinutes: number;
  minCredit: number;
  roundingStep: number;
  fullDayValue: number;
  breaks: ProductionShiftBreak[];
  /** The Settings shift groups: every production worker's shifts unless on a special one. */
  defaults: ProductionShiftGroup[];
  special: SpecialProductionShift[];
  roster: { production: number; onSpecialToday: number };
  today: string;
};

/** What a change answers: the whole picture again, plus warnings (days already worked out are worked out again). */
export type ProductionShiftsResult = ProductionShifts & { warnings?: string[]; assigned?: number };

/** A special shift as sent: the group's own fields and its Earned Shift rows (a new row has no id). */
export type SpecialShiftInput = {
  label: string;
  appliesOn: ProductionShiftAppliesOn;
  startTime: string;
  mainOutTime: string | null;
  mainOutNextDay: boolean;
  enabled: boolean;
  rules: { id?: number; label: string; outTime: string; outNextDay: boolean; shiftValue: number; enabled: boolean }[];
};

const PATH = "/api/shifts/production";
export const getProductionShiftsQueryKey = () => [PATH] as const;

export const useProductionShifts = (enabled = true) =>
  useQuery<ProductionShifts>({
    queryKey: getProductionShiftsQueryKey(),
    queryFn: () => customFetch<ProductionShifts>(PATH),
    enabled,
  });

/** Every change answers the new picture: put it in the cache (and refresh what depends on who is on which shift). */
function useProductionShiftsMutation<V>(request: (vars: V) => Promise<ProductionShiftsResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (data) => {
      queryClient.setQueryData(getProductionShiftsQueryKey(), data);
      void queryClient.invalidateQueries({ queryKey: ["/api/attendance"] });
    },
  });
}

const json = (method: string, body?: unknown) => ({
  method,
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

export const useSaveSpecialShift = () =>
  useProductionShiftsMutation(({ id, data }: { id?: number; data: SpecialShiftInput }) =>
    customFetch<ProductionShiftsResult>(
      id ? `${PATH}/special/${id}` : `${PATH}/special`,
      json(id ? "PUT" : "POST", data),
    ),
  );

export const useSwitchSpecialShift = () =>
  useProductionShiftsMutation(({ id, enabled }: { id: number; enabled: boolean }) =>
    customFetch<ProductionShiftsResult>(`${PATH}/special/${id}`, json("PUT", { enabled })),
  );

/** `force`: one that has had workers on it (they are taken off it too, their days back on the default shifts). */
export const useDeleteSpecialShift = () =>
  useProductionShiftsMutation(({ id, force = false }: { id: number; force?: boolean }) =>
    customFetch<ProductionShiftsResult>(`${PATH}/special/${id}${force ? "?force=1" : ""}`, json("DELETE")),
  );

export const useAssignSpecialShift = () =>
  useProductionShiftsMutation(
    ({
      id,
      employeeIds,
      effectiveFrom,
      effectiveTo,
      note,
    }: {
      id: number;
      employeeIds: number[];
      effectiveFrom: string;
      effectiveTo?: string | null;
      note?: string;
    }) =>
      customFetch<ProductionShiftsResult>(
        `${PATH}/special/${id}/assign`,
        json("POST", { employeeIds, effectiveFrom, effectiveTo: effectiveTo || null, note: note ?? "" }),
      ),
  );

export const useEndSpecialAssignment = () =>
  useProductionShiftsMutation(({ id, lastDay }: { id: number; lastDay: string }) =>
    customFetch<ProductionShiftsResult>(`${PATH}/special-assignments/${id}/end`, json("POST", { lastDay })),
  );

/** Take a worker off a special shift. `force`: one that has started (every day it covered goes back to the defaults). */
export const useRemoveSpecialAssignment = () =>
  useProductionShiftsMutation(({ id, force = false }: { id: number; force?: boolean }) =>
    customFetch<ProductionShiftsResult>(`${PATH}/special-assignments/${id}${force ? "?force=1" : ""}`, json("DELETE")),
  );
