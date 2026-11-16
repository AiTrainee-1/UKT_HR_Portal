// Pure helpers behind the Production shifts of Manage Shifts: what a production shift group (a Settings default or a
// special shift) means for HR, in plain clock times: its days, its hours, when a first punch stops being on time, when a
// last punch is an early out, its Earned Shift table, and where it sits on a 24-hour bar (a night shift wraps).
import type { ProductionShiftAppliesOn, ProductionShiftGroup } from "@/lib/api-client/custom-hooks";
import { MINUTES_PER_DAY, toHHMM, toMinutes } from "@/pages/hr/settings/production-shifts/time";

export const DAYS_LABEL: Record<ProductionShiftAppliesOn, string> = {
  mon_sat: "Monday to Saturday",
  sunday: "Sunday",
  all: "Every day",
};

/** "05:30" or "05:30 next day". */
export const clockText = (minutes: number): string =>
  `${toHHMM(minutes % MINUTES_PER_DAY)}${minutes >= MINUTES_PER_DAY ? " next day" : ""}`;

/** Start and standard departure as minutes from the start day's midnight (a next-day departure is +1440). */
export function shiftSpan(g: Pick<ProductionShiftGroup, "startTime" | "mainOutTime" | "mainOutNextDay">): {
  start: number;
  end: number | null;
} {
  const start = toMinutes(g.startTime) ?? 0;
  const out = toMinutes(g.mainOutTime);
  return { start, end: out === null ? null : out + (g.mainOutNextDay ? MINUTES_PER_DAY : 0) };
}

/** "11h 30m" from the start to the standard departure; null without a departure. */
export function spanLength(start: number, end: number | null): string | null {
  if (end === null || end <= start) return null;
  const mins = end - start;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/** The shift on a 24-hour bar as one or two pieces (percent left / width): a night shift wraps past midnight. */
export function timelinePieces(start: number, end: number | null): { left: number; width: number }[] {
  if (end === null || end <= start) return [];
  const pct = (m: number) => (m / MINUTES_PER_DAY) * 100;
  if (end <= MINUTES_PER_DAY) return [{ left: pct(start), width: pct(end - start) }];
  return [
    { left: pct(start), width: pct(MINUTES_PER_DAY - start) },
    { left: 0, width: pct(Math.min(end - MINUTES_PER_DAY, start)) },
  ];
}

export type DetectionTimes = {
  /** A first punch up to this time is on time (start + grace); later is Late. */
  onTimeUntil: string;
  /** A last punch before this is an early out (departure - grace); null without a departure. */
  earlyOutBefore: string | null;
  /** The first-punch window that sends a day to this shift (default shifts only; a special shift is assigned). */
  window: string;
};

export function detectionTimes(g: ProductionShiftGroup, graceMinutes: number): DetectionTimes {
  const { start, end } = shiftSpan(g);
  return {
    onTimeUntil: clockText(start + graceMinutes),
    earlyOutBefore: end === null ? null : clockText(end - graceMinutes),
    window: `${g.firstPunchFrom} – ${g.firstPunchTo}`,
  };
}

export type LadderRow = { at: string; value: number; label: string };

/** The Earned Shift table: "leave at this time = this many shifts", switched-on rows in time order. */
export function ladderRows(g: Pick<ProductionShiftGroup, "rules">): LadderRow[] {
  return g.rules
    .filter((r) => r.enabled)
    .map((r) => ({ abs: (toMinutes(r.outTime) ?? 0) + (r.outNextDay ? MINUTES_PER_DAY : 0), r }))
    .sort((a, b) => a.abs - b.abs)
    .map(({ abs, r }) => ({ at: clockText(abs), value: Number(r.shiftValue), label: r.label }));
}

/** The most the table pays (its top row). */
export const topValue = (g: Pick<ProductionShiftGroup, "rules">): number =>
  ladderRows(g).reduce((best, r) => Math.max(best, r.value), 0);

/** "2.50" */
export const shiftsText = (v: number): string => v.toFixed(2);
