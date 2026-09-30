// The morning arrival timeline, for the Settings preview and anything else that needs to say where a first punch falls.
// The rules live in backend/api/arrival_rules.py (which decides every real day); this is its twin and both are tested
// against the same worked examples, so what Settings shows is what the engine does.
//
// Everything is measured from the shift's own start and grace. With a 09:00 shift, 10 min grace and the defaults:
//
//   up to 09:10       on time
//   09:10 - 10:10     Late (late window)             full day, counts in the late pool
//   10:10 - 11:10     permission window              an approved Morning Late-In permission excuses up to here
//   11:10 - 11:30     extra minutes                  still the first half
//   after 11:30       second half                    Absent until a punch at/after Second Half Start, then Half Day
//
// After the Late window (and outside a permission) an arrival is a quarter-shift day: the deduction (0.25) comes off the
// day, so the employee earns 0.75 rather than losing a whole Half Day. Judged in whole minutes, every limit inclusive.

export type ArrivalSettings = {
  lateWindowMinutes: number;
  permissionWindowMinutes: number;
  extraMinutes: number;
  /** Shift taken off a quarter-shift arrival (0 = none). */
  quarterDeduction: number;
};

export const DEFAULT_ARRIVAL: ArrivalSettings = {
  lateWindowMinutes: 60,
  permissionWindowMinutes: 60,
  extraMinutes: 20,
  quarterDeduction: 0.25,
};

export type ArrivalZone = "on_time" | "late" | "excused" | "quarter" | "second_half";

/** Each limit in minutes since midnight, inclusive: a punch AT it is still inside. */
export type ArrivalLimits = {
  onTimeUntil: number;
  lateUntil: number;
  permissionUntil: number;
  firstHalfUntil: number;
};

export const MAX_WINDOW_MINUTES = 240;

const CLOCK = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/** "HH:MM" or "HH:MM:SS" -> minutes since midnight (seconds dropped: limits are judged in whole minutes); null if not a time. */
export function minutesOf(value: string | null | undefined): number | null {
  const m = CLOCK.exec((value ?? "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
}

/** 690 -> "11:30". */
export function clock(minutes: number): string {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

const wholeMinutes = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);

/** The four limits for a shift, or null when the shift start is not a clock time. */
export function arrivalLimits(
  shiftStart: string | null | undefined,
  graceMinutes: number,
  settings: ArrivalSettings = DEFAULT_ARRIVAL,
): ArrivalLimits | null {
  const start = minutesOf(shiftStart);
  if (start === null) return null;
  const onTimeUntil = start + wholeMinutes(graceMinutes);
  const lateUntil = onTimeUntil + wholeMinutes(settings.lateWindowMinutes);
  const permissionUntil = lateUntil + wholeMinutes(settings.permissionWindowMinutes);
  const firstHalfUntil = permissionUntil + wholeMinutes(settings.extraMinutes);
  return { onTimeUntil, lateUntil, permissionUntil, firstHalfUntil };
}

/** Where a first punch falls; `permissionCovers` is true only for an approved Morning Late-In permission within the monthly cap. */
export function arrivalZone(
  firstPunch: string | null | undefined,
  limits: ArrivalLimits,
  permissionCovers = false,
): ArrivalZone | null {
  const first = minutesOf(firstPunch);
  if (first === null) return null;
  if (first <= limits.onTimeUntil) return "on_time";
  if (first <= limits.lateUntil) return permissionCovers ? "excused" : "late";
  if (first <= limits.permissionUntil) return permissionCovers ? "excused" : "quarter";
  if (first <= limits.firstHalfUntil) return "quarter";
  return "second_half";
}

/** What the day earns in shifts for a first punch in `zone`, when the employee then works to the end of the day. */
export function shiftsFor(zone: ArrivalZone, quarterDeduction: number): number {
  if (zone === "second_half") return 0.5;
  if (zone === "quarter") return Math.max(0, Math.min(1, 1 - quarterDeduction));
  return 1;
}

/**
 * Twin of the settings PUT's check, so the message shows before the request goes out. Each window is a whole number of
 * minutes from 0 to 240; the deduction is 0 to 1 shift with at most two decimals. Null when everything is fine.
 */
export function validateArrival(settings: Partial<Record<keyof ArrivalSettings, unknown>>): string | null {
  const windows: [keyof ArrivalSettings, string][] = [
    ["lateWindowMinutes", "Late window"],
    ["permissionWindowMinutes", "Permission window"],
    ["extraMinutes", "Extra minutes"],
  ];
  for (const [key, label] of windows) {
    const value = Number(settings[key]);
    if (!Number.isInteger(value) || value < 0 || value > MAX_WINDOW_MINUTES) {
      return `${label} must be a whole number of minutes between 0 and ${MAX_WINDOW_MINUTES}.`;
    }
  }
  const deduction = Number(settings.quarterDeduction);
  if (
    !Number.isFinite(deduction) ||
    deduction < 0 ||
    deduction > 1 ||
    Math.abs(deduction * 100 - Math.round(deduction * 100)) > 1e-9
  ) {
    return "Quarter-shift deduction must be between 0 and 1 shift, with at most 2 decimals.";
  }
  return null;
}
