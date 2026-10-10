// The Casual Leave board for a month, with everyone in it (production employees too, named as not eligible). The shared
// useCasualLeaveEligibility only asks for staff and types the older fields; this page needs the reasons.

import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
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
