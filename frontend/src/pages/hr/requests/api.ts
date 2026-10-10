// Requests hub: the data hooks of the page. They live here (not in lib/api-client) because only this page uses them.

import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { normalizeHub, type HubItem, type HubResponse, type KindKey } from "./logic";

export const HUB_KEY = "/api/hr-requests";

/** The list the page shows: every kind in one response. Refreshes by itself every 30 seconds. */
export function useHubRequests(params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  return useQuery<HubResponse>({
    queryKey: [HUB_KEY, params],
    queryFn: async () => normalizeHub(await customFetch<Partial<HubResponse>>(`/api/hr-requests?${qs}`)),
    refetchInterval: 30_000,
    // while a filter change loads, the list stays on screen instead of flashing the loader
    placeholderData: keepPreviousData,
  });
}

export type Decision = {
  item: Pick<HubItem, "kind" | "id">;
  status: "approved" | "rejected";
  /** The reason HR gives; optional. */
  comment?: string;
};

type Call = { url: string; method: "PATCH" | "PUT"; body: Record<string, unknown> };

/** The decision endpoint of each kind that can be decided with a button, and the body it reads. Each endpoint runs the
 *  request through its approval pipeline (backend/api/approval_workflow.py): this page never decides by itself. */
export function decisionCall({ item, status, comment }: Decision): Call | null {
  const note = comment?.trim() || undefined;
  switch (item.kind) {
    case "leave":
      return { url: `/api/leave-requests/${item.id}/status`, method: "PATCH", body: { status, hrComment: note } };
    case "permission":
      return { url: `/api/permissions/${item.id}`, method: "PUT", body: { status, hrComment: note } };
    case "casual_leave":
      return { url: `/api/casual-leaves/${item.id}`, method: "PATCH", body: { status, comment: note } };
    case "missing_punch":
      return { url: `/api/missing-punch-requests/${item.id}/status`, method: "PATCH", body: { status, comment: note } };
    case "on_duty":
      return { url: `/api/on-duty-sessions/${item.id}/status`, method: "PATCH", body: { status, comment: note } };
    case "outpass":
      return { url: `/api/outpass-requests/${item.id}/hr-status`, method: "PUT", body: { status, comment: note } };
    default:
      return null;
  }
}

/** The list queries other pages keep for each kind: dropped after a decision so Leave, Casual Leave ... never show stale rows. */
const OTHER_KEYS: Partial<Record<KindKey, string>> = {
  leave: "/api/leave-requests",
  permission: "/api/permissions",
  casual_leave: "/api/casual-leaves",
  missing_punch: "/api/missing-punch-requests",
  on_duty: "/api/on-duty-sessions",
  outpass: "/api/outpass-requests",
  request: "/api/employee-requests",
};

export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (decision: Decision) => {
      const call = decisionCall(decision);
      if (!call) throw new Error("This kind of request is decided on its own page.");
      return customFetch<unknown>(call.url, { method: call.method, body: JSON.stringify(call.body) });
    },
    onSuccess: (_data, { item }) => {
      queryClient.invalidateQueries({ queryKey: [HUB_KEY] });
      const other = OTHER_KEYS[item.kind];
      if (other) queryClient.invalidateQueries({ queryKey: [other] });
    },
  });
}

export type RequestHandling = { id: number; status: string; hrNotes?: string; handledBy?: string };

/** A general employee request: HR sets its status and notes (PUT /api/employee-requests/<id>/action). */
export function useHandleRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, hrNotes, handledBy }: RequestHandling) =>
      customFetch<{ id: number; status: string }>(`/api/employee-requests/${id}/action`, {
        method: "PUT",
        body: JSON.stringify({ status, hrNotes, handledBy }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [HUB_KEY] });
      queryClient.invalidateQueries({ queryKey: [OTHER_KEYS.request!] });
    },
  });
}
