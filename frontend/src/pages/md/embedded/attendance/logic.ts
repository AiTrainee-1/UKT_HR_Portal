import type { StatTone } from "@/components/md/kit/StatCard";
import type { AssistantPageContext } from "@/lib/md/assistant-store";
import { minutesText, num, pct, type Tone } from "@/lib/md/format";
import { metricDelta, metricText, wasText } from "@/pages/md/attendance/logic";
import type { MetricKey } from "@/pages/md/attendance/types";
import type { BoardState, InsightsSummary, Metric, NewMetricKey, PeopleMetric } from "./types";

// The pure half of the Staff / Production Attendance Insights: which figures are shown and what a click on each opens,
// today's six cards, and what the assistant is told. No React here (logic.test.ts).

export type AttendanceKind = "staff" | "production";

export const PAGE_OF: Record<AttendanceKind, { id: string; title: string; noun: string }> = {
  staff: { id: "attendance", title: "Staff Attendance", noun: "staff" },
  production: { id: "attendance-production", title: "Production Attendance", noun: "production workers" },
};

export type TileKey = MetricKey | NewMetricKey;

export type Tile = {
  key: TileKey;
  label: string;
  tone: StatTone;
  provenanceIds: string[];
  /** The people list a click opens (none: the figure has no people behind it here). */
  drill?: PeopleMetric;
  sub: (s: InsightsSummary) => string | undefined;
};

const join = (...parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" · ") || undefined;

/** The headline figures, in reading order: attendance and absence, lateness and what it cost, then pay and corrections. */
export const TILES: Tile[] = [
  {
    key: "attendancePct",
    label: "Attendance",
    tone: "blue",
    provenanceIds: ["attendance-pct", "coverage"],
    drill: "absent",
    sub: (s) => wasText("attendancePct", s.metrics.attendancePct) ?? "of scheduled days worked",
  },
  {
    key: "absenteeismPct",
    label: "Absenteeism",
    tone: "red",
    provenanceIds: ["absenteeism-pct"],
    drill: "absent",
    sub: (s) => join(s.counts.absent != null && `${num(s.counts.absent)} unplanned absence days`),
  },
  {
    key: "latePct",
    label: "Late arrivals",
    tone: "amber",
    provenanceIds: ["late-pct", "avg-late-minutes"],
    drill: "late",
    sub: (s) =>
      join(
        s.counts.late != null && `${num(s.counts.late)} days`,
        s.metrics.avgLateMinutes?.value != null && `${minutesText(s.metrics.avgLateMinutes.value)} late on average`,
      ),
  },
  {
    key: "quarterDays",
    label: "Quarter shift off",
    tone: "purple",
    provenanceIds: ["shift-deductions"],
    drill: "quarter",
    sub: () => "arrived after the Late window: 0.25 off",
  },
  {
    key: "penaltyEarlyOuts",
    label: "Penalty Early Outs",
    tone: "red",
    provenanceIds: ["shift-deductions"],
    drill: "penalty",
    sub: (s) =>
      join(
        "left well before the end",
        s.metrics.shiftsDeducted?.value ? `${num(s.metrics.shiftsDeducted.value, 2)} shifts deducted in all` : null,
      ),
  },
  {
    key: "halfDays",
    label: "Half days",
    tone: "indigo",
    provenanceIds: ["half-days"],
    drill: "half",
    sub: (s) => wasText("halfDays", s.metrics.halfDays) ?? "one half worked only",
  },
  {
    key: "shiftsEarned",
    label: "Shifts earned",
    tone: "green",
    provenanceIds: ["shifts-earned"],
    drill: "worked",
    sub: (s) => join(s.counts.worked != null && `over ${num(s.counts.worked)} days worked`, "what payroll pays from"),
  },
  {
    key: "overtimeHours",
    label: "Overtime",
    tone: "slate",
    provenanceIds: ["overtime-hours"],
    sub: (s) =>
      s.metrics.overtimeHours?.value == null
        ? "Not tracked: see the notes"
        : join(s.counts.overtimeDays != null && `${num(s.counts.overtimeDays)} days`),
  },
];

const NEW_FORMAT: Record<NewMetricKey, (v: number) => string> = {
  shiftsEarned: (v) => num(v, 2),
  shiftsDeducted: (v) => num(v, 2),
  quarterDays: (v) => num(v),
  penaltyEarlyOuts: (v) => num(v),
};

const isNew = (key: TileKey): key is NewMetricKey => key in NEW_FORMAT;

/** The value of a tile as shown ("75.9%", "3.00", "2"); "—" when there is no figure. */
export function tileValue(key: TileKey, metric?: Metric | null): string {
  if (isNew(key)) return metric?.value == null ? "—" : NEW_FORMAT[key](metric.value);
  return metricText(key, metric);
}

