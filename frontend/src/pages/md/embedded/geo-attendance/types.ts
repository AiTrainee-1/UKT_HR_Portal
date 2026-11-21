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
  /** The employee's id (servers from 2026-11-21): opens their on-duty month. */
  employeeId?: number;
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
  // On-Duty tracking (servers from 2026-11-21); absent / null for a session the app does not track
  employeeId?: number;
  trackState?: TrackState | null;
  trackStateLabel?: string | null;
  batteryPct?: number | null;
  travelledKm?: number | null;
  stops?: number | null;
  openAlerts?: number;
};

export type TrackState = "moving" | "stationary" | "offline" | "location_off" | "waiting_first_fix";

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
  trackStates?: Partial<Record<TrackState, number>>;
  openAlerts?: number;
};

// ─── On-Duty tracking and the automatic alerts (2026-11-21) ─────────────────────────────────────────────────────

export type AlertKind =
  | "location_off"
  | "permission_restricted"
  | "background_restricted"
  | "tracking_failure"
  | "missing_punch"
  | "punch_reminder";

export type TrackingPerson = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string;
};

export type GeoTracking = MdEnvelope & {
  journeys: {
    count: number;
    previous: number;
    change: Change;
    people: number;
    km: number;
    kmPrevious: number;
    kmChange: Change;
    kmPerJourney: number | null;
    travelHours: number;
    stopHours: number;
    gapHours: number;
    stops: number;
    withGaps: number;
    withGapsPct: number | null;
    mockPoints: number;
    withMock: number;
    gpsOffEvents: number;
    backgroundRestrictedEvents: number;
    ended: { reason: string; label: string; count: number }[];
    stillRecording: number;
  };
  alerts: {
    count: number;
    previous: number;
    change: Change;
    people: number;
    escalated: number;
    escalatedPct: number | null;
    fixed: number;
    fixedPct: number | null;
    openFromPeriod: number;
    openNow: number;
    medianMinutesToFix: number | null;
    pushed: number;
    whatsapp: number;
    byKind: { kind: AlertKind; label: string; count: number; openNow: number }[];
  };
  days: { date: string; journeys: number; km: number; alerts: number }[];
  topAlerted: (TrackingPerson & { alerts: number; open: number })[];
  topDistance: (TrackingPerson & { journeys: number; km: number; gapHours: number })[];
  repeatAlertsMin: number;
};

export type AlertStatus = "all" | "open" | "fixed" | "escalated";

export type GeoAlertRow = TrackingPerson & {
  id: number;
  kind: AlertKind;
  kindLabel: string;
  destination: string;
  detectedAt: string | null;
  resolvedAt: string | null;
  open: boolean;
  resolution: string | null;
  minutes: number;
  employeeTold: boolean;
  escalated: boolean;
  departmentHead: string | null;
};

export type GeoAlerts = MdEnvelope & {
  filters: { kind: AlertKind | null; employee: number | null; status: AlertStatus };
  rows: GeoAlertRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  kinds: { kind: AlertKind; label: string }[];
};

export type GeoPersonDetail = MdEnvelope & {
  employee: { id: number; employeeCode: string; employeeName: string; department: string; unit: string | null };
  totals: {
    sessions: number;
    punches: number;
    verified: number;
    rejected: number;
    pending: number;
    km: number;
    alerts: number;
  };
  sessions: {
    date: string;
    since: string | null;
    destination: string;
    status: string;
    punches: number;
    verified: number;
    rejected: number;
    pending: number;
    tracked: boolean;
    km: number | null;
    travelHours: number | null;
    stops: number | null;
    gapHours: number | null;
    ended: string | null;
    mockPoints: number;
  }[];
  alerts: {
    kind: AlertKind;
    kindLabel: string;
    detectedAt: string | null;
    resolvedAt: string | null;
    resolution: string | null;
    escalated: boolean;
  }[];
};
