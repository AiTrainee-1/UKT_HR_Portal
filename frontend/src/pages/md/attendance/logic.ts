// Pure logic of the Attendance Analytics page: how a figure is written, how the responses become chart and table input,
// and the questions "Ask AI" opens with. No React in here, so every rule has a plain unit test (logic.test.ts).

import { kpiDelta, type KpiDelta } from "@/components/md/kit/dto";
import type { BarItem } from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import type { AssistantPageContext } from "@/lib/md/assistant-store";
import { changeTone, dayShort, minutesText, num, pct, signed, type Tone } from "@/lib/md/format";
import type { MdKpiFormat } from "@/lib/md/types";
import type { ScopeChoice } from "@/lib/md/period";
import type {
  AttendanceExceptions,
  AttendanceHeatmap,
  AttendanceSummary,
  AttendanceWeekday,
  Coverage,
  ExceptionKey,
  ExceptionsThresholds,
  LiveToday,
  Metric,
  MetricKey,
  TrendPoint,
  WeekdayRow,
} from "./types";

// ─── how a figure is written ─────────────────────────────────────────────────────────────────────────────────────

const PCT_KEYS: MetricKey[] = ["attendancePct", "absenteeismPct", "latePct", "coveragePct"];

/** The display format of a figure, in the vocabulary of the kit's KPI cards. */
export function formatOf(key: MetricKey): MdKpiFormat {
  if (PCT_KEYS.includes(key)) return "pct";
  if (key === "avgLateMinutes") return "minutes";
  return "number";
}

/** "91.8%", "35m", "6.5 h", "1,204" or "—" when there is no figure. */
export function metricText(key: MetricKey, metric?: Metric | null): string {
  const value = metric?.value;
  if (value == null) return "—";
  switch (formatOf(key)) {
    case "pct":
      return pct(value);
    case "minutes":
      return minutesText(value);
    default:
      return key === "overtimeHours" ? `${num(value, 1)} h` : num(value, Number.isInteger(value) ? 0 : 1);
  }
}

/** The change chip against the previous period (percentage points for a percentage), coloured by which way is good. */
export function metricDelta(key: MetricKey, metric?: Metric | null): KpiDelta | null {
  if (!metric?.delta) return null;
  return kpiDelta({
    format: formatOf(key),
    delta: { abs: metric.delta.abs, pct: metric.delta.pct, good: metric.good },
  });
}

/** "was 89.6% before": the previous figure in words, for the line under a card's number. */
export function wasText(key: MetricKey, metric?: Metric | null): string | null {
  if (metric?.previous == null) return null;
  return `was ${metricText(key, { ...metric, value: metric.previous })} before`;
}

/** A change in percentage points for a table cell: lower absenteeism is good, higher attendance is good. */
export function pointsDelta(
  value: number | null | undefined,
  higherIsBetter: boolean,
): { text: string; tone: Tone; direction: "up" | "down" | "flat" } | null {
  if (value == null) return null;
  return {
    text: `${signed(value, 1)} pts`,
    tone: changeTone(value, higherIsBetter),
    direction: value > 0 ? "up" : value < 0 ? "down" : "flat",
  };
}

/** "Last 7 days" style label of the period the figures cover, from the server's own words. */
export function measuredText(summary?: AttendanceSummary): string {
  const m = summary?.measured;
  if (!m) return summary?.period?.label ?? "";
  return m.start === m.end ? dayShort(m.start) : `${dayShort(m.start)} – ${dayShort(m.end)}`;
}

export function previousText(summary?: AttendanceSummary): string | null {
  const p = summary?.previous;
  if (!p) return null;
  return p.start === p.end ? dayShort(p.start) : `${dayShort(p.start)} – ${dayShort(p.end)}`;
}

// ─── today, live ─────────────────────────────────────────────────────────────────────────────────────────────────

/** "228 of 262 in so far (87%) · 14 on leave · 20 not in yet". */
export function liveSentence(live: LiveToday): string {
  if (!live.isWorkingDay) return "Nobody is scheduled to work today (weekly off or holiday).";
  const parts = [`${num(live.present)} of ${num(live.expected)} in so far (${pct(live.attendancePct, 0)})`];
  if (live.leave) parts.push(`${num(live.leave)} on leave`);
  parts.push(`${num(live.absent)} not in yet`);
  return parts.join(" · ");
}

/** The unit or department with the most people not in yet, for the line under the live count. */
export function mostMissing(groups: { name: string; absent: number }[]): { name: string; absent: number } | null {
  const worst = [...groups].sort((a, b) => b.absent - a.absent || a.name.localeCompare(b.name))[0];
  return worst && worst.absent > 0 ? worst : null;
}

