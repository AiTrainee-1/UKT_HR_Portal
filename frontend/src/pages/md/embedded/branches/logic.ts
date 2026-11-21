import { inrCompact, num, pct } from "@/lib/md/format";
import { deltaChip, type Delta } from "../employees/logic";
import type { MetricDef, MetricEntry, MetricId, UnitsSummary, UnitsTrend } from "./types";

// Pure shaping for the Branches Insights (tested in logic.test.ts).

/** A figure as the page writes it, by its format. */
export function metricText(format: MetricDef["format"] | undefined, value: number | null | undefined): string {
  if (value == null) return "—";
  switch (format) {
    case "pct":
      return pct(value);
    case "hours":
      return `${num(value, 1)} h`;
    case "years":
      return `${num(value, 1)} yrs`;
    case "inr_compact":
      return inrCompact(value);
    default:
      return num(value);
  }
}

/** "better" / "worse" / "similar" against the company, as a tone for a chip. */
export function verdictTone(entry: MetricEntry | undefined): "good" | "bad" | "neutral" | null {
  if (!entry?.verdict) return null;
  return entry.verdict === "better" ? "good" : entry.verdict === "worse" ? "bad" : "neutral";
}

/** "-22.1 pts vs company", "+5% vs company", "57% of company". */
export function againstCompany(def: MetricDef | undefined, entry: MetricEntry | undefined): string | null {
  if (!def || !entry) return null;
  if (def.kind === "total") return entry.sharePct != null ? `${pct(entry.sharePct, 0)} of the company` : null;
  if (def.kind === "rate" && entry.diff != null)
    return `${entry.diff > 0 ? "+" : ""}${num(entry.diff, 1)} pts vs company`;
  if (entry.diffPct != null) return `${entry.diffPct > 0 ? "+" : ""}${num(entry.diffPct, 0)}% vs company`;
  return null;
}

export type CompanyTile = {
  id: MetricId | "units";
  label: string;
  value: string;
  sub?: string;
  delta?: Delta | null;
  provenanceIds: string[];
};

const PROVENANCE: Partial<Record<MetricId, string[]>> = {
  attendancePct: ["attendance-pct"],
  absenteeismPct: ["absenteeism-pct"],
  latePct: ["late-pct"],
  overtimeHours: ["overtime-hours"],
  attritionPct: ["unit-attrition"],
  payrollCost: ["unit-payroll"],
  headcount: ["unit-headcount"],
};

/** The company's headline tiles (everyone in the selection, pooled), with the change against the previous period. */
export function companyTiles(s: UnitsSummary): CompanyTile[] {
  const defs = Object.fromEntries(s.metrics.map((m) => [m.id, m])) as Record<MetricId, MetricDef>;
  const c = s.company;
  const change = (id: MetricId, unit = "", places = 0) => {
    const now = c.metrics[id];
    const before = c.previous[id];
    if (now == null || before == null) return null;
    return deltaChip({ abs: Math.round((now - before) * 10) / 10, pct: null }, defs[id]?.good ?? null, unit, places);
  };
  const tile = (id: MetricId, sub?: string, unit = "", places = 0): CompanyTile => ({
    id,
    label: defs[id]?.label ?? id,
    value: metricText(defs[id]?.format, c.metrics[id]),
    sub,
    delta: change(id, unit, places),
    provenanceIds: PROVENANCE[id] ?? ["units-comparison"],
  });
  const factory = c.factory ?? 0;
  return [
    {
      id: "units",
      label: "Units",
      value: num(s.unitCount),
      sub: `${num(c.headcount)} active people${factory ? ` · ${num(factory)} factory` : ""}`,
      provenanceIds: ["units-comparison"],
    },
    tile("attendancePct", "share of scheduled days worked", "pts", 1),
    tile("absenteeismPct", "share of scheduled days absent", "pts", 1),
    tile("latePct", "of the days worked", "pts", 1),
    tile("overtimeHours", s.otTracked ? "staff overtime" : "not tracked in this period", "h", 1),
    tile("attritionPct", "last 12 months"),
    tile("joiners", "in the period"),
    tile("payrollCost", s.payrollMonth ? `${s.payrollMonth.label}, gross` : "no closed month yet"),
  ];
}

/** The trend chart's rows: one per bucket, a column per unit (by name) and the company. */
export function trendRows(t: UnitsTrend): Record<string, string | number | null>[] {
  return t.buckets.map((b, i) => {
    const row: Record<string, string | number | null> = { label: b.label, company: t.company[i] ?? null };
    for (const u of t.units) row[`u${u.id ?? "none"}`] = u.values[i] ?? null;
    return row;
  });
}

/** The metrics the trend can draw, in the order offered. */
export const TREND_CHOICES: { value: MetricId; label: string }[] = [
  { value: "attendancePct", label: "Attendance" },
  { value: "absenteeismPct", label: "Absenteeism" },
  { value: "latePct", label: "Late" },
  { value: "headcount", label: "Headcount" },
];

/** The four figures each unit's card shows. */
export const CARD_METRICS: MetricId[] = ["attendancePct", "absenteeismPct", "latePct", "costPerHead"];

/** What the assistant is told the MD sees. */
export function assistantSummary(s: UnitsSummary | undefined): Record<string, string> {
  if (!s) return {};
  return {
    Units: num(s.unitCount),
    "Active people": num(s.company.headcount),
    Attendance: pct(s.company.metrics.attendancePct),
    Absenteeism: pct(s.company.metrics.absenteeismPct),
    "Payroll (latest closed month)": inrCompact(s.company.metrics.payrollCost),
  };
}
