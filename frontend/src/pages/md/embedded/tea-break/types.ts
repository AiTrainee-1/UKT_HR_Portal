// The shapes of the Tea Break endpoints the MD Insights read (backend: api/md_portal/analytics/tea_break.py,
// /api/md/tea-break/*). Every response also carries the envelope.

import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";
import type { ListPage, Sentence } from "../outpass/types";

export type TeaMetric = {
  value: number | null;
  previous: number | null;
  change: { abs: number; pct: number | null } | null;
};

export type TeaSummary = MdEnvelope & {
  allowedMinutes: number;
  metrics: {
    breaks: TeaMetric;
    employees: TeaMetric;
    measured: TeaMetric;
    avgMinutes: TeaMetric;
    overruns: TeaMetric;
    overrunPct: TeaMetric;
    compliancePct: TeaMetric;
    minutesLost: TeaMetric;
  };
  hoursLost: number | null;
  withinAllowance: number | null;
  coverage: {
    activeEmployees: number;
    employeesScanning: number;
    participationPct: number | null;
    breaks: number;
    measured: number;
    longCompleted: number;
    noReturn: number;
    inProgress: number;
    unmeasured: number;
    unmeasuredPct: number | null;
  };
  /** Tea-break codes a gate refused (since 19 Nov 2026; an older server leaves it out). */
  refused?: TeaMetric;
};

export type TeaStory = MdEnvelope & { sentences: Sentence[]; text: string; ask: string };

export type TeaTrendPoint = {
  date: string;
  days: number;
  breaks: number;
  measured: number;
  overruns: number;
  overrunPct: number | null;
  minutesLost: number | null;
  avgMinutes: number | null;
  maOverrunPct: number | null;
  maMinutesLost: number | null;
};

export type TeaTrend = MdEnvelope & {
  allowedMinutes: number;
  granularity: "day" | "week";
  points: TeaTrendPoint[];
  momentum: { verdict: string; text: string };
  worstDay: {
    date: string;
    overrunPct: number | null;
    overruns: number;
    measured: number;
    minutesLost: number | null;
  } | null;
};

export type TeaGroupBy = "department" | "unit" | "type" | "gate";

export type TeaGroupRow = {
  key: string;
  label: string;
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
  lowSample: boolean;
  /** By gate only: tea-break codes this gate refused. */
  refused?: number;
};

export type TeaGroups = MdEnvelope & {
  by: TeaGroupBy;
  allowedMinutes: number;
  rows: TeaGroupRow[];
  total: number;
  truncated: boolean;
  average: { overrunPct: number | null; avgMinutes: number | null; measured: number; minutesLost: number | null };
  minSample: number;
};

export type TeaOffender = {
  employeeId?: number;
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string | null;
  type: string | null;
  breaks: number;
  measured: number;
  overruns: number;
  overrunPct: number | null;
  minutesLost: number | null;
  averageOverBy: number | null;
  worstMinutes: number | null;
  worstDate: string | null;
};

export type TeaOffenders = MdEnvelope & {
  allowedMinutes: number;
  threshold: number;
  total: number;
  overrunners: number;
  rows: TeaOffender[];
  truncated: boolean;
  shareOfMinutesLostPct: number | null;
};

export type TeaAttention = MdEnvelope & { items: MdInsightDto[] };

export type TeaRecord = {
  id: string;
  employeeId: number | null;
  employeeCode: string | null;
  employeeName: string | null;
  department: string;
  date: string;
  outAt: string | null;
  inAt: string | null;
  minutes: number | null;
  overMinutes: number | null;
  status: "within" | "overrun" | "long" | "no_return" | "in_progress" | "refused";
  statusLabel: string;
  outGate: string | null;
  inGate: string | null;
};

export type TeaRecords = ListPage<TeaRecord> & { allowedMinutes: number };
