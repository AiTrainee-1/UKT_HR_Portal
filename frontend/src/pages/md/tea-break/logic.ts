// The Tea Break page's logic, with no React in it: which way a change is good news, what a click on a ranking row does,
// which half-hour columns are worth drawing, the questions the "Ask AI" buttons carry. Every rule has a test.

import type { KpiDelta } from "@/components/md/kit/dto";
import type { StatTone } from "@/components/md/kit/StatCard";
import { changeTone, dayLong, dayShort, minutesText, num, pct, signed } from "@/lib/md/format";
import { PRESET_LABEL, describeScope, type PeriodChoice, type ScopeChoice } from "@/lib/md/period";
import type { MdOrg } from "@/lib/md/types";
import type {
  Change,
  GroupBy,
  TeaGroupRow,
  TeaHeatmap,
  TeaOffender,
  TeaOffenders,
  TeaRule,
  TeaSummary,
  TeaTrend,
  Verdict,
} from "./types";

/** The key the server gives the people who have no department / unit / shift: not a group the MD can focus on. */
export const NONE_KEY = "__none__";

export const GROUP_TABS: { value: GroupBy; label: string; header: string }[] = [
  { value: "department", label: "Departments", header: "Department" },
  { value: "unit", label: "Units", header: "Unit" },
  { value: "type", label: "Staff vs production", header: "Group" },
];

// ─── change chips ───────────────────────────────────────────────────────────────────────────────────────────────

export type ChipKind = "pts" | "pct" | "min";
/** Which direction of change is good news: "none" for a figure with no good or bad side (how many breaks). */
export type Better = "up" | "down" | "none";

/** "+8.3 pts" / "-4.2%" / "+1.4 min" next to a figure, coloured by whether the change is good news. A change that
 *  rounds to nothing is shown flat and neutral rather than as a tiny red or green arrow. */
export function deltaChip(change: Change | undefined, kind: ChipKind, better: Better): KpiDelta | null {
  if (!change || change.abs == null || Number.isNaN(change.abs)) return null;
  const shown = kind === "pct" && change.pct != null ? change.pct : change.abs;
  if (Math.abs(shown) < 0.05) {
    return { text: kind === "pts" ? "0 pts" : kind === "min" ? "0 min" : "0%", tone: "neutral", direction: "flat" };
  }
  let text: string;
  if (kind === "pts") text = `${signed(change.abs, 1)} pts`;
  else if (kind === "min") text = `${signed(change.abs, 1)} min`;
  else text = change.pct != null ? `${signed(change.pct, 1)}%` : signed(change.abs, 0);
  return {
    text,
    tone: better === "none" ? "neutral" : changeTone(change.abs, better === "up"),
    direction: change.abs > 0 ? "up" : "down",
  };
}

// ─── the figures strip ──────────────────────────────────────────────────────────────────────────────────────────

export type TileIcon = "breaks" | "average" | "overrun" | "lost" | "within" | "repeat";

export type KpiTile = {
  id: string;
  label: string;
  value: string;
  sub?: string;
  icon: TileIcon;
  tone: StatTone;
  delta: KpiDelta | null;
  spark?: (number | null)[];
  /** Which response explains the figure: the summary for most, the offenders list for the repeat count. */
  source: "summary" | "offenders";
  provenanceIds: string[];
};

const plural = (n: number | null | undefined, one: string, many: string) => (n === 1 ? one : many);

