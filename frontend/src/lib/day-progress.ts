// "In progress": TODAY's day while its shift is still running (owner 2026-11-26). The attendance engine counts a staff day
// with only a morning punch as present while the shift runs and stores it as provisional until the evening can be judged
// (AttendanceDayRecord.provisional_until = shift end + grace + 1 minute); a background job works it out again after that.
// Every day the server sends carries `inProgress` (provisional_until is set and still in the future) and
// `provisionalUntil` (that moment, an ISO datetime, or null). While `inProgress` is true a screen shows the day as
// "In progress" ("In 09:06 · at work"), with no shift count and no Present / Half Day verdict, and leaves it out of every
// count and total: the real result appears by itself once the shift is over. Only `inProgress` decides: `provisionalUntil`
// can still be set for a few minutes after that moment, until the background job has run.

/** The two fields every day object may carry (absent on an older backend: then the day is never in progress). */
export type DayProgressFields = {
  inProgress?: boolean | null;
  provisionalUntil?: string | null;
};

/** True while the day is still running and its result is not decided yet. */
export function isInProgress(day: DayProgressFields | null | undefined): boolean {
  return day?.inProgress === true;
}

const IST_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "18:11": the wall-clock time (factory time, IST) of `provisionalUntil`; null when it is missing or not a date. */
export function provisionalTime(provisionalUntil: string | null | undefined): string | null {
  if (!provisionalUntil) return null;
  const at = new Date(provisionalUntil);
  if (Number.isNaN(at.getTime())) return null;
  return IST_TIME.format(at);
}

/** The tooltip of an in-progress day: "Counted after the shift ends at 18:11" (without a time when none is known). */
export function countedAfterLabel(provisionalUntil: string | null | undefined): string {
  const time = provisionalTime(provisionalUntil);
  return time ? `Counted after the shift ends at ${time}` : "Counted after the shift ends";
}

/** The punch line of an in-progress day: "In 09:06 · at work", or "Day not over yet" with no punch. */
export function inProgressPunchText(firstIn: string | null | undefined): string {
  const t = (firstIn ?? "").slice(0, 5);
  return t ? `In ${t} · at work` : "Day not over yet";
}

/** The day's shift credit as a screen should use it: null while the day is in progress (shown as "—", counted as 0). */
export function settledShifts<T>(day: DayProgressFields | null | undefined, shifts: T): T | null {
  return isInProgress(day) ? null : shifts;
}

/** The shift credit a total adds for the day: 0 while it is in progress (not yet earned), else the number given. */
export function countedShifts(
  day: DayProgressFields | null | undefined,
  shifts: number | string | null | undefined,
): number {
  if (isInProgress(day)) return 0;
  const n = typeof shifts === "number" ? shifts : Number(shifts ?? 0);
  return Number.isFinite(n) ? n : 0;
}
