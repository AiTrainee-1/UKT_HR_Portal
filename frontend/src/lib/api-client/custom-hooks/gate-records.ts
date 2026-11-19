// gate-records: the ONE gate record row both Manage Gates (slice B1, HR: /api/gate-devices/records) and the Gate Monitor
// (slice A, the gate's own session: /api/gate-monitor/records) list and export. Built server side by gate_records.py from
// OutpassGateScan (exit -> "exit", entry -> "return") and TeaBreakLog (out -> "tea_out", in -> "tea_in"), merged in SQL,
// newest first. Types only: a contract shared by two slices, so change it only together with gate_records.py.
// (FOUNDATION: owned by the foundation stage; slices A and B1 import from here, neither edits it alone.)

import type { PaginatedRecords } from "./gate";

/** An employee as the gate pages show one (photoUrl is a signed link, never an embedded picture). */
export type GatePerson = {
  id: number;
  employeeCode: string;
  name: string;
  department: string | null;
  designation?: string | null;
  photoUrl: string | null;
};

export type GateRecordType = "exit" | "return" | "tea_out" | "tea_in";
export type GateRecordResult = "allowed" | "denied";

export type GateRecord = {
  /** "scan-<pk>" | "teaout-<pk>" | "teain-<pk>": unique across the three sources. */
  id: string;
  at: string;
  type: GateRecordType;
  result: GateRecordResult;
  /** The OutpassGateScan result code of a pass scan ("already_scanned", "expired", "not_allowed_here" ...), else null. */
  reason: string | null;
  reasonLabel: string | null;
  message: string | null;
  gateId: number | null;
  gateName: string | null;
  /** Null for a scan whose code named nobody (invalid_qr). */
  employee: GatePerson | null;
  destination: string | null;
  passId: number | null;
  /** How long the break lasted, on a "tea_in" row (null on every other row). */
  minutes?: number | null;
};

export type GateRecordCounts = { exits: number; returns: number; teaOut: number; teaIn: number; denied: number };

/** `GET .../records`: one page of rows, the total and the counts of every matching row (not only this page). */
export type GateRecordsPage = PaginatedRecords<GateRecord> & { counts: GateRecordCounts };

/**
 * The filters both record lists take (as query parameters). `from` / `to` are inclusive days in India (YYYY-MM-DD);
 * `gateId` is one id or a comma list (HR only: the gate monitor always lists its own gate); `branchId` is for an HR
 * account that is not bound to a branch.
 */
export type GateRecordFilters = {
  gateId?: string;
  from?: string;
  to?: string;
  type?: GateRecordType | "";
  result?: GateRecordResult | "";
  q?: string;
  branchId?: string;
  page?: number;
  pageSize?: number;
};

export const GATE_RECORD_TYPE_LABEL: Record<GateRecordType, string> = {
  exit: "Exit",
  return: "Return",
  tea_out: "Tea break out",
  tea_in: "Tea break in",
};

export const GATE_RECORD_RESULT_LABEL: Record<GateRecordResult, string> = { allowed: "Allowed", denied: "Denied" };
