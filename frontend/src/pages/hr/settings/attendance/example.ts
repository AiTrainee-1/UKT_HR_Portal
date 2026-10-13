import { clock, minutesOf } from "@/lib/arrival-rules";

// The one made-up case every example on the Attendance and Late Detection tabs is worked out for, so the numbers on the
// two tabs can be read side by side: a 09:00-18:00 staff shift with 10 minutes' grace and a 60-minute lunch from 13:30,
// paid ₹26,000 a month over 26 working days, so one day ("one shift" of pay) is ₹1,000.
//
// On the Attendance tab HR can move the start and the grace to try their own shift (the end and the lunch keep their
// distance from the start); the Late Detection tab always uses the defaults below.

export const EXAMPLE_START = "09:00";
export const EXAMPLE_GRACE = 10;
export const EXAMPLE_LUNCH_MINUTES = 60;
/** The end is 9 hours after the start and the lunch starts 4 h 30 min after it (18:00 and 13:30 for a 09:00 start). */
const SHIFT_LENGTH = 9 * 60;
const LUNCH_AFTER = 4 * 60 + 30;

export const EXAMPLE_MONTH_SALARY = 26000;
export const EXAMPLE_WORKING_DAYS = 26;
/** Staff payroll's daily rate: the month's salary over that month's working days. */
export const EXAMPLE_DAY_PAY = EXAMPLE_MONTH_SALARY / EXAMPLE_WORKING_DAYS;

/** A shift in minutes since midnight. */
export type ExampleShift = {
  start: number;
  end: number;
  grace: number;
  lunchStart: number;
  lunchMinutes: number;
};

/** The example shift for a start ("HH:MM") and a grace in minutes; null when the start is not a clock time. */
export function exampleShift(start: string = EXAMPLE_START, grace: number = EXAMPLE_GRACE): ExampleShift | null {
  const s = minutesOf(start);
  if (s === null) return null;
  return {
    start: s,
    end: s + SHIFT_LENGTH,
    grace: Number.isFinite(grace) ? Math.max(0, Math.trunc(grace)) : 0,
    lunchStart: s + LUNCH_AFTER,
    lunchMinutes: EXAMPLE_LUNCH_MINUTES,
  };
}

export const DEFAULT_EXAMPLE: ExampleShift = exampleShift()!;

/** "a 09:00-18:00 shift with 10 minutes' grace" */
export const describeShift = (s: ExampleShift): string =>
  `a ${clock(s.start)}-${clock(s.end)} shift with ${s.grace} minute${s.grace === 1 ? "" : "s"}' grace`;

/** "a 09:00 ..." -> "A 09:00 ..." for the start of a sentence. */
export const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The salary line the money in the examples is worked out from. */
export const EXAMPLE_PAY_LINE = `paid ${rupees(EXAMPLE_MONTH_SALARY)} a month over ${EXAMPLE_WORKING_DAYS} working days (${rupees(
  EXAMPLE_DAY_PAY,
)} a day)`;

/** ₹1,000 / ₹250 / ₹1,250.50: whole rupees without decimals, Indian digit grouping. */
export function rupees(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const whole = Number.isInteger(rounded);
  return `₹${rounded.toLocaleString("en-IN", {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** What `shifts` of a day come to in the example salary. */
export const payFor = (shifts: number): number => Math.round(shifts * EXAMPLE_DAY_PAY * 100) / 100;

/** 0.75 -> "0.75 shift", 1 -> "1.00 shift" (how attendance pages print a day's earning). */
export const shiftText = (shifts: number): string => `${shifts.toFixed(2)} shift`;
