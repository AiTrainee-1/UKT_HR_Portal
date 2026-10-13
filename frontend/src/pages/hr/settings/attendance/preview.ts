import {
  arrivalLimits,
  arrivalZone,
  clock,
  minutesOf,
  type ArrivalLimits,
  type ArrivalSettings,
  type ArrivalZone,
} from "@/lib/arrival-rules";
import type { ExampleShift } from "./example";

// The worked examples on the Attendance tab. Each function is the twin of one piece of the attendance engine (named in
// its comment) and is tested against the engine's own numbers (preview.test.ts), so an example shows what the engine
// would really decide for the values being typed. Times are minutes since the day's midnight; a punch made after
// midnight that belongs to the day before counts past 24:00 (01:10 = 1510), as the engine counts it.

/** A permission is always this long (EmployeePermission.FIXED_DURATION_MINUTES). */
export const PERMISSION_MINUTES = 60;
/** The retired fixed first-half end, still used for staff with no shift (PayrollSettings.half_day_first_half_end_time). */
export const FIXED_FIRST_HALF_END = 13 * 60 + 30;

export type DayStatus = "present" | "half_shift" | "absent";

/**
 * attendance_final._half_day_status: the morning half is made when the FIRST punch is at or before the shift's
 * first-half limit (or, with no shift, any punch before the fixed first-half end); the evening half when ANY punch is at
 * or after Second Half Start. Both = Full Day (1.00), one = Half Day (0.50), neither = Absent.
 */
export function halfDayStatus(
  punches: number[],
  secondHalfStart: number,
  firstHalfUntil: number | null,
  fixedFirstHalfEnd: number = FIXED_FIRST_HALF_END,
): { status: DayStatus; shifts: number; morning: boolean; evening: boolean } {
  if (punches.length === 0) return { status: "absent", shifts: 0, morning: false, evening: false };
  const morning =
    firstHalfUntil === null ? punches.some((p) => p < fixedFirstHalfEnd) : Math.min(...punches) <= firstHalfUntil;
  const evening = punches.some((p) => p >= secondHalfStart);
  if (morning && evening) return { status: "present", shifts: 1, morning, evening };
  if (morning || evening) return { status: "half_shift", shifts: 0.5, morning, evening };
  return { status: "absent", shifts: 0, morning, evening };
}

export type StaffDayInput = {
  punches: number[];
  shift: ExampleShift;
  arrival: ArrivalSettings;
  secondHalfStart: number;
  morningLateIn: boolean;
  eveningEarlyOut: boolean;
  /** An approved Morning Late-In permission within the monthly cap, that day. */
  morningPermission?: boolean;
  /** An approved Evening Early-Out permission within the monthly cap, that day. */
  eveningPermission?: boolean;
};

export type StaffDay = {
  status: DayStatus;
  /** What the day earns: 1.00, 0.75 after a quarter-shift arrival, 0.50, 0. */
  shifts: number;
  zone: ArrivalZone | null;
  late: boolean;
  earlyOut: boolean;
  limits: ArrivalLimits | null;
  /** Shift end minus grace (after an Evening Early-Out permission moved the end): leaving before it is Early Out. */
  earlyOutBefore: number;
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);

/**
 * attendance_final.compute_day_record for a staff day (no Compensation Day, no half-day leave): Full / Half / Absent from
 * _half_day_status, where the first punch falls on the arrival timeline (arrival_rules.zone_of), the Late mark (only an
 * arrival inside the Late window, and only while Morning Late-In is on), the quarter-shift cut (only on a day that is
 * otherwise a Full Day) and Early Out (the last punch of a day with 2+ punches before shift end minus grace).
 */
