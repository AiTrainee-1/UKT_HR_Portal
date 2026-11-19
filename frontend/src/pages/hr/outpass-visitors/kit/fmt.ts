// How Gate Pass, Visitors and Tea Break write times, dates, durations and counts, and the date ranges their filters stand
// for. Pure, so the pages, the exports and the tests read from one place.
//
// Every day is the factory's day in India (Asia/Kolkata, no daylight saving, so a fixed +05:30 is exact), whatever zone the
// browser is in: the server cuts its days the same way (ist_bounds), so "Today" here is the server's "today".

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** What a cell shows when there is nothing to show. */
export const NONE = "—";

export type DateInput = string | Date | null | undefined;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** "2026-11-18": a calendar day as the filters and the API write it. */
export function isDateKey(value: string | null | undefined): value is string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/**
 * The instant a value stands for: an ISO timestamp as it is, a bare day ("2026-11-18") as that day's start in India, a Date
 * as it is. Null for nothing or something unreadable.
 */
export function toInstant(value: DateInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (isDateKey(value)) {
    const [y, m, d] = value.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : new Date(t);
}

/** The calendar parts of an instant as a clock in India shows them. */
function istParts(at: Date) {
  const shifted = new Date(at.getTime() + IST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    /** Monday = 0 ... Sunday = 6 */
    weekday: (shifted.getUTCDay() + 6) % 7,
  };
}

/** The day (in India) of an instant, as "2026-11-18". Empty for nothing. */
export function istDateKey(value: DateInput = new Date()): string {
  const at = toInstant(value);
  if (!at) return "";
  const p = istParts(at);
  return `${p.year}-${pad2(p.month + 1)}-${pad2(p.day)}`;
}

/** Milliseconds from `now` to the next midnight in India (when "Today" becomes another day). */
export function msUntilNextIstDay(now: Date = new Date()): number {
  return DAY_MS - ((((now.getTime() + IST_OFFSET_MS) % DAY_MS) + DAY_MS) % DAY_MS);
}

/** "08:34" (24 hours, India time). */
export function fmtTime(value: DateInput): string {
  const at = toInstant(value);
  if (!at) return NONE;
  const p = istParts(at);
  return `${pad2(p.hours)}:${pad2(p.minutes)}`;
}

/** "18 Nov", or "18 Nov 2026" with `year`. */
export function fmtDate(value: DateInput, opts: { year?: boolean } = {}): string {
  const at = toInstant(value);
  if (!at) return NONE;
  const p = istParts(at);
  return `${p.day} ${MONTHS[p.month]}${opts.year ? ` ${p.year}` : ""}`;
}

/** "18 Nov, 08:34" (with the year when `year`). */
export function fmtDateTime(value: DateInput, opts: { year?: boolean } = {}): string {
  const at = toInstant(value);
  if (!at) return NONE;
  return `${fmtDate(at, opts)}, ${fmtTime(at)}`;
}

/** Whether a value falls on today's date in India. */
export function isTodayIst(value: DateInput, now: Date = new Date()): boolean {
  const key = istDateKey(value);
  return key !== "" && key === istDateKey(now);
}

/**
 * A table's time cell: the time, and the day under it only when it is not today ("08:34" / "08:34" + "17 Nov").
 * The year is added for a day in another year.
 */
export function fmtWhen(value: DateInput, now: Date = new Date()): { time: string; date: string | null } {
  const at = toInstant(value);
  if (!at) return { time: NONE, date: null };
  if (isTodayIst(at, now)) return { time: fmtTime(at), date: null };
  const sameYear = istParts(at).year === istParts(now).year;
  return { time: fmtTime(at), date: fmtDate(at, { year: !sameYear }) };
}

/** "18 min" under an hour, "1 h 05 m" from an hour on. Whole minutes (rounded), never negative. */
export function fmtMinutes(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return NONE;
  const whole = Math.max(0, Math.round(minutes));
  if (whole < 60) return `${whole} min`;
  return `${Math.floor(whole / 60)} h ${pad2(whole % 60)} m`;
}

/** "1,240" (Indian grouping: "1,23,456"). */
export function fmtCount(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NONE;
  return n.toLocaleString("en-IN");
}

/** "1 – 18 Nov 2026", "28 Oct – 18 Nov 2026", "18 Nov 2026", "From 1 Nov 2026", "All dates". */
export function fmtRangeLabel(from: string, to: string): string {
  const a = isDateKey(from) ? from : "";
  const b = isDateKey(to) ? to : "";
  if (!a && !b) return "All dates";
  if (a && !b) return `From ${fmtDate(a, { year: true })}`;
  if (!a && b) return `Up to ${fmtDate(b, { year: true })}`;
  if (a === b) return fmtDate(a, { year: true });
  const [ay, am] = a.split("-");
  const [by, bm] = b.split("-");
  if (ay === by && am === bm) return `${Number(a.slice(8))} – ${fmtDate(b, { year: true })}`;
  if (ay === by) return `${fmtDate(a)} – ${fmtDate(b, { year: true })}`;
  return `${fmtDate(a, { year: true })} – ${fmtDate(b, { year: true })}`;
}

// ── date ranges ──────────────────────────────────────────────────────────────

/** The quick picks of a date filter. A week starts on Monday, as the server's does. */
export type DatePreset = "today" | "week" | "month";
/** A preset, "custom" (the From / To days) or "all" (no date limit). */
export type DateRangeKind = DatePreset | "custom" | "all";

export const DATE_PRESETS: readonly { value: DatePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

const isPreset = (value: string | null | undefined): value is DatePreset => DATE_PRESETS.some((p) => p.value === value);

/** The first and last day (inclusive, India) a preset covers, up to today. */
export function presetRange(preset: DatePreset, now: Date = new Date()): { from: string; to: string } {
  const to = istDateKey(now);
  const p = istParts(now);
  const todayStart = Date.UTC(p.year, p.month, p.day);
  if (preset === "today") return { from: to, to };
  if (preset === "week") return { from: istDateKey(new Date(todayStart - p.weekday * DAY_MS - IST_OFFSET_MS)), to };
  return { from: `${p.year}-${pad2(p.month + 1)}-01`, to };
}

/**
 * The days a filter's `{range, from, to}` stands for, as the API takes them (`from` / `to`, inclusive, India): a preset is
 * worked out from today, "all" is no limit (two empty strings), and anything else is the From / To days as typed (an
 * unreadable one dropped, the two swapped when From is after To).
 */
export function resolveDateRange(
  value: { range?: string | null; from?: string | null; to?: string | null },
  now: Date = new Date(),
): { from: string; to: string } {
  if (isPreset(value.range)) return presetRange(value.range, now);
  if (value.range === "all") return { from: "", to: "" };
  const from = isDateKey(value.from) ? value.from : "";
  const to = isDateKey(value.to) ? value.to : "";
  return from && to && from > to ? { from: to, to: from } : { from, to };
}
