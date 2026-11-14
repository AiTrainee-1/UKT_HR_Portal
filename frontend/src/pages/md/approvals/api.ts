// HOD approvals: the data hooks. The list of Department Heads is shared by the page's tabs and the sidebar's sub-menu
// (one query key, so both refresh together).
import { useMutation, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { useMdQuery } from "@/lib/api-client/custom-hooks/md";
import type { DecideInput, DecideResponse, HodRequestsResponse, HodsResponse, RequestStatusFilter } from "./types";

/** The MD department's Department Heads, refreshed every minute so a head added in User Management shows up by itself. */
export const useMdHods = (options: { enabled?: boolean } = {}) =>
  useMdQuery<HodsResponse>("approvals/hods", undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
    enabled: options.enabled,
  });

export const useHodRequests = (managerId: number | undefined, status: RequestStatusFilter) =>
  useMdQuery<HodRequestsResponse>(`approvals/hods/${managerId ?? 0}`, { status }, { enabled: managerId != null });

/** Every MD query of this page (the heads and every head's lists): what a decision changes. */
export const isApprovalsKey = (key: QueryKey) =>
  key[0] === "/api/md" && typeof key[1] === "string" && key[1].startsWith("approvals/");

/** Approve or reject at a Department Head's step. Refreshes the heads (their counts) and every list afterwards. */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ managerId, ...body }: DecideInput) =>
      customFetch<DecideResponse>(`/api/md/approvals/hods/${managerId}/decide`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSettled: () => queryClient.invalidateQueries({ predicate: (q) => isApprovalsKey(q.queryKey) }),
  });
}