export function judgeStaffDay(input: StaffDayInput): StaffDay {
  const punches = [...input.punches].sort((a, b) => a - b);
  const { shift, arrival } = input;
  const limits = arrivalLimits(clock(shift.start), shift.grace, arrival);
  const half = halfDayStatus(punches, input.secondHalfStart, limits ? limits.firstHalfUntil : null);
  const earlyOutBefore = shift.end - (input.eveningPermission ? PERMISSION_MINUTES : 0) - shift.grace;
  if (punches.length === 0) {
    return { status: "absent", shifts: 0, zone: null, late: false, earlyOut: false, limits, earlyOutBefore };
  }
  const zone = limits ? arrivalZone(clock(punches[0]), limits, !!input.morningPermission) : null;
  let shifts = half.shifts;
  if (zone === "quarter" && half.status === "present") shifts = 1 - clamp01(arrival.quarterDeduction);
  const last = punches.length > 1 ? punches[punches.length - 1] : null;
  return {
    status: half.status,
    shifts,
    zone,
    late: input.morningLateIn && zone === "late",
    earlyOut: input.eveningEarlyOut && last !== null && last < earlyOutBefore,
    limits,
    earlyOutBefore,
  };
}

/** "Full Day" / "Half Day" / "Absent". */
export const statusLabel = (status: DayStatus): string =>
  status === "present" ? "Full Day" : status === "half_shift" ? "Half Day" : "Absent";

// ── Lunch return (Strict mode) ──

export type LunchVerdict = "on_time" | "night_late" | "lunch_permission";

/** shift_engine reads `afternoon_late_window_minutes or 60`: 0 (or nothing) behaves as 60. */
export const effectiveNightLateWindow = (minutes: number): number =>
  Number.isFinite(minutes) && Math.trunc(minutes) > 0 ? Math.trunc(minutes) : 60;

/** shift_engine reads `afternoon_permission_window_minutes or 0`. */
export const effectiveLunchZone = (minutes: number): number =>
  Number.isFinite(minutes) && minutes > 0 ? Math.trunc(minutes) : 0;

/**
 * shift_engine.compute_daily_shift_log, the lunch-return check (Strict mode, both lunch punches present): the deadline
 * is the lunch-out punch plus the shift's lunch length; a return up to the Night Late window past it is "Night Late",
 * the next band (the zone width) is "Lunch-return permission", and anything later is "Night Late" again
 * (_classify_zone with no grace). So every late return is flagged one way or the other.
 */
export function lunchReturn(
  lunchOut: number,
  back: number,
  lunchMinutes: number,
  nightLateWindow: number,
  zoneWidth: number,
): { verdict: LunchVerdict; deadline: number; minutesOver: number } {
  const deadline = lunchOut + (lunchMinutes > 0 ? lunchMinutes : 60);
  const over = Math.max(0, back - deadline);
  const window = effectiveNightLateWindow(nightLateWindow);
  const zone = effectiveLunchZone(zoneWidth);
  let verdict: LunchVerdict = "night_late";
  if (over <= 0) verdict = "on_time";
  else if (over > window && over <= window + zone) verdict = "lunch_permission";
  return { verdict, deadline, minutesOver: over };
}

// ── Forgotten last punch after midnight ──

export type MidnightRule = {
  /** Latest time on the next morning (minutes after its midnight) a punch is given back to the day before. */
  cutoff: number;
  /** Where the hours after shift end alone would reach (minutes after the next midnight). */
  reach: number;
  /** Where the next shift's protection stops it (minutes after the next midnight); null when there is no next shift. */
  protectedFrom: number | null;
  limitedBy: "grace" | "protection";
};

/**
 * shift_engine._cross_midnight_claim_cutoff: shift end + the grace hours, capped at the next shift's start minus the
 * protection hours. Null when the grace is 0 (the rule is off) or the window ends before midnight. Judged in seconds
 * like the engine; the cutoff itself is inclusive.
 */
export function forgottenExitRule(
  shiftEnd: number,
  nextStart: number | null,
  graceHours: number,
  protectionHours: number,
): MidnightRule | null {
  if (!Number.isFinite(graceHours) || graceHours <= 0) return null;
  const reachS = shiftEnd * 60 + Math.trunc(graceHours * 3600);
  let endS = reachS;
  let capS: number | null = null;
  if (nextStart !== null) {
    const buffer = Number.isFinite(protectionHours) && protectionHours > 0 ? protectionHours : 0;
    capS = 86400 + nextStart * 60 - Math.trunc(buffer * 3600);
    endS = Math.min(endS, capS);
  }
  if (endS <= 86400) return null;
  const cutoffS = Math.max(0, Math.min(86399, endS - 86400));
  return {
    cutoff: Math.floor(cutoffS / 60),
    reach: Math.floor((reachS - 86400) / 60),
    protectedFrom: capS === null ? null : Math.floor((capS - 86400) / 60),
    limitedBy: capS !== null && capS < reachS ? "protection" : "grace",
  };
}

