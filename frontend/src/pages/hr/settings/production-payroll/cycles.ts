/**
 * The three production pay cycles and their period maths, mirrored from the engine so the Settings examples show the
 * periods the Production Payroll pages will offer:
 *   backend/api/production_cycles.py   CYCLE_WEEKS, MONTHLY_EQUIVALENT_FACTOR, WEEK_START_WEEKDAY
 *   backend/api/production_period.py   cycle_anchor, resolve_cycle_period, next_cycle_period
 * A cycle is a run of whole weeks (Weekly 1, BiWeekly 2, Monthly 4: four weeks, not a calendar month) counted forwards
 * and backwards from an anchor: the saved first period start moved back to the cycle's start weekday. Dates are plain
 * calendar days (no time zone), so an example never shifts by a day.
 */

// Types only from the hooks: this module is reached from the settings search catalogue (metas.ts), which the e2e specs
// import under Node, so it must not pull the API client in at runtime. cycles.test.ts checks it agrees with
// PAY_CYCLE_INFO.
import type { PayCycle, WeekStart } from "@/lib/api-client/custom-hooks";
import type { Day } from "../payroll/preview";

export type { Day, PayCycle, WeekStart };

// ── calendar days ──

const UTC_DAY = 86_400_000;
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const ms = (d: Day): number => Date.UTC(d.year, d.month - 1, d.day);

function fromMs(value: number): Day {
  const date = new Date(value);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

export const addDays = (d: Day, n: number): Day => fromMs(ms(d) + n * UTC_DAY);

export const daysFrom = (from: Day, to: Day): number => Math.round((ms(to) - ms(from)) / UTC_DAY);

export const compareDays = (a: Day, b: Day): number => daysFrom(b, a);

/** Monday = 0 ... Sunday = 6, like Python's date.weekday(). */
export const weekdayOf = (d: Day): number => (new Date(ms(d)).getUTCDay() + 6) % 7;

const lastDayOfMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** "2026-10-05" -> a day; null for anything that is not a real date. */
export function parseIsoDay(text: string | null | undefined): Day | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((text ?? "").trim());
  if (!m) return null;
  const d = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  if (d.month < 1 || d.month > 12 || d.day < 1 || d.day > lastDayOfMonth(d.year, d.month)) return null;
  return d;
}

