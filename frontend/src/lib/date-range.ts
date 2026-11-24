// The one date filter of the HR portal's record pages (owner brief 2026-11-24): Today, Yesterday, This Month (and any
// earlier month, stepped to or picked) and Custom (one day or a from - to range). This Month is the default everywhere.
// Pure: the hook (components/date-range/useDateRange), the filter bar, the gate kit's useGateFilters and the tests all
// read from here, so every page means the same days by the same words.
//
// The address keeps it as
//   range=today|yesterday|month|custom   (left out for This Month, the default)
//   month=YYYY-MM                        (an earlier month; left out for the current one)
//   from=YYYY-MM-DD&to=YYYY-MM-DD        (Custom only; `to` left out for a single day)
// so a fresh page has none of them, a reload or a shared link shows the same days, and Back finds them again.
//
// Every day is the factory's day in India (Asia/Kolkata has no daylight saving, so a fixed +05:30 is exact), whatever zone
// the browser is in: the servers cut their days the same way. Nothing points to the future: a later month or day read
// from an address falls back to the current month / today.

export type RangeKind = "today" | "yesterday" | "month" | "custom";

/** A filter as the page holds it: always valid (see readDateRange). `month` is "" for the current month; `from` / `to`
 *  are only set for "custom" (`to` equal to `from` for a single day). */
export type DateRangeValue = { range: RangeKind; month: string; from: string; to: string };

/** The days a filter covers, inclusive, as the APIs take them (`from` / `to`, YYYY-MM-DD). */
export type RangeDays = { from: string; to: string };

/** The address keys and their defaults (module level: useUrlParams needs a stable object). */
export const DATE_RANGE_DEFAULTS = { range: "month", month: "", from: "", to: "" };
export type DateRangeParams = typeof DATE_RANGE_DEFAULTS;
export const DATE_RANGE_KEYS = ["range", "month", "from", "to"] as const;

export const RANGE_PRESETS: readonly { value: RangeKind; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "month", label: "This Month" },
  { value: "custom", label: "Custom" },
];

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = [
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
const MONTH_SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));
const pad2 = (n: number): string => String(n).padStart(2, "0");
const KINDS: readonly string[] = RANGE_PRESETS.map((p) => p.value);

// ── days and months ───────────────────────────────────────────────────────────