/**
 * shift_engine._claimed_by_previous_day: a next-morning punch (minutes after that midnight) is the day before's forgotten
 * last punch when it is at or before the cutoff AND the day before has no punch at or after its own shift end.
 */
export function claimedByDayBefore(
  punch: number,
  dayBeforeLastPunch: number | null,
  dayBeforeEnd: number,
  rule: MidnightRule | null,
): boolean {
  if (!rule || punch > rule.cutoff) return false;
  return dayBeforeLastPunch === null || dayBeforeLastPunch < dayBeforeEnd;
}

/** 25:10 and 01:10 both print as "01:10"; minutes past one midnight (a time on the next morning) as "01:10 next day". */
export const nextDayClock = (minutes: number): string => `${clock(minutes)} next day`;

// ── Production ──

export type ProductionSegmentLike = {
  label: string;
  startTime: string;
  endTime: string;
  shiftValue: number;
  isActive: boolean;
};

export type ProductionDay = {
  shifts: number;
  covered: string[];
  maxPossible: number;
  half: boolean;
  late: boolean;
  earlyOut: boolean;
  /** The grace the engine really uses (0 behaves as 10). */
  grace: number;
};

/**
 * attendance_final._compute_production: with 4+ punches the day is two worked spans (first to lunch-out, lunch-return to
 * last), otherwise one (first to last). A segment is earned when a span starts by its start + grace and ends no earlier
 * than its end - grace; the day earns the sum of the earned segments, at least 0.25 when someone punched in and out but
 * earned none, never more than all active segments together (1.50 when none are active). Late / Early Out compare the
 * first / last punch with Punch 1 + grace / Punch 4 - grace (flags only). Only active segments count.
 */
export function productionDay(
  punches: number[],
  segments: ProductionSegmentLike[],
  graceMinutes: number,
  punch1: string,
  punch4: string,
): ProductionDay {
  const grace = Number.isFinite(graceMinutes) && Math.trunc(graceMinutes) > 0 ? Math.trunc(graceMinutes) : 10;
  const sorted = [...punches].sort((a, b) => a - b);
  const spans: [number, number][] =
    sorted.length >= 4
      ? [
          [sorted[0], sorted[1]],
          [sorted[2], sorted[sorted.length - 1]],
        ]
      : sorted.length >= 2
        ? [[sorted[0], sorted[sorted.length - 1]]]
        : [];
  const active = segments.filter((s) => s.isActive);
  const cents = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100);
  let earned = 0;
  const covered: string[] = [];
  for (const seg of active) {
    const start = minutesOf(seg.startTime);
    const end = minutesOf(seg.endTime);
    if (start === null || end === null) continue;
    if (spans.some(([s, e]) => s <= start + grace && e >= end - grace)) {
      earned += cents(seg.shiftValue);
      covered.push(seg.label);
    }
  }
  let max = active.reduce((sum, s) => sum + cents(s.shiftValue), 0);
  if (max <= 0) max = 150;
  if (earned === 0 && spans.length > 0) earned = 25;
  earned = Math.min(earned, max);
  const p1 = minutesOf(punch1);
  const p4 = minutesOf(punch4);
  const last = sorted.length > 1 ? sorted[sorted.length - 1] : null;
  return {
    shifts: earned / 100,
    covered,
    maxPossible: max / 100,
    half: earned <= max / 2,
    late: sorted.length > 0 && p1 !== null && sorted[0] > p1 + grace,
    earlyOut: last !== null && p4 !== null && last < p4 - grace,
    grace,
  };
}
