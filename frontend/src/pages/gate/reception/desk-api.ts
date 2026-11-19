import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { getApiOrigin } from "@/lib/api-client/custom-fetch";
import type {
  EmployeeContact,
  GateRange,
  PaginatedRecords,
  VisitorRegisterInput,
  VisitorVisit,
} from "@/lib/api-client/custom-hooks";
import {
  downloadGateFile,
  GateDownloadError,
  type GateFileFormat,
  type GateFileQuery,
} from "@/pages/hr/outpass-visitors/kit/download";

// The reception desk's own client. A desk is not an HR login: every call here sends the desk's token explicitly
// (`Authorization: Bearer <reception_device_token>`) or no token at all (sign-in, login-info), and never goes through
// customFetch, whose fallback would attach the HR token of whoever last signed in to HRMS in this browser.
// The three localStorage keys are the ones the old pages used (and the e2e specs set).
//
// When the server says this desk's sign-in is over (401, e.g. code "session_ended" after Sign out elsewhere or a password
// reset; 403 code "desk_revoked" when HR switched the desk off) the three desk keys are cleared and the browser goes to
// /reception-login?ended=<reason>, where the sign-in page says what happened. Never to "/" or an HR page.

export const DESK_KEYS = {
  token: "reception_device_token",
  id: "reception_device_id",
  name: "reception_device_name",
} as const;

/** Where a desk signs in (also where it lands when its session ends). */
export const DESK_SIGN_IN = "/reception-login";
export const DESK_CONSOLE = "/reception/console";

/** Why the sign-in page was opened with `?ended=`: the words it shows. */
export type DeskEndedReason = "signed_out" | "switched_off" | "expired";

export const ENDED_MESSAGES: Record<DeskEndedReason, string> = {
  signed_out: "This desk was signed out. Sign in again with the desk's username and password.",
  switched_off: "HR switched this desk off. Ask HR to switch it on, then sign in again.",
  expired: "This desk's sign-in ran out. Sign in again with the desk's username and password.",
};

export function endedMessage(reason: string | null | undefined): string | null {
  return reason && reason in ENDED_MESSAGES ? ENDED_MESSAGES[reason as DeskEndedReason] : null;
}

export const NO_CONNECTION_MESSAGE = "No connection to the server. Check the network and try again.";

export class DeskError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly data: Record<string, unknown> | null;
  constructor(status: number, message: string, data: Record<string, unknown> | null) {
    super(message);
    this.name = "DeskError";
    this.status = status;
    this.data = data;
    this.code = typeof data?.code === "string" ? data.code : null;
  }
}

/** Thrown after the session was found to be over (the keys are already cleared and the redirect is on its way). */
export class DeskSessionEndedError extends Error {
  readonly reason: DeskEndedReason;
  constructor(reason: DeskEndedReason) {
    super(ENDED_MESSAGES[reason]);
    this.name = "DeskSessionEndedError";
    this.reason = reason;
  }
}

// ── the desk's session in this browser ───────────────────────────────────────────────────────────────────────────

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The desk token, or null. The ONLY token this module ever sends. */
export const deskToken = (): string | null => storage()?.getItem(DESK_KEYS.token) || null;

export const hasDeskSession = () => !!deskToken();

/** The desk name stored at sign-in (shown until GET me answers). */
export const storedDeskName = (): string | null => storage()?.getItem(DESK_KEYS.name) || null;

export function saveDeskSession(session: DeskSession) {
  resetDeskSessionEnd();
  const s = storage();
  if (!s) return;
  s.setItem(DESK_KEYS.token, session.token);
  s.setItem(DESK_KEYS.id, String(session.deviceId));
  s.setItem(DESK_KEYS.name, session.deskName);
}

/** A renewed token (GET me) and the desk's current name replace the stored ones. */
export function refreshDeskSession(me: DeskMe) {
  const s = storage();
  if (!s || !s.getItem(DESK_KEYS.token)) return;
  if (me.token) s.setItem(DESK_KEYS.token, me.token);
  s.setItem(DESK_KEYS.id, String(me.desk.id));
  s.setItem(DESK_KEYS.name, me.desk.name);
}

/** Forgets this desk's sign-in (only the desk's three keys: an HR session in the same browser is left alone). */
export function clearDeskSession() {
  const s = storage();
  if (!s) return;
  for (const key of Object.values(DESK_KEYS)) s.removeItem(key);
}

// ── where to go when the session ends ────────────────────────────────────────────────────────────────────────────

type Navigate = (to: string) => void;
const browserNavigate: Navigate = (to) => window.location.replace(to);
let navigateTo: Navigate = browserNavigate;

/** The console hands in the router's navigate (no full reload); null puts the plain browser redirect back. */
export function setDeskNavigator(fn: Navigate | null) {
  navigateTo = fn ?? browserNavigate;
}

// Several requests can find out at once (the heartbeat, the counts, the list): the first one decides the reason and
// redirects; the rest within a few seconds only say so.
const END_SETTLE_MS = 5_000;
let lastEnd: { reason: DeskEndedReason; at: number } | null = null;

