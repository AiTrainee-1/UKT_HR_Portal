// gate-admin: Manage Gates (/hr/outpass-visitors/outpass/gates). OWNER: slice B1. HR token, permission key
// outpass_visitors.outpass.gate_devices (view for GET, edit for writes); "See gate passwords" is its own key,
// outpass_visitors.outpass.gate_devices.view_password. Backend: gate_admin_views.py (+ gate_records.py, gate_exports.py).
//
//   GET    /api/gate-devices?q&status&branchId    ManagedGate[] (every key of the old GateDevice too; no params = all)
//   POST   /api/gate-devices                      GateCreateInput -> ManagedGate (409 username taken)
//   GET    /api/gate-devices/<id>                 ManagedGateDetail (active sessions)
//   PUT    /api/gate-devices/<id>                 GateUpdateInput -> ManagedGate (username / password change and
//                                                 switching off sign every session out)
//   DELETE /api/gate-devices/<id>                 hard delete (the page steers to Switch off)
//   POST   /api/gate-devices/<id>/reveal-password -> GatePasswordReveal, or 409 {error, code: "not_stored"}
//   POST   /api/gate-devices/<id>/sign-out        -> GateSignOutResult
//   GET    /api/gate-devices/summary?from&to      -> GateAdminSummary
//   GET    /api/gate-devices/records?<GateRecordFilters>          -> GateRecordsPage (gate-records.ts)
//   GET    /api/gate-devices/records/export?fmt=xlsx|pdf&<filters> (kit/download.ts)
//   GET    /api/gate-devices/export?fmt=xlsx|pdf                  the gate list (no passwords, no login links)
//
// These replace the old gate-device hooks of gate.ts (only the GateDevice type is left there). Every key here starts with
// "/api/gate-devices" (GATE_ADMIN_KEYS.all), so one invalidation refreshes every list, detail and figure.

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { GateDevice } from "./gate";
import { getInOutOptionsQueryKey } from "./gate-inout";
import type { GateRecordsPage } from "./gate-records";
import { TEA_BREAK_RECORDS_ROOT } from "./tea-break-admin";

export type GateCounts = {
  today: number;
  exits: number;
  returns: number;
  teaOut: number;
  teaIn: number;
  denied: number;
  total: number;
};

/** A gate as Manage Gates lists it: the old GateDevice keys plus the new ones. Never a password. */
export type ManagedGate = GateDevice & {
  location: string | null;
  notes: string | null;
  /** This gate may scan gate passes (exit and return). */
  allowOutpass: boolean;
  /** This gate may scan tea-break codes. */
  allowTeaBreak: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  /** A password is stored that "View" can show (false for a gate whose password was set before 18 Nov 2026). */
  passwordViewable: boolean;
  activeSessions: number;
  lastActivityAt: string | null;
  counts: GateCounts;
};

export type GateSessionRow = { id: number; deviceLabel: string; createdAt: string; lastSeenAt: string | null };

export type ManagedGateDetail = ManagedGate & { sessions: GateSessionRow[] };

export type GateCreateInput = {
  name: string;
  /** Ignored for an HR account bound to a branch (its own branch is used). */
  branchId?: number;
  username: string;
  password: string;
  location?: string | null;
  notes?: string | null;
  allowOutpass?: boolean;
  allowTeaBreak?: boolean;
};

export type GateUpdateInput = {
  name?: string;
  isActive?: boolean;
  password?: string;
  /** Only for an HR account not bound to a branch. */
  branchId?: number;
  username?: string;
  location?: string | null;
  notes?: string | null;
  allowOutpass?: boolean;
  allowTeaBreak?: boolean;
};

export type GatePasswordReveal = { password: string };
/** 409 from reveal-password: the password was set before passwords were stored and cannot be shown. */
export type GatePasswordNotStored = { error: string; code: "not_stored" };

export type GateSignOutResult = { signedOut: number };

export type GateAdminSummary = {
  gates: number;
  active: number;
  /** Sessions seen in the last 10 minutes. */
  signedInNow: number;
  recordsToday: number;
  deniedToday: number;
  /** In the asked range. */
  records: number;
  denied: number;
};

/** The addresses of Manage Gates (hooks, exports and the render-test harness read them from here). */
export const GATE_ADMIN_API = {
  list: "/api/gate-devices",
  detail: (id: number) => `/api/gate-devices/${id}`,
  revealPassword: (id: number) => `/api/gate-devices/${id}/reveal-password`,
  signOut: (id: number) => `/api/gate-devices/${id}/sign-out`,
  summary: "/api/gate-devices/summary",
  records: "/api/gate-devices/records",
  recordsExport: "/api/gate-devices/records/export",
  listExport: "/api/gate-devices/export",
} as const;

