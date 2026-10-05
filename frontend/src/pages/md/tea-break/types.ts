// The shapes of GET /api/md/tea-break/* (backend: api/md_portal/analytics/tea_break.py). Every response also carries the
// shared envelope (generatedAt, period, scope, provenance, notes).

import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

/** {abs, pct} against the previous period; null when either side has no data. pct is null when the previous was 0. */
export type Change = { abs: number; pct: number | null } | null;

export type Metric = { value: number | null; previous: number | null; change: Change };

export type MetricKey =
  "breaks" | "employees" | "measured" | "avgMinutes" | "overruns" | "overrunPct" | "compliancePct" | "minutesLost";

/** How complete the scans are: who scanned, and how many breaks could not be measured. */
export type TeaCoverage = {
  activeEmployees: number;
  employeesScanning: number;
  participationPct: number | null;
  daysWithScans: number;
  daysInPeriod: number;
  breaks: number;
  measured: number;
  /** Finished but longer than 60 minutes: probably a missed scan. */
  longCompleted: number;
  /** Never got a return scan. */
  noReturn: number;
  inProgress: number;
  unmeasured: number;
  unmeasuredPct: number | null;
};

export type TeaSummary = MdEnvelope & {
  allowedMinutes: number;
  metrics: Record<MetricKey, Metric>;
  hoursLost: number | null;
  withinAllowance: number | null;
  previousPeriod: MdPeriod;
  coverage: TeaCoverage;
};

export type TeaAttention = MdEnvelope & { items: MdInsightDto[] };

export type TeaTrendPoint = {
  /** The day (or the first day of the week). */
  date: string;
  days: number;
  breaks: number;
  measured: number;
  overruns: number;
  overrunPct: number | null;
  minutesLost: number | null;
  avgMinutes: number | null;
  /** 7-day moving average (daily points only). */
  maOverrunPct: number | null;
  maMinutesLost: number | null;
};

export type MomentumWindow = {
  start: string;
  end: string;
  breaks: number;
  measured: number;
  overrunPct: number | null;
  minutesLost: number | null;
};

export type Verdict = "better" | "worse" | "steady" | "unclear";

export type Momentum = {
  windowDays: number;
  verdict: Verdict;
  text: string;
  current: MomentumWindow;
  previous: MomentumWindow;
  overrunPctChange: Change;
  minutesLostChange: Change;
};

export type TeaTrend = MdEnvelope & {
  allowedMinutes: number;
  granularity: "day" | "week";
  points: TeaTrendPoint[];
  momentum: Momentum;
  worstDay: { date: string; overrunPct: number | null; overruns: number; measured: number; minutesLost: number } | null;
};

export type GroupBy = "department" | "unit" | "type";

/** One line of a ranking (a department, unit, staff/production or shift). */
export type TeaGroupRow = {
  /** Stable id; "__none__" for the people who have no department / unit / shift. */
  key: string;
  label: string;
  /** Shifts: "09:00–17:30 · Staff". */
  sub: string | null;
  headcount: number | null;
  employees: number;
  participationPct: number | null;
  breaks: number;
  measured: number;
  avgMinutes: number | null;
  overruns: number;
  overrunPct: number | null;
  minutesLost: number | null;
  shareOfLostPct: number | null;
  /** Too few measured breaks to rank or call a problem. */
  lowSample: boolean;
  previous: { breaks: number; overrunPct: number | null; minutesLost: number | null };
  change: { overrunPct: Change; minutesLost: Change };
};

export type TeaBreakdown = MdEnvelope & {
  by: GroupBy | "shift";
  allowedMinutes: number;
  rows: TeaGroupRow[];
  total: number;
  truncated: boolean;
  average: { overrunPct: number | null; avgMinutes: number | null; measured: number; minutesLost: number | null };
  minSample: number;
};

export type TeaHeatCell = {
  /** 0 = Monday. */
  weekday: number;
  /** Half-hour slot of the day: 0 = 00:00, 20 = 10:00, 47 = 23:30. */
  slot: number;
  breaks: number;
  measured: number;
  overruns: number;
  /** null when the cell has too few measured breaks to give a rate. */
  overrunPct: number | null;
  minutesLost: number | null;
};

export type TeaHeatmap = MdEnvelope & {
  allowedMinutes: number;
  weekdays: string[];
  slots: { index: number; label: string }[];
  cells: TeaHeatCell[];
  totalBreaks: number;
  minCellBreaks: number;
  busiestSlots: { slot: number; label: string; breaks: number; sharePct: number | null }[];
  worstCells: {
    weekday: string;
    slot: number;
    label: string;
    overrunPct: number;
    measured: number;
    minutesLost: number | null;
  }[];
  byWeekday: {
    weekday: number;
    label: string;
    breaks: number;
    measured: number;
    overruns: number;
    overrunPct: number | null;
    minutesLost: number | null;
  }[];
};

export type TeaOffender = {
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string | null;
  type: string;
  breaks: number;
  measured: number;
  overruns: number;
  overrunPct: number | null;
  minutesLost: number | null;
  averageOverBy: number | null;
  worstMinutes: number | null;
  worstOverBy: number | null;
  worstDate: string | null;
};

export type TeaOffenders = MdEnvelope & {
  allowedMinutes: number;
  threshold: number;
  /** People with at least `threshold` overruns. */
  total: number;
  /** People with at least one overrun. */
  overrunners: number;
  rows: TeaOffender[];
  truncated: boolean;
  minutesLostByRepeaters: number | null;
  shareOfMinutesLostPct: number | null;
};

export type TeaRule = MdEnvelope & {
  allowedMinutes: number;
  isDefault: boolean;
  updatedAt: string | null;
  missedScanMinutes: number;
  notReturnedMinutes: number;
  leftOpenHours: number;
  repeatMinOverruns: number;
  minSampleBreaks: number;
  hasGrace: boolean;
  hasWindows: boolean;
  statements: string[];
};
