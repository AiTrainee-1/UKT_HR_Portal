// Worked examples for the Compensation tab, computed with the same rules the attendance engine and payroll apply, so the
// lines on screen are what the system would do with the values being typed (not the saved ones):
//   Type 1 next-day allowance   the row with the most extra work the day reaches gives the allowance minutes; the first
//                               punch is judged against the shift start + allowance + the shift's own grace
//   Type 2 shift ladder         only a last punch MORE than the threshold past the shift end qualifies; then the first
//                               enabled row (in time order) whose limit is later than the punch gives the shifts
//   Pay                         shifts x the staff daily rate (payroll's own rounding, payroll/preview.ts staffPay)
// Everything here is pure: nothing fetches or stores anything.
import { EXAMPLE_MONTH_SALARY, EXAMPLE_WORKING_DAYS } from "../attendance/example";
import { divRoundHalfUp, formatPaise, staffPay } from "../payroll/preview";
import { formatDuration } from "./time";

/** The one made-up shift both examples use: 9:00 AM to 5:30 PM with 10 minutes' grace. */
export const EXAMPLE_SHIFT = { start: 9 * 60, end: 17 * 60 + 30, grace: 10 };

// ── Type 1 ──

export type AllowanceValue = { enabled: boolean; minExtraMinutes: number; allowanceMinutes: number };

/**
 * The allowance a day earns: the enabled row with the most extra work that the day reaches (0 when none is reached).
 * `maxExtra` is where Type 2 starts: a day with MORE extra work than that is Type 2's, not the allowance's.
 */
export function allowanceFor(
  extraMinutes: number,
  rules: AllowanceValue[],
  maxExtra?: number,
): { minutes: number; rule: number | null } {
  if (maxExtra !== undefined && extraMinutes > maxExtra) return { minutes: 0, rule: null };
  let best: number | null = null;
  rules.forEach((rule, i) => {
    if (!rule.enabled || rule.minExtraMinutes > extraMinutes) return;
    if (best === null || rule.minExtraMinutes >= rules[best].minExtraMinutes) best = i;
  });
  return best === null ? { minutes: 0, rule: null } : { minutes: rules[best].allowanceMinutes, rule: best };
}

export type FirstPunch = "on-time" | "compensation" | "late-rules";

/**
 * What happens to the next working day's first punch. Up to start + grace it is on time and the allowance is not used.
 * Up to start + allowance + grace it is inside the allowance: not Late, marked Compensation. After that the normal Late
 * rules judge it.
 */
export function judgeFirstPunch(punch: number, allowance: number, shift = EXAMPLE_SHIFT): FirstPunch {
  if (punch <= shift.start + shift.grace) return "on-time";
  if (punch <= shift.start + allowance + shift.grace) return "compensation";
  return "late-rules";
}

/** The latest first punch that is still inside the allowance (10:10 AM for a 9:00 AM shift, 10 minutes' grace, 60 minutes). */
export const allowanceLimit = (allowance: number, shift = EXAMPLE_SHIFT): number =>
  shift.start + allowance + shift.grace;

/** The rows' own names for the example: "the 2 hours row". */
export const ruleName = (rule: { label: string; minExtraMinutes: number }): string =>
  rule.label.trim() || formatDuration(rule.minExtraMinutes);

// ── Type 2 ──

export type ShiftValue = { enabled: boolean; untilMinutes: number | null; shifts: number };

/** The enabled rows in the order the engine reads them: by limit, the row with no limit last. */
export const ladderOrder = <T extends ShiftValue>(rules: T[]): T[] =>
  rules
    .filter((r) => r.enabled)
    .sort((a, b) => (a.untilMinutes ?? Number.POSITIVE_INFINITY) - (b.untilMinutes ?? Number.POSITIVE_INFINITY));

export type Type2Result = {
  /** Minutes between the shift end and the last punch-out. */
  extra: number;
  /** True only when the extra work is MORE than the threshold (exactly the threshold is still Type 1). */
  qualifies: boolean;
  /** The shifts of the matching row; null when the day does not qualify or no row's limit is later than the punch. */
  shifts: number | null;
  /** The matching row's position among the enabled rows in time order (0-based). */
  row: number | null;
};

/**
 * Type 2 for one day. `lastPunch` is in minutes since the OT day's midnight (00:40 the next morning is 1480).
 */
export function shiftFor(
  lastPunch: number,
  threshold: number,
  rules: ShiftValue[],
  shiftEnd = EXAMPLE_SHIFT.end,
): Type2Result {
  const extra = lastPunch - shiftEnd;
  if (extra <= threshold) return { extra, qualifies: false, shifts: null, row: null };
  const ordered = ladderOrder(rules);
  const row = ordered.findIndex((r) => r.untilMinutes === null || r.untilMinutes > lastPunch);
  return { extra, qualifies: true, shifts: row === -1 ? null : ordered[row].shifts, row: row === -1 ? null : row };
}

/** The staff daily rate of the example salary, in paise (₹26,000 over 26 working days = ₹1,000, as on the other tabs). */
export const exampleDailyRate = (): number =>
  staffPay({
    salary: EXAMPLE_MONTH_SALARY,
    workingDays: EXAMPLE_WORKING_DAYS,
    daysPaid: EXAMPLE_WORKING_DAYS,
  }).dailyRate;

/** What `shifts` come to as Pay in the example: shifts x the daily rate, rounded to the paisa like payroll. */
export const payForShifts = (shifts: number): string =>
  formatPaise(divRoundHalfUp(exampleDailyRate() * Math.round(shifts * 100), 100));

/** 0.25 -> "0.25 shift", 1 -> "1.00 shift". */
export const shiftsText = (shifts: number): string => `${shifts.toFixed(2)} shift`;

/** 0.5 -> "half a day", 0.25 -> "a quarter of a day", 1 -> "one whole day". */
export function dayWords(shifts: number): string {
  if (shifts === 1) return "one whole day";
  if (shifts === 0.5) return "half a day";
  if (shifts === 0.25) return "a quarter of a day";
  if (shifts === 0.75) return "three quarters of a day";
  return `${shifts.toFixed(2)} of a day`;
}
