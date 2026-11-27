// MD portal -> Settlement: the data hooks. The month's batches, the count waiting for the MD (the sidebar's badge, refreshed
// every minute), a decision on one request and Confirm & Proceed. Every write answers the whole updated batch, which
// replaces the batch on screen at once (no second round trip).
import { useMutation, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { parseMonthKey, type MonthKey } from "@/components/md/kit/MonthPicker";
import { ApiError, customFetch } from "@/lib/api-client/custom-fetch";
import { useMdQuery } from "@/lib/api-client/custom-hooks/md";
import type { LeaveCalendarData } from "@/components/leave-calendar/LeaveCalendar";
import type {
  AdvanceType,
  BulkBody,
  BulkReply,
  ConfirmMode,
  ConfirmReply,
  DecideBody,
  MdSettlementMonth,
  MdSettlementWaiting,
  ReturnBody,
  SettlementBatch,
} from "./types";

const MONTH_PATH = "settlement/month";
const WAITING_PATH = "settlement/waiting";

/** The month's forwarded batches of one type (the MD sees nothing HR has not forwarded). Off until the type is known. */
export function useSettlementMonth(month: MonthKey, type: AdvanceType | null) {
  const { year, month: m } = parseMonthKey(month);
  return useMdQuery<MdSettlementMonth>(
    MONTH_PATH,
    { month: m, year, type: type ?? "general" },
    { staleTime: 15_000, refetchInterval: 60_000, enabled: type !== null },
  );
}

/** The batches waiting for the MD, every month; `count` is the requests in them. Shared by the sidebar and the page. */
export const useSettlementWaiting = () =>
  useMdQuery<MdSettlementWaiting>(WAITING_PATH, undefined, { staleTime: 30_000, refetchInterval: 60_000 });

const isMdKey = (key: QueryKey, path: string) => key[0] === "/api/md" && key[1] === path;
export const isSettlementKey = (key: QueryKey) =>
  key[0] === "/api/md" && typeof key[1] === "string" && key[1].startsWith("settlement/");

/** Put the server's updated batch in every cached month that shows it. */
export function putBatch(queryClient: QueryClient, batch: SettlementBatch) {
  queryClient.setQueriesData<MdSettlementMonth>({ predicate: (q) => isMdKey(q.queryKey, MONTH_PATH) }, (old) =>
    old && old.batches.some((b) => b.id === batch.id)
      ? { ...old, batches: old.batches.map((b) => (b.id === batch.id ? batch : b)) }
      : old,
  );
}

/** The refusal's machine code ("remark", "amount", "stage", "undecided" ...), when the server gave one. */
export function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const data = error.data as { code?: unknown } | null;
  return typeof data?.code === "string" ? data.code : null;
}

/** The ids the server says still need a decision (Confirm & Proceed's 400 `undecided`). */
export function undecidedIds(error: unknown): number[] {
  if (!(error instanceof ApiError)) return [];
  const data = error.data as { undecided?: unknown } | null;
  return Array.isArray(data?.undecided) ? data.undecided.filter((x): x is number => typeof x === "number") : [];
}

/** The ids the server says the MD changed from HR's proposal (Confirm & Proceed's 409 `has_changes`). */
export function changedIds(error: unknown): number[] {
  if (errorCode(error) !== "has_changes" || !(error instanceof ApiError)) return [];
  const data = error.data as { changed?: unknown } | null;
  return Array.isArray(data?.changed) ? data.changed.filter((x): x is number => typeof x === "number") : [];
}

/** A refusal that means the page is out of date (the batch moved on, the request is gone): load it again. */
const isStale = (error: unknown) =>
  errorCode(error) === "stage" ||
  errorCode(error) === "not_found" ||
  (error instanceof ApiError && error.status === 409);

export type DecideInput = DecideBody & { id: number };

