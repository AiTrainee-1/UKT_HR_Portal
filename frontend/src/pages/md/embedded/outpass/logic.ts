// Pure helpers shared by the Gate Pass, Visitors and Tea Break Insights (no React): deltas for the tiles, chart rows, the
// questions for the assistant and the words of a scope. Tested in logic.test.ts.

import type { Tone } from "@/lib/md/format";
import { minutesText, num, pct, signed } from "@/lib/md/format";
import type { Metric, TrendPoint } from "./types";

export type Delta = { text: string; tone: Tone; direction: "up" | "down" | "flat" };

/** How a change is written on a tile. */
export type DeltaUnit = "count" | "pct" | "minutes";

/**
 * The change chip of a tile: "+3", "-2.5 pts", "+12m" against the previous period, sage when it is good news, crimson when it
 * is bad, plain when nobody can say (`higherIsBetter` null) or it did not move. None when either side is missing.
 */
export function deltaOf(m: Metric | undefined | null, higherIsBetter: boolean | null, unit: DeltaUnit = "count") {
  const change = m?.change;
  if (!change || m?.value == null || m.previous == null) return null;
  const abs = change.abs;
  const direction: Delta["direction"] = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  const tone: Tone = higherIsBetter === null || abs === 0 ? "neutral" : abs > 0 === higherIsBetter ? "good" : "bad";
  const text =
    unit === "pct"
      ? `${signed(abs)} pts`
      : unit === "minutes"
        ? `${abs > 0 ? "+" : abs < 0 ? "-" : ""}${minutesText(Math.abs(abs))}`
        : signed(abs, Number.isInteger(abs) ? 0 : 1);
  return { text, tone, direction } satisfies Delta;
}

/** "vs 12 last period": the previous figure under a tile. */
export function previousText(m: Metric | undefined | null, unit: DeltaUnit = "count"): string | undefined {
  if (!m || m.previous == null) return undefined;
  const value = unit === "pct" ? pct(m.previous) : unit === "minutes" ? minutesText(m.previous) : num(m.previous);
  return `${value} the period before`;
}

/** The trend's rows for the chart: one per day (or week), labelled by its first day. */
export function trendRows(points: TrendPoint[]) {
  return points.map((p) => ({
    date: p.start,
    visits: p.visits,
    passes: p.passes,
    left: p.left,
    returned: p.returned,
    hoursOut: Math.round((p.minutesOut / 60) * 10) / 10,
  }));
}

/** True when a series has anything to draw. */
export const anyOf = (points: TrendPoint[], key: keyof TrendPoint) => points.some((p) => Number(p[key]) > 0);

/** "in Nov 2026 (so far)" / "in the last 30 days" for a question to the assistant. */
export function inWhen(label: string): string {
  const lower = label.toLowerCase();
  return lower.startsWith("last") || lower.startsWith("this") || lower === "today" || lower === "yesterday"
    ? lower === "today" || lower === "yesterday"
      ? lower
      : `in the ${lower}`
    : `in ${label}`;
}

/** " for Unit 1 · Stitching" when the MD narrowed the scope, else "". */
export function forWhom(description: string | undefined, everyone: boolean): string {
  return everyone || !description ? "" : ` for ${description}`;
}

/** The longest names first would be noisy: the top of a ranked list, at most `n`, biggest value first. */
export function top<T>(rows: T[], value: (row: T) => number | null | undefined, n = 8): T[] {
  return [...rows].sort((a, b) => (value(b) ?? 0) - (value(a) ?? 0)).slice(0, n);
}

/** "3h 05m" / "45m" / "—". */
export const mins = (value: number | null | undefined) => minutesText(value ?? null);
