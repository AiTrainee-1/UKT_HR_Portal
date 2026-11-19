// reception-admin: Visitors -> Manage Reception (/hr/outpass-visitors/visitors/desks). HR token, permission key
// outpass_visitors.visitors.reception_devices (view for GET, edit for writes); "See desk passwords" is its own key,
// outpass_visitors.visitors.reception_devices.view_password. Backend: reception_admin_views.py.
//
//   GET    /api/reception-devices?q&deskStatus&branchId   ManagedDesk[] (every key of the old ReceptionDevice too)
//   POST   /api/reception-devices                         DeskCreateInput -> ManagedDesk (409 username taken)
//   GET    /api/reception-devices/<id>                    ManagedDeskDetail (signed-in browsers)
//   PUT    /api/reception-devices/<id>                    DeskUpdateInput -> ManagedDesk (a username / password change
//                                                         and switching off sign every browser out)
//   DELETE /api/reception-devices/<id>                    hard delete (the page steers to Switch off)
//   POST   /api/reception-devices/<id>/reveal-password    -> DeskPasswordReveal, or 409 {error, code: "not_stored"}
//   POST   /api/reception-devices/<id>/sign-out           -> DeskSignOutResult
//   GET    /api/reception-devices/overview?from&to        -> ReceptionOverview
//   GET    /api/reception-devices/records?deskId&from&to&type&q&page&pageSize   -> ReceptionRecordsPage
//   GET    /api/reception-devices/records/export?fmt=xlsx|pdf&<filters>        (kit/download.ts)
//   GET    /api/reception-devices/export?fmt=xlsx|pdf     the desk list (no passwords, no login links)
//
// The desk's own calls (sign-in, console) are NOT here: they never use the HR token (pages/gate/reception/desk-api.ts).
// Every key here starts with "/api/reception-devices" (RECEPTION_ADMIN_KEYS.all), so one invalidation refreshes them all.
// (The old desk hooks of gate.ts are gone: nothing used them.)

import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ReceptionDevice } from "./gate";
import type { VisitStatus } from "./visitor-admin";

export type DeskCounts = {
  /** Check-ins + check-outs of today (India). */
  today: number;
  /** Visitors this desk checked in (walk-ins registered at the desk), all time. */
  checkIns: number;
  /** Visitors this desk checked out, all time. */
  checkOuts: number;
  total: number;
};

/** A desk as Manage Reception lists it: the old ReceptionDevice keys plus the new ones. Never a password. */
export type ManagedDesk = ReceptionDevice & {
  location: string | null;
  notes: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  /** A password is stored that "View" can show (false for a desk whose password was set before 18 Nov 2026). */
  passwordViewable: boolean;
  activeSessions: number;
  lastActivityAt: string | null;
  counts: DeskCounts;
};

export type DeskSessionRow = { id: number; deviceLabel: string; createdAt: string; lastSeenAt: string | null };

export type ManagedDeskDetail = ManagedDesk & { sessions: DeskSessionRow[] };

export type DeskCreateInput = {
  name: string;
  /** Ignored for an HR account bound to a branch (its own branch is used). */
  branchId?: number;
  username: string;
  password: string;
  location?: string | null;
  notes?: string | null;
};

export type DeskUpdateInput = {
  name?: string;
  isActive?: boolean;
  password?: string;
  /** Only for an HR account not bound to a branch. */
  branchId?: number;
  username?: string;
  location?: string | null;
  notes?: string | null;
};

export type DeskPasswordReveal = { password: string };
export type DeskSignOutResult = { signedOut: number };

export type ReceptionOverview = {
  desks: number;
  active: number;
  /** Sessions seen in the last 10 minutes. */
  signedInNow: number;
  checkInsToday: number;
  checkOutsToday: number;
  /** In the asked range (all time without one). */
  checkIns: number;
  checkOuts: number;
};

export type ReceptionRecordType = "check_in" | "check_out";

export const RECEPTION_RECORD_TYPE_LABEL: Record<ReceptionRecordType, string> = {
  check_in: "Check-in",
  check_out: "Check-out",
};

/** One thing a desk did: it checked a visitor in (a walk-in registered at the desk) or out. No phone, no Aadhaar. */
export type ReceptionRecord = {
  /** "in-<visit id>" | "out-<visit id>" */
  id: string;
  at: string;
  type: ReceptionRecordType;
  typeLabel: string;
  desk: { id: number; name: string } | null;
  visit: {
    id: number;
    visitorName: string;
    company: string | null;
    peopleCount: number;
    host: string | null;
    hostDepartment: string | null;
    purpose: string;
    badgeNumber: string | null;
    status: VisitStatus;
    statusLabel: string;
    visitedAt: string;
    checkedOutAt: string | null;
    minutesInside: number | null;
    branchName: string | null;
  } | null;
};

/** Both types, whatever the type filter says (the other filters apply). */
export type ReceptionRecordCounts = { checkIns: number; checkOuts: number; total: number };

export type ReceptionRecordsPage = {
  items: ReceptionRecord[];
  total: number;
  page: number;
  pageSize: number;
  counts: ReceptionRecordCounts;
};

