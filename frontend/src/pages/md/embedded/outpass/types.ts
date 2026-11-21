// The shapes of the Gate Pass and Visitors endpoints the MD Insights read (backend: api/md_portal/analytics/visitors.py,
// /api/md/visitors/*). Shared by the Gate Pass (outpass) and Visitors Insights; every response also carries the envelope.

import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";

/** A figure with its previous-period twin; `change.pct` is null when the previous figure was 0. */
export type Metric = {
  value: number | null;
  previous: number | null;
  change: { abs: number; pct: number | null } | null;
};

export type PeriodInfo = { start: string; end: string; label: string; days: number; preset?: string | null };

export type Sentence = { id: string; tone: string; text: string };

export type StoryResponse = MdEnvelope & {
  focus: "outpass" | "visitors";
  sentences: Sentence[];
  text: string;
  ask: string;
};

export type SummaryResponse = MdEnvelope & {
  previousPeriod: PeriodInfo;
  visitors: {
    visits: Metric;
    uniqueVisitors: Metric;
    repeatVisitors: Metric;
    afterHours: Metric;
    avgPerDay: Metric;
    peakHour: { hour: number; label: string; visits: number } | null;
    peakDay: { date: string; weekday: string; visits: number } | null;
    /** Check-out exists from 18 Nov 2026 (older servers leave these out). */
    checkedOut?: Metric;
    checkedOutPct?: Metric;
    avgMinutesInside?: Metric;
    medianMinutesInside?: number | null;
    leftWithoutCheckout?: number;
    checkoutEligible?: number;
    /** Live, whatever the period. */
    insideNow?: number;
    longStayNow?: number;
    checkedOutToday?: number;
    visitsToday?: number;
  };
  outpass: {
    requests: Metric;
    approved: Metric;
    rejected: Metric;
    pending: Metric;
    rejectionRatePct: Metric;
    left: Metric;
    returned: Metric;
    notReturned: Metric;
    returnRatePct: Metric;
    minutesOut: Metric;
    hoursOut: Metric;
    avgMinutesOut: Metric;
    turnaroundAvgMinutes: Metric;
    turnaroundMedianMinutes: Metric;
    onDutyTrips: Metric;
    gateFormExits: Metric;
    outsideNow: number;
    overdueNow?: number;
    waitingNow: { waiting: number; overOneDay: number; oldestMinutes: number | null };
  };
};

export type TrendPoint = {
  key: string;
  start: string;
  end: string;
  days: number;
  visits: number;
  passes: number;
  left: number;
  returned: number;
  minutesOut: number;
  gateFormExits: number;
};

export type TrendResponse = MdEnvelope & { granularity: "day" | "week"; points: TrendPoint[] };

export type ExceptionsResponse = MdEnvelope & { attention: MdInsightDto[] };

// ─── visitors breakdown ─────────────────────────────────────────────────────────────────────────────────────────────

export type Checkout = {
  visits: number;
  checkoutEligible: number;
  checkedOut: number;
  checkedOutPct: number | null;
  insideNow: number;
  longStayNow: number;
  leftWithoutCheckout: number;
  avgMinutesInside: number | null;
  medianMinutesInside: number | null;
  longestMinutesInside: number | null;
  stayBands: { key: string; label: string; visits: number; sharePct: number | null }[];
  longStayFromMinutes: number;
  since: string;
};

export type SourceRow = {
  key: "qr" | "hr" | "reception";
  label: string;
  visits: number;
  sharePct: number | null;
  checkedOut: number;
  avgMinutesInside: number | null;
};

export type DeskRow = { deskId: number; desk: string | null; checkIns: number; checkOuts: number };

export type TopHost = {
  employeeId: number | null;
  name: string;
  code: string | null;
  department: string | null;
  linked: boolean;
  visits: number;
  uniqueVisitors: number;
};

