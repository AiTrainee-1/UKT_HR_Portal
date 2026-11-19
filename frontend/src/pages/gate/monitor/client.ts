// The gate monitor's own API client. It NEVER goes through customFetch, whose fallback attaches the HR sign-in
// ("uk_textile_token") to any call without an Authorization header: a kiosk browser that once had HR signed in must not
// send that token to the gate's endpoints (it would be refused, logged as the HR user, or worse). Here the gate token is
// the only token ever sent, the sign-in sends none, and a missing gate token sends none.
//
// When the server says this gate's sign-in is over (401, e.g. code "session_ended" after Sign out elsewhere or a
// password reset; 403 code "gate_revoked" when HR switched the gate off) the three gate keys are cleared and the
// browser goes to /gatemonitor?ended=<reason>, where the sign-in page says what happened. Never to "/" or an HR page.

import { getApiOrigin } from "@/lib/api-client/custom-fetch";
// straight from the slice files (not the hooks barrel): this lazy chunk stays small and never loads customFetch's hooks
import {
  GATE_MONITOR_API,
  GATE_SESSION_KEYS,
  type GateLoginInfo,
  type GateMonitorLoginResponse,
  type GateMonitorMe,
  type GateMonitorRecord,
  type GateMonitorSummary,
  type GateScanResult,
} from "@/lib/api-client/custom-hooks/gate-monitor";
import type { GateRecordsPage } from "@/lib/api-client/custom-hooks/gate-records";
import {
  downloadGateFile,
  GateDownloadError,
  type GateFileFormat,
  type GateFileQuery,
} from "@/pages/hr/outpass-visitors/kit/download";

export const SIGN_IN_PATH = "/gatemonitor";
export const CONSOLE_PATH = "/gatemonitor/console";

/** Why the sign-in page was opened with `?ended=`: the words it shows. */
export type EndedReason = "signed_out" | "switched_off" | "expired";

export const ENDED_MESSAGES: Record<EndedReason, string> = {
  signed_out: "This gate was signed out. Sign in again with the gate's username and password.",
  switched_off: "This gate was switched off by HR. Ask HR to switch it on, then sign in again.",
  expired: "This gate's sign-in ran out. Sign in again with the gate's username and password.",
};

export function endedMessage(reason: string | null | undefined): string | null {
  return reason && reason in ENDED_MESSAGES ? ENDED_MESSAGES[reason as EndedReason] : null;
}

// ── the gate's session in this browser ───────────────────────────────────────────────────────────────────────────

export type StoredGateSession = { token: string; gateId: number | null; gateName: string };

function storage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The gate token, or null. The ONLY token this module ever sends. */
export function gateToken(): string | null {
  return storage()?.getItem(GATE_SESSION_KEYS.token) || null;
}

export function readGateSession(): StoredGateSession | null {
  const s = storage();
  const token = s?.getItem(GATE_SESSION_KEYS.token);
  if (!s || !token) return null;
  const id = Number(s.getItem(GATE_SESSION_KEYS.id));
  return {
    token,
    gateId: Number.isInteger(id) && id > 0 ? id : null,
    gateName: s.getItem(GATE_SESSION_KEYS.name) ?? "",
  };
}

export function saveGateSession(login: GateMonitorLoginResponse): void {
  resetGateSessionEnd();
  const s = storage();
  if (!s) return;
  s.setItem(GATE_SESSION_KEYS.token, login.token);
  s.setItem(GATE_SESSION_KEYS.id, String(login.gate.id));
  s.setItem(GATE_SESSION_KEYS.name, login.gate.name);
}

/** A renewed token (GET me) and the gate's current name replace the stored ones. */
export function refreshGateSession(me: GateMonitorMe): void {
  const s = storage();
  if (!s || !s.getItem(GATE_SESSION_KEYS.token)) return;
  if (me.token) s.setItem(GATE_SESSION_KEYS.token, me.token);
  s.setItem(GATE_SESSION_KEYS.id, String(me.gate.id));
  s.setItem(GATE_SESSION_KEYS.name, me.gate.name);
}

export function clearGateSession(): void {
  const s = storage();
  if (!s) return;
  for (const key of Object.values(GATE_SESSION_KEYS)) s.removeItem(key);
}

// ── where to go when the session ends ────────────────────────────────────────────────────────────────────────────

type Navigator = (to: string) => void;
const browserNavigate: Navigator = (to) => window.location.replace(to);
let navigateTo: Navigator = browserNavigate;

/** The console hands in the router's navigate (no full reload); null puts the plain browser redirect back. */
export function setGateNavigator(fn: Navigator | null): void {
  navigateTo = fn ?? browserNavigate;
}

/** Thrown after the session was found to be over (the keys are already cleared and the redirect is on its way). */
export class GateSessionEndedError extends Error {
  readonly reason: EndedReason;
  constructor(reason: EndedReason) {
    super(ENDED_MESSAGES[reason]);
    this.name = "GateSessionEndedError";
    this.reason = reason;
  }
}

// Several requests can find out at once (the heartbeat, today's counts, the latest scans): the first one decides the
// reason and redirects; the rest within a few seconds only say so (a later call that finds no token must not turn
// "switched off by HR" into "signed out").
const END_SETTLE_MS = 5_000;
let lastEnd: { reason: EndedReason; at: number } | null = null;

export function endGateSession(reason: EndedReason): GateSessionEndedError {
  clearGateSession();
  const now = Date.now();
  if (lastEnd && now - lastEnd.at < END_SETTLE_MS) return new GateSessionEndedError(lastEnd.reason);
  lastEnd = { reason, at: now };
  navigateTo(`${SIGN_IN_PATH}?ended=${reason}`);
  return new GateSessionEndedError(reason);
}