/** The six headline tiles. `trend` supplies the sparklines, `offenders` the repeat-overrunner count. */
export function kpiTiles(summary: TeaSummary, trend?: TeaTrend, offenders?: TeaOffenders): KpiTile[] {
  const m = summary.metrics;
  const allowed = summary.allowedMinutes;
  const measured = m.measured.value ?? 0;
  const overruns = m.overruns.value ?? 0;
  const spark = (key: "breaks" | "overrunPct" | "minutesLost") => trend?.points.map((p) => p[key]);

  return [
    {
      id: "breaks",
      label: "Breaks taken",
      value: num(m.breaks.value),
      sub: `${num(m.employees.value)} ${plural(m.employees.value, "employee", "employees")}`,
      icon: "breaks",
      tone: "blue",
      delta: deltaChip(m.breaks.change, "pct", "none"),
      spark: spark("breaks"),
      source: "summary",
      provenanceIds: ["tea-breaks"],
    },
    {
      id: "average",
      label: "Average break",
      value: m.avgMinutes.value == null ? "—" : `${num(m.avgMinutes.value, 1)} min`,
      sub: `Allowed: ${allowed} min`,
      icon: "average",
      tone: "slate",
      delta: deltaChip(m.avgMinutes.change, "min", "down"),
      source: "summary",
      provenanceIds: ["tea-average"],
    },
    {
      id: "overrun",
      label: "Overrun rate",
      value: pct(m.overrunPct.value, 1),
      sub: measured > 0 ? `${num(overruns)} of ${num(measured)} breaks ran over` : "No measured breaks",
      icon: "overrun",
      tone: "amber",
      delta: deltaChip(m.overrunPct.change, "pts", "down"),
      spark: spark("overrunPct"),
      source: "summary",
      provenanceIds: ["tea-overrun"],
    },
    {
      id: "lost",
      label: "Minutes lost",
      value: m.minutesLost.value == null ? "—" : minutesText(m.minutesLost.value),
      sub:
        summary.hoursLost == null
          ? "No measured breaks"
          : overruns === 0
            ? "No overruns"
            : `≈ ${num(summary.hoursLost, 1)} hours across ${num(overruns)} ${plural(overruns, "overrun", "overruns")}`,
      icon: "lost",
      tone: "red",
      delta: deltaChip(m.minutesLost.change, "pct", "down"),
      spark: spark("minutesLost"),
      source: "summary",
      provenanceIds: ["tea-minutes-lost"],
    },
    {
      id: "within",
      label: "Within allowance",
      value: pct(m.compliancePct.value, 1),
      sub: measured > 0 ? `${num(summary.withinAllowance)} of ${num(measured)} breaks` : "No measured breaks",
      icon: "within",
      tone: "green",
      delta: deltaChip(m.compliancePct.change, "pts", "up"),
      source: "summary",
      provenanceIds: ["tea-compliance"],
    },
    {
      id: "repeat",
      label: "Repeat overrunners",
      value: offenders ? num(offenders.total) : "—",
      sub: offenders
        ? `${offenders.threshold}+ overruns each` +
          (offenders.shareOfMinutesLostPct != null && offenders.total > 0
            ? ` · ${pct(offenders.shareOfMinutesLostPct, 0)} of lost time`
            : "")
        : undefined,
      icon: "repeat",
      tone: "purple",
      delta: null,
      source: "offenders",
      provenanceIds: ["tea-repeat"],
    },
  ];
}

// ─── the trend ──────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendRow = {
  date: string;
  minutesLost: number | null;
  overrunPct: number | null;
  average: number | null;
};

/** One row per day (or week) for the chart. The moving average only exists for daily points. */
export function trendRows(trend: TeaTrend): TrendRow[] {
  const daily = trend.granularity === "day";
  return trend.points.map((p) => ({
    date: p.date,
    minutesLost: p.minutesLost,
    overrunPct: p.overrunPct,
    average: daily ? p.maOverrunPct : null,
  }));
}

/** False when no point has a measured break: there is nothing to draw, only to explain. */
export function hasMeasuredBreaks(trend: TeaTrend): boolean {
  return trend.points.some((p) => p.measured > 0);
}

export const VERDICT_STYLE: Record<Verdict, { label: string; box: string }> = {
  better: { label: "Getting better", box: "border-green-200 bg-green-50 text-green-900" },
  worse: { label: "Getting worse", box: "border-red-200 bg-red-50 text-red-900" },
  steady: { label: "Holding steady", box: "border-slate-200 bg-slate-50 text-slate-800" },
  unclear: { label: "Too early to say", box: "border-amber-200 bg-amber-50 text-amber-900" },
};

// ─── rankings ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What clicking a ranking row does: narrow the whole page to that department, unit or staff/production group.
 *  null when there is nothing to narrow to (no group, already focused, or shifts, which are not a filter). */
