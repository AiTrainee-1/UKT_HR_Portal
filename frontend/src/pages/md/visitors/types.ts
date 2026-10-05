// The shapes of the Outpass & Visitors endpoints (backend: api/md_portal/analytics/visitors.py, /api/md/visitors/*).
// Every response also carries the shared envelope (generatedAt, period, scope, provenance, notes).

import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";

/** A figure with its previous-period twin; `change.pct` is null when the previous figure was 0. */
export type Metric = {
  value: number | null;
  previous: number | null;
  change: { abs: number; pct: number | null } | null;
};

export type PeriodInfo = { start: string; end: string; label: string; days: number; preset?: string | null };

// ─── summary ──────────────────────────────────────────────────────────────────────────────────────────────────

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
    /** Live: left today on a pass and not scanned back in. */
    outsideNow: number;
    /** Live, all dates: requests nobody has decided yet. */
    waitingNow: { waiting: number; overOneDay: number; oldestMinutes: number | null };
  };
};

// ─── trend ────────────────────────────────────────────────────────────────────────────────────────────────────

export type TrendPoint = {
  /** The day, or the Monday of the week. */
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

export type TrendResponse = MdEnvelope & {
  granularity: "day" | "week";
  points: TrendPoint[];
  totals: Omit<TrendPoint, "key" | "start" | "end" | "days">;
};

// ─── units ────────────────────────────────────────────────────────────────────────────────────────────────────

export type UnitRow = {
  unitId: number | null;
  unit: string;
  visits: number;
  uniqueVisitors: number;
  afterHours: number;
  requests: number;
  approved: number;
  minutesOut: number | null;
  avgMinutes: number | null;
  notReturned: number;
  headcount: number | null;
  requestsPer100: number | null;
};

export type UnitsResponse = MdEnvelope & { units: UnitRow[] };

// ─── visitors ─────────────────────────────────────────────────────────────────────────────────────────────────

export type PurposeCategory = { key: string; label: string; visits: number; sharePct: number | null };
export type TypedPurpose = { text: string; visits: number };

export type HostDepartment = { department: string; visits: number; uniqueVisitors: number; sharePct: number | null };

export type TopHost = {
  employeeId: number | null;
  name: string;
  code: string | null;
  department: string | null;
  /** True when the gate form matched the person to an employee; false when it is only the name the visitor typed. */
  linked: boolean;
  visits: number;
  uniqueVisitors: number;
};

export type RepeatVisitor = {
  visitorId: number;
  visitorName: string;
  visits: number;
  hostsMet: number;
  firstVisitAt: string | null;
  lastVisitAt: string | null;
  lastPurpose: string | null;
};

export type Heatmap = { weekdays: string[]; hours: number[]; values: number[][]; max: number };

export type VisitorsResponse = MdEnvelope & {
  visits: number;
  uniqueVisitors: number;
  purposes: {
    categories: PurposeCategory[];
    otherSharePct: number | null;
    otherSamples: TypedPurpose[];
    typedTop: TypedPurpose[];
  };
  hostDepartments: HostDepartment[];
  hostsNotLinked: { visits: number; sharePct: number | null };
  topHosts: TopHost[];
  repeatVisitors: {
    total: number;
    visits: number;
    sharePct: number | null;
    frequentFrom: number;
    rows: RepeatVisitor[];
  };
  afterHours: { total: number; sharePct: number | null; startHour: number; endHour: number; label: string };
  peakHour: { hour: number; label: string; visits: number } | null;
  peakDay: { date: string; weekday: string; visits: number } | null;
  busiestWeekday: { weekday: string; visits: number } | null;
  heatmap?: Heatmap;
};

// ─── outpass ──────────────────────────────────────────────────────────────────────────────────────────────────

export type Funnel = {
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

export type DurationBucket = { key: string; label: string; passes: number; sharePct: number | null };

export type AgingBucket = { key: string; label: string; count: number };

export type GateScans = {
  attempts: number;
  successful: number;
  refused: number;
  refusedPct: number | null;
  byReason: { key: string; label: string; count: number }[];
  byGate: { gate: string; exits: number; returns: number; refused: number }[];
};

export type OutpassResponse = MdEnvelope & {
  requests: number;
  funnel: Funnel;
  byDepartment: DepartmentRow[];
  departmentsTotal: number;
  byReason: ReasonRow[];
  durations: {
    buckets: DurationBucket[];
    measured: number;
    medianMinutes: number | null;
    avgMinutes: number | null;
    longestMinutes: number | null;
  };
  totals: {
    minutesOut: number | null;
    hoursOut: number | null;
    avgMinutesOut: number | null;
    returnRatePct: number | null;
  };
  approvals: {
    turnaround: { avgMinutes: number | null; medianMinutes: number | null; decisions: number };
    rejectionRatePct: number | null;
    aging: { waiting: number; overOneDay: number; oldestMinutes: number | null; buckets: AgingBucket[] };
  };
  gateScans: GateScans;
};

// ─── exceptions ───────────────────────────────────────────────────────────────────────────────────────────────

/** The standard person keys of every row that is about an employee. */
export type EmployeeRef = { employeeId: number; name: string; code: string; department: string };

export type RepeatOutpassRow = EmployeeRef & {
  passes: number;
  personal: number;
  official: number;
  earlyDismissal: number;
  notStated: number;
  minutesOut: number;
  lastPassAt: string | null;
};

export type NotReturnedRow = EmployeeRef & {
  /** outside_now: left today and not back yet · not_returned: left on an earlier day, no return scan. */
  state: "outside_now" | "not_returned";
  stateLabel: string;
  passType: string;
  passTypeLabel: string;
  destination: string | null;
  exitedAt: string | null;
  daysAgo: number;
  minutesOutsideSoFar: number | null;
  expectedReturnAt: string | null;
};

export type LongOutpassRow = EmployeeRef & {
  minutes: number;
  passType: string;
  passTypeLabel: string;
  destination: string | null;
  exitedAt: string | null;
  enteredAt: string | null;
};

export type WaitingRow = EmployeeRef & {
  requestedAt: string | null;
  waitingMinutes: number | null;
  passType: string;
  passTypeLabel: string;
  destination: string | null;
  reason: string | null;
};

export type AfterHoursVisit = {
  visitId: number;
  visitedAt: string | null;
  visitorName: string;
  hostName: string | null;
  hostLinked: boolean;
  hostDepartment: string | null;
  purpose: string | null;
};

export type ExceptionsResponse = MdEnvelope & {
  thresholds: {
    repeatOutpass: { per30Days: number; forThisPeriod: number; criticalFrom: number };
    longOutpass: { minMinutes: number; factorOfTypical: number; typicalMinutes: number | null; forThisPeriod: number };
    approvalWaitHours: number;
    afterHours: { startHour: number; endHour: number; label: string };
    frequentVisitor: { per30Days: number; forThisPeriod: number };
  };
  attention: MdInsightDto[];
  repeatOutpass: { total: number; minimum: number; rows: RepeatOutpassRow[] };
  notReturned: {
    total: number;
    neverReturned: number;
    outsideNow: number;
    sharePct: number | null;
    rows: NotReturnedRow[];
  };
  longOutpasses: { total: number; thresholdMinutes: number; medianMinutes: number | null; rows: LongOutpassRow[] };
  approvalsWaiting: { total: number; pendingTotal: number; oldestMinutes: number | null; rows: WaitingRow[] };
  afterHoursVisits: { total: number; rows: AfterHoursVisit[] };
  frequentVisitors: { total: number; minimum: number; rows: RepeatVisitor[] };
};

// ─── activity ─────────────────────────────────────────────────────────────────────────────────────────────────

export type VisitItem = {
  kind: "visit";
  id: string;
  at: string | null;
  visitorName: string;
  hostName: string | null;
  hostLinked: boolean;
  hostDepartment: string | null;
  purpose: string | null;
  branch: string | null;
};

export type PassItem = EmployeeRef & {
  kind: "outpass";
  id: string;
  at: string | null;
  passType: string;
  passTypeLabel: string;
  destination: string | null;
  status: "pending" | "approved" | "rejected";
  outcome: string;
  outcomeLabel: string;
  exitedAt: string | null;
  enteredAt: string | null;
  minutesOut: number | null;
};

export type FormItem = {
  kind: "gate_form";
  id: string;
  at: string | null;
  employeeId: number | null;
  name: string | null;
  code: string | null;
  department: string | null;
  matched: boolean;
  destination: string | null;
  branch: string | null;
};

export type ActivityItem = VisitItem | PassItem | FormItem;

export type ActivityKind = "all" | "visits" | "outpasses" | "gate_form";

export type ActivityResponse = MdEnvelope & {
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
  kind: ActivityKind;
  q: string;
  counts: { visits: number; outpasses: number; gateForm: number };
  items: ActivityItem[];
};
