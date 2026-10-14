import type {
  BalanceEntry,
  CompensationWindow,
  CreateWindowBody,
  HolidayWorkClaim,
  HolidayWorkEligibleEmployee,
  RaiseHolidayWorkBody,
  ShiftsValue,
} from "@/lib/api-client/custom-hooks";
import { waitingText } from "@/lib/approval-workflow";
import type { Tone } from "@/lib/statusTones";
import {
  addDays,
  clock12,
  dateLong,
  dateShort,
  isIsoDate,
  isShiftsValue,
  shiftsText,
  sumShifts,
  fmtShifts,
} from "../logic";

// The rules of Compensation Leave as pure functions: the announce form (A), the Sunday / holiday work claim form and the claim
// list (B), the balance and the redeem form (B), with the words each one shows.

// ── A. Announced late-in / early-out ──────────────────────────────────────────

/** HR can announce a window at most this many days ahead (the server refuses more). */
export const WINDOW_MAX_DAYS_AHEAD = 180;
export const WINDOW_REASON_MAX = 300;

export type WindowForm = {
  date: string;
  kind: "late_in" | "early_out";
  /** HH:MM */
  time: string;
  reason: string;
  departmentId: string;
  branchId: string;
};

export const emptyWindowForm = (today: string): WindowForm => ({
  date: today,
  kind: "late_in",
  time: "",
  reason: "",
  departmentId: "",
  branchId: "",
});

export type WindowCheck = { ok: boolean; problems: Partial<Record<"date" | "time" | "reason", string>> };

/** What is wrong with the announce form (the same rules the server enforces, so HR sees them before sending). */
export function checkWindow(form: WindowForm, today: string): WindowCheck {
  const problems: WindowCheck["problems"] = {};
  if (!form.date) problems.date = "Choose the date.";
  else if (!isIsoDate(form.date)) problems.date = "Enter a valid date.";
  else if (form.date < today) problems.date = "A window can only be announced for today or a later date.";
  else if (form.date > addDays(today, WINDOW_MAX_DAYS_AHEAD)) {
    problems.date = `A window can only be announced up to ${WINDOW_MAX_DAYS_AHEAD} days ahead.`;
  }
  if (!/^\d{2}:\d{2}$/.test(form.time)) {
    problems.time = form.kind === "late_in" ? "Enter the latest arrival time." : "Enter the earliest leaving time.";
  }
  const reason = form.reason.trim();
  if (reason === "") problems.reason = "Give a reason (what happened?): staff see it with the announcement.";
  else if (reason.length > WINDOW_REASON_MAX)
    problems.reason = `The reason can be at most ${WINDOW_REASON_MAX} characters.`;
  return { ok: Object.keys(problems).length === 0, problems };
}

export function windowPayload(form: WindowForm): CreateWindowBody {
  return {
    date: form.date,
    kind: form.kind,
    time: form.time,
    reason: form.reason.trim(),
    branchId: form.branchId ? Number(form.branchId) : null,
    departmentId: form.departmentId ? Number(form.departmentId) : null,
  };
}

/** Who an announcement covers, in words: "all staff", "all staff of Head Office", "Cutting staff of Head Office". */
export function scopeText(parts: { branch?: string | null; department?: string | null }): string {
  const { branch, department } = parts;
  if (department && branch) return `${department} staff of ${branch}`;
  if (department) return `${department} staff`;
  if (branch) return `all staff of ${branch}`;
  return "all staff";
}

/** What an announcement will do, before it is sent. */
export function windowSentence(
  form: WindowForm,
  scope: { branch?: string | null; department?: string | null },
): string {
  if (!form.date || !/^\d{2}:\d{2}$/.test(form.time)) return "";
  const who = scopeText(scope);
  const time = clock12(form.time);
  if (form.kind === "late_in") {
    return `On ${dateLong(form.date)}, ${who} may arrive up to ${time}. Their regular shift start and grace do not apply that day, so nobody arriving by ${time} is marked Late; after ${time} the usual Late rules count from ${time}.`;
  }
  return `On ${dateLong(form.date)}, ${who} may leave from ${time}. Their regular shift end and grace do not apply that day, so nobody leaving at or after ${time} is marked Early Out.`;
}

