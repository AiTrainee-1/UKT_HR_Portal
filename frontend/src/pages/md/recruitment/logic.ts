// The Recruitment page's pure logic: turning what the server sends into what the cards draw. No React in here, so it is
// unit-tested directly (logic.test.ts).

import type { BarItem } from "@/components/md/kit/BarList";
import { CHART } from "@/components/md/kit/chartTheme";
import type { DonutSlice } from "@/components/md/kit/DonutChart";
import { kpiDelta, type KpiDelta } from "@/components/md/kit/dto";
import { num, pct } from "@/lib/md/format";
import { PRESET_LABEL, describeScope, type PeriodChoice, type PeriodPreset, type ScopeChoice } from "@/lib/md/period";
import type { MdEnvelope, MdOrg } from "@/lib/md/types";
import type {
  Change,
  FunnelStage,
  FunnelStageId,
  GapRow,
  OutlookWindow,
  ReasonRow,
  RecruitmentJoiners,
  StageMix,
  SummaryCurrent,
  TrendMonth,
} from "./types";

/** Hiring is slow and lumpy (a month can have two joiners), so the page opens on a quarter and offers longer windows. */
export const DEFAULT_PERIOD: PeriodChoice = { preset: "last_90_days" };
export const PERIOD_PRESETS: PeriodPreset[] = [
  "last_30_days",
  "this_month",
  "last_month",
  "last_90_days",
  "last_12_months",
  "this_fy",
];

// ─── words ───

export function daysText(days: number | null | undefined): string {
  if (days == null) return "—";
  const tenths = Math.round(days * 10) / 10;
  return tenths === 1 ? "1 day" : `${num(tenths, Number.isInteger(tenths) ? 0 : 1)} days`;
}

