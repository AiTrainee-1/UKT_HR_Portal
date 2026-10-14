import type {
  AllowanceStatus,
  OvertimeAssignBody,
  OvertimeConfig,
  OvertimeMode,
  OvertimeRow,
  OvertimeSkipped,
  ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { ApiError } from "@/lib/api-client/custom-fetch";
import {
  dateShort,
  isIsoDate,
  isShiftsValue,
  matchesText,
  monthBounds,
  monthYear,
  parseIso,
  sameMonth,
  shiftsText,
  sumShifts,
  fmtShifts,
} from "../logic";

// The rules of the OT Detection tab as pure functions: how the month's records are split into the Type 1 list, the Type 2
// candidates and the history, the tiles, the filters, and everything the Assign dialog decides (what it starts with, what is
// wrong with it, what it sends, what it says will happen).

/** One record is one employee on one OT day. */
export const rowKey = (r: { employeeId: number; date: string }): string => `${r.employeeId}|${r.date}`;

export type OtGroups = {
  /** Type 1: automatic, read-only. */
  allowance: OvertimeRow[];
  /** Type 2 candidates waiting for HR to assign or reject. */
  waiting: OvertimeRow[];
  /** Type 2 that HR already dealt with (assigned or rejected). */
  history: OvertimeRow[];
  /** Records made before the new rules, with their old meaning. */
  legacy: OvertimeRow[];
};

export function groupOt(rows: OvertimeRow[]): OtGroups {
  const groups: OtGroups = { allowance: [], waiting: [], history: [], legacy: [] };
  for (const row of rows) {
    if (row.otType === "allowance") groups.allowance.push(row);
    else if (row.otType === "legacy") groups.legacy.push(row);
    else if (row.status === "detected") groups.waiting.push(row);
    else groups.history.push(row);
  }
  return groups;
}

/** The shifts a record stands for: what HR assigned; an older announced record is one day (one shift) whatever its mode. */
export function shiftsOf(row: OvertimeRow): number | null {
  if (row.shifts !== null && row.shifts !== undefined) return row.shifts;
  if (row.otType === "legacy" && row.status === "announced") return 1;
  return null;
}

/**
 * Where a Type 1 allowance stands: the server's `allowanceStatus`. A backend that does not send it is read from
 * `allowanceUsed` (used, else not used).
 */
export function allowanceStatusOf(row: Pick<OvertimeRow, "allowanceStatus" | "allowanceUsed">): AllowanceStatus {
  if (row.allowanceStatus) return row.allowanceStatus;
  return row.allowanceUsed ? "used" : "not_used";
}

export type OtKpis = {
  allowanceEarned: number;
  allowanceMinutes: number;
  allowanceUsed: number;
  allowanceUsedMinutes: number;
  /** The next working day has come and the employee did not need the allowance. */
  allowanceNotUsed: number;
  /** The next working day is today or later: nothing can be said yet. */
  allowancePending: number;
  waiting: number;
  waitingSuggestedShifts: number;
  assigned: number;
  assignedShifts: number;
  assignedRelaxation: number;
  assignedPay: number;
  rejected: number;
};

/** The figures of the tiles, over every record of the month (the filters do not change them). */
export function otKpis(rows: OvertimeRow[]): OtKpis {
  const kpis: OtKpis = {
    allowanceEarned: 0,
    allowanceMinutes: 0,
    allowanceUsed: 0,
    allowanceUsedMinutes: 0,
    allowanceNotUsed: 0,
    allowancePending: 0,
    waiting: 0,
    waitingSuggestedShifts: 0,
    assigned: 0,
    assignedShifts: 0,
    assignedRelaxation: 0,
    assignedPay: 0,
    rejected: 0,
  };
  const assignedShifts: (number | null)[] = [];
  const suggested: (number | null)[] = [];
  for (const row of rows) {
    if (row.otType === "allowance") {
      kpis.allowanceEarned += 1;
      kpis.allowanceMinutes += row.allowanceMinutes ?? 0;
      const standing = allowanceStatusOf(row);
      if (standing === "used") {
        kpis.allowanceUsed += 1;
        kpis.allowanceUsedMinutes += row.usedMinutes ?? 0;
      } else if (standing === "pending") {
        kpis.allowancePending += 1;
      } else {
        kpis.allowanceNotUsed += 1;
      }
    } else if (row.otType === "shift" && row.status === "detected") {
      // an older record still waiting is not a Type 2 candidate: it is listed under Earlier records
      kpis.waiting += 1;
      suggested.push(row.suggestedShifts);
    } else if (row.status === "announced") {
      kpis.assigned += 1;
      assignedShifts.push(shiftsOf(row));
      if (row.compensationType === "relaxation") kpis.assignedRelaxation += 1;
      if (row.compensationType === "pay") kpis.assignedPay += 1;
    } else if (row.status === "rejected") {
      kpis.rejected += 1;
    }
  }
  kpis.assignedShifts = sumShifts(assignedShifts);
  kpis.waitingSuggestedShifts = sumShifts(suggested);
  return kpis;
}

// ── Filters ───────────────────────────────────────────────────────────────────

export type OtFilters = { q: string; dept: string };

/** Search by name, code or department; `dept` is a department's name ("" = every department). */
export function filterOt(rows: OvertimeRow[], { q, dept }: OtFilters): OvertimeRow[] {
  return rows.filter(
    (r) =>
      (dept === "" || (r.department ?? "") === dept) && matchesText(q, r.employeeName, r.employeeCode, r.department),
  );
}

/** The departments that occur in the month's records, sorted. */
export function otDepartments(rows: OvertimeRow[]): string[] {
  return [...new Set(rows.map((r) => r.department).filter((d): d is string => !!d))].sort((a, b) =>
    a.localeCompare(b, "en", { sensitivity: "base", numeric: true }),
  );
}

export type HistoryStatus = "all" | "assigned" | "rejected";
export const HISTORY_STATUSES: { value: HistoryStatus; label: string }[] = [
  { value: "assigned", label: "Assigned" },
  { value: "rejected", label: "Rejected" },
];

export const isHistoryStatus = (value: string): value is HistoryStatus =>
  value === "all" || value === "assigned" || value === "rejected";

/** The Type 2 history by status. */
export function filterHistory(rows: OvertimeRow[], status: HistoryStatus): OvertimeRow[] {
  if (status === "assigned") return rows.filter((r) => r.status === "announced");
  if (status === "rejected") return rows.filter((r) => r.status === "rejected");
  return rows;
}

// ── Words ─────────────────────────────────────────────────────────────────────

/**
 * Type 1: whether and when the employee used the allowance. A pending one (the next working day has not come) is never
 * "Not used": nothing can be said about it yet.
 */
export function allowanceUseText(row: OvertimeRow): { status: AllowanceStatus; used: boolean; text: string } {
  const status = allowanceStatusOf(row);
  if (status === "used") {
    const minutes = row.usedMinutes ? ` (${row.usedMinutes} min)` : "";
    const day = row.usedOn ? ` on ${dateShort(row.usedOn)}` : "";
    return { status, used: true, text: `Used${day}${minutes}` };
  }
  if (status === "pending") return { status, used: false, text: "Pending" };
  return { status, used: false, text: "Not used" };
}

/** "18:30", or "01:00 (next day)" for a punch after midnight. */
export function lastPunchText(row: Pick<OvertimeRow, "lastPunchOut" | "lastPunchNextDay">): string {
  if (!row.lastPunchOut) return "—";
  return row.lastPunchNextDay ? `${row.lastPunchOut} (next day)` : row.lastPunchOut;
}

/** What an assigned record gave, in a few words: "Relaxation on 5 Mar 2026", "Payment", or the older meaning. */
export function assignedText(row: OvertimeRow): string {
  const legacy = row.otType === "legacy";
  if (row.compensationType === "relaxation") {
    if (legacy) return "Relaxation: one Alternative-Day credit";
    return row.claimDate ? `Relaxation on ${dateShort(row.claimDate)}` : "Relaxation (added to the balance)";
  }
  if (row.compensationType === "pay") {
    if (legacy) return "Payment: one day's pay";
    return row.claimDate ? `Payment (granted ${dateShort(row.claimDate)})` : "Payment";
  }
  return "—";
}

// ── What can be done ──────────────────────────────────────────────────────────

/** The modes HR can give Type 2 in, in the order the dialog offers them: only those switched on in Settings. */
export function assignModes(config: OvertimeConfig | undefined): OvertimeMode[] {
  if (!config || !config.masterEnabled || !config.shiftEnabled) return [];
  const modes: OvertimeMode[] = [];
  if (config.relaxationEnabled) modes.push("relaxation");
  if (config.payEnabled) modes.push("pay");
  return modes;
}

export type Pause = { reason: string; setting?: string } | null;

/**
 * Why changing Type 2 records is paused right now (null when it is not). The master switch first, since nothing at all
 * works without it, then Type 2's own switch, then the two modes.
 */
export function type2Pause(config: OvertimeConfig | undefined, featuresOff: boolean): Pause {
  if (featuresOff || config?.masterEnabled === false) {
    return { reason: "Paused: the OT / Compensation features are switched off in Settings → Payroll" };
  }
  if (!config) return null;
  if (!config.shiftEnabled) {
    return {
      reason: "Paused: Type 2 (shift-based compensation) is switched off in Settings → Compensation",
      setting: "shift-enabled",
    };
  }
  if (!config.relaxationEnabled && !config.payEnabled) {
    return {
      reason: "Paused: neither Relaxation nor Payment is switched on in Settings → Compensation",
      setting: "shift-relaxation",
    };
  }
  return null;
}

// ── The Assign dialog ─────────────────────────────────────────────────────────

export type AssignRow = {
  key: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  /** The OT day. */
  date: string;
  suggested: number | null;
  shifts: ShiftsValue | null;
  /** The date it is granted ("" = not chosen). */
  claimDate: string;
  /** What the server said about this record the last time (shown under the row until it is changed). */
  problem: string | null;
};

/** The dialog starts with every selected record on its suggested shifts and no date. */
export function initialAssignRows(rows: OvertimeRow[]): AssignRow[] {
  return rows.map((r) => ({
    key: rowKey(r),
    employeeId: r.employeeId,
    employeeCode: r.employeeCode,
    employeeName: r.employeeName,
    date: r.date,
    suggested: r.suggestedShifts,
    shifts: isShiftsValue(r.suggestedShifts) ? r.suggestedShifts : null,
    claimDate: "",
    problem: null,
  }));
}

/** The first and last day a record can be granted on: the month of its OT day. */
export const grantBounds = (otDate: string): { min: string; max: string } | null => {
  const b = monthBounds(otDate);
  return b ? { min: b.first, max: b.last } : null;
};

/** The days every row can share: the month the OT days are in (none when they are in different months). */
export function commonBounds(rows: Pick<AssignRow, "date">[]): { min: string; max: string } | null {
  if (rows.length === 0) return null;
  const first = rows[0].date;
  if (!rows.every((r) => sameMonth(r.date, first))) return null;
  return grantBounds(first);
}

/** What is wrong with one row for this mode (null = nothing). */
export function rowProblem(mode: OvertimeMode, row: AssignRow): string | null {
  if (row.shifts === null) return "Choose the shifts: 0.25, 0.50, 0.75 or 1.";
  if (row.claimDate === "") {
    return mode === "relaxation" ? "Choose the date the day off is granted." : null;
  }
  if (!isIsoDate(row.claimDate)) return "Enter a valid date.";
  if (!sameMonth(row.claimDate, row.date)) {
    const d = parseIso(row.date)!;
    return `The date must be in ${monthYear(d.month, d.year)}: the month of the overtime.`;
  }
  return null;
}

export type AssignCheck = { ok: boolean; problems: Record<string, string>; general: string | null };

/** Everything wrong with the dialog as it stands: per row, and as a whole (no mode chosen, nothing to assign). */
export function checkAssign(mode: OvertimeMode | null, modes: OvertimeMode[], rows: AssignRow[]): AssignCheck {
  const problems: Record<string, string> = {};
  if (mode === null || !modes.includes(mode)) {
    return { ok: false, problems, general: "Choose how to give it: Relaxation or Payment." };
  }
  if (rows.length === 0) return { ok: false, problems, general: "There is nothing left to assign." };
  for (const row of rows) {
    const problem = rowProblem(mode, row);
    if (problem) problems[row.key] = problem;
  }
  return { ok: Object.keys(problems).length === 0, problems, general: null };
}

/** The request: every record carries its own shifts and date, so the server needs no batch defaults. */
export function assignPayload(mode: OvertimeMode, rows: AssignRow[]): OvertimeAssignBody {
  return {
    mode,
    records: rows.map((r) => ({
      employeeId: r.employeeId,
      date: r.date,
      shifts: r.shifts as ShiftsValue,
      ...(r.claimDate ? { claimDate: r.claimDate } : {}),
    })),
  };
}

/** What will happen to one record, as the row of the dialog says it. */
export function effectText(mode: OvertimeMode, row: AssignRow): string {
  if (row.shifts === null) return "—";
  if (mode === "relaxation") {
    return row.claimDate
      ? `${dateShort(row.claimDate)} is topped up by ${shiftsText(row.shifts)} (a day never goes above 1 shift).`
      : "Choose the day to top up.";
  }
  const d = parseIso(row.claimDate || row.date)!;
  return `${shiftsText(row.shifts)} × the daily rate is added to the ${monthYear(d.month, d.year)} payslip as OT pay.`;
}

/** The one-paragraph summary above the buttons. */
export function assignSummary(mode: OvertimeMode, rows: AssignRow[]): string {
  const people = new Set(rows.map((r) => r.employeeId)).size;
  const total = sumShifts(rows.map((r) => r.shifts));
  const who = `${rows.length} ${rows.length === 1 ? "record" : "records"} for ${people} ${people === 1 ? "employee" : "employees"}, ${fmtShifts(total)} ${total === 1 ? "shift" : "shifts"} in all.`;
  const what =
    mode === "relaxation"
      ? "Relaxation: each granted day's attendance is topped up by the shifts (never above 1 shift in a day), marked Compensation in attendance."
      : "Payment: each record adds its shifts × the employee's daily rate to the payslip of that month as OT pay (payslips already generated are not changed).";
  return `${who} ${what}`;
}

/** The server's refusals, matched onto the rows (a row is matched by employee and OT day). */
export function applySkipped(rows: AssignRow[], skipped: OvertimeSkipped[]): AssignRow[] {
  return rows.map((row) => {
    const hit = skipped.find((s) => s.employeeId === row.employeeId && s.date === row.date);
    return { ...row, problem: hit ? hit.reason : null };
  });
}

/** The rows the server could not assign (they stay in the dialog with the reason); the others are done. */
export function remainingAfter(rows: AssignRow[], skipped: OvertimeSkipped[]): AssignRow[] {
  return applySkipped(rows, skipped).filter((r) => r.problem !== null);
}

/** The refusals of an assign request that assigned nothing (HTTP 400), or the single sentence. */
export function assignFailure(error: unknown): { message: string; skipped: OvertimeSkipped[] } {
  if (error instanceof ApiError) {
    const data = error.data as { error?: unknown; skipped?: unknown } | null;
    const skipped = Array.isArray(data?.skipped)
      ? (data.skipped as OvertimeSkipped[]).filter((s) => s && typeof s.reason === "string")
      : [];
    const message = typeof data?.error === "string" && data.error ? data.error : "";
    if (message || skipped.length > 0) {
      return { message: message || skipped[0].reason, skipped };
    }
  }
  return { message: "The records could not be assigned. Check the connection and try again.", skipped: [] };
}
