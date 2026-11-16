/**
 * The pay-period calendar of a Production Payroll cycle page (owner 2026-11-16): which colour a day of the calendar
 * takes (the state of the pay period that holds it, as the server lists it), which periods the months on screen still
 * need from the server, how a month is laid out (weeks start on the cycle's own start weekday, so every pay period fills
 * whole rows), and the wording of the selected period's summary. Pure functions only; the server's period list is the
 * only source of where a period begins and ends, and of its state.
 */

import { dateShort, ddmmyyyy, monthYear, plural, weekdayShort } from "@/components/payroll/kit/format";
import type { CyclePeriod, CyclePeriodRow } from "@/lib/api-client/custom-hooks";
import { periodStateOf } from "./period-workflow";

// ── days as "YYYY-MM-DD" ───────────────────────────────────────────────────────

const UTC_DAY = 86_400_000;

const toMs = (iso: string): number => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export const isIsoDay = (text: string | null | undefined): text is string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text ?? "")) return false;
  return fromMs(toMs(text!)) === text;
};

export const addDays = (iso: string, n: number): string => fromMs(toMs(iso) + n * UTC_DAY);

/** 0 = Sunday ... 6 = Saturday. */
export const weekdayOf = (iso: string): number => new Date(toMs(iso)).getUTCDay();

export const daysBetween = (from: string, to: string): number => Math.round((toMs(to) - toMs(from)) / UTC_DAY);

export const holds = (p: CyclePeriod, day: string): boolean => p.periodStart <= day && day <= p.periodEnd;

export const periodKey = (p: CyclePeriod): string => `${p.periodStart}|${p.periodEnd}`;

// ── months ─────────────────────────────────────────────────────────────────────

export type Month = { year: number; month: number };

export const monthOf = (iso: string): Month => ({ year: +iso.slice(0, 4), month: +iso.slice(5, 7) });