/** Tests, and a fresh sign-in: the next end redirects again. */
export function resetGateSessionEnd(): void {
  lastEnd = null;
}

// ── requests ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const NO_CONNECTION_MESSAGE = "Could not reach the server. Check the connection and try again.";

export class GateApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly data: unknown;
  constructor(message: string, status: number, code: string | null = null, data: unknown = null) {
    super(message);
    this.name = "GateApiError";
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

type Body = { error?: unknown; message?: unknown; code?: unknown; result?: unknown } | null;

/** Whether a gate-authenticated answer means "this gate's sign-in is over", and why. */
export function sessionEndReason(status: number, body: Body): EndedReason | null {
  const code = typeof body?.code === "string" ? body.code : null;
  if (status === 401) return code === "session_ended" ? "signed_out" : "expired";
  if (status === 403 && code === "gate_revoked") return "switched_off";
  // a token that is not a gate token at all (403, no scan result): it cannot be used here, sign in again
  if (status === 403 && body?.error === "This token cannot be used here") return "signed_out";
  return null;
}

async function readBody(response: Response): Promise<Body> {
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text) as Body;
  } catch {
    return null;
  }
}

function messageOf(body: Body, status: number): string {
  if (typeof body?.message === "string" && body.message) return body.message;
  if (typeof body?.error === "string" && body.error) return body.error;
  return `Something went wrong (error ${status}). Try again in a minute.`;
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: unknown;
  query?: URLSearchParams | Record<string, string | number | null | undefined>;
  /** false: the public sign-in and login-info (no token at all). Default true: the gate token. */
  auth?: boolean;
  /** The scan answers 400-410 with a result body: hand those back instead of throwing. */
  acceptResult?: boolean;
  signal?: AbortSignal;
};

function queryString(query: RequestOptions["query"]): string {
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

export async function gateRequest<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const auth = opts.auth ?? true;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    const token = gateToken();
    if (!token) throw endGateSession("signed_out");
    headers.Authorization = `Bearer ${token}`;
  }
  let response: Response;
  try {
    response = await fetch(`${getApiOrigin()}${path}${queryString(opts.query)}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
      credentials: "omit",
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new GateApiError(NO_CONNECTION_MESSAGE, 0, "network");
  }
  const body = await readBody(response);
  if (response.ok) return body as T;
  if (auth) {
    const ended = sessionEndReason(response.status, body);
    if (ended) throw endGateSession(ended);
  }
  if (opts.acceptResult && body && typeof body.result === "string") return body as T;
  const code = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : null;
  throw new GateApiError(messageOf(body, response.status), response.status, code, body);
}

// ── the endpoints ────────────────────────────────────────────────────────────────────────────────────────────────

export function gateLogin(username: string, password: string): Promise<GateMonitorLoginResponse> {
  return gateRequest<GateMonitorLoginResponse>(GATE_MONITOR_API.login, {
    method: "POST",
    body: { username: username.trim(), password },
    auth: false,
  });
}

/** An old per-gate link's hint ("Signing in to Main Gate"); null when the link is unknown or unreachable. */
export async function gateLoginInfo(loginToken: string): Promise<GateLoginInfo | null> {
  if (!loginToken) return null;
  try {
    return await gateRequest<GateLoginInfo>(GATE_MONITOR_API.loginInfo(loginToken), { auth: false });
  } catch {
    return null;
  }
}

/** Who this gate is, and a renewed token when the old one is past half its life (stored here). */
export async function gateMe(): Promise<GateMonitorMe> {
  const me = await gateRequest<GateMonitorMe>(GATE_MONITOR_API.me);
  refreshGateSession(me);
  return me;
}

/** Sign out: ends this browser's session on the server (best effort), forgets it here whatever the answer. */
export async function gateLogout(): Promise<void> {
  const token = gateToken();
  clearGateSession();
  if (!token) return;
  try {
    await fetch(`${getApiOrigin()}${GATE_MONITOR_API.logout}`, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      credentials: "omit",
    });
  } catch {
    /* offline: the token is forgotten here, and HR can sign the gate out everywhere */
  }
}

export function gateScan(code: string): Promise<GateScanResult> {
  return gateRequest<GateScanResult>(GATE_MONITOR_API.scan, {
    method: "POST",
    body: { qrToken: code },
    acceptResult: true,
  });
}

export function gateSummary(signal?: AbortSignal): Promise<GateMonitorSummary> {
  return gateRequest<GateMonitorSummary>(GATE_MONITOR_API.summary, { signal });
}

export type GateRecordsQuery = {
  from?: string;
  to?: string;
  type?: string;
  result?: string;
  q?: string;
  page?: number;
  pageSize?: number;
};

export function gateRecords(
  query: GateRecordsQuery | URLSearchParams,
  signal?: AbortSignal,
): Promise<GateRecordsPage & { items: GateMonitorRecord[] }> {
  return gateRequest(GATE_MONITOR_API.records, { query: query as RequestOptions["query"], signal });
}

/**
 * This gate's records as an Excel / PDF file (the server's file, kit downloadGateFile) with the GATE token. A 401 / 403
 * means the sign-in is over or the gate was switched off: GET me finds out which and sends the browser to the sign-in.
 */
export async function gateExport(format: GateFileFormat, query: URLSearchParams | GateRecordsQuery): Promise<string> {
  try {
    return await downloadGateFile({
      path: GATE_MONITOR_API.recordsExport,
      query: query as GateFileQuery,
      format,
      title: "Gate records",
      token: gateToken,
    });
  } catch (e) {
    if (e instanceof GateDownloadError && (e.status === 401 || e.status === 403)) {
      await gateMe(); // throws GateSessionEndedError (and redirects) when the session is really over
    }
    throw e;
  }
}
