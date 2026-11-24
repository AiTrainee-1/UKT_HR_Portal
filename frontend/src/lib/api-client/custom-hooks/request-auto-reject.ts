// request-auto-reject: Settings -> Auto-Reject Requests (owner 2026-11-24). Backend: api/request_auto_reject/ (views.py).
// Every request nobody decided within N days (45 by default) of being submitted is rejected automatically every night at
// 01:30 India time, the way its own module rejects it, with the usual in-app notice and phone push but no WhatsApp.
// Resignations are never rejected automatically.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type Query } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

/** One kind of request: its approval workflow key and the Requests page's name for it. */
export type AutoRejectKind = { key: string; label: string };

/** A request the next run would reject. */
export type AutoRejectDueItem = {
  key: string;
  kind: string;
  kindLabel: string;
  id: number;
  employee: { id: number; code: string; name: string; branch: string | null };
  /** What was asked, in the Requests page's words ("Missing Punch · Morning Check-In"). */
  what: string;
  summary: string;
  submittedAt: string;
  /** The India day it was submitted (YYYY-MM-DD). */
  submittedOn: string;
  daysWaiting: number;
  /** An On-Duty punch whose On-Duty request is due too: voided by that request's rejection. */
  voidedWith?: { kind: string; id: number };
};

export type AutoRejectDue = {
  total: number;
  byKind: Record<string, number>;
  /** Oldest first, at most 300 (the count is always exact). */
  items: AutoRejectDueItem[];
  truncated: boolean;
  /** The number of days the list was worked out with, and whether it is the saved one. */
  days: number;
  saved: boolean;
};

/** What one run did (the nightly run or Run now). */
export type AutoRejectRunResult = {
  ran: boolean;
  at: string;
  day: string;
  days: number;
  trigger: "nightly" | "run_now";
  /** "nightly" or the HR user who pressed Run now. */
  runBy: string;
  branchId: number | null;
  rejected: number;
  byKind: Record<string, number>;
  skipped: number;
  attendanceSkipped: number;
  failed: number;
  failures: { kind: string; id: number; error: string }[];
};

export type AutoRejectConfig = {
  enabled: boolean;
  days: number;
  limits: { min: number; max: number; default: number };
  /** "01:30" India time. */
  runAt: string;
  lastRunAt: string | null;
  lastRunBy: string | null;
  lastRun: AutoRejectRunResult | null;
  updatedBy: string | null;
  updatedAt: string | null;
  /** May change the switch / the days: the Settings edit right and a login for all units. */
  canChange: boolean;
  /** May press Run now (the Settings edit right; a branch login rejects only its branch's requests). */
  canRun: boolean;
  branchScoped: boolean;
  kinds: AutoRejectKind[];
  neverRejected: AutoRejectKind[];
  due: AutoRejectDue;
};

export type AutoRejectConfigInput = Partial<{ enabled: boolean; days: number }>;

/** A refused save: the first problem, and every problem by the field it is about. */
export type AutoRejectConfigErrors = { error?: string; errors?: Partial<Record<keyof AutoRejectConfigInput, string>> };

export type AutoRejectHistoryItem = {
  id: number;
  kind: string;
  kindLabel: string;
  requestId: number;
  employee: { id: number | null; code: string; name: string };
  what: string;
  summary: string;
  submittedAt: string;
  daysWaited: number;
  daysSetting: number;
  remark: string;
  rejectedAt: string;
  trigger: "nightly" | "run_now";
  runBy: string | null;
  /** "Nightly run" or "Run now by NAME". */
  by: string;
  effects: Record<string, unknown>;
  /** What else the rejection did, in words ("1 waiting On-Duty punch voided", "Attendance not changed: ..."). */
  effectsText: string[];
};

export type AutoRejectHistoryPage = {
  items: AutoRejectHistoryItem[];
  page: number;
  pageSize: number;
  total: number;
  pages: number;
};

const ROOT = "/api/request-auto-reject";
const CONFIG = `${ROOT}/config`;
const HISTORY = `${ROOT}/history`;

/** `previewDays`: another number of days to list the due requests with, before it is saved (null = the saved one). */
export const getRequestAutoRejectConfigQueryKey = (previewDays?: number | null) =>
  [CONFIG, previewDays ?? "saved"] as const;

export const useRequestAutoRejectConfig = (previewDays?: number | null) =>
  useQuery<AutoRejectConfig>({
    queryKey: getRequestAutoRejectConfigQueryKey(previewDays),
    queryFn: () => customFetch<AutoRejectConfig>(previewDays ? `${CONFIG}?days=${previewDays}` : CONFIG),
    placeholderData: keepPreviousData,
  });

export const getRequestAutoRejectHistoryQueryKey = (page: number, pageSize: number, kind: string) =>
  [HISTORY, page, pageSize, kind] as const;

export const useRequestAutoRejectHistory = (page: number, pageSize = 25, kind = "") =>
  useQuery<AutoRejectHistoryPage>({
    queryKey: getRequestAutoRejectHistoryQueryKey(page, pageSize, kind),
    queryFn: () => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (kind) params.set("kind", kind);
      return customFetch<AutoRejectHistoryPage>(`${HISTORY}?${params.toString()}`);
    },
    placeholderData: keepPreviousData,
  });

const ownQuery = (query: Query) => {
  const head = query.queryKey[0];
  return typeof head === "string" && head.startsWith(ROOT);
};

export const useUpdateRequestAutoReject = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AutoRejectConfigInput) =>
      customFetch<AutoRejectConfig>(CONFIG, { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: (saved) => {
      queryClient.setQueryData(getRequestAutoRejectConfigQueryKey(null), saved);
      void queryClient.invalidateQueries({ predicate: ownQuery });
    },
  });
};

export const useRunRequestAutoRejectNow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      customFetch<{ summary: AutoRejectRunResult; config: AutoRejectConfig }>(`${ROOT}/run-now`, { method: "POST" }),
    onSuccess: (result) => {
      queryClient.setQueryData(getRequestAutoRejectConfigQueryKey(null), result.config);
      // the rejected requests leave every waiting list and count (Requests, Leave, Missing Punch, the dashboards ...)
      void queryClient.invalidateQueries();
    },
  });
};
