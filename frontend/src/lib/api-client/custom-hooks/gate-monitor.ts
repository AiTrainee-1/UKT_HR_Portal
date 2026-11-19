// gate-monitor: the shared gate sign-in at /gatemonitor and its console. OWNER: slice A. TYPES ONLY, on purpose: the
// gate monitor must never send the HR token, so its calls do not go through customFetch (which falls back to the HR
// "uk_textile_token") but through its own small fetch wrapper, pages/gate/monitor/client.ts, which sets
// `Authorization: Bearer <gate token>` itself (no header at all for the sign-in). Gate localStorage keys stay
// gate_device_token / gate_device_id / gate_device_name (e2e relies on them).
//
//   POST /api/gate-monitor/login    {username, password} -> GateMonitorLoginResponse
//                                   401 "Wrong username or password." / 403 switched off / 429 too many tries (+ `code`)
//   GET  /api/gate-monitor/me       -> GateMonitorMe (`token` = a fresh one when fewer than 15 days are left)
//   POST /api/gate-monitor/logout   204 (ends this session only)
//   POST /api/gate-monitor/scan     {qrToken} -> GateScanResult (the same body as /api/gate-devices/scan);
//                                   403 not_allowed_here when the gate does not take that kind of code
//   GET  /api/gate-monitor/summary  -> GateMonitorSummary (today, this gate)
//   GET  /api/gate-monitor/records?from&to&type&result&q&page&pageSize -> GateRecordsPage (this gate only)
//   GET  /api/gate-monitor/records/export?fmt=xlsx|pdf&<filters>  (kit/download.ts with `token` = the gate token)
// A switched-off gate answers 403 {code: "gate_revoked"}, an ended sign-in 401 {code: "session_ended"}.

import type { GateRecord } from "./gate-records";

/** The gate a monitor is signed in to (never its username, password or login link). */
export type GateMonitorGate = {
  id: number;
  name: string;
  branchName: string | null;
  location: string | null;
  /** The gate takes gate passes (exit and return). */
  allowOutpass: boolean;
  /** The gate takes tea-break QRs. */
  allowTeaBreak: boolean;
};

export type GateMonitorLoginResponse = { token: string; gate: GateMonitorGate };

/** This browser's sign-in; null for a token from before 18 Nov 2026 (no session row). */
export type GateMonitorSession = {
  id: number;
  deviceLabel: string | null;
  createdAt: string | null;
  lastSeenAt: string | null;
};

export type GateMonitorMe = {
  gate: GateMonitorGate;
  session: GateMonitorSession | null;
  /** When the token this browser holds (or the fresh `token`) runs out. */
  expiresAt: string | null;
  /** Present when the session was renewed: store it in place of the old one. */
  token?: string;
};

export type GateMonitorSummary = {
  exits: number;
  returns: number;
  teaOut: number;
  teaIn: number;
  denied: number;
  total: number;
  /** Passes that went out through this gate today and have not come back. */
  passesOutNow: number;
  /** Tea breaks started at this gate today and not ended. */
  teaOutNow: number;
  outNow: number;
  /** Today in India (YYYY-MM-DD). */
  date: string;
};

/** `GET /api/gate-devices/login-info/<token>` (public): an old per-gate link names its gate as a hint. */
export type GateLoginInfo = { gateName: string; branchName: string; isActive: boolean };

/** What a scan can answer. The console treats any other value as "check with HR" (it never crashes on a new one). */
export type GateScanResultCode =
  "success" | "already_scanned" | "expired" | "not_approved" | "invalid_qr" | "not_exited" | "not_allowed_here";

export type GateScanPerson = {
  id?: number;
  name: string;
  employeeCode: string;
  department: string | null;
  photoUrl: string | null;
};

/** POST .../scan, every status (200 / 400 / 403 / 404 / 409 / 410 all carry this body). */
export type GateScanResult = {
  result: GateScanResultCode | (string & {});
  message: string;
  /** A gate pass: which leg ("entry" = the return). Absent for a tea break and an unreadable code. */
  scanType?: "exit" | "entry";
  /** A tea break: started ("out") or ended ("in"). */
  action?: "out" | "in";
  takenMinutes?: number;
  /** not_allowed_here: which kind the gate refused. */
  kind?: "outpass" | "tea_break";
  employee?: GateScanPerson;
  destination?: string | null;
  reason?: string | null;
  approvedBy?: string | null;
  approverRole?: string | null;
  approvedAt?: string | null;
  expiresAt?: string | null;
  gateName?: string | null;
  exitedAt?: string | null;
  entryGateName?: string | null;
  enteredAt?: string | null;
};

/** A gate record as the monitor reads it (the shared row, a tea break's minutes included). */
export type GateMonitorRecord = GateRecord;

/** The localStorage keys of a gate's session (kept from the old gate scanner). */
export const GATE_SESSION_KEYS = {
  token: "gate_device_token",
  id: "gate_device_id",
  name: "gate_device_name",
} as const;

export const GATE_MONITOR_API = {
  login: "/api/gate-monitor/login",
  me: "/api/gate-monitor/me",
  logout: "/api/gate-monitor/logout",
  scan: "/api/gate-monitor/scan",
  summary: "/api/gate-monitor/summary",
  records: "/api/gate-monitor/records",
  recordsExport: "/api/gate-monitor/records/export",
  loginInfo: (loginToken: string) => `/api/gate-devices/login-info/${encodeURIComponent(loginToken)}`,
} as const;