export function focusScope(
  scope: ScopeChoice,
  by: GroupBy | "shift",
  row: Pick<TeaGroupRow, "key" | "label">,
  org?: MdOrg,
): ScopeChoice | null {
  if (row.key === NONE_KEY) return null;
  if (by === "department") return scope.department === row.label ? null : { ...scope, department: row.label };
  if (by === "type") {
    if (row.key !== "staff" && row.key !== "production") return null;
    return scope.type === row.key ? null : { ...scope, type: row.key };
  }
  if (by === "unit") {
    const unit = org?.branches.find((b) => b.name === row.label);
    if (!org || !unit || scope.branch === String(unit.id)) return null;
    // a department the new unit does not have is dropped, as the unit selector itself does
    const keeps =
      !scope.department || org.departments.some((d) => d.name === scope.department && d.branchId === unit.id);
    return { ...scope, branch: String(unit.id), department: keeps ? scope.department : "" };
  }
  return null;
}

/** The text under a group's name in the ranking: how many people it has and how many of them scan (shifts have no
 *  headcount, so they say how many people took a break). */
export function participationText(row: TeaGroupRow): string | null {
  if (row.headcount == null) return `${num(row.employees)} ${plural(row.employees, "person", "people")}`;
  if (row.headcount === 0) return null;
  const people = `${num(row.headcount)} ${plural(row.headcount, "employee", "employees")}`;
  return row.participationPct == null ? people : `${people} · ${pct(row.participationPct, 0)} scan`;
}

/** What the change chips compare with: "18 Aug to 31 Aug 2026". */
export function previousText(summary: Pick<TeaSummary, "previousPeriod">): string {
  return `${dayShort(summary.previousPeriod.start)} to ${dayLong(summary.previousPeriod.end)}`;
}

// ─── the heat map ───────────────────────────────────────────────────────────────────────────────────────────────

export type HeatMetric = "breaks" | "rate";

/** The half-hour columns worth drawing: the server's contiguous range minus stray scans at the edges (slots at either
 *  end holding together at most `edgeShare` of all breaks, e.g. a test scan at 03:00). `hidden` says how many breaks
 *  that leaves out, so nothing is dropped silently. */
export function visibleSlots(
  data: Pick<TeaHeatmap, "slots" | "cells" | "totalBreaks">,
  edgeShare = 0.01,
): { slots: TeaHeatmap["slots"]; hidden: number } {
  const slots = data.slots;
  const total = data.totalBreaks;
  if (slots.length <= 1 || total <= 0) return { slots, hidden: 0 };
  const perSlot = new Map<number, number>();
  for (const c of data.cells) perSlot.set(c.slot, (perSlot.get(c.slot) ?? 0) + c.breaks);
  const limit = total * edgeShare;
  let lo = 0;
  let hi = slots.length - 1;
  let hidden = 0;
  let acc = 0;
  while (lo < hi) {
    const n = perSlot.get(slots[lo].index) ?? 0;
    if (acc + n > limit) break;
    acc += n;
    lo += 1;
  }
  hidden += acc;
  acc = 0;
  while (hi > lo) {
    const n = perSlot.get(slots[hi].index) ?? 0;
    if (acc + n > limit) break;
    acc += n;
    hi -= 1;
  }
  hidden += acc;
  return { slots: slots.slice(lo, hi + 1), hidden };
}

/** Weekdays down, half hours across, in the shape the Heatmap component takes. A cell with no breaks (or, for the rate,
 *  too few to give one) is null and shows as a dot. */
export function heatmapMatrix(
  data: Pick<TeaHeatmap, "weekdays" | "slots" | "cells">,
  metric: HeatMetric,
  slots: TeaHeatmap["slots"] = data.slots,
) {
  const column = new Map(slots.map((s, i) => [s.index, i]));
  const values: (number | null)[][] = data.weekdays.map(() => slots.map(() => null));
  for (const cell of data.cells) {
    const col = column.get(cell.slot);
    if (col == null || !values[cell.weekday]) continue;
    values[cell.weekday][col] = metric === "breaks" ? cell.breaks : cell.overrunPct;
  }
  return { rows: data.weekdays, cols: slots.map((s) => s.label), values };
}

