// The request date window: which dates an employee may pick on the request forms (Leave, Casual Leave, Permission /
// Late-In, Missing Punch). The SAME rule is shared by the backend (backend/api/request_window.py), the Employee Web App
// (src/lib/request-window.ts), the Mobile App (src/lib/requestWindow.ts) and the HR portal's employee page
// (frontend/src/lib/request-window.ts), and all four are tested against the same vectors, so change them together.
//
//   * An employee may request dates in the CURRENT calendar month only: from the 1st to the last day of this month.
//   * Grace: on the first GRACE_DAYS (2) days of a month, the PREVIOUS month is still open as well, so on the 1st and the
//     2nd the window starts on the 1st of last month. From the 3rd it starts on the 1st of this month.
//   * Missing Punch also cannot be in the future (opts.noFuture): a punch cannot be missed tomorrow.
//
// Pure TypeScript, no imports. "Today" is passed in (`now`) and must be read when the form is used, never once at start-up.
// The server is the authority (it uses India time); a device with a wrong clock only gets the wrong hint on screen.

export const GRACE_DAYS = 2;

export type RequestWindow = {
  /** First selectable day, YYYY-MM-DD. */
  min: string;
  /** Last selectable day, YYYY-MM-DD (the last day of the current month). */
  max: string;
  /** Today, YYYY-MM-DD. */
  today: string;
  /** True while last month is still open (the 1st .. GRACE_DAYS-th of a month). */
  graceOpen: boolean;
  /** 'October 2026' */
  currentMonth: string;
  /** 'September 2026' (always the month before the current one) */
  previousMonth: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** Days in month `m` (1-12) of year `y`. */
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();
/** '1 September 2026' for a YYYY-MM-DD string. */
const longDate = (s: string) => `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;

export function getRequestWindow(now: Date): RequestWindow {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const d = now.getDate();
  const graceOpen = d <= GRACE_DAYS;
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return {
    min: graceOpen ? iso(py, pm, 1) : iso(y, m, 1),
    max: iso(y, m, daysIn(y, m)),
    today: iso(y, m, d),
    graceOpen,
    currentMonth: `${MONTHS[m - 1]} ${y}`,
    previousMonth: `${MONTHS[pm - 1]} ${py}`,
  };
}

/** The sentence shown when a date is outside the window (the same words on the server and in both apps). */
export function windowMessage(w: RequestWindow): string {
  if (!w.graceOpen) return `You can only request dates in ${w.currentMonth}.`;
  const prevName = w.previousMonth.split(" ")[0];
  const currentName = w.currentMonth.split(" ")[0];
  return (
    `You can only request dates from ${longDate(w.min)} to ${longDate(w.max)}. ` +
    `${prevName} closes at the end of ${GRACE_DAYS} ${currentName}.`
  );
}

/** A short hint to show under a date field. */
export function windowHint(w: RequestWindow): string {
  return w.graceOpen ? `${longDate(w.min)} to ${longDate(w.max)}` : `Any day in ${w.currentMonth}`;
}

/** A real calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

/** null when `value` may be requested, else the message to show. `noFuture`: the day cannot be after today (Missing Punch). */
export function checkRequestDate(value: string, now: Date, opts: { noFuture?: boolean } = {}): string | null {
  const w = getRequestWindow(now);
  if (!isIsoDate(value)) return "Choose a valid date.";
  if (opts.noFuture && value > w.today) return "Date cannot be in the future.";
  if (value < w.min || value > w.max) return windowMessage(w);
  return null;
}

/** null when both ends of a leave range may be requested and the end is not before the start, else the message to show. */
export function checkRequestRange(start: string, end: string, now: Date): string | null {
  const w = getRequestWindow(now);
  if (!isIsoDate(start) || !isIsoDate(end)) return "Choose a valid date.";
  if (start < w.min || start > w.max || end < w.min || end > w.max) return windowMessage(w);
  if (end < start) return "End date must be on or after start date.";
  return null;
}
