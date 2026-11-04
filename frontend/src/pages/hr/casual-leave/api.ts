// The Casual Leave board for a month, with everyone in it (production employees too, named as not eligible). The shared
// useCasualLeaveEligibility only asks for staff and types the older fields; this page needs the reasons.
// Carry Forward (2026-11-04): detecting an employee's absent / leave days, giving the picked ones as Casual Leave, and the
// log of it (cl_adjustment_views.py).

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type { ClAdjustmentLog, ClAssignSaved, Detection, PickedDate } from "./carry-forward";
import type { ClBoard } from "./logic";

/** Same key prefix as the shared eligibility hook, so creating, deciding or deleting a request (which invalidate that
 *  prefix) refreshes this board too. */
export const clBoardKey = (month: number, year: number) =>
  ["/api/casual-leaves/eligibility", month, year, "board"] as const;

export const useClBoard = (month: number, year: number) =>
  useQuery<ClBoard>({
    queryKey: clBoardKey(month, year),
    queryFn: () => customFetch<ClBoard>(`/api/casual-leaves/eligibility?month=${month}&year=${year}&scope=all`),
  });

const LOG = "/api/casual-leaves/adjustments";
const DETECT = "/api/casual-leaves/absent-dates";

/** The year's log of absent / leave days given as Casual Leave, newest first (all of it: a few hundred at most). */
export const useClAdjustments = (year: number, enabled = true) =>
  useQuery<ClAdjustmentLog>({
    queryKey: [LOG, year],
    queryFn: () => customFetch<ClAdjustmentLog>(`${LOG}?year=${year}&pageSize=500`),
    enabled,
  });

/** Detect each employee's absent and on-leave days of a month (and the month as a calendar). */
export const useDetection = (employeeIds: number[], month: number, year: number, enabled = true) =>
  useQuery<Detection>({
    queryKey: [DETECT, employeeIds.join(","), month, year],
    queryFn: () => customFetch<Detection>(`${DETECT}?employeeIds=${employeeIds.join(",")}&month=${month}&year=${year}`),
    enabled: enabled && employeeIds.length > 0,
    staleTime: 0,
  });

export type ClAssignInput = {
  reason: string;
  items: { employeeId: number; limit: number; dates: PickedDate[] }[];
};

/** Give the picked dates as approved Casual Leave (all or nothing). The attendance of those days, the board, the requests,
 *  every history, the detection and the log are read again. */
export const useAssignCl = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ClAssignInput) =>
      customFetch<ClAssignSaved>("/api/casual-leaves/assign", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => {
      for (const key of [
        "/api/casual-leaves",
        "/api/casual-leaves/eligibility",
        "/api/casual-leaves/history",
        DETECT,
        LOG,
        "/api/attendance/employee-monthly",
      ]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
};
