// What the Dashboard endpoints send (backend: api/md_portal/analytics/dashboard.py, routed under /api/md/dashboard/).
// The Dashboard calculates nothing itself: every figure here is the one the page behind it shows, so the types of the
// trend sections follow the Attendance, Payroll and Employees pages' own trend responses.
// Percentages are 0-100 floats, "no data" is null (never 0), dates are ISO strings.

import type { MdEnvelope, MdInsightDto, MdKpiDto, MdPeriod, Provenance } from "@/lib/md/types";

/** `{ "error": "..." }` stands in for a section whose module could not be read; the rest of the answer is intact. */
export type SectionError = { error: string };

export const isSectionError = (value: unknown): value is SectionError =>
  typeof value === "object" && value !== null && "error" in value;

/** A headline card, as the page's own `headline()` made it, plus the text the card shows and the entries that explain it. */
export type DashboardKpi = MdKpiDto & {
  /** The analytics module it came from ("attendance", "tea_break"...). */
  module: string;
  /** The figure written the way the card writes it ("₹2.4 Cr"); null = no data. */
  display: string | null;
  /** Ids into the response's `provenance` that explain this card. */
  provenanceIds: string[];
};

export type DashboardInsight = MdInsightDto & { module: string };

/** `watch` = look at it, `good` = good news, `neutral` = just information. */
export type BriefingTone = "good" | "watch" | "neutral";

export type BriefingSentence = {
  id: string;
  text: string;
  /** The MD page it came from (null when it speaks for several). */
  page: string | null;
  tone: BriefingTone;
};

export type Briefing = { sentences: BriefingSentence[]; text: string; ask: string };

export type UnitRow = {
  id: number | null;
  name: string;
  /** People scheduled to work today. */
  expected: number;
  /** Punched in so far. */
  present: number;
  /** Late arrivals, or null when the day records are not computed far enough to say. */
  late: number | null;
  /** On approved leave. */
  leave: number;
  /** Not in yet (provisional: not the same as absent). */
  absent: number;
  attendancePct: number | null;
};

export type UnitsToday = {
  date: string;
  /** The factory's clock when the count was made ("2026-10-05T10:42:10"); null for a past day. */
  asOf: string | null;
  provisional: boolean;
  isWorkingDay: boolean;
  lateKnown: boolean;
  total: Omit<UnitRow, "id" | "name">;
  /** Weakest first. */
  rows: UnitRow[];
  weakestDepartment: { name: string; expected: number; present: number; absent: number; attendancePct: number } | null;
};

export type SourceStatus = {
  title: string;
  page: string;
  ok: boolean;
  /** Why the module could not be read (a plain sentence; the technical reason is in the server log). */
  error?: string;
  tookMs: number;
  kpis: number;
  insights: number;
};

/** GET /api/md/dashboard/overview */
export type DashboardOverview = MdEnvelope & {
  today: string;
  /** False early in the day, while people are still arriving. */
  settled: boolean;
  kpis: DashboardKpi[];
  insights: DashboardInsight[];
  /** How many exceptions there were in all (the list is cut to the first eight). */
  insightsTotal: number;
  briefing: Briefing;
  units: UnitsToday | SectionError;
  /** Per analytics module: did it answer. */
  sources: Record<string, SourceStatus>;
};

export type AttendanceTrendPoint = {
  date: string;
  days: number;
  attendancePct: number | null;
  absentPct: number | null;
  latePct: number | null;
  present: number;
  absent: number;
  expected: number;
};

export type AttendanceTrend = {
  granularity: "day" | "week";
  points: AttendanceTrendPoint[];
  average: { attendancePct: number | null; absentPct: number | null; latePct: number | null } | null;
  period?: MdPeriod;
  provenance: Provenance[];
  notes: string[];
};

export type PayrollTrendMonth = {
  month: string;
  label: string;
  hasData: boolean;
  /** paid | part_paid | generated | in_progress | not_generated | not_started | no_data */
  state: string;
  provisionalSlips: number;
  grossPay: number | null;
  netPay: number | null;
  headcount: number | null;
  costPerHead: number | null;
  overtimePay: number | null;
};

export type PayrollTrend = {
  hasData: boolean;
  month?: string;
  months: PayrollTrendMonth[];
  average: number | null;
  highest: { month: string; label: string; grossPay: number } | null;
  lowest: { month: string; label: string; grossPay: number } | null;
  provenance: Provenance[];
  notes: string[];
};

export type MovementPoint = {
  key: string;
  label: string;
  start: string;
  end: string;
  joiners: number;
  leavers: number;
  net: number;
  headcount: number;
};

export type MovementTrend = {
  grain: "day" | "week" | "month";
  points: MovementPoint[];
  totals: { joiners: number; leavers: number; net: number; opening: number | null; closing: number | null };
  period?: MdPeriod;
  provenance: Provenance[];
  notes: string[];
};

/** GET /api/md/dashboard/trends: the three charts, each of which may be an error entry on its own. */
export type DashboardTrends = MdEnvelope & {
  today: string;
  attendance: AttendanceTrend | SectionError;
  payroll: PayrollTrend | SectionError;
  movement: MovementTrend | SectionError;
};
