// The Report Log insights' logic, with no React in it: which way a change is good news, how the gap calendar is laid out,
// how a row's marks become a bar, what a click on a ranking row does, the questions the "Ask AI" buttons carry. Every rule
// has a test.

import type { BarItem } from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import type { KpiDelta } from "@/components/md/kit/dto";
import type { StatTone } from "@/components/md/kit/StatCard";
import { changeTone, clockText, dayLong, dayShort, num, pct, signed } from "@/lib/md/format";
import { PRESET_LABEL, describeScope, type PeriodChoice, type ScopeChoice } from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import type {
  Change,
  ExportReport,
  ExportUser,
  GapCalendarDay,
  GroupBy,
  LatestExport,
  RlGaps,
  RlGroupRow,
  RlSummary,
  RlTrend,
} from "./types";

export const GROUP_TABS: { value: GroupBy; label: string; header: string }[] = [
  { value: "department", label: "Departments", header: "Department" },
  { value: "unit", label: "Units", header: "Unit" },
  { value: "type", label: "Staff vs production", header: "Group" },
];

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const plural = (n: number | null | undefined, one: string, many: string) => (n === 1 ? one : many);

// ─── change chips ───────────────────────────────────────────────────────────────────────────────────────────────

export type ChipKind = "pts" | "pct";
/** Which direction of change is good news: "none" for a figure with no good or bad side (how many exports). */
export type Better = "up" | "down" | "none";

/** "+8.3 pts" / "-4.2%" next to a figure, coloured by whether the change is good news. A change that rounds to nothing is
 *  shown flat and neutral rather than as a tiny red or green arrow. */
export function deltaChip(change: Change | undefined, kind: ChipKind, better: Better): KpiDelta | null {
  if (!change || change.abs == null || Number.isNaN(change.abs)) return null;
  const shown = kind === "pct" && change.pct != null ? change.pct : change.abs;
  if (Math.abs(shown) < 0.05) {
    return { text: kind === "pts" ? "0 pts" : "0%", tone: "neutral", direction: "flat" };
  }
  let text: string;
  if (kind === "pts") text = `${signed(change.abs, 1)} pts`;
  else text = change.pct != null ? `${signed(change.pct, 1)}%` : signed(change.abs, 0);
  return {
    text,
    tone: better === "none" ? "neutral" : changeTone(change.abs, better === "up"),
    direction: change.abs > 0 ? "up" : "down",
  };
}

// ─── the figures strip ──────────────────────────────────────────────────────────────────────────────────────────

export type TileIcon = "absences" | "followed" | "notInformed" | "unmarked" | "gaps" | "exports" | "people" | "latest";

export type KpiTile = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  icon: TileIcon;
  tone: StatTone;
  delta: KpiDelta | null;
  spark?: (number | null)[];
  provenanceIds: string[];
};

/** "13 Sep, 11:50 pm": when the latest export was made. */
export function exportWhen(at: string | null | undefined): string {
  if (!at) return "—";
  return `${dayShort(at.slice(0, 10))}, ${clockText(at)}`;
}

