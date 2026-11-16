// The "at a glance" view of the Production Shifts tab: each shift group's hours as a From / To range, its first-punch
// window, what the day pays at its end time and at the top of its ladder, and where the paid leaving times and the unpaid
// breaks fall on a 24-hour bar. Worked out from the form on screen (so an edit shows at once), with the engine's own rule
// for a leaving time between two rows (backend/api/production_shift_rules.py value_at: the shifts grow by the paid
// minute, breaks not counted). All pure, so it is tested without a screen.
import { parseNumber } from "../payroll/form";
import { breakSpans, paidMinutes, SHIFT_VALUE, type BreakRow, type GroupRow } from "./form";
import { absMinutes, atText, clockPadded, MINUTES_PER_DAY, rangeText, spanText, toMinutes } from "./time";

/** The days a group is used on, as the summary says them. */
export const DAYS_WORDS: Record<GroupRow["appliesOn"], string> = {
  mon_sat: "Monday – Saturday",
  sunday: "Sunday",
  all: "Every day",
};

/** One paid leaving time of a ladder: a row that is on, readable and after the start. */
export type LadderPoint = {
  key: string;
  /** Minutes from the shift day's midnight (a next-day time is 1440 more). */
  at: number;
  value: number;
  label: string;
};

/** "1.00 shift", "1.50 shifts". */
export const shiftsText = (value: number): string => `${value.toFixed(2)} shift${value === 1 ? "" : "s"}`;

/** The rows of a group that pay, in time order. */
export function ladderPoints(group: GroupRow): LadderPoint[] {
  const start = toMinutes(group.startTime);
  return group.rules
    .flatMap((r) => {
      const at = absMinutes(r.outTime, r.outNextDay);
      const value = parseNumber(r.shiftValue, SHIFT_VALUE).value;
      return r.enabled && at !== null && value !== null && (start === null || at > start)
        ? [{ key: r.key, at, value, label: r.label.trim() }]
        : [];
    })
    .sort((a, b) => a.at - b.at);
}

/**
 * The shifts a day earns by leaving at `at` (minutes from the shift day's midnight), worked out like the engine: the
 * paid minutes since the start, between the two rows around it, the last row's shifts after the last row.
 */
export function ladderValueAt(start: number, points: LadderPoint[], spans: [number, number][], at: number): number {
  if (at <= start) return 0;
  const exact = points.find((p) => p.at === at);
  if (exact) return exact.value;
  const paid = paidMinutes(start, at, spans);
  let prevPaid = 0;
  let prevValue = 0;
  for (const p of points) {
    const pointPaid = paidMinutes(start, p.at, spans);
    if (paid < pointPaid) return prevValue + ((p.value - prevValue) * (paid - prevPaid)) / (pointPaid - prevPaid);
    prevPaid = pointPaid;
    prevValue = p.value;
  }
  return prevValue;
}

