import type { StatTone } from "@/components/md/kit/StatCard";
import { CHART } from "@/components/md/kit/chartTheme";
import type { AssistantPageContext } from "@/lib/md/assistant-store";
import { dayShort, num, pct, type Tone } from "@/lib/md/format";
import type { FamilyKey, PunchDrill, PunchMetric, PunchSummary, SourcePoint } from "./types";

// The pure half of the Attendance Search Insights: the headline figures and what a click on each opens, the chart's series
// and what the assistant is told. No React here (logic.test.ts).

export const PAGE = "attendance-search";
export const TITLE = "Attendance Search";

/** How each family of punches is drawn: devices at the bottom of a stack, hand entries on top. */
export const FAMILY_COLOR: Record<FamilyKey, string> = {
  biometric: CHART.deep,
  geo: CHART.info,
  on_duty: CHART.teal,
  import: CHART.slate,
  missing_punch: CHART.warn,
  manual: CHART.brand,
  auto: CHART.gold,
  other: CHART.light,
};

export type PunchTile = {
  id: string;
  label: string;
  tone: StatTone;
  value: (s: PunchSummary) => string;
  sub: (s: PunchSummary) => string | undefined;
  /** The change chip: the metric and whether up is good news (null: neither). */
  metric?: (s: PunchSummary) => { m: PunchMetric | undefined; good: "up" | "down" | null; points?: boolean };
  provenanceIds: string[];
  /** What a click opens: a drill-down sheet, or another MD page. */
  drill?: PunchDrill["kind"];
  open?: string;
};

export const TILES: PunchTile[] = [
  {
    id: "punches",
    label: "Punches",
    tone: "blue",
    value: (s) => num(s.metrics.punches.value),
    sub: (s) => (s.metrics.employees.value != null ? `by ${num(s.metrics.employees.value)} people` : undefined),
    metric: (s) => ({ m: s.metrics.punches, good: null }),
    provenanceIds: ["punches-total"],
  },
  {
    id: "hand",
    label: "Entered by hand",
    tone: "red",
    value: (s) =>
      s.metrics.handEnteredPct.value != null ? pct(s.metrics.handEnteredPct.value) : num(s.metrics.handEntered.value),
    sub: (s) =>
      s.metrics.handEnteredPct.value != null
        ? `${num(s.metrics.handEntered.value)} punches typed in or corrected`
        : "punches typed in or corrected (too few for a share)",
    metric: (s) => ({ m: s.metrics.handEnteredPct, good: "down", points: true }),
    provenanceIds: ["punches-hand-entered"],
    drill: "manual",
  },
  {
    id: "missing",
    label: "Days with a missing punch",
    tone: "amber",
    value: (s) => num(s.missing.days),
    sub: (s) =>
      s.missing.complete
        ? [
            s.missing.pct != null ? `${pct(s.missing.pct)} of days punched` : null,
            s.missing.withoutRequest != null ? `${num(s.missing.withoutRequest)} with no request` : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        : "no complete day yet",
    metric: (s) => ({ m: s.metrics.missingDays, good: "down" }),
    provenanceIds: ["punches-missing", "punches-requests"],
    drill: "missing",
  },
  {
    id: "devices",
    label: "Devices sending",
    tone: "indigo",
    value: (s) => `${num(s.devices.reporting)} of ${num(s.devices.listed)}`,
    sub: (s) => (s.devices.silent ? `${num(s.devices.silent)} silent` : "none silent"),
    provenanceIds: ["punches-devices", "punches-silent"],
    drill: "devices",
  },
  {
    id: "held",
    label: "On-Duty waiting for HR",
    tone: "purple",
    value: (s) => num(s.heldOnDuty?.pending ?? 0),
    sub: (s) =>
      s.heldOnDuty
        ? `${num(s.heldOnDuty.people)} people · ${num(s.heldOnDuty.rejected)} turned down · not attendance yet`
        : undefined,
    provenanceIds: ["punches-sources"],
    open: "/md/geo-attendance/verifications",
  },
  {
    id: "coverage",
    label: "Days already worked out",
    tone: "green",
    value: (s) => (s.coverage?.coveragePct != null ? pct(s.coverage.coveragePct) : "—"),
    sub: (s) => (s.coverage ? `of ${num(s.coverage.punchDays)} days with punches have a day record` : undefined),
    provenanceIds: ["punches-coverage"],
  },
];

/** The change chip of a tile ("+12", "-2.5 pts"), coloured by whether the move is good news. */
export function tileDelta(
  tile: PunchTile,
  s: PunchSummary,
): { text: string; tone: Tone; direction?: "up" | "down" | "flat" } | null {
  const spec = tile.metric?.(s);
  const abs = spec?.m?.change?.abs;
  if (abs == null || !spec) return null;
  const direction = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  const tone: Tone = abs === 0 || spec.good == null ? "neutral" : abs > 0 === (spec.good === "up") ? "good" : "bad";
  const size = spec.points ? `${num(Math.abs(abs), 1)} pts` : num(Math.abs(abs));
  return { text: `${abs > 0 ? "+" : abs < 0 ? "-" : ""}${size}`, tone, direction };
}

/** Families with punches, for the donut (biggest first) and the chart's series (in stacking order). */
export function familySlices(s: PunchSummary): { name: string; value: number; color: string }[] {
  return s.families
    .filter((f) => f.punches > 0)
    .sort((a, b) => b.punches - a.punches)
    .map((f) => ({ name: f.label, value: f.punches, color: FAMILY_COLOR[f.key] }));
}

export function chartSeries(families: { key: FamilyKey; label: string; punches: number }[]) {
  return families
    .filter((f) => f.punches > 0)
    .map((f) => ({ key: f.key, label: f.label, color: FAMILY_COLOR[f.key], kind: "bar" as const, stackId: "punches" }));
}

export const chartRows = (points: SourcePoint[]) =>
  points.map((p) => ({ ...p, label: dayShort(p.date) }) as Record<string, string | number | null>);

export function assistantContext(
  s: PunchSummary | undefined,
  periodLabel: string,
  scopeText: string,
): AssistantPageContext {
  return {
    page: PAGE,
    title: TITLE,
    filters: { Period: periodLabel, Scope: scopeText },
    summary: s
      ? {
          Punches: s.metrics.punches.value,
          "People who punched": s.metrics.employees.value,
          "Entered by hand": s.metrics.handEntered.value,
          "Hand-entered share": s.metrics.handEnteredPct.value != null ? pct(s.metrics.handEnteredPct.value) : null,
          "Days with a missing punch": s.missing.days,
          "Silent devices": s.devices.silent,
          "On-Duty punches waiting for HR": s.heldOnDuty?.pending ?? null,
          "Unmatched device IDs": s.unmatched.activeInPeriod,
        }
      : {},
  };
}