/** The eight headline tiles. `trend` supplies the export sparkline. */
export function kpiTiles(summary: RlSummary, trend?: RlTrend): KpiTile[] {
  const m = summary.metrics;
  const absences = m.absences.value;
  const measured = summary.measured;
  const unmarkedPct = absences ? ((m.unmarked.value ?? 0) / absences) * 100 : null;
  const latest = summary.latestExport;
  const days = trend?.points.map((p) => p.exports);

  return [
    {
      id: "absences",
      label: "Absences to follow up",
      value: absences == null ? "—" : num(absences),
      sub: measured
        ? `On scheduled days · ${num(measured.days)} complete ${plural(measured.days, "day", "days")}`
        : "No completed day in this period yet",
      icon: "absences",
      tone: "blue",
      delta: deltaChip(m.absences.change, "pct", "down"),
      provenanceIds: ["reportlog-absences"],
    },
    {
      id: "followed",
      label: "Followed up",
      value: pct(m.reviewedPct.value, 1),
      sub:
        absences != null && absences > 0
          ? `${num((m.informed.value ?? 0) + (m.notInformed.value ?? 0))} of ${num(absences)} absences marked`
          : "No absences",
      icon: "followed",
      tone: "green",
      delta: deltaChip(m.reviewedPct.change, "pts", "up"),
      provenanceIds: ["reportlog-followup"],
    },
    {
      id: "notInformed",
      label: "Not informed",
      value: m.notInformed.value == null ? "—" : num(m.notInformed.value),
      sub:
        m.notInformedPct.value == null ? "No absences" : `${pct(m.notInformedPct.value, 0)} of absences · unauthorised`,
      icon: "notInformed",
      tone: "red",
      delta: deltaChip(m.notInformed.change, "pct", "down"),
      provenanceIds: ["reportlog-followup"],
    },
    {
      id: "unmarked",
      label: "Not yet marked",
      value: m.unmarked.value == null ? "—" : num(m.unmarked.value),
      sub: unmarkedPct == null ? "No absences" : `${pct(unmarkedPct, 0)} of absences have no call`,
      icon: "unmarked",
      tone: "amber",
      delta: deltaChip(m.unmarked.change, "pct", "down"),
      provenanceIds: ["reportlog-followup"],
    },
    {
      id: "gaps",
      label: "Days nobody made the call",
      value: measured ? num(summary.gapDays) : "—",
      sub: `${summary.gapMinAbsences}+ absences, none marked`,
      icon: "gaps",
      tone: "purple",
      delta: null,
      provenanceIds: ["reportlog-gaps"],
    },
    {
      id: "exports",
      label: "Attendance report exports",
      value: num(m.exports.value),
      sub: `${num(m.exportDays.value)} of ${num(summary.period?.days)} days · on record`,
      icon: "exports",
      tone: "indigo",
      delta: deltaChip(m.exports.change, "pct", "none"),
      spark: days,
      provenanceIds: ["reportlog-exports"],
    },
    {
      id: "people",
      label: "People who export them",
      value: num(m.exporters.value),
      sub: `${num(m.exportsAll.value)} exports of any report`,
      icon: "people",
      tone: "teal",
      delta: deltaChip(m.exporters.change, "pct", "none"),
      provenanceIds: ["reportlog-exports"],
    },
    {
      id: "latest",
      label: "Latest export",
      value: latest ? latest.userName : "—",
      sub: latest ? `${latest.report} · ${exportWhen(latest.at)}` : "None on record in this period",
      icon: "latest",
      tone: "slate",
      delta: null,
      provenanceIds: ["reportlog-exports"],
    },
  ];
}

/** What the change chips compare with: "31 Aug to 06 Sep 2026". */
export function previousText(summary: Pick<RlSummary, "previousPeriod">): string {
  return `${dayShort(summary.previousPeriod.start)} to ${dayLong(summary.previousPeriod.end)}`;
}

export type CompareRow = { id: string; label: string; current: string; previous: string; delta: KpiDelta | null };

/** "This period against the previous" as rows: the same figures as the strip, side by side. */
export function compareRows(summary: RlSummary): CompareRow[] {
  const m = summary.metrics;
  const count = (
    key: "absences" | "informed" | "notInformed" | "unmarked" | "exports" | "exporters" | "exportDays",
  ) => ({
    current: num(m[key].value),
    previous: num(m[key].previous),
  });
  return [
    {
      id: "absences",
      label: "Absences on scheduled days",
      ...count("absences"),
      delta: deltaChip(m.absences.change, "pct", "down"),
    },
    {
      id: "informed",
      label: "Marked Informed",
      ...count("informed"),
      delta: deltaChip(m.informed.change, "pct", "none"),
    },
    {
      id: "notInformed",
      label: "Marked Not informed",
      ...count("notInformed"),
      delta: deltaChip(m.notInformed.change, "pct", "down"),
    },
    {
      id: "unmarked",
      label: "Not yet marked",
      ...count("unmarked"),
      delta: deltaChip(m.unmarked.change, "pct", "down"),
    },
    {
      id: "followed",
      label: "Followed up",
      current: pct(m.reviewedPct.value, 1),
      previous: pct(m.reviewedPct.previous, 1),
      delta: deltaChip(m.reviewedPct.change, "pts", "up"),
    },
    {
      id: "exports",
      label: "Attendance report exports",
      ...count("exports"),
      delta: deltaChip(m.exports.change, "pct", "none"),
    },
    {
      id: "exporters",
      label: "People who export",
      ...count("exporters"),
      delta: deltaChip(m.exporters.change, "pct", "none"),
    },
    {
      id: "exportDays",
      label: "Days with an export",
      ...count("exportDays"),
      delta: deltaChip(m.exportDays.change, "pct", "none"),
    },
  ];
}

// ─── the trend ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendRow = {
  date: string;
  informed: number | null;
  notInformed: number | null;
  unmarked: number | null;
  reviewedPct: number | null;
  exports: number;
};