/** The change chip of a tile: counts change by the count; better or worse by the figure's good direction. */
export function tileDelta(
  key: TileKey,
  metric?: Metric | null,
): { text: string; tone: Tone; direction?: "up" | "down" | "flat" } | null {
  if (!isNew(key)) return metricDelta(key, metric);
  const abs = metric?.delta?.abs;
  if (abs == null) return null;
  const direction = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  const tone: Tone =
    abs === 0 || metric?.good == null ? "neutral" : abs > 0 === (metric.good === "up") ? "good" : "bad";
  const text = `${abs > 0 ? "+" : abs < 0 ? "-" : ""}${NEW_FORMAT[key](Math.abs(abs))}`;
  return { text, tone, direction };
}

// ── today: HR's six status cards ────────────────────────────────────────────────────────────────────────────────────

export const BOARD: { key: BoardState; label: string; hint: string; tone: string }[] = [
  { key: "present", label: "Present", hint: "punched in", tone: "md-analytics-tone-good" },
  { key: "onDuty", label: "On Duty", hint: "approved On-Duty", tone: "md-analytics-tone-info" },
  { key: "onLeave", label: "On Leave", hint: "leave approved", tone: "md-analytics-tone-wine" },
  { key: "cl", label: "CL", hint: "casual leave approved", tone: "md-analytics-tone-wine" },
  { key: "leaveApplied", label: "Leave", hint: "waiting for approval", tone: "md-analytics-tone-watch" },
  { key: "absent", label: "Not in yet", hint: "no punch, no leave", tone: "md-analytics-tone-bad" },
];

export const boardLabel = (state: BoardState) => BOARD.find((b) => b.key === state)?.label ?? state;

/** "228 of 262 in (87.0%)". */
export function boardSentence(board: Record<BoardState, number> | undefined, expected: number): string {
  if (!board || !expected) return "Nobody is scheduled today.";
  const working = board.present + board.onDuty;
  return `${num(working)} of ${num(expected)} working (${pct((100 * working) / expected)})`;
}

// ── drill-down titles ───────────────────────────────────────────────────────────────────────────────────────────────

export const PEOPLE_TITLE: Record<PeopleMetric, string> = {
  absent: "Unplanned absence",
  late: "Late arrivals",
  half: "Half days",
  leave: "On approved leave",
  quarter: "Quarter shift off",
  penalty: "Penalty Early Outs",
  worked: "Days worked",
  workedOff: "Days off worked",
};

/** "3 days · 33.3% attendance" for a person row. */
export function personLine(days: number, attendancePct: number | null, avgLate?: number | null): string {
  return [
    `${num(days)} ${days === 1 ? "day" : "days"}`,
    avgLate != null ? `${minutesText(avgLate)} late on average` : null,
    attendancePct != null ? `${pct(attendancePct)} attendance` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ── the assistant ───────────────────────────────────────────────────────────────────────────────────────────────────

export function assistantContext(
  kind: AttendanceKind,
  summary: InsightsSummary | undefined,
  periodLabel: string,
  scopeText: string,
): AssistantPageContext {
  const m = summary?.metrics ?? {};
  const board = summary?.live?.board;
  const show = (key: TileKey) => {
    const metric = (m as Record<string, Metric | undefined>)[key];
    return metric?.value != null ? tileValue(key, metric) : null;
  };
  return {
    page: PAGE_OF[kind].id,
    title: PAGE_OF[kind].title,
    filters: { Period: periodLabel, Scope: scopeText, Employees: PAGE_OF[kind].noun },
    summary: {
      Attendance: show("attendancePct"),
      Absenteeism: show("absenteeismPct"),
      "Late arrivals": show("latePct"),
      "Quarter shift off (days)": show("quarterDays"),
      "Penalty Early Outs": show("penaltyEarlyOuts"),
      "Shifts earned": show("shiftsEarned"),
      "Half days": show("halfDays"),
      "Data-gap days left out": summary?.dataGaps?.length || null,
      Today: board && summary?.live ? boardSentence(board, summary.live.expected) : null,
    },
  };
}

/** The question each tile's Ask AI opens with. */
export function tileQuestion(tile: Tile, kind: AttendanceKind, where: string, value: string): string {
  const who = PAGE_OF[kind].noun;
  switch (tile.key) {
    case "attendancePct":
      return `Attendance of ${who} is ${value} (${where}). What is driving it, and which departments pull it down?`;
    case "absenteeismPct":
      return `Absenteeism of ${who} is ${value} (${where}). Who and where is it coming from?`;
    case "latePct":
      return `${value} of days worked by ${who} start late (${where}). Which departments and people are worst?`;
    case "quarterDays":
      return `${value} days of ${who} lost a quarter shift for arriving after the Late window (${where}). Who, and is it growing?`;
    case "penaltyEarlyOuts":
      return `There were ${value} Penalty Early Outs among ${who} (${where}). Who leaves early, and what does it cost?`;
    case "shiftsEarned":
      return `${who} earned ${value} shifts (${where}). How does that compare with the previous period?`;
    case "halfDays":
      return `How many half days did ${who} have (${where}), and why?`;
    default:
      return `Explain ${tile.label.toLowerCase()} for ${who} (${where}).`;
  }
}