export type VisitorsResponse = MdEnvelope & {
  visits: number;
  uniqueVisitors: number;
  purposes: { categories: { key: string; label: string; visits: number; sharePct: number | null }[] };
  hostDepartments: { department: string; visits: number; uniqueVisitors: number; sharePct: number | null }[];
  hostsNotLinked: { visits: number; sharePct: number | null };
  topHosts: TopHost[];
  repeatVisitors: {
    total: number;
    visits: number;
    sharePct: number | null;
    frequentFrom: number;
    rows: { visitorId: number; visitorName: string | null; visits: number; lastVisitAt: string | null }[];
  };
  afterHours: { total: number; sharePct: number | null; label: string };
  peakHour: { hour: number; label: string; visits: number } | null;
  busiestWeekday: { weekday: string; visits: number } | null;
  checkout?: Checkout;
  sources?: SourceRow[];
  desks?: DeskRow[];
  companies?: {
    visitsWithCompany: number;
    companies: number;
    rows: { company: string | null; visits: number; uniqueVisitors: number }[];
  };
};

// ─── outpass breakdown ──────────────────────────────────────────────────────────────────────────────────────────────

export type DepartmentRow = {
  department: string;
  requests: number;
  employees: number;
  headcount: number | null;
  requestsPer100: number | null;
  returned: number;
  minutesOut: number | null;
  avgMinutes: number | null;
  notReturned: number;
};

export type ReasonRow = {
  key: string;
  label: string;
  requests: number;
  sharePct: number | null;
  returned: number;
  minutesOut: number | null;
  avgMinutes: number | null;
};

export type GateRow = {
  gateId: number | null;
  gate: string;
  wentOut: number;
  cameBack: number;
  stillOut: number;
  notReturned: number;
  avgMinutesOut: number | null;
  minutesOut: number | null;
};

export type OutpassResponse = MdEnvelope & {
  requests: number;
  funnel: {
    requested: number;
    approved: number;
    left: number;
    returned: number;
    dropOffs: {
      rejected: number;
      waiting: number;
      approvedNotUsed: number;
      outsideNow: number;
      notReturned: number;
      earlyDismissal: number;
    };
    onDutyTrips: number;
  };
  byDepartment: DepartmentRow[];
  byReason: ReasonRow[];
  byGate?: GateRow[];
  durations: {
    buckets: { key: string; label: string; passes: number; sharePct: number | null }[];
    measured: number;
    medianMinutes: number | null;
    avgMinutes: number | null;
    longestMinutes: number | null;
  };
  approvals: {
    turnaround: { avgMinutes: number | null; medianMinutes: number | null; decisions: number };
    rejectionRatePct: number | null;
  };
  gateScans: {
    attempts: number;
    successful: number;
    refused: number;
    refusedPct: number | null;
    byReason: { key: string; label: string; count: number }[];
    byGate: { gate: string; exits: number; returns: number; refused: number }[];
  };
};

// ─── drill-down lists ───────────────────────────────────────────────────────────────────────────────────────────────

export type ListPage<T> = MdEnvelope & {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  filters: string[];
  items: T[];
};

export type VisitItem = {
  visitId: number;
  visitedAt: string | null;
  checkedOutAt: string | null;
  minutesInside: number | null;
  status: "inside" | "checked_out" | "not_checked_out" | "before_checkout";
  statusLabel: string;
  visitorName: string | null;
  purpose: string | null;
  purposeCategory: string;
  hostEmployeeId: number | null;
  hostName: string | null;
  hostDepartment: string | null;
  hostLinked: boolean;
  company: string | null;
  source: string;
  sourceLabel: string;
  peopleCount: number | null;
  unit: string | null;
  desk: string | null;
  checkoutDesk: string | null;
};

export type PassItem = {
  passId: number;
  employeeId: number;
  name: string;
  code: string | null;
  department: string;
  passType: string;
  destination: string | null;
  reason: string | null;
  requestedAt: string | null;
  approvedAt: string | null;
  exitedAt: string | null;
  enteredAt: string | null;
  expectedReturnAt: string | null;
  minutesOut: number | null;
  outcome: string;
  outcomeLabel: string;
  exitGate: string | null;
  entryGate: string | null;
  reviewComment: string | null;
};

export type VisitList = ListPage<VisitItem>;
export type PassList = ListPage<PassItem>;
