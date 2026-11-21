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
  | "exportDays"
  // scheduled attendance reports (Attendance Notify), servers from 2026-11-21
  | "scheduledRuns"
  | "scheduledFailedRuns"
  | "scheduledDelivered";

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
  metrics: Record<Exclude<MetricKey, ScheduledKey>, Metric> & Partial<Record<ScheduledKey, Metric>>;
  gapDays: number;
  gapMinAbsences: number;
  coverage: Coverage | null;
  latestExport: LatestExport | null;
  /** Attendance Notify automations switched on (servers from 2026-11-21). */
  activeAutomations?: number;
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

export type ScheduledKey = "scheduledRuns" | "scheduledFailedRuns" | "scheduledDelivered";

// ─── scheduled attendance reports (Attendance Notify) and the absences drill-down (2026-11-21) ───────────────────

export type ChannelCount = {
  channel: string;
  label: string;
  sent: number;
  queued: number;
  failed: number;
  skipped: number;
  pending: number;
};

export type RlScheduled = MdEnvelope & {
  automations: {
    total: number;
    active: number;
    byChannel: { channel: string; label: string; total: number; active: number }[];
  };
  runs: {
    total: number;
    previous: number;
    change: Change;
    done: number;
    partial: number;
    failed: number;
    skipped: number;
    running: number;
    scheduled: number;
    manual: number;
    retries: number;
    reachedEveryonePct: number | null;
  };
  delivered: number;
  deliveredPrevious: number;
  recipients: number;
  byChannel: ChannelCount[];
  byAutomation: {
    automation: string;
    channel: string;
    label: string;
    runs: number;
    done: number;
    failed: number;
    lastRun: string | null;
  }[];
  failures: {
    id: number;
    automation: string;
    channel: string;
    date: string;
    slot: string | null;
    status: string;
    trigger: string;
    error: string;
    failedDeliveries: number;
  }[];
  days: { date: string; runs: number; failed: number }[];
  lastRun: { automation: string; channel: string; date: string; slot: string | null; status: string } | null;
};

export type AbsenceMark = "all" | "informed" | "not_informed" | "unmarked";

export type AbsenceRow = {
  date: string;
  weekday: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string;
  type: string;
  mark: Exclude<AbsenceMark, "all">;
  absencesInSelection: number;
};

export type RlAbsences = MdEnvelope & {
  filters: { mark: AbsenceMark; day: string | null; by: GroupBy | null; group: string | null };
  counts: {
    absences: number;
    informed: number;
    notInformed: number;
    unmarked: number;
    reviewedPct: number | null;
  };
  rows: AbsenceRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};