export type GroupSummary = {
  key: string;
  name: string;
  kind: GroupRow["kind"];
  enabled: boolean;
  /** "Monday – Saturday". */
  days: string;
  /** Minutes from the shift day's midnight; null while the start time cannot be read. */
  start: number | null;
  /** The end the summary uses: the group's end time (its standard departure), else its last paid leaving time. */
  end: number | null;
  /** Where `end` comes from: the group's own end time, its last paid leaving time (no end time set), or nothing. */
  endSource: "set" | "last" | "none";
  /** "From 08:30 AM to 08:00 PM"; null while the start cannot be read. */
  range: string | null;
  /** "11 h 30 min"; null without an end. */
  length: string | null;
  /** Minutes of unpaid break between the start and the end. */
  unpaid: number;
  /** "Punch in between 04:00 AM and 04:59 PM"; null while a window time cannot be read. */
  window: string | null;
  points: LadderPoint[];
  /** "1.50 shifts by 08:00 PM; up to 3.00 shifts by 05:30 AM next day". */
  pays: string;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What the day pays, in one sentence. */
function paysText(
  start: number | null,
  end: number | null,
  source: GroupSummary["endSource"],
  points: LadderPoint[],
  spans: [number, number][],
): string {
  if (points.length === 0) return "No paid leaving time is switched on, so a day of this group earns nothing.";
  if (start === null) return "Enter the start time to see what the day pays.";
  const last = points[points.length - 1];
  if (source !== "set" || end === null) return `Up to ${shiftsText(last.value)} by ${atText(last.at)}`;
  // the figure is exact on a row, and after the last row (where it stays at the top); between rows it is worked out
  const exact = end >= last.at || points.some((p) => p.at === end);
  const atEnd = `${exact ? "" : "About "}${shiftsText(round2(ladderValueAt(start, points, spans, end)))} by ${atText(end)}`;
  if (last.at > end) return `${atEnd}; up to ${shiftsText(last.value)} by ${atText(last.at)}`;
  if (last.at === end) return `${atEnd}, the most this shift pays`;
  return `${atEnd}: the most this shift pays, reached at ${atText(last.at)}`;
}

/** One group, summed up for its card (from the form on screen: the breaks are the ones that are on). */
export function groupSummary(group: GroupRow, breaks: BreakRow[], index = 0): GroupSummary {
  const spans = breakSpans(breaks);
  const start = toMinutes(group.startTime);
  const points = ladderPoints(group);
  const setEnd = group.mainOutTime.trim() === "" ? null : absMinutes(group.mainOutTime, group.mainOutNextDay);
  let end: number | null = null;
  let endSource: GroupSummary["endSource"] = "none";
  if (start !== null && setEnd !== null && setEnd > start) {
    end = setEnd;
    endSource = "set";
  } else if (start !== null && group.mainOutTime.trim() === "" && points.length > 0) {
    end = points[points.length - 1].at;
    endSource = "last";
  }
  const from = toMinutes(group.firstPunchFrom);
  const to = toMinutes(group.firstPunchTo);
  return {
    key: group.key,
    name: group.label.trim() || `Group ${index + 1}`,
    kind: group.kind,
    enabled: group.enabled,
    days: DAYS_WORDS[group.appliesOn],
    start,
    end,
    endSource,
    range: start === null ? null : end === null ? `From ${atText(start)}` : rangeText(start, end),
    length: start !== null && end !== null ? spanText(end - start) : null,
    unpaid: start !== null && end !== null ? end - start - paidMinutes(start, end, spans) : 0,
    window:
      from !== null && to !== null
        ? `Punch in between ${clockPadded(group.firstPunchFrom)} and ${clockPadded(group.firstPunchTo)}`
        : null,
    points,
    pays: paysText(start, end, endSource, points, spans),
  };
}

// ── the breaks ──

export type BreakTotals = {
  /** Breaks that are on and readable. */
  count: number;
  /** Their unpaid minutes in a day (two that touch are counted once). */
  minutes: number;
  /** "5 breaks, 2 h 30 min unpaid each day". */
  text: string;
};

/** How many breaks are on and how long they are, together. */
export function breakTotals(breaks: BreakRow[]): BreakTotals {
  const count = breaks.filter((b) => {
    const start = toMinutes(b.startTime);
    const end = toMinutes(b.endTime);
    return b.enabled && start !== null && end !== null && end > start;
  }).length;
  const minutes = breakSpans(breaks).reduce((sum, [from, to]) => sum + (to - from), 0);
  const text =
    count === 0
      ? "No break is switched on: every minute between a worker's punches is paid"
      : `${count} ${count === 1 ? "break" : "breaks"}, ${spanText(minutes)} unpaid each day`;
  return { count, minutes, text };
}

/** "10:30 AM – 10:45 AM". */
export const breakRangeText = (b: Pick<BreakRow, "startTime" | "endTime">): string =>
  `${clockPadded(b.startTime)} – ${clockPadded(b.endTime)}`;

// ── the 24-hour bar ──

/** The bar always shows one whole day: 24 hours from its left edge. */
export const BAR_MINUTES = MINUTES_PER_DAY;

/**
 * Where a group's bar starts (minutes from the shift day's midnight): two hours before the start, on the hour, so the
 * whole shift and the night after it fit (Day 06:00 to 06:00 next day, Night 19:00 to 19:00 next day). A bar for the whole
 * day (the breaks) starts at midnight.
 */
export function barOrigin(start: number | null): number {
  if (start === null) return 0;
  return Math.max(0, Math.floor(start / 60) * 60 - 120);
}

/** A time's place on the bar, 0 to 100 (outside the bar it sits on the nearer edge). */
export function barPercent(origin: number, at: number): number {
  return Math.min(100, Math.max(0, ((at - origin) / BAR_MINUTES) * 100));
}

const TICK_WORDS: Record<number, string> = { 0: "Midnight", 360: "6 AM", 720: "Noon", 1080: "6 PM" };

/** The hour marks under a bar: midnight, 6 AM, noon and 6 PM, wherever they fall inside it. */
export function barTicks(origin: number): { at: number; label: string }[] {
  const out: { at: number; label: string }[] = [];
  for (let at = Math.ceil(origin / 360) * 360; at <= origin + BAR_MINUTES; at += 360) {
    if (at > origin && at < origin + BAR_MINUTES) out.push({ at, label: TICK_WORDS[at % MINUTES_PER_DAY] });
  }
  return out;
}

/** The unpaid breaks as stretches of the bar (each break on the shift day and again the morning after), clipped to it. */
export function barBreaks(origin: number, spans: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const [from, to] of spans) {
    for (const day of [0, 1]) {
      const lo = Math.max(origin, from + day * MINUTES_PER_DAY);
      const hi = Math.min(origin + BAR_MINUTES, to + day * MINUTES_PER_DAY);
      if (hi > lo) out.push([lo, hi]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Which point labels fit above the bar without running into each other: left to right, a label is kept when it is at
 * least `gap` percent from the last one kept; the last point (the most the shift pays) always is, in place of the one
 * before it when they are too close.
 */
export function labelsThatFit(percents: number[], gap: number): boolean[] {
  const keep = percents.map(() => false);
  let lastKept = -1;
  percents.forEach((p, i) => {
    if (lastKept === -1 || p - percents[lastKept] >= gap) {
      keep[i] = true;
      lastKept = i;
    }
  });
  const last = percents.length - 1;
  if (last >= 0 && !keep[last]) {
    if (lastKept >= 0) keep[lastKept] = false;
    keep[last] = true;
  }
  return keep;
}