// ─── data coverage ───────────────────────────────────────────────────────────────────────────────────────────────

const COVERAGE_NOTE = /^Attendance day records exist for \d/;

/** The server's notes without its partial-coverage sentence: the Data coverage note at the foot of the page says it. */
export const notesWithoutCoverage = (notes: string[]): string[] => notes.filter((n) => !COVERAGE_NOTE.test(n));

export function coverageText(cov: Coverage | null | undefined): string {
  if (!cov || cov.expectedDays === 0) return "No scheduled days to cover in this period.";
  return `${pct(cov.coveragePct)} of scheduled days have an attendance record (${num(cov.recordedDays)} of ${num(cov.expectedDays)} employee-days).`;
}

/** "12 Sep (31%), 13 Sep (40%)": the dates HR should open in Attendance first. */
export function worstDaysText(cov: Coverage | null | undefined): string {
  return (cov?.worstDays ?? []).map((d) => `${dayShort(d.date)} (${pct(d.coveragePct, 0)})`).join(", ");
}

// ─── trend ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendRow = Record<string, string | number | null>;

export function trendRows(points: TrendPoint[]): TrendRow[] {
  return points.map((p) => ({
    date: p.date,
    attendancePct: p.attendancePct,
    absentPct: p.absentPct,
    latePct: p.latePct,
    present: p.present,
    absent: p.absent,
    leave: p.leave,
    late: p.late,
  }));
}

/** The y range of the attendance line: from just under its lowest point to 100, in steps of 5, so a dip is visible. */
export function attendanceDomain(points: TrendPoint[]): [number, number] {
  const values = points.map((p) => p.attendancePct).filter((v): v is number => v != null);
  if (values.length === 0) return [0, 100];
  const lowest = Math.min(...values);
  return [Math.max(0, Math.floor((lowest - 2) / 5) * 5), 100];
}

/** "Mon 07 Sep" style tick for a day, or "Week of 07 Sep" when each point is a week. */
export function trendTick(granularity: "day" | "week"): (value: string) => string {
  return granularity === "week" ? (v) => `Wk ${dayShort(v)}` : (v) => dayShort(v);
}

// ─── weekday pattern ─────────────────────────────────────────────────────────────────────────────────────────────

/** Absence % per weekday as ranked bars: the worst day is red, the others blue; attendance and late % under each. */
export function weekdayBars(weekdays: WeekdayRow[]): BarItem[] {
  const worst = weekdays.reduce<WeekdayRow | null>(
    (w, x) => (x.absentPct != null && (w == null || x.absentPct > (w.absentPct ?? -1)) ? x : w),
    null,
  );
  return weekdays.map((w) => ({
    key: w.name,
    label: w.name,
    value: w.absentPct ?? 0,
    display: pct(w.absentPct),
    sub: `Attendance ${pct(w.attendancePct)} · late ${pct(w.latePct)} · ${num(w.absent)} absent in ${num(w.scheduledDays)} scheduled days`,
    color: worst && w.name === worst.name && (w.absentPct ?? 0) > 0 ? CHART.bad : CHART.brand,
  }));
}

/** One sentence about Mondays, or null when there is nothing to say. */
export function mondayText(effect: AttendanceWeekday["mondayEffect"]): string | null {
  if (!effect) return null;
  if (effect.gapPts >= 1) {
    return `Mondays run ${pct(effect.mondayAbsentPct)} absent against ${pct(effect.otherDaysAbsentPct)} on other days.`;
  }
  return `Mondays are no worse than other days (${pct(effect.mondayAbsentPct)} against ${pct(effect.otherDaysAbsentPct)}).`;
}

export type GridInput = { rows: string[]; cols: string[]; values: (number | null)[][] };

/** The weekday x week grid: a column per week, labelled with the Monday it starts on. */
export function weekGridInput(grid: AttendanceWeekday["heatmap"]): GridInput {
  return { rows: grid.weekdays, cols: grid.weeks.map((w) => dayShort(w)), values: grid.values };
}

/** The department x day grid: a column per working day, labelled with the day of the month. */
export function dayGridInput(h: AttendanceHeatmap): GridInput {
  return { rows: h.departments, cols: h.days.map((d) => String(Number(d.slice(8, 10)))), values: h.values };
}

export function gridRange(h: AttendanceHeatmap): string {
  if (h.days.length === 0) return "";
  return `${dayShort(h.days[0])} – ${dayShort(h.days[h.days.length - 1])}`;
}

// ─── exceptions ──────────────────────────────────────────────────────────────────────────────────────────────────