/** The announcements from today on (soonest first) and the earlier ones (newest first). */
export function splitWindows(
  rows: CompensationWindow[],
  today: string,
): { upcoming: CompensationWindow[]; earlier: CompensationWindow[] } {
  const upcoming = rows.filter((r) => r.date >= today).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const earlier = rows.filter((r) => r.date < today).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return { upcoming, earlier };
}

export function windowKindText(row: Pick<CompensationWindow, "kind" | "kindLabel">): string {
  if (row.kind === "day") return "Compensation Day (older kind)";
  return row.kindLabel || (row.kind === "late_in" ? "Late-in" : "Early-out");
}

/** "Arrive up to 10:30 AM", "Leave from 4:00 PM", or the old "Leave until" of an older Compensation Day. */
export function windowTimeText(row: Pick<CompensationWindow, "kind" | "time">): string {
  if (row.kind === "day")
    return row.time ? `Leave until ${clock12(row.time)}` : "Whole day exempt from Late / Permission";
  if (!row.time) return "—";
  return row.kind === "late_in" ? `Arrive up to ${clock12(row.time)}` : `Leave from ${clock12(row.time)}`;
}

export function windowScopeText(row: CompensationWindow): string {
  if (row.employeeCount > 0) return `${row.employeeCount} named ${row.employeeCount === 1 ? "employee" : "employees"}`;
  return scopeText({ branch: row.branch, department: row.department });
}

// ── B. Work on Sundays and company holidays ───────────────────────────────────

export const CLAIM_REASON_MAX = 500;

/** The month value of the claims list that means every month (`?hmonth=all`, asked as `anyMonth=1`). */
export const WHOLE_YEAR = "all";

/** The ticked employees and the shifts chosen for each (null = not chosen yet). */
export type ClaimSelection = Record<number, ShiftsValue | null>;

export type ClaimCheck = {
  ok: boolean;
  /** Why the form cannot be sent yet, in one sentence (null when it can). */
  first: string | null;
  /** The ticked employees with no shifts chosen. */
  missingShifts: number[];
  reasonProblem: string | null;
};

export function checkClaim(selection: ClaimSelection, reason: string, canRaise: boolean): ClaimCheck {
  const ids = Object.keys(selection).map(Number);
  const missing = ids.filter((id) => selection[id] === null);
  const text = reason.trim();
  const reasonProblem =
    text === ""
      ? "Give a reason (what was the work on that day?): the Department Head reads it before deciding."
      : text.length > CLAIM_REASON_MAX
        ? `The reason can be at most ${CLAIM_REASON_MAX} characters.`
        : null;
  let first: string | null = null;
  if (!canRaise) first = "Raising claims is paused: see the notice above.";
  else if (ids.length === 0) first = "Tick the employees who worked.";
  else if (missing.length > 0) first = "Choose the shifts for every ticked employee.";
  else if (reasonProblem) first = reasonProblem;
  return { ok: first === null, first, missingShifts: missing, reasonProblem };
}

export function claimPayload(workDate: string, selection: ClaimSelection, reason: string): RaiseHolidayWorkBody {
  return {
    workDate,
    reason: reason.trim(),
    items: Object.entries(selection).map(([id, shifts]) => ({ employeeId: Number(id), shifts: shifts as ShiftsValue })),
  };
}

/** "9:00 - 17:30 (8 h 30 min, 4 punches)": what the employee's punches on the day say. */
export function punchSummary(
  e: Pick<HolidayWorkEligibleEmployee, "firstPunch" | "lastPunch" | "spanMinutes" | "punchCount">,
): string {
  if (!e.firstPunch) return e.punchCount > 0 ? `${e.punchCount} punches` : "No punches";
  const span =
    e.spanMinutes && e.spanMinutes > 0
      ? `${Math.floor(e.spanMinutes / 60)} h ${String(e.spanMinutes % 60).padStart(2, "0")} min`
      : null;
  const punches = `${e.punchCount} ${e.punchCount === 1 ? "punch" : "punches"}`;
  return `${e.firstPunch} - ${e.lastPunch ?? "?"} (${[span, punches].filter(Boolean).join(", ")})`;
}

