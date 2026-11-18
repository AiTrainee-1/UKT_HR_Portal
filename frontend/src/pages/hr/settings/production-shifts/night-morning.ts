// The worked examples of Settings -> Production Shifts -> Night and early morning, from what is typed on the tab (not
// saved yet). Pure, so they are tested without a screen. The rules themselves live in the backend engine
// (production_shift_rules.py, RuleSet.arrival_guard / close_by_s / tap_gap_s); these only say what they mean for the
// groups on the tab.
import { parseNumber } from "../payroll/form";
import {
  CLOCK_IN_AGAIN,
  CUT_OFF,
  DOUBLE_TAP,
  EARLY_ARRIVAL,
  NIGHT_MORNING_DEFAULTS,
  type GroupRow,
  type ShiftRulesDraft,
} from "./form";
import { MINUTES_PER_DAY, toHHMM, toMinutes } from "./time";

/** The typed minutes, or the default while the box cannot be read. */
export function nightMorningMinutes(draft: ShiftRulesDraft) {
  return {
    earlyArrival: parseNumber(draft.earlyArrivalMinutes, EARLY_ARRIVAL).value ?? NIGHT_MORNING_DEFAULTS.earlyArrival,
    clockInAgain: parseNumber(draft.clockInAgainMinutes, CLOCK_IN_AGAIN).value ?? NIGHT_MORNING_DEFAULTS.clockInAgain,
    cutOff: parseNumber(draft.cutOffMinutes, CUT_OFF).value ?? NIGHT_MORNING_DEFAULTS.cutOff,
    doubleTap: parseNumber(draft.doubleTapMinutes, DOUBLE_TAP).value ?? NIGHT_MORNING_DEFAULTS.doubleTap,
  };
}

/** A night shift: its standard departure is the next morning (Night 9 PM -> 5:30 AM next day). */
export const isNightShift = (g: GroupRow): boolean =>
  g.mainOutTime.trim() !== "" ? g.mainOutNextDay : g.kind === "night";

export type MorningRow = {
  group: string;
  night: boolean;
  /** HH:MM */
  start: string;
  /** From this clock time a morning punch is the day's early arrival (HH:MM). */
  arrivalFrom: string;
  /** A clock-in up to this time makes an earlier morning punch the end of the night (HH:MM). */
  clockInBy: string;
};

/** Every group in use whose start can be read, with what the early-arrival rule means for it. */
export function morningRows(draft: ShiftRulesDraft): MorningRow[] {
  const m = nightMorningMinutes(draft);
  return draft.groups.flatMap((g, i) => {
    const start = toMinutes(g.startTime);
    if (!g.enabled || start === null) return [];
    return [
      {
        group: g.label.trim() || `Group ${i + 1}`,
        night: isNightShift(g),
        start: toHHMM(start),
        arrivalFrom: toHHMM(start - m.earlyArrival),
        clockInBy: toHHMM(start + m.clockInAgain),
      },
    ];
  });
}

/**
 * The next-morning cut-off with the groups on the tab: the latest next-morning leaving time of the rows and standard
 * departures in use, plus the minutes (HH:MM); null while the switch is off. Like the engine, a table with no
 * next-morning time counts from midnight. Special shifts (Manage Shifts) can move it later; they are not on this tab.
 */
export function cutOffTime(draft: ShiftRulesDraft): string | null {
  if (!draft.cutOffEnabled) return null;
  let latest = 0;
  for (const g of draft.groups) {
    if (!g.enabled) continue;
    const outs = g.rules.filter((r) => r.enabled && r.outNextDay).map((r) => toMinutes(r.outTime));
    if (g.mainOutNextDay) outs.push(toMinutes(g.mainOutTime));
    for (const out of outs) if (out !== null) latest = Math.max(latest, out);
  }
  return toHHMM(Math.min(latest + nightMorningMinutes(draft).cutOff, MINUTES_PER_DAY - 1));
}

/**
 * The clock-in-again example for one day group: a worker on overtime through the night leaves 18 minutes after the
 * early-arrival time and punches again one minute after the start. Is the early punch the end of the night?
 */
export function clockInExample(draft: ShiftRulesDraft, row: MorningRow) {
  const m = nightMorningMinutes(draft);
  const start = toMinutes(row.start) ?? 0;
  const out = toMinutes(row.arrivalFrom)! + 18;
  const again = start + 1;
  const endsNight = draft.clockInAgainEnabled && again <= start + m.clockInAgain;
  return { out: toHHMM(out), again: toHHMM(again), endsNight };
}

/** Two presses 3 minutes apart: one punch or two? */
export function doubleTapExample(draft: ShiftRulesDraft) {
  const gap = 3;
  return { gap, onePunch: draft.doubleTapEnabled && gap < nightMorningMinutes(draft).doubleTap };
}
