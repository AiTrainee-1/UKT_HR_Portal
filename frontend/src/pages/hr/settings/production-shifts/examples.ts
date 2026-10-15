// The made-up cases the Grace setting shows under its box, worked out from the form on screen (not the saved rules), so HR
// sees what a new number would do before saving. The full calculation (the ladder between rows, the breaks) is the server's:
// the "Try a day" box asks it. These are only the two simple edges of the grace.
import { parseNumber } from "../payroll/form";
import { absMinutes, clock12, MINUTES_PER_DAY, pointText, toHHMM, toMinutes } from "./time";
import { GRACE, type GroupRow, type ShiftRulesDraft } from "./form";

/** A day's shifts rounded to a step ("nearest" or "down"), to two decimals: 1.37 to 0.25 is 1.25 nearest, 1.25 down. */
export function roundShifts(value: number, step: number, mode: "nearest" | "down"): number {
  if (!(step > 0)) return Math.round(value * 100) / 100;
  const steps = value / step;
  const whole = mode === "down" ? Math.floor(steps + 1e-9) : Math.round(steps);
  return Math.round(whole * step * 100) / 100;
}

export type GraceExample = {
  group: string;
  grace: number;
  /** The last first-punch that is on time, and the next minute (late). */
  onTime: string;
  late: string;
  /** Leaving `grace` minutes before a ladder row: counts as that row. Null with no grace or no usable row. */
  snap: { leaves: string; counts: string; shifts: string } | null;
};

/** The group the example is about: the first one that is in use and has a start time (a Day group first). */
function exampleGroup(draft: ShiftRulesDraft): GroupRow | null {
  const usable = draft.groups.filter((g) => g.enabled && toMinutes(g.startTime) !== null);
  return usable.find((g) => g.kind === "day") ?? usable[0] ?? null;
}

/** The example for the grace box, or null while the grace or the groups cannot be read. */
export function graceExample(draft: ShiftRulesDraft): GraceExample | null {
  const grace = parseNumber(draft.graceMinutes, GRACE).value;
  const group = exampleGroup(draft);
  if (grace === null || group === null) return null;
  const start = toMinutes(group.startTime) as number;

  // the row closest to one whole shift: the one HR thinks of as "the shift", and the one a grace matters most for
  const rows = group.rules.flatMap((r) => {
    const at = absMinutes(r.outTime, r.outNextDay);
    const value = parseNumber(r.shiftValue, { min: 0, max: 99, decimals: 2 }).value;
    return r.enabled && at !== null && value !== null ? [{ row: r, at, value }] : [];
  });
  const best = rows.reduce<(typeof rows)[number] | null>(
    (pick, r) => (pick === null || Math.abs(r.value - 1) < Math.abs(pick.value - 1) ? r : pick),
    null,
  );
  const time = (minutes: number) => pointText(toHHMM(minutes), minutes >= MINUTES_PER_DAY);

  return {
    group: group.label.trim() || "the group",
    grace,
    onTime: clock12(toHHMM(start + grace)),
    late: clock12(toHHMM(start + grace + 1)),
    snap:
      grace > 0 && best
        ? {
            leaves: time(best.at - grace),
            counts: pointText(best.row.outTime, best.row.outNextDay),
            shifts: best.value.toFixed(2),
          }
        : null,
  };
}