/** One row per day (or week) for the charts. */
export function trendRows(trend: RlTrend): TrendRow[] {
  return trend.points.map((p) => ({
    date: p.date,
    informed: p.informed,
    notInformed: p.notInformed,
    unmarked: p.unmarked,
    reviewedPct: p.reviewedPct,
    exports: p.exports,
  }));
}

/** False when no day of the period has an absence: there is nothing to follow up, only to explain. */
export function hasAbsences(trend: Pick<RlTrend, "points">): boolean {
  return trend.points.some((p) => (p.absences ?? 0) > 0);
}

export function hasExports(trend: Pick<RlTrend, "points">): boolean {
  return trend.points.some((p) => p.exports > 0);
}

/** The one sentence under the follow-up chart: how much of the period's absences were marked, and the worst day. */
export function trendCaption(trend: Pick<RlTrend, "points">): string | null {
  const days = trend.points.filter((p) => (p.absences ?? 0) > 0);
  if (days.length === 0) return null;
  const absences = days.reduce((n, p) => n + (p.absences ?? 0), 0);
  const unmarked = days.reduce((n, p) => n + (p.unmarked ?? 0), 0);
  const worst = [...days].sort((a, b) => (b.unmarked ?? 0) - (a.unmarked ?? 0) || (a.date < b.date ? -1 : 1))[0];
  const worstText =
    (worst.unmarked ?? 0) > 0
      ? ` Most unmarked on ${dayLong(worst.date)} (${num(worst.unmarked)}).`
      : " Every absence has a call.";
  return `${num(unmarked)} of ${num(absences)} absences have no call.${worstText}`;
}

// ─── the gap calendar ───────────────────────────────────────────────────────────────────────────────────────────

/** The calendar as the Heatmap takes it: one row per week (labelled by its Monday), Monday to Sunday across. A cell is the
 *  number of absences nobody marked that day; a day with no absence (or that the figures do not cover yet) is null and
 *  shows as a dot, so "everything marked" (0) and "nothing to mark" (a dot) are told apart. */
export function calendarMatrix(days: Pick<GapCalendarDay, "date" | "absences" | "unmarked">[]) {
  const weeks = new Map<string, (number | null)[]>();
  for (const day of days) {
    const [y, m, d] = day.date.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    const weekday = (date.getDay() + 6) % 7; // Monday = 0
    const monday = new Date(y, m - 1, d - weekday);
    const key = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    if (!weeks.has(key)) weeks.set(key, Array(7).fill(null));
    (weeks.get(key) as (number | null)[])[weekday] = day.absences ? (day.unmarked ?? 0) : null;
  }
  const keys = [...weeks.keys()].sort();
  return {
    rows: keys.map((k) => `Week of ${dayShort(k)}`),
    cols: WEEKDAYS,
    values: keys.map((k) => weeks.get(k) as (number | null)[]),
  };
}

/** "1 day had 2+ absences and nobody marked any" or the good news: what the calendar says in words. */
export function gapText(
  gaps: Pick<RlGaps, "gapDayCount" | "minAbsences" | "daysWithAbsences" | "daysFullyMarked" | "gapDays">,
): string {
  if (gaps.daysWithAbsences === 0) return "No day in this period had an absence to follow up.";
  const marked = `${num(gaps.daysFullyMarked)} of ${num(gaps.daysWithAbsences)} days with absences have every absence marked.`;
  if (gaps.gapDayCount === 0) return `No day had ${gaps.minAbsences}+ absences with nothing marked. ${marked}`;
  const latest = gaps.gapDays[gaps.gapDays.length - 1];
  return `${num(gaps.gapDayCount)} ${plural(gaps.gapDayCount, "day", "days")} had ${gaps.minAbsences}+ absences and nobody marked any (the latest: ${dayLong(latest.date)}). ${marked}`;
}

// ─── follow-up by group ─────────────────────────────────────────────────────────────────────────────────────────

/** How a row's absences split by mark, as widths for the in-cell bar (they add up to 100). */
export function markShares(row: Pick<RlGroupRow, "absences" | "informed" | "notInformed" | "unmarked">) {
  if (row.absences <= 0) return { informed: 0, notInformed: 0, unmarked: 0 };
  return {
    informed: (row.informed / row.absences) * 100,
    notInformed: (row.notInformed / row.absences) * 100,
    unmarked: (row.unmarked / row.absences) * 100,
  };
}

/** What clicking a ranking row does: narrow the whole tab to that department, unit or staff/production group. null when
 *  there is nothing to narrow to (no group, or already focused). */