export const isoDay = (d: Day): string =>
  `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;

/** "Mon 5 Oct 2026". */
export const formatDayLong = (d: Day): string =>
  `${WEEKDAYS[weekdayOf(d)]} ${d.day} ${SHORT_MONTHS[d.month - 1]} ${d.year}`;

export type Period = { start: Day; end: Day };

/** "1 Oct - 14 Oct 2026", "31 Oct - 9 Nov 2026", "29 Dec 2026 - 4 Jan 2027". */
export function formatPeriod(p: Period): string {
  const end = `${p.end.day} ${SHORT_MONTHS[p.end.month - 1]} ${p.end.year}`;
  const start =
    p.start.year === p.end.year
      ? `${p.start.day} ${SHORT_MONTHS[p.start.month - 1]}`
      : `${p.start.day} ${SHORT_MONTHS[p.start.month - 1]} ${p.start.year}`;
  return `${start} - ${end}`;
}

export const periodDays = (p: Period): number => daysFrom(p.start, p.end) + 1;

// ── the cycles ──

export const CYCLES: readonly PayCycle[] = ["weekly", "biweekly", "monthly"];

export type CycleInfo = {
  /** "Weekly", "BiWeekly", "Monthly": the sidebar's and the engine's names. */
  label: string;
  weeks: number;
  days: number;
  /** "every week", "every two weeks", "every four weeks". */
  every: string;
  /** The cycle's Production Payroll page. */
  path: string;
  /** Whether the cycle needs a first period start before payroll can be generated (which week a block begins on). */
  needsDate: boolean;
  /** One period's gross x this = the "estimated monthly pay" the PF / ESI bands and the ESI ceiling are tested on. */
  monthlyFactor: number;
};

/** What each cycle is, in the words the Settings tab uses (production_cycles.py CYCLE_WEEKS, MONTHLY_EQUIVALENT_FACTOR). */
export const CYCLE_INFO: Record<PayCycle, CycleInfo> = {
  weekly: {
    label: "Weekly",
    weeks: 1,
    days: 7,
    every: "every week",
    path: "/hr/production-payroll/weekly",
    needsDate: false,
    monthlyFactor: 4,
  },
  biweekly: {
    label: "BiWeekly",
    weeks: 2,
    days: 14,
    every: "every two weeks",
    path: "/hr/production-payroll/biweekly",
    needsDate: true,
    monthlyFactor: 2,
  },
  monthly: {
    label: "Monthly",
    weeks: 4,
    days: 28,
    every: "every four weeks",
    path: "/hr/production-payroll/monthly",
    needsDate: true,
    monthlyFactor: 1,
  },
};

/** The weekdays a cycle's weeks may start on, in the order the dropdown lists them (production_cycles.py WEEKDAYS). */
export const WEEK_STARTS: readonly WeekStart[] = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
];

export const WEEK_START_NAME: Record<WeekStart, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

/** Python's date.weekday(): Monday 0 .. Sunday 6. */
const START_WEEKDAY: Record<WeekStart, number> = WEEK_STARTS.reduce(
  (all, name, number) => ({ ...all, [name]: number }),
  {} as Record<WeekStart, number>,
);

/** The first release stored only these two keys; the engine still reads them as the weekday they meant. */
const LEGACY_WEEK_STARTS: Record<string, WeekStart> = { mon_sat: "monday", sun_sat: "sunday" };

/** A stored or typed week start the way the engine reads it: any weekday in any case, or a legacy key; else Monday. */
export function normalizeWeekStart(value: unknown): WeekStart {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const key = LEGACY_WEEK_STARTS[text] ?? text;
  return (WEEK_STARTS as readonly string[]).includes(key) ? (key as WeekStart) : "monday";
}

/** "Wednesday to Tuesday": the weekdays a week starting on `weekStart` runs between. */
export const weekRunsText = (weekStart: WeekStart): string =>
  `${WEEK_START_NAME[weekStart]} to ${WEEK_START_NAME[WEEK_STARTS[(START_WEEKDAY[weekStart] + 6) % 7]]}`;

/** The week start dropdown: one option per weekday, each saying where its weeks run from and to. */
export const WEEK_START_OPTIONS: { value: WeekStart; label: string }[] = WEEK_STARTS.map((value) => ({
  value,
  label: `${WEEK_START_NAME[value]} (weeks run ${weekRunsText(value)})`,
}));

/** 2000-01-03 was a Monday: the fixed reference a Weekly cycle with no date counts from (as the engine does). */
const WEEKLY_REFERENCE: Day = { year: 2000, month: 1, day: 3 };

/** One cycle's period rule as typed or saved. An unknown week start reads as Monday, as it does in the engine. */
export type CycleRule = {
  weekStart: string;
  /** The first period start ("2026-02-02"); blank or null when not set. */
  anchorDate?: string | null;
};

/** The engine's own message when BiWeekly or Monthly has no first period start. */
export const missingDateError = (cycle: PayCycle): string =>
  `Set the first period start date for ${CYCLE_INFO[cycle].label} in Settings -> Production Payroll -> ${CYCLE_INFO[cycle].label}.`;

/** `day` moved back to the cycle's start weekday (it stays put when already on it). */
export const snapToWeekStart = (day: Day, weekStart: string): Day =>
  addDays(day, -((weekdayOf(day) - START_WEEKDAY[normalizeWeekStart(weekStart)] + 7) % 7));

/**
 * The date a cycle's periods are counted from: the first period start moved back to the start weekday. Weekly needs no
 * date (every week starts on the start weekday whatever the date, so it counts from a fixed Monday); BiWeekly and
 * Monthly refuse without one, with the engine's words.
 */
export function cycleAnchor(cycle: PayCycle, rule: CycleRule): { anchor: Day } | { error: string } {
  const typed = parseIsoDay(rule.anchorDate);
  if (!typed && CYCLE_INFO[cycle].needsDate) return { error: missingDateError(cycle) };
  return { anchor: snapToWeekStart(typed ?? WEEKLY_REFERENCE, rule.weekStart) };
}

/** Fixed-length periods chained both ways from the anchor (Python's floor division, so a day before the anchor works too). */
function rollingPeriod(ref: Day, anchor: Day, length: number): Period {
  const index = Math.floor(daysFrom(anchor, ref) / length);
  const start = addDays(anchor, index * length);
  return { start, end: addDays(start, length - 1) };
}

/** The period of `cycle` that `ref` falls in under `rule`, or why the engine would refuse (its own message). */
export function resolveCyclePeriod(ref: Day, cycle: PayCycle, rule: CycleRule): { period: Period } | { error: string } {
  const anchored = cycleAnchor(cycle, rule);
  if ("error" in anchored) return anchored;
  return { period: rollingPeriod(ref, anchored.anchor, CYCLE_INFO[cycle].days) };
}

export type NextCyclePeriod = {
  period: Period;
  /** The two periods after it. */
  then: Period[];
  /** Days of it that a period already generated on this cycle covers (workers paid for them are skipped). */
  overlap: Period | null;
  /** Production Payroll refuses a period whose last day is after today: this is the first day it can be generated. */
  generateFrom: Day;
  ended: boolean;
};

/**
 * What the cycle's page would generate next (production_period.py next_cycle_period): the period holding the day after
 * the latest period already generated on this cycle, or, on the first run, the most recent period that has ended (the
 * period holding today when today is its last day). A rule changed after periods were generated decides which period
 * holds that next day, so the next period can start before it: `overlap` is that stretch.
 */
export function nextCyclePeriod(
  cycle: PayCycle,
  rule: CycleRule,
  lastEnd: Day | null,
  today: Day,
): NextCyclePeriod | { error: string } {
  let resolved: { period: Period } | { error: string };
  if (lastEnd) {
    resolved = resolveCyclePeriod(addDays(lastEnd, 1), cycle, rule);
  } else {
    const current = resolveCyclePeriod(today, cycle, rule);
    if ("error" in current) return current;
    resolved =
      compareDays(current.period.end, today) <= 0
        ? current
        : resolveCyclePeriod(addDays(current.period.start, -1), cycle, rule);
  }
  if ("error" in resolved) return resolved;
  const { period } = resolved;
  const days = CYCLE_INFO[cycle].days;
  const then = [1, 2].map((k) => ({ start: addDays(period.start, k * days), end: addDays(period.end, k * days) }));
  const overlap = lastEnd && compareDays(period.start, lastEnd) <= 0 ? { start: period.start, end: lastEnd } : null;
  return { period, then, overlap, generateFrom: period.end, ended: compareDays(period.end, today) <= 0 };
}

/** A saved rule in words: "Monday weeks", "Monday weeks counted from Mon 2 Feb 2026", "first period start not set". */
export function describeCycleRule(cycle: PayCycle, rule: CycleRule): string {
  const weeks = `${WEEK_START_NAME[normalizeWeekStart(rule.weekStart)]} weeks`;
  const anchored = cycleAnchor(cycle, rule);
  if ("error" in anchored) return `${weeks}, first period start not set`;
  return parseIsoDay(rule.anchorDate) ? `${weeks} counted from ${formatDayLong(anchored.anchor)}` : weeks;
}