// ── hooks ─────────────────────────────────────────────────────────────────────

/** The gate list's own filters (they go to the server: GET /api/gate-devices?q&status&branchId). */
export type GateListParams = { q?: string; status?: "" | "active" | "inactive"; branchId?: string };

/** Every key starts with GATE_ADMIN_KEYS.all ("/api/gate-devices"), so one invalidation refreshes all. */
export const GATE_ADMIN_KEYS = {
  all: ["/api/gate-devices"] as const,
  list: (params: GateListParams) => ["/api/gate-devices", "managed", params] as const,
  detail: (id: number) => ["/api/gate-devices", "detail", id] as const,
  summary: (query: string) => ["/api/gate-devices", "summary", query] as const,
  records: (query: string) => ["/api/gate-devices", "records", query] as const,
};

/** "?a=1&b=2" of the values that are set ("" when none). */
const queryOf = (params: Record<string, string | undefined> | URLSearchParams): string => {
  const out = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  for (const [key, value] of entries) if (value !== undefined && value !== "") out.set(key, value);
  const qs = out.toString();
  return qs ? `?${qs}` : "";
};

/** Every gate the signed-in HR user may see, with its counts and sessions (Manage Gates' left column). */
export const useManagedGates = (params: GateListParams = {}, options: { enabled?: boolean } = {}) =>
  useQuery<ManagedGate[]>({
    queryKey: GATE_ADMIN_KEYS.list(params),
    queryFn: () => customFetch<ManagedGate[]>(`${GATE_ADMIN_API.list}${queryOf(params)}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });

/** One gate with its signed-in browsers. */
export const useManagedGate = (id: number | null | undefined) =>
  useQuery<ManagedGateDetail>({
    queryKey: GATE_ADMIN_KEYS.detail(id ?? 0),
    queryFn: () => customFetch<ManagedGateDetail>(GATE_ADMIN_API.detail(id!)),
    enabled: typeof id === "number" && id > 0,
  });

/** The tiles at the top of Manage Gates (?from&to&branchId: the range only changes `records` / `denied`). */
export const useGateAdminSummary = (params: { from?: string; to?: string; branchId?: string } = {}) => {
  const query = queryOf(params);
  return useQuery<GateAdminSummary>({
    queryKey: GATE_ADMIN_KEYS.summary(query),
    queryFn: () => customFetch<GateAdminSummary>(`${GATE_ADMIN_API.summary}${query}`),
  });
};

/** One page of gate records (gateId, from, to, type, result, q, branchId, page, pageSize). The previous page stays on
 *  screen while the next one loads. */
export const useGateAdminRecords = (params: URLSearchParams, options: { enabled?: boolean } = {}) => {
  const query = queryOf(params);
  return useQuery<GateRecordsPage>({
    queryKey: GATE_ADMIN_KEYS.records(query),
    queryFn: () => customFetch<GateRecordsPage>(`${GATE_ADMIN_API.records}${query}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
};

/**
 * After any change: every Manage Gates list, gate, tile and record list (and the old dialog's list) is asked again, and so
 * are the gate choices of the In/Out and Tea Break filters (a new, renamed or deleted gate shows there too).
 */
const useRefreshGates = () => {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: GATE_ADMIN_KEYS.all }),
      client.invalidateQueries({ queryKey: getInOutOptionsQueryKey() }),
      client.invalidateQueries({ queryKey: [TEA_BREAK_RECORDS_ROOT, "options"] }),
    ]);
};

export const useCreateManagedGate = () => {
  const refresh = useRefreshGates();
  return useMutation({
    mutationFn: (data: GateCreateInput) =>
      customFetch<ManagedGate>(GATE_ADMIN_API.list, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: refresh,
  });
};

export const useUpdateManagedGate = () => {
  const refresh = useRefreshGates();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: GateUpdateInput }) =>
      customFetch<ManagedGate>(GATE_ADMIN_API.detail(id), { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: refresh,
  });
};

export const useDeleteManagedGate = () => {
  const refresh = useRefreshGates();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(GATE_ADMIN_API.detail(id), { method: "DELETE" }),
    onSuccess: refresh,
  });
};

/** Shows a gate's password (recorded on the server every time). 409 {code: "not_stored"} for a gate set before
 *  18 Nov 2026. Nothing to refresh: it changes nothing. */
export const useRevealGatePassword = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<GatePasswordReveal>(GATE_ADMIN_API.revealPassword(id), { method: "POST" }),
  });

/** Ends every session of a gate (Sign out everywhere). */
export const useSignOutGate = () => {
  const refresh = useRefreshGates();
  return useMutation({
    mutationFn: (id: number) => customFetch<GateSignOutResult>(GATE_ADMIN_API.signOut(id), { method: "POST" }),
    onSuccess: refresh,
  });
};