export function addMonths(m: Month, n: number): Month {
  const index = m.year * 12 + (m.month - 1) + n;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** Negative when `a` is before `b`. */
export const compareMonths = (a: Month, b: Month): number => a.year * 12 + a.month - (b.year * 12 + b.month);

export const monthTitle = (m: Month): string => monthYear(m.month, m.year);

const pad = (n: number) => String(n).padStart(2, "0");
export const firstOfMonth = (m: Month): string => `${m.year}-${pad(m.month)}-01`;
export const lastOfMonth = (m: Month): string => addDays(firstOfMonth(addMonths(m, 1)), -1);

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The seven column heads of a month, starting on the cycle's own start weekday. */
export const weekdayHeads = (weekStart: number): string[] =>
  Array.from({ length: 7 }, (_, i) => WEEKDAY_SHORT[(weekStart + i) % 7]);

/**
 * A month as rows of seven days, the first row starting on the cycle's start weekday on or before the 1st and the last
 * row holding the month's last day. Days of the months around it fill the first and last rows (drawn faded).
 */
export function monthRows(m: Month, weekStart: number): string[][] {
  const first = firstOfMonth(m);
  const last = lastOfMonth(m);
  let start = addDays(first, -((weekdayOf(first) - weekStart + 7) % 7));
  const rows: string[][] = [];
  while (start <= last) {
    rows.push(Array.from({ length: 7 }, (_, i) => addDays(start, i)));
    start = addDays(start, 7);
  }
  return rows;
}

/** The first and last day drawn for these months side by side. */
export function gridWindow(left: Month, months: number, weekStart: number): { from: string; to: string } {
  const first = monthRows(left, weekStart)[0][0];
  const lastRows = monthRows(addMonths(left, months - 1), weekStart);
  return { from: first, to: lastRows[lastRows.length - 1][6] };
}

/**
 * The weekday the cycle's periods start on, read from the server's own periods (every period of a cycle starts on the
 * same weekday: they are whole weeks). null while none is known.
 */
export function weekStartOf(rows: readonly CyclePeriod[]): number | null {
  return rows.length ? weekdayOf(rows[0].periodStart) : null;
}

// ── the server's periods ──────────────────────────────────────────────────────

/** Every row of every list, once: a later list's copy of a period replaces an earlier one. Oldest first. */
export function mergeRows(...lists: readonly (readonly CyclePeriodRow[] | null | undefined)[]): CyclePeriodRow[] {
  const byKey = new Map<string, CyclePeriodRow>();
  for (const list of lists) for (const row of list ?? []) byKey.set(periodKey(row), row);
  return [...byKey.values()].sort((a, b) => a.periodStart.localeCompare(b.periodStart));
}

/** A cheap fingerprint of a merged list: equal fingerprints = nothing on screen would change. */
export const rowsSignature = (rows: readonly CyclePeriodRow[]): string =>
  rows
    .map(
      (r) =>
        `${r.periodStart}|${r.periodEnd}|${r.state ?? ""}|${r.generated}|${r.paid}|${r.parked ?? 0}|${r.periodEnded ? 1 : 0}|${r.isNext ? 1 : 0}`,
    )
    .join(",");

export const rowHolding = (rows: readonly CyclePeriodRow[], day: string): CyclePeriodRow | undefined =>
  rows.find((r) => holds(r, day));

/**
 * The dates to ask the server about ("?around=") so that every day from `from` to `to` has its period: the first day of
 * every period on screen that no list has given yet. Periods are back-to-back blocks of `days` days, so stepping a whole
 * period at a time from one the server gave lands on each period's first day (the server still decides which period a
 * date belongs to). One request per missing period; the same window always gives the same dates (fewer as periods
 * arrive), so a request on its way is never replaced by another. Nothing outside [min, max] is asked for.
 */
export function probeDates(
  known: readonly CyclePeriod[],
  window: { from: string; to: string },
  days: number,
  limits: { min: string; max: string },
): string[] {
  if (known.length === 0 || days < 1 || window.from > window.to) return [];
  const ref = known[0].periodStart;
  const out: string[] = [];
  let start = addDays(ref, Math.floor(daysBetween(ref, window.from) / days) * days);
  for (; start <= window.to; start = addDays(start, days)) {
    const end = addDays(start, days - 1);
    if (end < limits.min || start > limits.max) continue;
    if (known.some((p) => holds(p, start))) continue;
    out.push(start < limits.min ? limits.min : start);
  }
  return out;
}

// ── what a period's colour says ────────────────────────────────────────────────

/**
 * paid      Payroll Done and marked as Paid                             (green)
 * done      Payroll Done, payment pending                               (amber, like the page's Payment Pending)
 * generated generated, still open                                       (indigo, like the page's Generated chip)
 * due       ended but nothing generated yet: needs attention            (rose)
 * upcoming  not ended yet (today's period and the ones after it)        (sky, dashed)
 */
export type PeriodKind = "paid" | "done" | "generated" | "due" | "upcoming";

export const PERIOD_KINDS: readonly PeriodKind[] = ["paid", "done", "generated", "due", "upcoming"];

export function periodKind(row: Pick<CyclePeriodRow, "state" | "generated" | "periodEnded">): PeriodKind {
  const state = periodStateOf(row.state ?? (row.generated > 0 ? "generated" : "not_generated"));
  if (state === "paid") return "paid";
  if (state === "finalized") return "done";
  if (state === "generated") return "generated";
  return row.periodEnded ? "due" : "upcoming";
}

export type KindMeta = {
  /** The status word (summary badge, a day's spoken label). */
  label: string;
  /** The legend's words. */
  legend: string;
  hint: string;
  /** A period that is not selected: light tint, its border and text. */
  block: string;
  text: string;
  /** The solid fill of the selected period, and the icon badge. */
  solid: string;
  /** A small swatch for the legend. */
  swatch: string;
  /** The summary badge. */
  badge: string;
};

export const KIND_META: Record<PeriodKind, KindMeta> = {
  paid: {
    label: "Paid",
    legend: "Paid",
    hint: "Payroll Done and the wages marked as paid.",
    block: "border-emerald-300 bg-emerald-100/80",
    text: "text-emerald-900",
    solid: "bg-emerald-600",
    swatch: "border-emerald-400 bg-emerald-200",
    badge: "border-emerald-300 bg-emerald-50 text-emerald-800",
  },
  done: {
    label: "Payroll Done",
    legend: "Payroll Done · payment pending",
    hint: "Finalized and locked: waiting for the wages to be marked as paid.",
    block: "border-amber-300 bg-amber-100/80",
    text: "text-amber-900",
    solid: "bg-amber-500",
    swatch: "border-amber-400 bg-amber-200",
    badge: "border-amber-300 bg-amber-50 text-amber-800",
  },
  generated: {
    label: "Generated",
    legend: "Generated",
    hint: "Payroll generated and still open: it can be generated again, adjusted and cleared until Payroll Done.",
    block: "border-indigo-300 bg-indigo-100/80",
    text: "text-indigo-900",
    solid: "bg-indigo-600",
    swatch: "border-indigo-400 bg-indigo-200",
    badge: "border-indigo-300 bg-indigo-50 text-indigo-800",
  },
  due: {
    label: "Not generated",
    legend: "Ended · not generated",
    hint: "The period has ended and no payroll has been generated for it yet.",
    block: "border-rose-200 bg-rose-50",
    text: "text-rose-900",
    solid: "bg-rose-500",
    swatch: "border-rose-300 bg-rose-100",
    badge: "border-rose-200 bg-rose-50 text-rose-800",
  },
  upcoming: {
    label: "Upcoming",
    legend: "Upcoming · not ended",
    hint: "The period has not ended yet: it can be generated from the day after its last day.",
    // dashed and striped as well as sky: still to come, whatever the theme does with the blues
    block:
      "border-dashed border-sky-300 bg-white bg-[repeating-linear-gradient(135deg,var(--color-sky-100)_0px,var(--color-sky-100)_5px,transparent_5px,transparent_10px)]",
    text: "text-sky-900",
    solid: "bg-sky-500",
    swatch:
      "border-dashed border-sky-400 bg-white bg-[repeating-linear-gradient(135deg,var(--color-sky-200)_0px,var(--color-sky-200)_3px,transparent_3px,transparent_6px)]",
    badge: "border-dashed border-sky-300 bg-sky-50 text-sky-800",
  },
};

/** How many periods of each colour the months on screen show. */
export function kindCounts(
  rows: readonly CyclePeriodRow[],
  window: { from: string; to: string } | null,
): Record<PeriodKind, number> {
  const counts: Record<PeriodKind, number> = { paid: 0, done: 0, generated: 0, due: 0, upcoming: 0 };
  if (!window) return counts;
  for (const r of rows) {
    if (r.periodEnd < window.from || r.periodStart > window.to) continue;
    counts[periodKind(r)] += 1;
  }
  return counts;
}

// ── which months are on screen ─────────────────────────────────────────────────

/** The day in the middle of a period: its month is the one that shows most of it. */
export const periodMiddle = (p: CyclePeriod): string =>
  addDays(p.periodStart, Math.floor(daysBetween(p.periodStart, p.periodEnd) / 2));

/** The left-most month that shows `p` with its middle in the right-most month on screen. */
export const viewFor = (p: CyclePeriod, months: number): Month => addMonths(monthOf(periodMiddle(p)), -(months - 1));

/** Whether the middle of `p` is in one of the months on screen. */
export function periodInView(p: CyclePeriod, left: Month, months: number): boolean {
  const mid = monthOf(periodMiddle(p));
  return compareMonths(mid, left) >= 0 && compareMonths(mid, addMonths(left, months - 1)) <= 0;
}

export type CalendarLimits = {
  /** The left-most month can go from `minLeft` to `maxLeft`. */
  minLeft: Month;
  maxLeft: Month;
  /** The days the From field takes and the server is asked about. */
  min: string;
  max: string;
};

const earlier = (a: Month, b: Month) => (compareMonths(a, b) <= 0 ? a : b);
const later = (a: Month, b: Month) => (compareMonths(a, b) >= 0 ? a : b);

/**
 * How far the calendar pages: three years back and two months ahead of today's month (the right-most month), always
 * far enough to show the selected period (an old one opened from its address). Dates are taken up to the end of the
 * third month ahead.
 */
export function calendarLimits(today: string, months: number, selected?: CyclePeriod | null): CalendarLimits {
  const now = monthOf(today);
  let oldest = addMonths(now, -36);
  let newest = addMonths(now, 2);
  let lastDay = lastOfMonth(addMonths(now, 3));
  if (selected) {
    oldest = earlier(oldest, monthOf(selected.periodStart));
    newest = later(newest, monthOf(selected.periodEnd));
    if (selected.periodEnd > lastDay) lastDay = lastOfMonth(monthOf(selected.periodEnd));
  }
  return {
    minLeft: oldest,
    maxLeft: later(oldest, addMonths(newest, -(months - 1))),
    min: firstOfMonth(oldest),
    max: lastDay,
  };
}

export function clampView(left: Month, limits: Pick<CalendarLimits, "minLeft" | "maxLeft">): Month {
  if (compareMonths(left, limits.minLeft) < 0) return limits.minLeft;
  if (compareMonths(left, limits.maxLeft) > 0) return limits.maxLeft;
  return left;
}

// ── the selection's sweep ──────────────────────────────────────────────────────

/** Seconds before the `index`-th day of a selected period fills in: the whole sweep takes about half a second. */
export function sweepDelay(index: number, length: number, reduce: boolean): number {
  if (reduce || index <= 0) return 0;
  const step = Math.min(0.035, 0.5 / Math.max(1, length));
  return Math.round(index * step * 1000) / 1000;
}

// ── quick picks ────────────────────────────────────────────────────────────────

export const nextDueRow = (rows: readonly CyclePeriodRow[]): CyclePeriodRow | undefined => rows.find((r) => r.isNext);

/** The newest period that has payroll (generated, Payroll Done or Paid). */
export function latestGeneratedRow(rows: readonly CyclePeriodRow[]): CyclePeriodRow | undefined {
  let best: CyclePeriodRow | undefined;
  for (const r of rows) {
    const has = r.generated > 0 || periodStateOf(r.state) !== "not_generated";
    if (has && (!best || r.periodStart > best.periodStart)) best = r;
  }
  return best;
}

// ── the summary's words ────────────────────────────────────────────────────────

/** "Mon 26 Oct → Sun 8 Nov · 14 days". */
export function periodSpan(p: CyclePeriod): string {
  const a = `${weekdayShort(p.periodStart)} ${dateShort(p.periodStart).replace(/ \d{4}$/, "")}`;
  const b = `${weekdayShort(p.periodEnd)} ${dateShort(p.periodEnd).replace(/ \d{4}$/, "")}`;
  return `${a} → ${b} · ${plural(daysBetween(p.periodStart, p.periodEnd) + 1, "day")}`;
}

/**
 * "113 payslips · 112 on the cycle now" (and who is still waiting in New Joiners, how many are Cleared). Payslips can
 * outnumber the people on the cycle now: somebody paid in the period may since have moved to another cycle or left, so
 * that case gets its own sentence instead of a confusing "114 of 113".
 */
export function payslipSummary(
  row: Pick<CyclePeriodRow, "generated" | "paid" | "parked">,
  roster: number,
): { line: string; note: string | null } {
  const parts = [row.generated > 0 ? plural(row.generated, "payslip") : "No payslips yet"];
  parts.push(`${roster} on the cycle now`);
  if (row.paid > 0) parts.push(`${row.paid} Cleared`);
  if ((row.parked ?? 0) > 0) parts.push(`${row.parked} waiting in New Joiners`);
  const note =
    row.generated > roster
      ? "More payslips than people on the cycle today: some of those paid in this period have since moved to another cycle or left."
      : null;
  return { line: parts.join(" · "), note };
}

/** Where the period stands in time: ended (and whether it can be generated), in progress, or still to come. */
export function periodTiming(
  row: Pick<CyclePeriodRow, "periodStart" | "periodEnd" | "periodEnded"> &
    Partial<Pick<CyclePeriodRow, "state" | "generated">>,
  today: string,
): string {
  const from = dateShort(addDays(row.periodEnd, 1));
  if (row.periodEnded) {
    const nothing = periodKind({ state: row.state, generated: row.generated ?? 0, periodEnded: true }) === "due";
    return `Ended ${dateShort(row.periodEnd)}${nothing ? " · ready to be generated" : ""}`;
  }
  if (row.periodStart <= today) return `In progress · ends ${dateShort(row.periodEnd)} · can be generated from ${from}`;
  return `Starts ${dateShort(row.periodStart)} · can be generated from ${from}`;
}

/** What a screen reader hears for a day: the date, today, the period that holds it and where that period stands. */
export function dayLabel(day: string, row: CyclePeriodRow | undefined, today: string, selected: boolean): string {
  const parts = [`${weekdayShort(day)} ${dateShort(day)}`];
  if (day === today) parts.push("today");
  if (row) {
    parts.push(`pay period ${dateShort(row.periodStart)} to ${dateShort(row.periodEnd)}`);
    parts.push(KIND_META[periodKind(row)].label);
    if (row.generated > 0) parts.push(plural(row.generated, "payslip"));
    if (row.isNext) parts.push("next due");
  } else {
    parts.push("pay period not loaded yet");
  }
  if (selected) parts.push("selected");
  return parts.join(", ");
}

/** "26-10-2026": how the From / To fields read. */
export const fieldDate = (iso: string | null | undefined): string => ddmmyyyy(iso);