/** "leaves today" / "1 day left" / "15 days left" for someone serving notice. */
export function daysLeftText(days: number): string {
  if (days <= 0) return "leaves today";
  return days === 1 ? "1 day left" : `${num(days)} days left`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

// ─── change chips ───

/** The change chip for a KPI. `good` is the direction that is good news (more joiners, fewer leavers). */
export function deltaOf(change: Change | undefined, format: "number" | "pct", good: "up" | "down"): KpiDelta | null {
  if (!change) return null;
  return kpiDelta({ format, delta: { abs: change.abs, pct: change.pct, good } });
}

/** How long a resignation has waited, as a tone: amber from the server's warning line, red from twice that. */
export function waitTone(days: number, warnAfter: number): "red" | "amber" | "slate" {
  if (days >= warnAfter * 2) return "red";
  return days >= warnAfter ? "amber" : "slate";
}

// ─── the funnel ───

export type FunnelBar = {
  id: FunnelStageId;
  label: string;
  count: number | null;
  /** 0-100, relative to the widest pipeline step; 0 for an empty or untracked step. */
  widthPct: number;
  tracked: boolean;
  /** Joined comes from the employee records, not from the candidate pipeline. */
  standalone: boolean;
  /** "77% of screened", or null when the step has nothing to be compared with. */
  conversion: string | null;
  dropOff: string | null;
  note: string | null;
};

const MIN_BAR = 8;

export function funnelBars(stages: FunnelStage[]): FunnelBar[] {
  const pipeline = stages.filter((s) => s.id !== "joined" && s.count != null).map((s) => s.count as number);
  const top = Math.max(...pipeline, 1);
  return stages.map((s) => {
    const tracked = s.count != null;
    const share = tracked ? ((s.count as number) / top) * 100 : 0;
    return {
      id: s.id,
      label: s.label,
      count: s.count,
      widthPct: tracked && (s.count as number) > 0 ? Math.min(100, Math.max(MIN_BAR, share)) : 0,
      tracked,
      standalone: s.id === "joined",
      conversion: s.ofPrevious != null && s.previousLabel ? `${pct(s.ofPrevious)} of ${s.previousLabel}` : null,
      dropOff: s.dropOff != null && s.dropOff > 0 ? `${num(s.dropOff)} dropped (${pct(s.dropOffPct)})` : null,
      note: s.note,
    };
  });
}

/** Bar colour for step `index` of `total`: the portal's blue ramp, light to dark down the funnel. */
export function stepColor(index: number, total: number): string {
  const ramp = CHART.ramp;
  const position = total <= 1 ? 0 : index / (total - 1);
  return ramp[Math.min(ramp.length - 1, Math.max(0, Math.round(1 + position * (ramp.length - 2))))];
}

// ─── open positions ───

export type AgeBar = { widthPct: number; markerPct: number; tone: "ok" | "warn" | "stale" };

/** A bar for "open for N days": scaled to the oldest position (never less than 1.5x the stale line, so one fresh
 *  posting does not fill the bar), with a tick where "stale" starts. */
export function ageBar(days: number, staleAfter: number, maxDays: number): AgeBar {
  const scale = Math.max(maxDays, staleAfter * 1.5, 1);
  return {
    widthPct: Math.min(100, Math.max(days > 0 ? 3 : 0, (days / scale) * 100)),
    markerPct: Math.min(100, (staleAfter / scale) * 100),
    tone: days > staleAfter ? "stale" : days > staleAfter * 0.75 ? "warn" : "ok",
  };
}

export const MIX_META: { key: keyof StageMix; label: string; color: string }[] = [
  { key: "applied", label: "Applied", color: "#94a3b8" },
  { key: "attended", label: "Attended interview", color: "#4FB8F0" },
  { key: "selected", label: "Selected", color: CHART.good },
  { key: "rejected", label: "Rejected", color: "#fca5a5" },
  { key: "other", label: "Other", color: "#cbd5e1" },
];

export type MixSegment = { key: keyof StageMix; label: string; count: number; widthPct: number; color: string };

/** The applicants of one position as proportional segments (empty ones left out). */
export function mixSegments(mix: StageMix): MixSegment[] {
  const total = MIX_META.reduce((sum, m) => sum + mix[m.key], 0);
  if (total === 0) return [];
  return MIX_META.filter((m) => mix[m.key] > 0).map((m) => ({
    key: m.key,
    label: m.label,
    count: mix[m.key],
    widthPct: (mix[m.key] / total) * 100,
    color: m.color,
  }));
}

export function mixTitle(mix: StageMix): string {
  const parts = MIX_META.filter((m) => mix[m.key] > 0).map((m) => `${mix[m.key]} ${m.label.toLowerCase()}`);
  return parts.length ? parts.join(" · ") : "No applicants yet";
}

// ─── the staffing gap ───

/** Red below 70% of the plan, amber below 90%, otherwise the portal blue. */
export function gapColor(fillPct: number | null): string {
  if (fillPct == null) return CHART.slate;
  if (fillPct < 70) return CHART.bad;
  if (fillPct < 90) return CHART.warn;
  return CHART.brand;
}

/** The departments that are short of staff, biggest gap first, as ranked bars. Fully staffed ones are left out. */
export function gapBarItems(rows: GapRow[]): BarItem[] {
  return rows
    .filter((r) => r.vacancy > 0)
    .sort((a, b) => b.vacancy - a.vacancy || a.department.localeCompare(b.department))
    .map((r) => ({
      key: String(r.departmentId),
      label: r.department,
      value: r.vacancy,
      display: `${num(r.vacancy)} short`,
      color: gapColor(r.fillPct),
      sub: `${num(r.current)} of ${num(r.required)} filled (${pct(r.fillPct, 0)})${
        r.openJobs ? ` · ${plural(r.openJobs, "open posting")}` : " · no open posting"
      }`,
    }));
}

// ─── resignations ───

const REASON_COLOR: Record<string, string> = {
  pay: "#006496",
  family: "#8b5cf6",
  health: "#ef4444",
  relocation: "#0d9488",
  business: "#f59e0b",
  growth: "#0096c7",
  work: "#4FB8F0",
  other: "#64748b",
  not_stated: "#cbd5e1",
};

/** Reason groups as donut slices with a fixed colour per reason, so a colour means the same thing in every period. */
export function reasonSlices(reasons: ReasonRow[]): DonutSlice[] {
  return reasons.map((r) => ({ name: r.label, value: r.count, color: REASON_COLOR[r.id] ?? CHART.slate }));
}

export function outlookLine(w: OutlookWindow): string {
  if (w.total === 0) return "Nobody is due to leave";
  const parts = [];
  if (w.approved) parts.push(`${num(w.approved)} serving notice`);
  if (w.pending) parts.push(`${num(w.pending)} waiting for a decision`);
  return parts.join(" · ");
}

// ─── joiners, early attrition, the trend ───

export type DocsChip = { text: string; tone: "green" | "amber" | "slate" };

export function docsChip(docsMissing: number | null): DocsChip {
  if (docsMissing == null) return { text: "Has left", tone: "slate" };
  if (docsMissing === 0) return { text: "Documents complete", tone: "green" };
  return { text: `${plural(docsMissing, "document")} missing`, tone: "amber" };
}

export function earlyHeadline(early: RecruitmentJoiners["earlyAttrition"]): string {
  if (early.totalLeavers === 0) return "Nobody has left in this period.";
  return `${num(early.leavers)} of ${plural(early.totalLeavers, "leaver")} left within ${early.windowDays} days of joining${
    early.pct != null ? ` (${pct(early.pct, 0)})` : ""
  }.`;
}

export type TrendRow = { month: string; joiners: number; leavers: number; vacancies: number | null };

export function trendRows(months: TrendMonth[]): TrendRow[] {
  return months.map((m) => ({ month: m.month, joiners: m.joiners, leavers: m.leavers, vacancies: m.vacancies }));
}

export function hasVacancyLine(months: TrendMonth[]): boolean {
  return months.some((m) => m.vacancies != null);
}

/** "joiners outpaced leavers by 2 in the last 12 months" (or the reverse). */
export function trendVerdict(totals: { joiners: number; leavers: number; net: number }): string {
  if (totals.net > 0) return `Hiring outpaced exits by ${num(totals.net)} over the last 12 months.`;
  if (totals.net < 0) return `Exits outpaced hiring by ${num(-totals.net)} over the last 12 months.`;
  return "Hiring and exits were level over the last 12 months.";
}

// ─── notes, filters and the assistant's view of the page ───

/** The distinct notes of several responses, in the order first seen (the same caveat should not be shown twice). */
export function collectNotes(...responses: (Pick<MdEnvelope, "notes"> | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of responses) {
    for (const note of r?.notes ?? []) {
      if (!seen.has(note)) {
        seen.add(note);
        out.push(note);
      }
    }
  }
  return out;
}

export function periodText(choice: PeriodChoice, serverLabel?: string): string {
  if (serverLabel) return serverLabel;
  return choice.preset === "custom" ? `${choice.from} to ${choice.to}` : PRESET_LABEL[choice.preset];
}

export function scopeText(scope: ScopeChoice, org?: MdOrg): string {
  const branch = org?.branches.find((b) => String(b.id) === scope.branch)?.name;
  return describeScope(scope, branch, scope.department || undefined);
}

/** What the assistant is told about the page, so "why is this high?" has something to point at. */
export function assistantSummary(c: SummaryCurrent): Record<string, string | number | null> {
  return {
    "Open positions": c.openPositions,
    "Vacancies against plan": c.vacancies,
    "Positions open too long": c.stalePositions,
    "Average days open": c.avgOpenDays,
    "Candidates in the pipeline": c.applicantsInPipeline,
    "Joined in the period": c.joiners,
    "Left in the period": c.leavers,
    "Resignations waiting for a decision": c.resignationsPending,
    Attrition: c.attritionPct == null ? null : pct(c.attritionPct),
  };
}