export function endDeskSession(reason: DeskEndedReason): DeskSessionEndedError {
  clearDeskSession();
  const now = Date.now();
  if (lastEnd && now - lastEnd.at < END_SETTLE_MS) return new DeskSessionEndedError(lastEnd.reason);
  lastEnd = { reason, at: now };
  navigateTo(`${DESK_SIGN_IN}?ended=${reason}`);
  return new DeskSessionEndedError(reason);
}

/** Tests, and a fresh sign-in: the next end redirects again. */
export function resetDeskSessionEnd() {
  lastEnd = null;
}

/** Whether a desk-authenticated answer means "this desk's sign-in is over", and why. */
export function sessionEndReason(status: number, body: Record<string, unknown> | null): DeskEndedReason | null {
  const code = typeof body?.code === "string" ? body.code : null;
  if (status === 401) return code === "session_ended" ? "signed_out" : "expired";
  if (status === 403 && code === "desk_revoked") return "switched_off";
  // a server from before 18 Nov 2026 said this without a code
  if (status === 403 && body?.error === "This desk's access has been revoked") return "switched_off";
  // a token that is not a desk token at all: it cannot be used here, sign in again
  if (status === 403 && body?.error === "This token cannot be used here") return "signed_out";
  return null;
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────────

type Query = URLSearchParams | Record<string, string | number | null | undefined>;

function queryString(query: Query | undefined): string {
  if (!query) return "";
  const params = new URLSearchParams();
  const entries = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query);
  for (const [key, value] of entries) {
    if (value === null || value === undefined || value === "") continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** A JSON call to the API as the desk (`auth: false`: no Authorization header at all). Throws DeskError, or
 *  DeskSessionEndedError (after clearing the keys and sending the browser to the sign-in). */
export async function deskFetch<T>(
  path: string,
  { method = "GET", body, auth = true, query }: { method?: string; body?: unknown; auth?: boolean; query?: Query } = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  if (auth) {
    const token = deskToken();
    if (!token) throw endDeskSession("signed_out");
    headers.set("Authorization", `Bearer ${token}`);
  }
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${path}${queryString(query)}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "omit",
    });
  } catch {
    throw new DeskError(0, NO_CONNECTION_MESSAGE, null);
  }
  const text = response.status === 204 ? "" : await response.text().catch(() => "");
  let data: Record<string, unknown> | null = null;
  if (text) {
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    if (auth) {
      const ended = sessionEndReason(response.status, data);
      if (ended) throw endDeskSession(ended);
    }
    const message =
      typeof data?.error === "string" && data.error
        ? data.error
        : typeof data?.message === "string" && data.message
          ? data.message
          : `Something went wrong (error ${response.status}). Please try again.`;
    throw new DeskError(response.status, message, data);
  }
  return data as T;
}

/** The desk's session is over (it is already on its way to the sign-in page). */
export const sessionEnded = (error: unknown): boolean => error instanceof DeskSessionEndedError;

// ── types ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type DeskInfo = { id: number; name: string; branchName: string | null; location: string | null };
export type DeskSession = { token: string; deviceId: number; deskName: string; desk?: DeskInfo };
export type DeskMe = {
  desk: DeskInfo;
  session: { id: number; deviceLabel: string | null; createdAt: string | null; lastSeenAt: string | null } | null;
  expiresAt: string | null;
  /** A fresh token for the same session, when the old one has less than 15 days left. */
  token?: string;
};
export type DeskLoginInfo = { deskName: string; branchName: string; isActive: boolean };
export type DeskSummary = {
  today: number;
  thisWeek: number;
  thisMonth: number;
  insideNow?: number;
  checkedOutToday?: number;
};
/** The register form of the desk: HR's, without a branch (a desk always registers at its own). */
export type DeskRegisterInput = Omit<VisitorRegisterInput, "branchId">;
export type DeskHostLookup = { found: boolean; employee?: EmployeeContact };
export type DeskReturningVisitor = {
  id: number;
  name: string;
  visitCount: number;
  lastVisitAt: string | null;
  insideNow: boolean;
  lastVisitId: number | null;
};

// ── the endpoints ────────────────────────────────────────────────────────────────────────────────────────────────

export const DESK_API = {
  login: "/api/reception-devices/login",
  loginInfo: (token: string) => `/api/reception-devices/login-info/${encodeURIComponent(token)}`,
  me: "/api/reception-devices/me",
  logout: "/api/reception-devices/logout",
  summary: "/api/reception-devices/summary",
  visits: "/api/reception-devices/visits",
  visitsExport: "/api/reception-devices/visits/export",
  checkOut: (id: number) => `/api/reception-devices/visits/${id}/check-out`,
  hostLookup: "/api/reception-devices/host-lookup",
  visitorLookup: "/api/reception-devices/visitor-lookup",
} as const;

