// Employee Enquiries (2026-11-24): questions employees raise from the mobile app, handled here as a to-do list
// (backend/api/enquiry_views.py).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

export type EnquiryStatus = "pending" | "on_hold" | "done";

export type EnquiryHistoryItem = { at: string; by: string; status: EnquiryStatus; reply: string | null };

export type EnquiryItem = {
  id: number;
  category: string;
  categoryLabel: string;
  subject: string;
  message: string;
  status: EnquiryStatus;
  statusLabel: string;
  hrReply: string | null;
  handledBy: string | null;
  handledAt: string | null;
  doneAt: string | null;
  history: EnquiryHistoryItem[];
  createdAt: string | null;
  updatedAt: string | null;
  employee?: {
    id: number;
    employeeCode: string;
    name: string;
    department: string | null;
    designation: string | null;
    branch: string | null;
    phone: string | null;
    photoUrl: string | null;
  };
};

export type EnquiryCounts = { pending: number; onHold: number; done: number; all: number };

export type EnquirySummary = {
  pending: number;
  onHold: number;
  done: number;
  latest: { id: number; subject: string; employeeName: string; createdAt: string } | null;
};

export const ENQUIRIES_KEY = "/api/enquiries";

export function useEnquiries(params: { status: EnquiryStatus | "all"; q?: string; category?: string }) {
  const search = new URLSearchParams({ status: params.status });
  if (params.q?.trim()) search.set("q", params.q.trim());
  if (params.category) search.set("category", params.category);
  return useQuery({
    queryKey: [ENQUIRIES_KEY, params.status, params.q ?? "", params.category ?? ""],
    queryFn: () => customFetch<{ items: EnquiryItem[]; counts: EnquiryCounts }>(`/api/enquiries?${search.toString()}`),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
}

/** The pending count for the sidebar badge and the newest waiting one (the "new enquiry" toast). */
export function useEnquirySummary(enabled = true) {
  return useQuery({
    queryKey: [ENQUIRIES_KEY, "summary"],
    queryFn: () => customFetch<EnquirySummary>("/api/enquiries/summary"),
    refetchInterval: 30_000,
    enabled,
  });
}

export function useUpdateEnquiry() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, reply }: { id: number; status?: EnquiryStatus; reply?: string }) =>
      customFetch<EnquiryItem>(`/api/enquiries/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...(status ? { status } : {}), ...(reply?.trim() ? { reply: reply.trim() } : {}) }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [ENQUIRIES_KEY] }),
  });
}
