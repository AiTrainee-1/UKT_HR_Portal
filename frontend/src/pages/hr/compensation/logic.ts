import { ApiError } from "@/lib/api-client/custom-fetch";
import type { ShiftsValue } from "@/lib/api-client/custom-hooks";

// Pure helpers shared by the pages of Compensation: what lives in the address, the amounts of shift
// compensation HR can give, dates (kept as plain ISO days and split by hand, never run through `new Date("2026-10-13")`,
// which is UTC midnight and so the day before in some zones), and what a failed request says.

// ── The address ───────────────────────────────────────────────────────────────
// (The page paths themselves, /hr/compensation/ot-detection/type-1 and the rest, are in ./routes.)

/** The three parts of Compensation Leave, as the old `?tab=leave&sub=...` addresses wrote them (the Requests hub linked to `holiday-work`). */
export const LEAVE_PARTS = ["windows", "holiday-work", "birthdays"] as const;
export type LeavePart = (typeof LEAVE_PARTS)[number];
export const isLeavePart = (value: string): value is LeavePart => (LEAVE_PARTS as readonly string[]).includes(value);

/** Other spellings of a part that a link may use. */
const PART_ALIASES: Record<string, LeavePart> = {
  holiday: "holiday-work",
  holiday_work: "holiday-work",
  holidaywork: "holiday-work",
  window: "windows",
  announce: "windows",
  birthday: "birthdays",
};

/** The part an old address asks for: one of the three, a known other spelling, else the first (A). */
export function leavePartOf(value: string): LeavePart {
  if (isLeavePart(value)) return value;
  return PART_ALIASES[value.trim().toLowerCase()] ?? "windows";
}

/**
 * Everything the pages keep in the query string (`/hr/compensation/compensation-leave/holiday-work?hstatus=pending`): it
 * survives a reload, a shared link and Back. A value equal to its default (or blank) is left out, so a fresh page keeps a
 * clean URL. Each page keeps its own keys, so switching pages never mixes their filters. Blank month / year / date mean
 * "the current one". The page and its subtab are the path, not a key.
 */
export const COMPENSATION_URL_DEFAULTS = {
  // OT Detection
  month: "",
  year: "",
  otq: "",
  otdept: "",
  otstatus: "all",
  // Compensation Leave
  hmonth: "",
  hyear: "",
  hstatus: "all",
  hdate: "",
  bperiod: "today",
  bdate: "",
  // History and Reports
  period: "today",
  date: "",
  type: "all",
  dept: "",
  branch: "",
};

export type CompensationUrl = typeof COMPENSATION_URL_DEFAULTS;

/** `/hr/settings?tab=compensation#shift-enabled`: a setting of the Settings page (the page scrolls to it once it opens). */
export const settingsHref = (tab: string, setting?: string): string =>
  `/hr/settings?tab=${encodeURIComponent(tab)}${setting ? `#${encodeURIComponent(setting)}` : ""}`;

/** The Settings -> Compensation tab, or one setting of it. The ids are the `data-setting-id` of each setting there. */
export const compensationSettingsHref = (setting?: string): string => settingsHref("compensation", setting);

/** The master switch of the OT / Compensation features: Settings -> Payroll -> OT / Compensation. */
export const MASTER_SWITCH_HREF = settingsHref("payroll", "compensation-features");

// ── Shifts ────────────────────────────────────────────────────────────────────

/** The only amounts HR can give or redeem: a quarter, a half, three quarters or one whole shift. */
export const SHIFT_CHOICES: readonly ShiftsValue[] = [0.25, 0.5, 0.75, 1];

export const isShiftsValue = (value: unknown): value is ShiftsValue =>
  typeof value === "number" && (SHIFT_CHOICES as readonly number[]).includes(value);

