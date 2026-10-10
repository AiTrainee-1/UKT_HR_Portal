// The shapes of GET /api/md/reportlog/* (backend: api/md_portal/analytics/reportlog.py). Every response also carries the
// shared envelope (generatedAt, period, scope, provenance, notes).
//
// What the Report Log is: HR's daily absence report (each absent person marked Informed or Not informed) and the monthly
// attendance register. "Absences" are absences on scheduled days; "followed up" means carrying either mark; "exports" are the
// attendance reports recorded in the audit trail (the Report Log page's own exports are not recorded).

import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

/** {abs, pct} against the previous period; null when either side has no data. pct is null when the previous was 0. */
export type Change = { abs: number; pct: number | null } | null;

export type Metric = { value: number | null; previous: number | null; change: Change };

export type MetricKey =
  | "absences"
  | "informed"
  | "notInformed"
  | "unmarked"
  | "reviewedPct"
  | "notInformedPct"
  | "exports"
  | "exportsAll"
  | "exporters"
  | "exportDays";

export type Window = { start: string; end: string; days: number };

export type Coverage = {
  expectedDays: number;
  recordedDays: number;
  missingDays: number;
  coveragePct: number | null;
  partial: boolean;
};

export type LatestExport = { at: string | null; userName: string; report: string };

export type RlSummary = MdEnvelope & {
  /** The complete days the absence figures cover (today is left out); null when the period has no completed day. */
  measured: Window | null;
  previous: Window | null;
  previousPeriod: MdPeriod;
  metrics: Record<MetricKey, Metric>;
  gapDays: number;
  gapMinAbsences: number;
  coverage: Coverage | null;
  latestExport: LatestExport | null;
  /** What the data can never say about this page (reports sent, late, failed, who marked an absence). */
  unknowns: string[];
};

export type BriefingSentence = { id: string; text: string; tone: "good" | "bad" | "neutral" };

export type RlBriefing = MdEnvelope & { sentences: BriefingSentence[]; text: string; ask: string };

export type RlAttention = MdEnvelope & { items: MdInsightDto[] };

export type RlTrendPoint = {
  /** The day (or the first day of the week). */
  date: string;
  days: number;
  /** null for a day the figures do not cover yet (today and later). */
  absences: number | null;
  informed: number | null;
  notInformed: number | null;
  unmarked: number | null;
  reviewedPct: number | null;
  exports: number;
};

export type RlTrend = MdEnvelope & { granularity: "day" | "week"; points: RlTrendPoint[]; measured: Window | null };

export type GapCalendarDay = {
  date: string;
  weekday: string;
  absences: number | null;
  informed: number | null;
  notInformed: number | null;
  unmarked: number | null;
  exports: number;
};

export type GapDay = { date: string; weekday: string; absences: number; unmarked: number };

export type RlGaps = MdEnvelope & {
  days: GapCalendarDay[];
  truncated: boolean;
  gapDays: GapDay[];
  gapDayCount: number;
  minAbsences: number;
  daysWithAbsences: number;
  daysFullyMarked: number;
  measured: Window | null;
};

export type GroupBy = "department" | "unit" | "type";

export type RlGroupRow = {
  key: string;
  label: string;
  headcount: number;
  absences: number;
  informed: number;
  notInformed: number;
  unmarked: number;
  reviewedPct: number | null;
  notInformedPct: number | null;
  unmarkedPct: number | null;
  lowSample: boolean;
  previous: { absences: number; reviewedPct: number | null };
  change: { absences: Change; reviewedPct: Change };
};

export type RlBreakdown = MdEnvelope & {
  by: GroupBy;
  rows: RlGroupRow[];
  total: number;
  truncated: boolean;
  average: {
    absences: number;
    informed: number;
    notInformed: number;
    unmarked: number;
    reviewedPct: number | null;
    notInformedPct: number | null;
    unmarkedPct: number | null;
  };
  minSample: number;
};

export type ExportUser = {
  userName: string;
  exports: number;
  days: number;
  sharePct: number | null;
  lastAt: string | null;
};
export type ExportReport = { report: string; exports: number; sharePct: number | null };

export type RlExports = MdEnvelope & {
  totals: {
    attendance: number;
    all: number;
    otherReports: number;
    exporters: number;
    days: number;
    daysInPeriod: number;
    previousAttendance: number;
    change: Change;
  };
  byUser: ExportUser[];
  usersTotal: number;
  byReport: ExportReport[];
  reportsTotal: number;
  latest: LatestExport[];
  unknowns: string[];
};