/** The two sentences under the grid: where breaks cluster, where they overrun. */
export function heatmapCaption(data: Pick<TeaHeatmap, "busiestSlots" | "worstCells">): string[] {
  const out: string[] = [];
  const busiest = data.busiestSlots[0];
  if (busiest) out.push(`Busiest half hour: ${busiest.label} (${pct(busiest.sharePct, 0)} of breaks)`);
  const worst = data.worstCells[0];
  if (worst) out.push(`Highest overrun rate: ${worst.weekday} ${worst.label} (${pct(worst.overrunPct, 0)})`);
  return out;
}

// ─── repeat overrunners ─────────────────────────────────────────────────────────────────────────────────────────

/** "60 min on 06 Sep": the longest measured break. */
export function worstCase(row: Pick<TeaOffender, "worstMinutes" | "worstDate">): string {
  if (row.worstMinutes == null) return "—";
  return `${num(row.worstMinutes)} min${row.worstDate ? ` on ${dayShort(row.worstDate)}` : ""}`;
}

export function offenderSub(row: Pick<TeaOffender, "employeeCode" | "department" | "unit">): string {
  return [row.employeeCode, row.department, row.unit].filter(Boolean).join(" · ");
}

// ─── the rule ───────────────────────────────────────────────────────────────────────────────────────────────────

export type LegendItem = { id: string; tone: "good" | "bad" | "muted"; title: string; text: string };

/** How a break is classified, from shortest to longest, for the "What counts as an overrun" card. */
export function ruleLegend(rule: Pick<TeaRule, "allowedMinutes" | "missedScanMinutes">): LegendItem[] {
  const a = rule.allowedMinutes;
  const cutoff = rule.missedScanMinutes;
  const items: LegendItem[] = [
    { id: "on-time", tone: "good", title: `Up to ${Math.min(a, cutoff)} min`, text: "On time" },
  ];
  if (a < cutoff) {
    items.push({
      id: "overrun",
      tone: "bad",
      title: `${a + 1} to ${cutoff} min`,
      text: "Overrun: counted as minutes lost",
    });
  }
  items.push({ id: "missed", tone: "muted", title: `Over ${cutoff} min`, text: "Probably a missed scan: left out" });
  items.push({ id: "no-return", tone: "muted", title: "No return scan", text: "Left out until it is closed" });
  return items;
}

export function ruleUpdatedText(rule: Pick<TeaRule, "isDefault" | "updatedAt">): string {
  if (rule.isDefault) return "No rule has been saved yet, so the default allowance is used.";
  return rule.updatedAt ? `Last changed ${dayLong(rule.updatedAt)}.` : "";
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
export function assistantSummary(summary: TeaSummary | undefined): Record<string, string | number | null> | undefined {
  if (!summary) return undefined;
  const m = summary.metrics;
  return {
    "Allowed minutes": summary.allowedMinutes,
    "Breaks taken": m.breaks.value,
    "Employees who took a break": m.employees.value,
    "Average break (min)": m.avgMinutes.value,
    "Breaks that ran over": m.overruns.value,
    "Overrun rate": m.overrunPct.value == null ? null : pct(m.overrunPct.value, 1),
    "Minutes lost": m.minutesLost.value,
    "Within allowance": m.compliancePct.value == null ? null : pct(m.compliancePct.value, 1),
    "Employees scanning": summary.coverage.participationPct == null ? null : pct(summary.coverage.participationPct, 0),
  };
}

/** The ready-made questions on the page's "Ask AI" buttons. `scopeText` is null when the page shows everyone. */
export function askQuestions(periodLabel: string, scopeText: string | null) {
  const when = scopeText ? ` (${periodLabel}, ${scopeText})` : ` (${periodLabel})`;
  return {
    page: `Summarise tea-break discipline${when}: how many breaks ran over, how much time was lost and what needs my attention.`,
    attention: `What needs my attention on tea-break discipline${when}, and why?`,
    trend: `Is tea-break discipline getting better or worse${when}? What changed in the last week?`,
    departments: `Which departments, units or staff groups have the worst tea-break overruns${when}, and what is driving them?`,
    shifts: `Which shifts have the worst tea-break overruns${when}?`,
    heatmap: `At what times of day and on which weekdays do tea breaks overrun most${when}?`,
    offenders: `Who are the repeat tea-break overrunners${when}, and how much of the lost time do they account for?`,
    rule: "What counts as a tea-break overrun, and which breaks are left out of the figures?",
  };
}