/** "0.25", "0.50", "0.75", "1", "1.50": two decimals, except a whole number. */
export function fmtShifts(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** "0.50 shift", "1 shift", "1.75 shifts". */
export function shiftsText(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${fmtShifts(value)} ${value === 1 ? "shift" : "shifts"}`;
}

/** The shifts of a total that came out of float sums (0.1 + 0.2): rounded to a hundredth. */
export const sumShifts = (values: (number | null | undefined)[]): number =>
  Math.round(values.reduce<number>((total, v) => total + (v ?? 0), 0) * 100) / 100;

// ── Dates ─────────────────────────────────────────────────────────────────────

export const MONTH_NAMES = [
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
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Ymd = { year: number; month: number; day: number };

export function parseIso(iso: string | null | undefined): Ymd | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) } : null;
}

const pad = (n: number): string => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;

export const isIsoDate = (text: string): boolean => {
  const d = parseIso(text);
  if (!d || text.length !== 10) return false;
  const check = new Date(Date.UTC(d.year, d.month - 1, d.day));
  return check.getUTCFullYear() === d.year && check.getUTCMonth() === d.month - 1 && check.getUTCDate() === d.day;
};

/** Today's date in India (the factory's own time, as the server uses), YYYY-MM-DD. */
export function todayIst(now: Date = new Date()): string {
  const ist = new Date(now.getTime() + (5 * 60 + 30) * 60_000);
  return ist.toISOString().slice(0, 10);
}

/** A day plus or minus some days. */
export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  if (!d) return iso;
  const next = new Date(Date.UTC(d.year, d.month - 1, d.day + days));
  return toIso(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

/** A day plus or minus some months, keeping the day of the month where it exists (31 Jan + 1 month = 28 Feb). */
export function addMonths(iso: string, months: number): string {
  const d = parseIso(iso);
  if (!d) return iso;
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return toIso(year, month, Math.min(d.day, last));
}

/** The first and last day of the month a day is in. */
export function monthBounds(iso: string): { first: string; last: string } | null {
  const d = parseIso(iso);
  if (!d) return null;
  const last = new Date(Date.UTC(d.year, d.month, 0)).getUTCDate();
  return { first: toIso(d.year, d.month, 1), last: toIso(d.year, d.month, last) };
}

export const sameMonth = (a: string, b: string): boolean => {
  const x = parseIso(a);
  const y = parseIso(b);
  return !!x && !!y && x.year === y.year && x.month === y.month;
};

export function isSunday(iso: string): boolean {
  const d = parseIso(iso);
  return !!d && new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay() === 0;
}

/** "14 Oct 2026". */
export function dateShort(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${d.day} ${MONTH_SHORT[d.month - 1]} ${d.year}` : "—";
}

/** "14 Oct". */
export function dayMonth(iso: string | null | undefined): string {
  const d = parseIso(iso);
  return d ? `${d.day} ${MONTH_SHORT[d.month - 1]}` : "—";
}

/** "Wed, 14 Oct 2026". */
export function dateLong(iso: string | null | undefined): string {
  const d = parseIso(iso);
  if (!d) return "—";
  const weekday = WEEKDAY_SHORT[new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()];
  return `${weekday}, ${d.day} ${MONTH_SHORT[d.month - 1]} ${d.year}`;
}

/** "12 Oct - 18 Oct 2026" / "29 Dec 2026 - 4 Jan 2027" / just "14 Oct 2026" for one day. */
export function rangeLabel(from: string | null | undefined, to: string | null | undefined): string {
  const a = parseIso(from);
  const b = parseIso(to);
  if (!a || !b) return "—";
  if (from === to) return dateShort(from);
  const start = a.year === b.year ? dayMonth(from) : dateShort(from);
  return `${start} - ${dateShort(to)}`;
}

/** "October 2026". */
export const monthYear = (month: number, year: number): string => `${MONTH_NAMES[month - 1] ?? ""} ${year}`.trim();

/** "17:30" -> "5:30 PM". Anything else comes back as it is (an empty value is a dash). */
export function clock12(time: string | null | undefined): string {
  if (!time) return "—";
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  if (!m) return time;
  const hour = Number(m[1]);
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m[2]} ${hour < 12 ? "AM" : "PM"}`;
}

/** "30 min", "1 h", "1 h 30 min". */
export function minutesText(total: number | null | undefined): string {
  if (total === null || total === undefined || Number.isNaN(total)) return "—";
  const t = Math.max(0, Math.round(total));
  const h = Math.floor(t / 60);
  const m = t % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "1 employee" / "3 employees". */
export const countOf = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The month and year a page shows: the ones in the address, else the current month. */
export function monthYearFromUrl(
  month: string,
  year: string,
  today: string = todayIst(),
): { month: number; year: number } {
  const now = parseIso(today)!;
  const m = Number(month);
  const y = Number(year);
  return {
    month: Number.isInteger(m) && m >= 1 && m <= 12 ? m : now.month,
    year: Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : now.year,
  };
}

/** The years a month picker offers: this year and the three before it (and next year, for a December looking ahead). */
export function yearChoices(today: string = todayIst()): number[] {
  const y = parseIso(today)!.year;
  return [y + 1, y, y - 1, y - 2, y - 3];
}

// ── What a failed request says ────────────────────────────────────────────────

/**
 * The server's own sentence for a refused change ("The balance is 0.50 shift, so 1 shift cannot be redeemed."): every
 * refusal of the Compensation endpoints carries one as `{ error }`. Anything else (the network is down, a server fault)
 * gets `fallback`.
 */
export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    const sentence = (error.data as { error?: unknown } | null)?.error;
    if (typeof sentence === "string" && sentence.trim() !== "") return sentence.trim();
    if (error.status === 403) return "Your login is not allowed to do this.";
    if (error.status === 404) return "That record was not found. It may have been removed: reload and try again.";
  }
  return fallback;
}

/** The status of a failed request (undefined when it never reached the server). */
export const errorStatus = (error: unknown): number | undefined =>
  error instanceof ApiError ? error.status : undefined;

/** A list of `{employeeId, error}` problems an all-or-nothing request came back with (empty when there were none). */
export function problemsOf(error: unknown): { employeeId: number; error: string }[] {
  if (!(error instanceof ApiError)) return [];
  const list = (error.data as { problems?: unknown } | null)?.problems;
  if (!Array.isArray(list)) return [];
  return list.flatMap((p) => {
    const item = p as { employeeId?: unknown; error?: unknown };
    return typeof item.employeeId === "number" && typeof item.error === "string"
      ? [{ employeeId: item.employeeId, error: item.error }]
      : [];
  });
}

/** Free text matches a name, a code or a department, whatever the case. */
export function matchesText(query: string, ...fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return fields.some((f) => (f ?? "").toLowerCase().includes(q));
}
