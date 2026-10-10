// The shapes of GET /api/md/geo/* (backend: api/md_portal/analytics/geo.py). Every response also carries the shared
// envelope (generatedAt, period, scope, provenance, notes).

import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";

/** {abs, pct} against the previous period; null when either side has no data. pct is null when the previous was 0. */
export type Change = { abs: number; pct: number | null } | null;

export type Metric = { value: number | null; previous: number | null; change: Change };

export type MetricKey =
  | "sessions"
  | "people"
  | "punches"
  | "officePunches"
  | "verifiedPct"
  | "rejectedPct"
  | "pendingPunches"
  | "medianVerifyHours"
  | "mockedPunches"
  | "farPunches"
  | "oddPunches";

export type GeoSummary = MdEnvelope & {
  metrics: Record<MetricKey, Metric>;
  /** Active employees in the selection (today's headcount). */
  headcount: number;
  /** Active people who went out ÷ active employees. */
  participationPct: number | null;
  officePeople: number;
  previousPeriod: MdPeriod;
};

export type BriefingSentence = { id: string; text: string; tone: "good" | "bad" | "neutral" };

export type GeoBriefing = MdEnvelope & { sentences: BriefingSentence[]; text: string; ask: string };

export type GeoAttention = MdEnvelope & { items: MdInsightDto[] };

export type GeoTrendPoint = {
  /** The day (or the first day of the week). */
  date: string;
  days: number;
  sessions: number;
  punches: number;
  approved: number;
  rejected: number;
  pending: number;
  officePunches: number;
  /** 7-day average of sessions (daily points only). */
  maSessions: number | null;
};

export type Verdict = "rising" | "falling" | "steady" | "unclear";

export type GeoMomentum = {
  windowDays: number;
  verdict: Verdict;
  text: string;
  current: { start: string; end: string; sessions: number };
  previous: { start: string; end: string; sessions: number };
  sessionsChange: Change;
};

export type GeoTrend = MdEnvelope & {
  granularity: "day" | "week";
  points: GeoTrendPoint[];
  momentum: GeoMomentum;
  busiestDay: { date: string; sessions: number; punches: number } | null;
};

export type DecisionTiming = {
  decided: number;
  medianHours: number | null;
  p90Hours: number | null;
  within24hPct: number | null;
};

export type AgeBucket = { label: string; punches: number; sessions: number };

export type Backlog = {
  pendingPunches: number;
  pendingSessions: number;
  oldestPunchHours: number | null;
  oldestSessionHours: number | null;
  overdueHours: number;
  overduePunches: number;
  overdueSessions: number;
  ageBuckets: AgeBucket[];
};

export type GeoVerification = MdEnvelope & {
  sessions: {
    requested: number;
    awaitingHod: number;
    awaitingHr: number;
    approved: number;
    active: number;
    completed: number;
    rejected: number;
  };
  punches: { captured: number; approved: number; rejected: number; voided: number; pending: number };
  verifiedPct: number | null;
  rejectedPct: number | null;
  decisionTime: { punches: DecisionTiming; requests: DecisionTiming };
  backlog: Backlog;
};

export type GroupBy = "department" | "unit" | "type";

export type GeoGroupRow = {
  key: string;
  label: string;
  headcount: number;
  people: number;
  participationPct: number | null;
  sessions: number;
  shareOfSessionsPct: number | null;
  sessionsPerPerson: number | null;
  rejectedSessions: number;
  punches: number;
  rejectedPunches: number;
  mockedPunches: number;
  farPunches: number;
  lowSample: boolean;
  previous: { sessions: number };
  change: { sessions: Change };
};

export type GeoBreakdown = MdEnvelope & {
  by: GroupBy;
  rows: GeoGroupRow[];
  total: number;
  truncated: boolean;
  average: { sessions: number; people: number; sessionsPerPerson: number | null; participationPct: number | null };
  minSample: number;
};

export type GeoPerson = {
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string | null;
  type: string | null;
  sessions: number;
  daysOut: number;
  lastDate: string | null;
  rejectedSessions: number;
  punches: number;
  rejectedPunches: number;
  mockedPunches: number;
  farPunches: number;
  oddPunches: number;
  frequent: boolean;
};

export type GeoPeople = MdEnvelope & {
  threshold: number;
  total: number;
  frequent: number;
  frequentMin: number;
  rows: GeoPerson[];
  truncated: boolean;
};

export type DistanceBand = { key: string; label: string; punches: number; people: number; sharePct: number | null };

export type GeoReach = MdEnvelope & {
  bands: DistanceBand[];
  punches: number;
  farKm: number;
  farPunches: number;
  farPeople: number;
  unknownPunches: number;
  farthestKm: number | null;
};

export type ReasonCode = "mocked" | "far" | "odd" | "long" | "stale" | "rejected";

export type UnusualSession = {
  sessionId: number;
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string | null;
  date: string | null;
  destination: string;
  status: string;
  severity: "critical" | "warning" | "info";
  reasons: { code: ReasonCode; label: string }[];
};

export type RepeatRejected = {
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string | null;
  rejectedSessions: number;
  rejectedPunches: number;
  rejections: number;
};

export type GeoUnusual = MdEnvelope & {
  counts: {
    sessionsFlagged: number;
    mockedSessions: number;
    farSessions: number;
    oddSessions: number;
    longSessions: number;
    staleSessions: number;
    rejectedPunchSessions: number;
    repeatRejectedPeople: number;
  };
  rows: UnusualSession[];
  truncated: boolean;
  repeatRejected: RepeatRejected[];
  thresholds: {
    longSessionHours: number;
    farKm: number;
    oddFromHour: number;
    oddBeforeHour: number;
    repeatMinRejections: number;
  };
};

export type LiveRow = {
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string | null;
  destination: string;
  since: string | null;
  minutesOut: number;
  stale: boolean;
  approved: boolean;
  punchesToday: number;
  pendingPunches: number;
  lastPunch: string | null;
  mockedPunches: number;
  tracked: boolean;
  lastSeen: string | null;
  minutesSinceSeen: number | null;
  lastSeenMocked: boolean;
  distanceFromUnitKm: number | null;
};

export type GeoLive = MdEnvelope & {
  asOf: string;
  onDutyNow: number;
  leftOpen: number;
  awaitingApproval: number;
  withSignal: number;
  noSignal: number;
  silentMinutes: number;
  activeHeadcount: number;
  outPct: number | null;
  rows: LiveRow[];
  total: number;
  truncated: boolean;
};
