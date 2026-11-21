import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";
import type { BriefingSentence } from "../employees/types";

// What the Branches Insights tab reads (backend: api/md_portal/analytics/units.py).

export type MetricId =
  | "headcount"
  | "attendancePct"
  | "absenteeismPct"
  | "latePct"
  | "overtimeHours"
  | "overtimePerHead"
  | "attritionPct"
  | "joiners"
  | "leavers"
  | "avgTenureYears"
  | "payrollCost"
  | "costPerHead";

export type MetricDef = {
  id: MetricId;
  label: string;
  format: "number" | "pct" | "hours" | "years" | "inr_compact";
  good: "up" | "down" | null;
  kind: "rate" | "average" | "total";
  group: string;
  window: string;
  rankBy: "best" | "largest";
  hint: string;
};

export type MetricEntry = {
  value: number | null;
  reference: number | null;
  diff: number | null;
  diffPct: number | null;
  sharePct: number | null;
  rank: number | null;
  of: number;
  verdict: "better" | "worse" | "similar" | null;
  previous: number | null;
  delta: number | null;
};

export type UnitRow = {
  id: number | null;
  name: string;
  isHeadOffice?: boolean;
  isActive?: boolean;
  headcount: number;
  staff: number;
  production: number;
  factory?: number;
  metrics: Record<MetricId, MetricEntry>;
};

export type CompanyFigures = {
  label: string;
  headcount: number | null;
  staff: number;
  production: number;
  factory?: number;
  metrics: Record<MetricId, number | null>;
  previous: Record<MetricId, number | null>;
};

export type PayrollMonth = { key: string; label: string; ended: boolean; previousLabel: string } | null;

export type UnitsSummary = MdEnvelope & {
  today: string;
  measured: { start: string; end: string; days: number } | null;
  previous: { start: string; end: string; days: number } | null;
  payrollMonth: PayrollMonth;
  metrics: MetricDef[];
  unitCount: number;
  company: CompanyFigures;
  rows: UnitRow[];
  otTracked: boolean;
  briefing: { sentences: BriefingSentence[]; text: string; ask: string };
};

export type UnitsTrend = MdEnvelope & {
  metric: MetricDef;
  granularity: string;
  buckets: { key: string; label: string }[];
  units: { id: number | null; name: string; values: (number | null)[] }[];
  company: (number | null)[];
};

export type UnitsAttention = MdEnvelope & { items: MdInsightDto[] };

export type UnitProfile = MdEnvelope & {
  unit: { id: number; name: string; isHeadOffice?: boolean; isActive?: boolean } | null;
  row: UnitRow | null;
  company?: CompanyFigures;
  departments: { referenceLabel: string; reference: CompanyFigures; total: number; rows: UnitRow[] } | null;
  units?: { id: number | null; name: string }[];
  payrollMonth?: PayrollMonth;
};