/** The MD's decision on one request (approve, a smaller amount, reject, or "" to clear it). */
export function useDecideItem() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: DecideInput) =>
      customFetch<SettlementBatch>(`/api/md/settlement/items/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    // a refresh already on its way would land after the reply and show the batch as it was before this decision
    onMutate: () => queryClient.cancelQueries({ predicate: (q) => isMdKey(q.queryKey, MONTH_PATH) }),
    onSuccess: (batch) => putBatch(queryClient, batch),
    onError: (error) => {
      if (isStale(error)) void queryClient.invalidateQueries({ predicate: (q) => isSettlementKey(q.queryKey) });
    },
  });
}

/** Several requests at once (owner 2026-11-27): approve (HR's proposed amount, else the full amount asked) or reject (one
 *  reason for all). The reply is the batch plus the requests the server left out, and why. */
export function useBulkDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ batchId, ...body }: BulkBody & { batchId: number }) =>
      customFetch<BulkReply>(`/api/md/settlement/batches/${batchId}/bulk`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onMutate: () => queryClient.cancelQueries({ predicate: (q) => isMdKey(q.queryKey, MONTH_PATH) }),
    onSuccess: ({ skipped: _skipped, ...batch }) => putBatch(queryClient, batch),
    onError: (error) => {
      if (isStale(error)) void queryClient.invalidateQueries({ predicate: (q) => isSettlementKey(q.queryKey) });
    },
  });
}

export type ConfirmInput = {
  id: number;
  note: string;
  mode: ConfirmMode;
  /** Direct to Auditor: the finalized report the page built (the same files HR's Send to Auditor sends). */
  files?: { pdf: File; xlsx: File };
};

/** The body of Confirm & Proceed: JSON for Forward to HR; multipart with the report for Direct to Auditor. */
export function confirmBody({ note, mode, files }: Omit<ConfirmInput, "id">): string | FormData {
  if (mode !== "direct") return JSON.stringify({ note, mode: "hr" });
  const form = new FormData();
  form.append("note", note);
  form.append("mode", "direct");
  if (files) {
    form.append("pdf", files.pdf, files.pdf.name);
    form.append("xlsx", files.xlsx, files.xlsx.name);
  }
  return form;
}

/** Confirm & Proceed: Forward to HR (HR Final Settlement), or Direct to Auditor (the MD's decisions are the final
 *  settlement and go to the auditor at once; `warning` when that e-mail failed and the batch waits at Send to Auditor). */
export function useConfirmBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...rest }: ConfirmInput) =>
      customFetch<ConfirmReply>(`/api/md/settlement/batches/${id}/confirm`, {
        method: "POST",
        body: confirmBody(rest),
      }),
    onSuccess: ({ warning: _warning, ...batch }) => {
      putBatch(queryClient, batch);
      void queryClient.invalidateQueries({ predicate: (q) => isSettlementKey(q.queryKey) });
    },
    onError: (error) => {
      if (isStale(error) || errorCode(error) === "undecided")
        void queryClient.invalidateQueries({ predicate: (q) => isSettlementKey(q.queryKey) });
    },
  });
}

/** Return to HR for rework (2026-11-27): the MD changed amounts / rejected requests or asks for corrections. Refused
 *  400 `no_changes` when there is no change, no remark of the MD's and no note for HR. */
export function useReturnBatch() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number } & ReturnBody) =>
      customFetch<SettlementBatch>(`/api/md/settlement/batches/${id}/return`, {
        method: "POST",
        body: JSON.stringify({ note }),
      }),
    onMutate: () => queryClient.cancelQueries({ predicate: (q) => isMdKey(q.queryKey, MONTH_PATH) }),
    onSuccess: (batch) => {
      putBatch(queryClient, batch);
      void queryClient.invalidateQueries({ predicate: (q) => isSettlementKey(q.queryKey) });
    },
    // no_changes: the page's copy thought there was something to rework - load the batch again
    onError: (error) => {
      if (isStale(error) || errorCode(error) === "no_changes")
        void queryClient.invalidateQueries({ predicate: (q) => isSettlementKey(q.queryKey) });
    },
  });
}

/** A request's Leave calendar (the month it was raised in, the leave days of the counted days in red). */
export const loadLeaveCalendar = (itemId: number) =>
  customFetch<LeaveCalendarData>(`/api/md/settlement/items/${itemId}/leave-calendar`);