/** The addresses of Manage Reception (hooks, exports and the render-test harness read them from here). */
export const RECEPTION_ADMIN_API = {
  list: "/api/reception-devices",
  detail: (id: number) => `/api/reception-devices/${id}`,
  revealPassword: (id: number) => `/api/reception-devices/${id}/reveal-password`,
  signOut: (id: number) => `/api/reception-devices/${id}/sign-out`,
  overview: "/api/reception-devices/overview",
  records: "/api/reception-devices/records",
  recordsExport: "/api/reception-devices/records/export",
  listExport: "/api/reception-devices/export",
} as const;

// ── hooks ─────────────────────────────────────────────────────────────────────

/** The desk list's own filters (they go to the server: GET /api/reception-devices?q&deskStatus&branchId). */
export type DeskListParams = { q?: string; deskStatus?: "" | "active" | "inactive"; branchId?: string };

/** Every key starts with RECEPTION_ADMIN_KEYS.all ("/api/reception-devices"). */
export const RECEPTION_ADMIN_KEYS = {
  all: ["/api/reception-devices"] as const,
  list: (params: DeskListParams) => ["/api/reception-devices", "managed", params] as const,
  detail: (id: number) => ["/api/reception-devices", "detail", id] as const,
  overview: (query: string) => ["/api/reception-devices", "overview", query] as const,
  records: (query: string) => ["/api/reception-devices", "records", query] as const,
};

/** "?a=1&b=2" of the values that are set ("" when none). */
const queryOf = (params: Record<string, string | undefined> | URLSearchParams): string => {
  const out = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? [...params.entries()] : Object.entries(params);
  for (const [key, value] of entries) if (value !== undefined && value !== "") out.set(key, value);
  const qs = out.toString();
  return qs ? `?${qs}` : "";
};

/** Every desk the signed-in HR user may see, with its counts and sessions (Manage Reception's left column). */
export const useManagedDesks = (params: DeskListParams = {}, options: { enabled?: boolean } = {}) =>
  useQuery<ManagedDesk[]>({
    queryKey: RECEPTION_ADMIN_KEYS.list(params),
    queryFn: () => customFetch<ManagedDesk[]>(`${RECEPTION_ADMIN_API.list}${queryOf(params)}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });

/** One desk with its signed-in browsers. */
export const useManagedDesk = (id: number | null | undefined) =>
  useQuery<ManagedDeskDetail>({
    queryKey: RECEPTION_ADMIN_KEYS.detail(id ?? 0),
    queryFn: () => customFetch<ManagedDeskDetail>(RECEPTION_ADMIN_API.detail(id!)),
    enabled: typeof id === "number" && id > 0,
  });

/** The tiles at the top of Manage Reception (?from&to&branchId: the range only changes `checkIns` / `checkOuts`). */
export const useReceptionOverview = (params: { from?: string; to?: string; branchId?: string } = {}) => {
  const query = queryOf(params);
  return useQuery<ReceptionOverview>({
    queryKey: RECEPTION_ADMIN_KEYS.overview(query),
    queryFn: () => customFetch<ReceptionOverview>(`${RECEPTION_ADMIN_API.overview}${query}`),
  });
};

/** One page of desk records (deskId, from, to, type, q, branchId, page, pageSize). The previous page stays on screen while
 *  the next one loads. */
export const useReceptionRecords = (params: URLSearchParams, options: { enabled?: boolean } = {}) => {
  const query = queryOf(params);
  return useQuery<ReceptionRecordsPage>({
    queryKey: RECEPTION_ADMIN_KEYS.records(query),
    queryFn: () => customFetch<ReceptionRecordsPage>(`${RECEPTION_ADMIN_API.records}${query}`),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
  });
};

/** After any change: every Manage Reception list, desk, tile and record list (and the old list) is asked again. */
const useRefreshDesks = () => {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: RECEPTION_ADMIN_KEYS.all });
};

export const useCreateManagedDesk = () => {
  const refresh = useRefreshDesks();
  return useMutation({
    mutationFn: (data: DeskCreateInput) =>
      customFetch<ManagedDesk>(RECEPTION_ADMIN_API.list, { method: "POST", body: JSON.stringify(data) }),
    onSuccess: refresh,
  });
};

export const useUpdateManagedDesk = () => {
  const refresh = useRefreshDesks();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: DeskUpdateInput }) =>
      customFetch<ManagedDesk>(RECEPTION_ADMIN_API.detail(id), { method: "PUT", body: JSON.stringify(data) }),
    onSuccess: refresh,
  });
};

export const useDeleteManagedDesk = () => {
  const refresh = useRefreshDesks();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(RECEPTION_ADMIN_API.detail(id), { method: "DELETE" }),
    onSuccess: refresh,
  });
};

/** Shows a desk's password (recorded on the server every time). 409 {code: "not_stored"} for a desk set before
 *  18 Nov 2026. Nothing to refresh: it changes nothing. */
export const useRevealDeskPassword = () =>
  useMutation({
    mutationFn: (id: number) =>
      customFetch<DeskPasswordReveal>(RECEPTION_ADMIN_API.revealPassword(id), { method: "POST" }),
  });

/** Ends every session of a desk (Sign out everywhere). */
export const useSignOutDesk = () => {
  const refresh = useRefreshDesks();
  return useMutation({
    mutationFn: (id: number) => customFetch<DeskSignOutResult>(RECEPTION_ADMIN_API.signOut(id), { method: "POST" }),
    onSuccess: refresh,
  });
};