export const EXCEPTION_TABS: { key: ExceptionKey; label: string }[] = [
  { key: "chronicAbsentees", label: "Chronic absentees" },
  { key: "habitualLate", label: "Late-comers" },
  { key: "longAbsences", label: "Long absences" },
  { key: "missingPunches", label: "Missing punches" },
  { key: "afterOffAbsences", label: "After days off" },
];

export function exceptionCounts(ex?: AttendanceExceptions): Record<ExceptionKey, number> {
  return {
    chronicAbsentees: ex?.chronicAbsentees.total ?? 0,
    habitualLate: ex?.habitualLate.total ?? 0,
    longAbsences: ex?.longAbsences.total ?? 0,
    missingPunches: ex?.missingPunches.total ?? 0,
    afterOffAbsences: ex?.afterOffAbsences.total ?? 0,
  };
}

/** The first tab with something in it, so the card opens on what matters. */
export function firstBusyTab(counts: Record<ExceptionKey, number>): ExceptionKey {
  return EXCEPTION_TABS.find((t) => counts[t.key] > 0)?.key ?? "chronicAbsentees";
}

/** The rule behind a tab in plain words (the thresholds the server used, so the screen and the rule cannot differ). */
export function ruleText(key: ExceptionKey, t?: ExceptionsThresholds): string {
  if (!t) return "";
  switch (key) {
    case "chronicAbsentees":
      return `${t.chronicAbsent.minDays} or more unplanned absence days, and at least ${t.chronicAbsent.minPctOfScheduledDays}% of the person's scheduled days.`;
    case "habitualLate":
      return `Late on ${t.habitualLate.minDays} or more days, and on at least ${t.habitualLate.minPctOfWorkedDays}% of the days they worked.`;
    case "longAbsences":
      return `${t.longAbsence.minDays} or more days in a row absent with no explanation (a weekly off or holiday in between does not break the run).`;
    case "missingPunches":
      return `${t.missingPunches.minRequests} or more missing-punch requests for days in the period.`;
    case "afterOffAbsences":
      return `${t.afterOff.minAbsences} or more absences, at least ${t.afterOff.minSharePct}% of them on the first working day after a weekly off or holiday.`;
  }
}

/** "04 Sep, 07 Sep +3 more": dates as evidence, short. */
export function datesText(dates: string[], shown = 3): string {
  const head = dates.slice(0, shown).map(dayShort).join(", ");
  return dates.length > shown ? `${head} +${dates.length - shown} more` : head;
}

// ─── approvals waiting ───────────────────────────────────────────────────────────────────────────────────────────

export function waitText(days: number | null | undefined): string {
  if (days == null) return "—";
  if (days === 0) return "today";
  return days === 1 ? "1 day" : `${num(days)} days`;
}

/** A request waiting more than a week is a process problem; more than two weeks is a worse one. */
export function waitTone(days: number | null | undefined): "slate" | "amber" | "red" {
  if (days == null || days <= 7) return "slate";
  return days > 14 ? "red" : "amber";
}

// ─── narrowing the scope by clicking ─────────────────────────────────────────────────────────────────────────────

export const withDepartment = (scope: ScopeChoice, name: string): ScopeChoice => ({ ...scope, department: name });
export const withUnit = (scope: ScopeChoice, id: number): ScopeChoice => ({
  ...scope,
  branch: String(id),
  department: "",
});
export const withType = (scope: ScopeChoice, type: string): ScopeChoice =>
  type === "staff" || type === "production" ? { ...scope, type } : scope;

// ─── questions for the assistant ─────────────────────────────────────────────────────────────────────────────────

export type AskContext = { period: string; scope: string; summary?: AttendanceSummary };

const where = (c: AskContext) => `${c.period}, ${c.scope}`;

