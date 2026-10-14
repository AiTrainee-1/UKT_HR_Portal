import { Cake, CalendarCheck2, CalendarHeart, Sunrise, Sunset, TimerReset, type LucideIcon } from "lucide-react";
import type { AttendanceCompensationKind } from "@/lib/api-client/custom-hooks";

// The compensation marker of an attendance day: what the attendance engine says shaped the day (backend/api/
// attendance_final.py::compensation_marker_json). Every HR attendance JSON that shows a day carries three keys,
//   compensationKind     null | "ot_allowance" | "window_late_in" | "window_early_out" | "birthday" | "relaxation"
//   compensationMinutes  the allowance minutes the arrival used (ot_allowance), else 0
//   compensationNote     one plain sentence saying what happened (or null)
// and every screen that draws a day shows them the same way, through the components next to this file, so HR can see at a
// glance that an employee used their compensation. A marker is never colour alone: each kind has its own icon, its own
// short code and its own words.

/** The three keys an attendance day carries (all optional: an older backend sends none of them). */
export type CompensationFields = {
  compensationKind?: string | null;
  compensationMinutes?: number | null;
  compensationNote?: string | null;
};

/** The kinds in the order a legend lists them (the engine's own order of importance, reversed: the common one first). */
export const COMPENSATION_KINDS: readonly AttendanceCompensationKind[] = [
  "ot_allowance",
  "window_late_in",
  "window_early_out",
  "birthday",
  "relaxation",
];

/** A kind this build does not know (a newer backend): drawn as a plain "Compensation" marker, never dropped. */
export type MarkKind = AttendanceCompensationKind | "other";

export type KindMeta = {
  label: string;
  /** Two letters for a compact cell: the legend explains them. */
  short: string;
  icon: LucideIcon;
  /** The full chip: pale fill, dark text, border. Tailwind only sees complete class strings, so each is written out. */
  chip: string;
  /** The compact symbol: solid fill, white text. */
  solid: string;
  /** One sentence for the legend: what the marker means. */
  meaning: string;
};

export const KIND_META: Record<MarkKind, KindMeta> = {
  ot_allowance: {
    label: "OT allowance used",
    short: "OT",
    icon: TimerReset,
    chip: "bg-violet-100 text-violet-800 border-violet-200",
    solid: "bg-violet-600",
    meaning: "Worked extra hours the day before and arrived inside the next-day late-in allowance, so no Late mark.",
  },
  window_late_in: {
    label: "Announced late-in",
    short: "LI",
    icon: Sunrise,
    chip: "bg-sky-100 text-sky-800 border-sky-200",
    solid: "bg-sky-700",
    meaning: "The company announced a late-in time for the day; arriving up to that time is not Late.",
  },
  window_early_out: {
    label: "Announced early-out",
    short: "EO",
    icon: Sunset,
    chip: "bg-teal-100 text-teal-800 border-teal-200",
    solid: "bg-teal-700",
    meaning: "The company announced an early-out time for the day; leaving from that time is not an Early Out.",
  },
  birthday: {
    label: "Birthday leave",
    short: "BD",
    icon: Cake,
    chip: "bg-pink-100 text-pink-800 border-pink-200",
    solid: "bg-pink-600",
    meaning: "The employee's birthday: paid compensation leave, no attendance detection applies that day.",
  },
  relaxation: {
    label: "Relaxation (compensation day)",
    short: "RX",
    icon: CalendarHeart,
    chip: "bg-indigo-100 text-indigo-800 border-indigo-200",
    solid: "bg-indigo-600",
    meaning: "A compensation day off (relaxation) was applied to this day; no punches are needed for it.",
  },
  other: {
    label: "Compensation",
    short: "CP",
    icon: CalendarCheck2,
    chip: "bg-slate-100 text-slate-700 border-slate-200",
    solid: "bg-slate-600",
    meaning: "A compensation shaped this day.",
  },
};

export type CompensationMark = {
  kind: MarkKind;
  /** "OT allowance used (30 min)": the words on a chip. */
  label: string;
  short: string;
  /** The allowance minutes the arrival used (0 for every other kind). */
  minutes: number;
  /** The engine's sentence, null when it sent none. */
  note: string | null;
  /** Label and note as one line, for a tooltip and a screen reader. */
  title: string;
};

const isKnownKind = (raw: string): raw is AttendanceCompensationKind =>
  (COMPENSATION_KINDS as readonly string[]).includes(raw);

/** The words of a kind, with the minutes an allowance used: "OT allowance used (30 min)". */
export function kindLabel(kind: MarkKind, minutes = 0): string {
  const base = KIND_META[kind].label;
  return kind === "ot_allowance" && minutes > 0 ? `${base} (${minutes} min)` : base;
}

/** The marker an attendance day carries, or null for an ordinary day (no kind, or an older backend that sends none). */
export function compensationMark(day: CompensationFields | null | undefined): CompensationMark | null {
  const raw = (day?.compensationKind ?? "").trim();
  if (!raw) return null;
  const kind: MarkKind = isKnownKind(raw) ? raw : "other";
  const minutes = Math.max(0, Math.round(Number(day?.compensationMinutes) || 0));
  const note = day?.compensationNote?.trim() || null;
  const label = kindLabel(kind, minutes);
  return { kind, label, short: KIND_META[kind].short, minutes, note, title: note ? `${label}: ${note}` : label };
}

/**
 * A day topped up only by a relaxation has no punches: the attendance sheet still labels its half "afternoon" (it has
 * nothing to judge by), which would read as a real Half Day worked in the evening. Such a day shows the Relaxation marker
 * and its note instead of a half-day period.
 */
export function isPunchlessRelaxation(day: CompensationFields & { firstPunch?: string | null }): boolean {
  return (day.compensationKind ?? "").trim() === "relaxation" && !day.firstPunch;
}

/** How many of these days carry each kind of marker (kinds with none are left out), in the legend's order. */
export function countMarks(days: readonly CompensationFields[]): Partial<Record<MarkKind, number>> {
  const counts: Partial<Record<MarkKind, number>> = {};
  for (const day of days) {
    const mark = compensationMark(day);
    if (mark) counts[mark.kind] = (counts[mark.kind] ?? 0) + 1;
  }
  const ordered: Partial<Record<MarkKind, number>> = {};
  for (const kind of [...COMPENSATION_KINDS, "other" as const]) {
    const n = counts[kind];
    if (n) ordered[kind] = n;
  }
  return ordered;
}

/** The kinds present in these days, in the legend's order. */
export const markKinds = (days: readonly CompensationFields[]): MarkKind[] =>
  Object.keys(countMarks(days)) as MarkKind[];

/** The short code of a day's marker ("OT", "LI", ...) or "" for an ordinary day: what a spreadsheet cell appends. */
export const markShort = (day: CompensationFields | null | undefined): string => compensationMark(day)?.short ?? "";

/** The one sentence a spreadsheet note holds: label plus the engine's note ("" for an ordinary day). */
export const markTitle = (day: CompensationFields | null | undefined): string => compensationMark(day)?.title ?? "";
