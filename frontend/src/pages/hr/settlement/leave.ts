// The leave check of a Salary Advance / Term Loan request (owner 2026-11-26), shown on the Settlement page in both methods:
// the days of leave (Absent + approved leave, a half day 0.5; never Casual Leave, Sundays or holidays) on the working days
// of the 1st-20th of the month it was raised in. Exactly 3 days is a warning (orange), more than 3 is critical (red). The
// server works the days and the flag out (advance_earnings.leave_check_json); this only words them.

import type { AdvanceLeaveCheck } from "@/lib/api-client";
import type { Tone } from "@/lib/statusTones";
import { ordinal } from "./rules";
import { MONTH_FULL } from "./shared";

export type LeaveFlag = AdvanceLeaveCheck["flag"];

export type LeaveChipView = {
  flag: LeaveFlag;
  tone: Tone;
  /** What the chip says: "3 days leave", "4.5 days leave", or "2 days" for one below the warning. */
  text: string;
  /** Said before the text to a screen reader (the colour is never the only signal): "Leave warning:". */
  srPrefix: string;
  /** The whole sentence (the chip's tooltip). */
  title: string;
};

/** The warning line when the server did not say it (it always does): 3 days. */
export const LEAVE_WARNING_AT = 3;

/** "1 day", "3 days", "2.5 days". */
export const leaveDaysText = (days: number): string =>
  `${days.toLocaleString("en-IN", { maximumFractionDigits: 2 })} ${days === 1 ? "day" : "days"}`;

/** The flag of a number of days, as the server words it (advance_earnings.leave_flag). */
export function leaveFlagOf(days: number, warningAt = LEAVE_WARNING_AT): LeaveFlag {
  if (days > warningAt) return "critical";
  if (days === warningAt) return "warning";
  return "ok";
}

/** "1st-20th November 2026" (the days Settings counts: the check's own throughDay). */
const periodOf = (c: AdvanceLeaveCheck): string =>
  `${c.throughDay ? `1st-${ordinal(c.throughDay)}` : "the month so far,"} ${MONTH_FULL[(c.month ?? 1) - 1] ?? ""} ${c.year ?? ""}`.trim();

/** How the chip reads for a request's leave check; null when there is none yet (an older advance, an older server). */
export function leaveChipOf(check: AdvanceLeaveCheck | null | undefined): LeaveChipView | null {
  if (!check || typeof check.days !== "number" || !Number.isFinite(check.days)) return null;
  const warningAt = typeof check.warningAt === "number" ? check.warningAt : LEAVE_WARNING_AT;
  const flag: LeaveFlag =
    check.flag === "ok" || check.flag === "warning" || check.flag === "critical"
      ? check.flag
      : leaveFlagOf(check.days, warningAt);
  const days = leaveDaysText(check.days);
  const period = periodOf(check);
  if (flag === "critical") {
    return {
      flag,
      tone: "danger",
      text: `${days} leave`,
      srPrefix: "Leave critical:",
      title: `Critical: ${days} of leave (absent or on leave) in ${period}, more than ${leaveDaysText(warningAt)}.`,
    };
  }
  if (flag === "warning") {
    return {
      flag,
      tone: "caution",
      text: `${days} leave`,
      srPrefix: "Leave warning:",
      title: `Warning: ${days} of leave (absent or on leave) in ${period}.`,
    };
  }
  return {
    flag,
    tone: "neutral",
    text: days,
    srPrefix: "Leave:",
    title: `${days} of leave (absent or on leave) in ${period}: below the ${leaveDaysText(warningAt)} warning.`,
  };
}

/** The flagged ones only (warning or critical): what a list row shows. */
export const leaveFlagged = (check: AdvanceLeaveCheck | null | undefined): boolean => {
  const view = leaveChipOf(check);
  return view != null && view.flag !== "ok";
};