export const ask = {
  page: (c: AskContext) =>
    `Give me a short briefing on attendance (${where(c)}): what is good, what is wrong, what to do first.`,
  attendance: (c: AskContext) => {
    const m = c.summary?.metrics.attendancePct;
    const was = wasText("attendancePct", m);
    return m?.value == null
      ? `What does attendance look like (${where(c)})?`
      : `Attendance is ${metricText("attendancePct", m)}${was ? ` (${was})` : ""} (${where(c)}). What is driving it, and which departments pull it down?`;
  },
  absenteeism: (c: AskContext) => {
    const m = c.summary?.metrics.absenteeismPct;
    return m?.value == null
      ? `How much unplanned absence is there (${where(c)})?`
      : `Absenteeism is ${metricText("absenteeismPct", m)} (${where(c)}). Is that high for us, and who or where is it coming from?`;
  },
  late: (c: AskContext) => {
    const m = c.summary?.metrics.latePct;
    const minutes = c.summary?.metrics.avgLateMinutes;
    return m?.value == null
      ? `How many people arrive late (${where(c)})?`
      : `${metricText("latePct", m)} of days worked start late, ${minutes?.value != null ? `by ${minutesText(minutes.value)} on average ` : ""}(${where(c)}). Which departments and shifts are worst?`;
  },
  overtime: (c: AskContext) => {
    const m = c.summary?.metrics.overtimeHours;
    return m?.value == null
      ? `How much overtime is there (${where(c)}) and is it being tracked?`
      : `There were ${metricText("overtimeHours", m)} of overtime (${where(c)}). Which departments and people account for it, and is it growing?`;
  },
  halfDays: (c: AskContext) =>
    `How many half days were there (${where(c)}), what causes them (single punch, late arrival, early exit) and which departments have most?`,
  missingPunches: (c: AskContext) =>
    `Which employees and departments file the most missing-punch requests (${where(c)}), and how many are still waiting for a decision?`,
  today: (c: AskContext) => `Who is not in yet today (${c.scope}) and which units or departments are short?`,
  trend: (c: AskContext) => {
    const m = c.summary?.metrics.attendancePct;
    return `How has attendance moved (${where(c)})${m?.value != null ? `, now ${metricText("attendancePct", m)}` : ""}? When did it dip and why?`;
  },
  weekday: (c: AskContext) =>
    `Is attendance worse on certain weekdays, especially Mondays or after holidays (${where(c)})?`,
  departments: (c: AskContext) =>
    `Rank the departments by attendance (${where(c)}) and tell me which need attention and why.`,
  department: (c: AskContext, name: string) =>
    `Why is attendance low in ${name} (${where(c)}) compared with the rest of the company? Who is absent most?`,
  heatmap: (c: AskContext) => `Which departments had the worst days (${where(c)}), and what happened on those days?`,
  exceptions: (c: AskContext, key: ExceptionKey) => {
    switch (key) {
      case "chronicAbsentees":
        return `Who are the chronic absentees (${where(c)}), which departments are they in, and what should I do?`;
      case "habitualLate":
        return `Who are the habitual late-comers (${where(c)}) and how late are they on average?`;
      case "longAbsences":
        return `Which employees have been absent several days in a row without explanation (${where(c)}), and are any still absent?`;
      case "missingPunches":
        return `Who files the most missing-punch requests (${where(c)}) and is one device or department behind it?`;
      case "afterOffAbsences":
        return `Which employees are mostly absent right after a weekly off or a holiday (${where(c)})?`;
    }
  },
  overtimeByDepartment: (c: AskContext) =>
    `Which departments and people have the most overtime (${where(c)}), and how does it compare with the previous period?`,
  leave: (c: AskContext) =>
    `How much leave was taken (${where(c)}), by type, and what approvals are waiting the longest?`,
  coverage: (c: AskContext) =>
    `Which dates (${where(c)}) have no attendance records, and how does that change the attendance figures?`,
  /** `date` is an ISO date, or a word the server understands ("yesterday", "today"). */
  day: (c: AskContext, date: string) =>
    `How many people were absent, late or on leave ${/^\d{4}-\d{2}-\d{2}/.test(date) ? `on ${dayShort(date)}` : date} (${c.scope}), by unit and department?`,
};

/** What the assistant is told the page shows: the filters and the headline numbers. */
export function buildAssistantContext(
  summary: AttendanceSummary | undefined,
  periodLabel: string,
  scopeText: string,
): AssistantPageContext {
  const m = summary?.metrics ?? {};
  const live = summary?.live;
  return {
    page: "attendance",
    title: "Attendance Analytics",
    filters: {
      Period: periodLabel,
      Scope: scopeText,
      "Days measured": summary?.measured ? `${summary.measured.days}` : null,
    },
    summary: {
      Attendance: m.attendancePct?.value != null ? metricText("attendancePct", m.attendancePct) : null,
      Absenteeism: m.absenteeismPct?.value != null ? metricText("absenteeismPct", m.absenteeismPct) : null,
      "Late arrivals": m.latePct?.value != null ? metricText("latePct", m.latePct) : null,
      "Average minutes late": m.avgLateMinutes?.value != null ? metricText("avgLateMinutes", m.avgLateMinutes) : null,
      "Overtime hours": m.overtimeHours?.value != null ? metricText("overtimeHours", m.overtimeHours) : null,
      "Half days": m.halfDays?.value ?? null,
      "Missing punches waiting": m.missingPunches?.value ?? null,
      "Data coverage": summary?.coverage?.coveragePct != null ? pct(summary.coverage.coveragePct) : null,
      "In so far today": live?.isWorkingDay ? `${live.present} of ${live.expected}` : null,
    },
  };
}