/** The last Sunday on or before a day: where the date of a claim starts. */
export function lastSunday(today: string): string {
  const [y, m, d] = today.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(today, -dow);
}

export type ClaimStatusInfo = { label: string; tone: Tone };

/** "Waiting for HOD" / "Approved" / "Rejected" for a claim, from the approval pipeline when the server sent it. */
export function claimStatusInfo(claim: Pick<HolidayWorkClaim, "status" | "approval">): ClaimStatusInfo {
  if (claim.status === "approved") return { label: "Approved", tone: "success" };
  if (claim.status === "rejected") return { label: "Rejected", tone: "danger" };
  return { label: waitingText(claim.approval) ?? "Waiting for HOD", tone: "warning" };
}

/** Who decided and when ("Approved by Suresh Raj, 14 Oct 2026"), or null while it waits. */
export function decisionText(claim: Pick<HolidayWorkClaim, "status" | "reviewedBy" | "reviewedAt">): string | null {
  if (claim.status === "pending") return null;
  const who = claim.reviewedBy ? ` by ${claim.reviewedBy}` : "";
  const when = claim.reviewedAt ? `, ${dateShort(claim.reviewedAt.slice(0, 10))}` : "";
  return `${claim.status === "approved" ? "Approved" : "Rejected"}${who}${when}`;
}

export function dayKindText(claim: Pick<HolidayWorkClaim, "dayKind" | "holidayName">): string {
  if (claim.dayKind === "sunday") return "Sunday";
  return claim.holidayName ? `Holiday: ${claim.holidayName}` : "Company holiday";
}

export const CLAIM_STATUS_OPTIONS = [
  { value: "pending", label: "Waiting for HOD" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

// ── The balance ───────────────────────────────────────────────────────────────

/** What a ledger entry is, in words HR reads. */
export function entrySourceText(entry: Pick<BalanceEntry, "source" | "type">): string {
  switch (entry.source) {
    case "holiday_work":
      return "Sunday / holiday work (approved by the Department Head)";
    case "legacy_credit":
      return entry.type === "credit" ? "Earlier Alternative-Day credit" : "Earlier Alternative-Day credit used";
    case "redemption":
      return "Redeemed as a day off";
    case "ot_shift":
      return "Overtime relaxation without a date";
    default:
      return entry.type === "credit" ? "Added" : "Used";
  }
}

export type RedeemForm = { date: string; shifts: ShiftsValue | null };
export type RedeemCheck = {
  ok: boolean;
  dateProblem: string | null;
  shiftsProblem: string | null;
  after: number | null;
};

/** The redeem form: a date, and shifts that are one of the four amounts and not more than the balance. */
export function checkRedeem(form: RedeemForm, balance: number): RedeemCheck {
  let dateProblem: string | null = null;
  if (!form.date) dateProblem = "Choose the day the day off is taken.";
  else if (!isIsoDate(form.date)) dateProblem = "Enter a valid date.";
  let shiftsProblem: string | null = null;
  if (form.shifts === null) shiftsProblem = "Choose how many shifts.";
  else if (!isShiftsValue(form.shifts)) shiftsProblem = "Shifts must be 0.25, 0.50, 0.75 or 1.";
  else if (form.shifts > balance + 1e-9) shiftsProblem = `More than the balance (${fmtShifts(balance)}).`;
  return {
    ok: dateProblem === null && shiftsProblem === null,
    dateProblem,
    shiftsProblem,
    after: form.shifts !== null && form.shifts <= balance + 1e-9 ? sumShifts([balance, -form.shifts]) : null,
  };
}

/** "The day is topped up by 0.50 shift: the balance goes from 1.50 to 1.00." */
export function redeemSummary(form: RedeemForm, balance: number): string {
  if (form.shifts === null) return "";
  const after = sumShifts([balance, -form.shifts]);
  const day = form.date ? dateLong(form.date) : "the chosen day";
  return `${day} is topped up by ${shiftsText(form.shifts)} (a day never goes above 1 shift) and marked Compensation in attendance. The balance goes from ${fmtShifts(balance)} to ${fmtShifts(after)}.`;
}