export const deskLogin = (username: string, password: string) =>
  deskFetch<DeskSession>(DESK_API.login, {
    method: "POST",
    body: { username: username.trim(), password },
    auth: false,
  });

/** Who this desk is, and a renewed token when the old one is past half its life (stored here). */
export async function deskMe(): Promise<DeskMe> {
  const me = await deskFetch<DeskMe>(DESK_API.me);
  refreshDeskSession(me);
  return me;
}

/** Sign out: ends this browser's session on the server (best effort), forgets it here whatever the answer. */
export async function deskLogout(): Promise<void> {
  const token = deskToken();
  clearDeskSession();
  if (!token) return;
  try {
    await fetch(`${getApiOrigin()}${DESK_API.logout}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit",
    });
  } catch {
    /* offline: the token is forgotten here, and HR can sign the desk out everywhere */
  }
}

export const deskRegister = (body: DeskRegisterInput) =>
  deskFetch<VisitorVisit>(DESK_API.visits, { method: "POST", body });

/** The employee a visitor is meeting, by the employee's phone (the QR form's own look-up). */
export const deskHostLookup = (phone: string) =>
  deskFetch<DeskHostLookup>(DESK_API.hostLookup, { method: "POST", body: { phone } });

export async function deskVisitorLookup(phone: string): Promise<DeskReturningVisitor | null> {
  const res = await deskFetch<{ visitor: DeskReturningVisitor | null }>(DESK_API.visitorLookup, { query: { phone } });
  return res.visitor;
}

export const deskVisits = (query: Query) => deskFetch<PaginatedRecords<VisitorVisit>>(DESK_API.visits, { query });

/**
 * This desk's branch visits as an Excel / PDF file (the server's file, kit downloadGateFile) with the DESK token. A 401 /
 * 403 means the sign-in is over or the desk was switched off: GET me finds out which and sends the browser to the
 * sign-in.
 */
export async function deskExport(format: GateFileFormat, query: GateFileQuery): Promise<string> {
  try {
    return await downloadGateFile({ path: DESK_API.visitsExport, query, format, title: "Visitors", token: deskToken });
  } catch (e) {
    if (e instanceof GateDownloadError && (e.status === 401 || e.status === 403)) {
      await deskMe(); // throws DeskSessionEndedError (and redirects) when the session is really over
    }
    throw e;
  }
}

// ── hooks ────────────────────────────────────────────────────────────────────────────────────────────────────────

const retry = (count: number, error: unknown) =>
  !sessionEnded(error) && error instanceof DeskError && error.status === 0 && count < 1;

export const useDeskLogin = () =>
  useMutation({
    mutationFn: (body: { username: string; password: string }) => deskLogin(body.username, body.password),
  });

export const useDeskLoginInfo = (loginToken: string) =>
  useQuery<DeskLoginInfo>({
    queryKey: ["reception-desk", "login-info", loginToken],
    queryFn: () => deskFetch<DeskLoginInfo>(DESK_API.loginInfo(loginToken), { auth: false }),
    enabled: !!loginToken,
    retry: false,
  });

export const getDeskSummaryQueryKey = () => ["reception-desk", "summary"] as const;
export const useDeskSummary = (enabled = true) =>
  useQuery<DeskSummary>({
    queryKey: getDeskSummaryQueryKey(),
    queryFn: () => deskFetch<DeskSummary>(DESK_API.summary),
    enabled,
    refetchInterval: 30_000,
    retry,
  });

export const getDeskVisitsQueryKey = (range: GateRange, page: number) =>
  ["reception-desk", "visits", range, page] as const;
export const useDeskVisits = (range: GateRange, page: number, pageSize = 15, enabled = true) =>
  useQuery<PaginatedRecords<VisitorVisit>>({
    enabled,
    queryKey: getDeskVisitsQueryKey(range, page),
    queryFn: () => deskVisits({ range, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: 20_000,
    retry,
  });

/** The records view: any dates (from / to), status and search, one page at a time. */
export const useDeskRecords = (params: URLSearchParams, queryKey: string, enabled = true) =>
  useQuery<PaginatedRecords<VisitorVisit>>({
    enabled,
    queryKey: ["reception-desk", "records", queryKey],
    queryFn: () => deskVisits(params),
    placeholderData: keepPreviousData,
    retry,
    staleTime: 15_000,
  });

export const useDeskVisitorLookup = (phone: string) =>
  useQuery<DeskReturningVisitor | null>({
    queryKey: ["reception-desk", "visitor-lookup", phone],
    queryFn: () => deskVisitorLookup(phone),
    enabled: phone.replace(/\D/g, "").length >= 6,
    retry: false,
    staleTime: 30_000,
  });

export const useDeskCheckOut = () =>
  useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) =>
      deskFetch<VisitorVisit>(DESK_API.checkOut(id), { method: "POST", body: note ? { note } : {} }),
  });

export const useDeskRegister = () => useMutation({ mutationFn: (body: DeskRegisterInput) => deskRegister(body) });