export function focusScope(
  scope: ScopeChoice,
  by: GroupBy,
  row: Pick<RlGroupRow, "key" | "label">,
  org?: MdOrg,
): ScopeChoice | null {
  if (by === "department") return scope.department === row.label ? null : { ...scope, department: row.label };
  if (by === "type") {
    const type = row.label.toLowerCase();
    if (type !== "staff" && type !== "production") return null;
    return scope.type === type ? null : { ...scope, type };
  }
  const unit = org?.branches.find((b) => b.name === row.label);
  if (!org || !unit || scope.branch === String(unit.id)) return null;
  // a department the new unit does not have is dropped, as the unit selector itself does
  const keeps = !scope.department || org.departments.some((d) => d.name === scope.department && d.branchId === unit.id);
  return { ...scope, branch: String(unit.id), department: keeps ? scope.department : "" };
}

// ─── who exports reports ────────────────────────────────────────────────────────────────────────────────────────

/** People who export, as ranked bars: exports, the days they exported on and when they last did. */
export function userBars(users: ExportUser[]): BarItem[] {
  return users.map((u) => ({
    key: `user-${u.userName}`,
    label: u.userName,
    value: u.exports,
    display: `${num(u.exports)}${u.sharePct != null ? ` · ${pct(u.sharePct, 0)}` : ""}`,
    sub: `${num(u.days)} ${plural(u.days, "day", "days")} · last ${exportWhen(u.lastAt)}`,
    color: CHART.brand,
  }));
}

/** The reports that were exported, as ranked bars. */
export function reportBars(reports: ExportReport[]): BarItem[] {
  return reports.map((r) => ({
    key: `report-${r.report}`,
    label: r.report,
    value: r.exports,
    display: `${num(r.exports)}${r.sharePct != null ? ` · ${pct(r.sharePct, 0)}` : ""}`,
    color: CHART.teal,
  }));
}

export function latestLine(item: LatestExport): string {
  return `${exportWhen(item.at)} · ${item.userName} · ${item.report}`;
}

// ─── the assistant ──────────────────────────────────────────────────────────────────────────────────────────────

/** The period in words, for the questions and the assistant until the server's own label arrives. */
export function periodText(choice: PeriodChoice): string {
  return choice.preset === "custom" ? `${dayLong(choice.from)} to ${dayLong(choice.to)}` : PRESET_LABEL[choice.preset];
}

/** The selection in words: the server's description once it has answered, otherwise worked out from the filters. */
export function scopeText(scope: ScopeChoice, serverDescription?: string): string {
  return serverDescription ?? describeScope(scope, undefined, scope.department || undefined);
}

/** The headline numbers on screen, in the words the assistant is given as page context. */
export function assistantSummary(summary: RlSummary | undefined): Record<string, string | number | null> | undefined {
  if (!summary) return undefined;
  const m = summary.metrics;
  return {
    "Absences on scheduled days": m.absences.value,
    "Marked Informed": m.informed.value,
    "Marked Not informed": m.notInformed.value,
    "Not yet marked": m.unmarked.value,
    "Followed up": m.reviewedPct.value == null ? null : pct(m.reviewedPct.value, 1),
    "Days nobody made the call": summary.measured ? summary.gapDays : null,
    "Attendance report exports on record": m.exports.value,
    "People who exported": m.exporters.value,
  };
}

/** The ready-made questions on the page's "Ask AI" buttons. `scopeText` is null when the page shows everyone. */
export function askQuestions(periodLabel: string, scopeText: string | null) {
  const when = scopeText ? ` (${periodLabel}, ${scopeText})` : ` (${periodLabel})`;
  return {
    page: `Summarise the Report Log${when}: are absences being followed up, and who produces the attendance reports?`,
    briefing: `Explain the Report Log summary${when} in more detail and tell me what to ask HR.`,
    attention: `What needs my attention on absence follow-up and attendance reports${when}, and why?`,
    trend: `Is absence follow-up getting better or worse${when}? Which days were not marked?`,
    gaps: `On which days did nobody make the Informed / Not informed call${when}, and what were the absences?`,
    groups: `Which departments, units or staff groups do not mark absences${when}, and where are the unauthorised absences?`,
    exports: `Who exports attendance reports and how often${when}? Which reports?`,
    compare: `How does absence follow-up compare with the previous period${when}? Which figures moved most?`,
    limits: "What can and what can't the Report Log tell me about attendance reports being produced or sent?",
  };
}