/** "2026-11-24": a real calendar day. */
export function isDayKey(value: string | null | undefined): value is string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** "2026-11": a real month. */
export function isMonthKey(value: string | null | undefined): value is string {
  const m = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  return !!m && Number(m[1]) >= 1900 && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** Today in India, "2026-11-24". */
export function istDay(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + IST_OFFSET_MS);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** The India day of an ISO timestamp (or a bare day as it is); "" for nothing or something unreadable. */
export function istDayOf(value: string | null | undefined): string {
  if (!value) return "";
  if (isDayKey(value)) return value;
  const t = Date.parse(value);
  return Number.isNaN(t) ? "" : istDay(new Date(t));
}

/** Milliseconds from `now` to the next midnight in India (when Today becomes another day). */
export function msUntilNextIstDay(now: Date = new Date()): number {
  return DAY_MS - ((((now.getTime() + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS);
}

/** The month of a day: "2026-11-24" -> "2026-11". */
export const monthOf = (day: string): string => day.slice(0, 7);

/** A day moved by `n` days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/** A month moved by `n` months. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/** The first and last day of a month (the whole month, also the current one: a request can be for a later day of it). */
export function monthDays(month: string): RangeDays {
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${pad2(last)}` };
}

/** "November 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

/** "Nov 2026". */
export function monthShortLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTH_SHORT[m - 1]} ${y}`;
}

/** "24 Nov", or "24 Nov 2026" with `year`. */
export function dayLabel(day: string, opts: { year?: boolean } = {}): string {
  const [y, m, d] = day.split("-").map(Number);
  return `${d} ${MONTH_SHORT[m - 1]}${opts.year ? ` ${y}` : ""}`;
}

// ── the filter ────────────────────────────────────────────────────────────────

/**
 * The address's values as a valid filter: an unknown `range` is This Month, or Custom when the address has days (a link
 * like `?from=2026-11-03&to=2026-11-09`: the address leaves out the default `range`, so days beside This Month of the
 * current month are Custom too); a month that is not a month, or a later one than now, is the current month; Custom days
 * after today are today, swapped when From is after To, and a Custom without a readable day is This Month.
 */
export function readDateRange(
  raw: Partial<Record<keyof DateRangeParams, string | null | undefined>>,
  now: Date = new Date(),
): DateRangeValue {
  const today = istDay(now);
  const current = monthOf(today);
  const asked = raw.range ?? "";
  const days = [raw.from, raw.to].filter(isDayKey);
  const daysWin = days.length > 0 && (!KINDS.includes(asked) || (asked === "month" && !raw.month));
  const range: RangeKind = daysWin ? "custom" : KINDS.includes(asked) ? (asked as RangeKind) : "month";
  if (range === "custom") {
    if (days.length === 0) return { range: "month", month: "", from: "", to: "" };
    const clamp = (d: string) => (d > today ? today : d);
    let from = clamp(isDayKey(raw.from) ? raw.from : days[0]);
    let to = clamp(isDayKey(raw.to) ? raw.to : from);
    if (from > to) [from, to] = [to, from];
    return { range, month: "", from, to };
  }
  if (range === "month") {
    const month = isMonthKey(raw.month) && raw.month < current ? raw.month : "";
    return { range, month, from: "", to: "" };
  }
  return { range, month: "", from: "", to: "" };
}

/** The days a filter covers (inclusive, India): what the APIs are sent as `from` / `to`. */
export function rangeDays(value: DateRangeValue, now: Date = new Date()): RangeDays {
  const today = istDay(now);
  if (value.range === "today") return { from: today, to: today };
  if (value.range === "yesterday") {
    const y = addDays(today, -1);
    return { from: y, to: y };
  }
  if (value.range === "custom" && isDayKey(value.from)) {
    const to = isDayKey(value.to) ? value.to : value.from;
    return value.from <= to ? { from: value.from, to } : { from: to, to: value.from };
  }
  return monthDays(value.month || monthOf(today));
}

/** The address values of a filter (for useUrlParams, which leaves out "" and defaults): This Month of the current month
 *  leaves nothing; a single Custom day has no `to`. */
export function rangeParams(value: DateRangeValue): DateRangeParams {
  return {
    range: value.range,
    month: value.range === "month" ? value.month : "",
    from: value.range === "custom" ? value.from : "",
    to: value.range === "custom" && value.to !== value.from ? value.to : "",
  };
}

/** The address query of a filter ("range=custom&from=2026-11-03&to=2026-11-09"; "" for This Month). */
export function rangeQuery(value: DateRangeValue): string {
  const out = new URLSearchParams();
  for (const [key, v] of Object.entries(rangeParams(value))) {
    if (v && v !== DATE_RANGE_DEFAULTS[key as keyof DateRangeParams]) out.set(key, v);
  }
  return out.toString();
}

/** The month the filter is on (the one the ‹ month › stepper shows): its month for This Month, else the month of its
 *  last day. */
export function shownMonth(value: DateRangeValue, now: Date = new Date()): string {
  if (value.range === "month") return value.month || monthOf(istDay(now));
  return monthOf(rangeDays(value, now).to);
}

/** Whether the filter is on the current month (This Month of now): the default. */
export const isDefaultRange = (value: DateRangeValue): boolean => value.range === "month" && value.month === "";

/** Two filters that cover the same days the same way. */
export const sameRange = (a: DateRangeValue, b: DateRangeValue): boolean =>
  a.range === b.range && a.month === b.month && a.from === b.from && a.to === b.to;

/** "November 2026", "Today, 24 Nov", "Yesterday, 23 Nov", "12 Nov 2026", "3 Nov – 9 Nov 2026", "28 Dec 2025 – 3 Jan 2026". */
export function rangeLabel(value: DateRangeValue, now: Date = new Date()): string {
  const days = rangeDays(value, now);
  if (value.range === "today") return `Today, ${dayLabel(days.from)}`;
  if (value.range === "yesterday") return `Yesterday, ${dayLabel(days.from)}`;
  if (value.range === "month") return monthLabel(shownMonth(value, now));
  if (days.from === days.to) return dayLabel(days.from, { year: true });
  if (days.from.slice(0, 4) === days.to.slice(0, 4))
    return `${dayLabel(days.from)} – ${dayLabel(days.to, { year: true })}`;
  return `${dayLabel(days.from, { year: true })} – ${dayLabel(days.to, { year: true })}`;
}

/** The same in a sentence: "in November 2026", "today", "yesterday", "on 12 Nov 2026", "between 3 Nov – 9 Nov 2026". */
export function rangePhrase(value: DateRangeValue, now: Date = new Date()): string {
  const days = rangeDays(value, now);
  if (value.range === "today") return "today";
  if (value.range === "yesterday") return "yesterday";
  if (value.range === "month") return `in ${rangeLabel(value, now)}`;
  return days.from === days.to ? `on ${rangeLabel(value, now)}` : `between ${rangeLabel(value, now)}`;
}

// ── changing it ───────────────────────────────────────────────────────────────

/** Picking a month: This Month of it (a later month than now is the current month). */
export function chooseMonth(month: string, now: Date = new Date()): DateRangeValue {
  const current = monthOf(istDay(now));
  return { range: "month", month: isMonthKey(month) && month < current ? month : "", from: "", to: "" };
}

/** Picking days: Custom from - to (one day when `to` is empty), never after today, swapped when needed. */
export function chooseDays(from: string, to: string, now: Date = new Date()): DateRangeValue {
  return readDateRange({ range: "custom", from, to: to || from }, now);
}

/**
 * Picking a preset. Today / Yesterday / This Month (the current month) as they say; Custom starts on the days on screen up
 * to today (This Month of November on the 24th: 1 - 24 Nov), so HR only moves one end.
 */
export function choosePreset(kind: RangeKind, current: DateRangeValue, now: Date = new Date()): DateRangeValue {
  if (kind === "custom") {
    if (current.range === "custom") return current;
    const days = rangeDays(current, now);
    return chooseDays(days.from, days.to, now);
  }
  return { range: kind, month: "", from: "", to: "" };
}

/** The month before / after the one shown (from any range), as This Month of it; never past the current month. */
export function stepMonth(value: DateRangeValue, delta: number, now: Date = new Date()): DateRangeValue {
  return chooseMonth(shiftMonth(shownMonth(value, now), delta), now);
}

/** Whether ‹ month › may go forward: only up to the current month (This Month of the current month cannot). */
export function canStepForward(value: DateRangeValue, now: Date = new Date()): boolean {
  const current = monthOf(istDay(now));
  return value.range === "month" ? shownMonth(value, now) < current : shownMonth(value, now) <= current;
}

// ── matching records ──────────────────────────────────────────────────────────

/** A day is one of the range's days. An empty or unreadable day never is. */
export function dayInRange(day: string | null | undefined, days: RangeDays): boolean {
  if (!isDayKey(day)) return false;
  return day >= days.from && day <= days.to;
}

/** A record for the days `from` - `to` (a leave of three days) counts when any of them is in the range. */
export function spanOverlaps(from: string | null | undefined, to: string | null | undefined, days: RangeDays): boolean {
  if (!isDayKey(from)) return false;
  const end = isDayKey(to) && to >= from ? to : from;
  return from <= days.to && end >= days.from;
}

/** The earliest day of a list (for "N more outside these dates · Show them"); "" for none. */
export function earliestDay(days: readonly (string | null | undefined)[]): string {
  return days.filter(isDayKey).reduce((min, d) => (min === "" || d < min ? d : min), "");
}
