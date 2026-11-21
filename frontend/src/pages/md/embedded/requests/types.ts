import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";

// The answers of /api/md/requests/* (backend: api/md_portal/analytics/requests.py). The MD only looks at requests: HR and
// the Department Heads decide them.

export type Holder = "hr" | "hod" | "either";
export type Band = "under_1d" | "1_3d" | "3_7d" | "over_7d";
export type ListStatus = "waiting" | "submitted" | "decided" | "approved" | "rejected";

export type Change = { abs: number; pct: number | null } | null;
export type Metric<T = number | null> = { value: T; previous: T; change: Change };

export type KindMeta = { key: string; label: string; onRequestsPage: boolean };
export type BandCount = { key: Band; label: string; count: number };

export type WaitingBlock = {
  total: number;
  oldestHours: number | null;
  oldestDays: number | null;
  agedDays: number;
  threeDaysPlus: number;
  sevenDaysPlus: number;
  withHr: number;
  withDepartmentHead: number;
  withEither: number;
  hrCanDecide: number;
  advanceAmount: number;
  buckets: BandCount[];
  oldestKind: string | null;
  agedByKind: Record<string, number>;
};

export type Sentence = { id: string; tone: string; text: string };

export type RqSummary = MdEnvelope & {
  kind: string;
  kindLabel: string;
  kinds: KindMeta[];
  waiting: WaitingBlock;
  metrics: {
    submitted: Metric<number>;
    decided: Metric<number>;
    approved: Metric<number>;
    rejected: Metric<number>;
    approvalPct: Metric;
    rejectionPct: Metric;
    medianHours: Metric;
    p90Hours: Metric;
    withinDayPct: Metric;
  };
  previousPeriod: { start: string; end: string; label: string; days: number };
  slaHours: number;
  briefing: { sentences: Sentence[]; ask: string };
};

export type HolderRow = {
  key: Holder;
  label: string;
  total: number;
  buckets: BandCount[];
  threeDaysPlus: number;
  oldestHours: number | null;
  hrCanDecide: number;
};

export type RqWaiting = MdEnvelope & {
  total: number;
  oldestHours: number | null;
  threeDaysPlus: number;
  buckets: BandCount[];
  byKind: {
    key: string;
    label: string;
    total: number;
    buckets: BandCount[];
    threeDaysPlus: number;
    oldestHours: number | null;
    withHr: number;
    withDepartmentHead: number;
    withEither: number;
  }[];
  byHolder: HolderRow[];
};

export type BreakdownBy = "kind" | "department" | "unit" | "type";

export type BreakdownRow = {
  key: string;
  label: string;
  submitted: number;
  people: number;
  decided: number;
  approved: number;
  rejected: number;
  approvalPct: number | null;
  rejectionPct: number | null;
  medianHours: number | null;
  p90Hours: number | null;
  withinDayPct: number | null;
  waiting: number;
  threeDaysPlus: number;
  oldestHours: number | null;
  lowSample: boolean;
  previous: { submitted: number };
  change: { submitted: Change };
};

export type RqBreakdown = MdEnvelope & {
  by: BreakdownBy;
  rows: BreakdownRow[];
  total: number;
  truncated: boolean;
  overall: { submitted: number; decided: number; approvalPct: number | null; medianHours: number | null };
  minSample: number;
};

export type TrendPoint = {
  date: string;
  endDate: string;
  submitted: number;
  byKind: Record<string, number>;
  previousSubmitted: number;
  decided: number;
  approved: number;
  rejected: number;
  medianHours: number | null;
  p90Hours: number | null;
};

export type RqTrend = MdEnvelope & {
  granularity: "day" | "week";
  points: TrendPoint[];
  kinds: { key: string; label: string; submitted: number }[];
  totals: { submitted: Metric<number>; decided: { value: number } };
};

export type RqBottlenecks = MdEnvelope & {
  holders: {
    key: Holder;
    label: string;
    waiting: number;
    threeDaysPlus: number;
    oldestHours: number | null;
    hrCanDecide: number;
  }[];
  departments: {
    key: string;
    label: string;
    waiting: number;
    threeDaysPlus: number;
    oldestHours: number | null;
    withDepartmentHead: number;
    departmentHeadThreeDaysPlus: number;
    decided: number;
    medianHours: number | null;
    p90Hours: number | null;
    lowSample: boolean;
  }[];
  departmentsTotal: number;
  approvers: {
    approverName: string;
    role: string | null;
    roleLabel: string | null;
    decided: number;
    approved: number;
    rejected: number;
    medianHours: number | null;
    p90Hours: number | null;
    lowSample: boolean;
  }[];
  approversTotal: number;
  agedDays: number;
};

export type RqRejections = MdEnvelope & {
  rejected: Metric<number>;
  withReason: number;
  withoutReason: number;
  reasons: {
    key: string;
    reason: string;
    count: number;
    sharePct: number | null;
    kinds: { key: string; label: string }[];
  }[];
  otherReasons: { distinct: number; count: number };
  byKind: {
    key: string;
    label: string;
    rejected: number;
    decided: number;
    rejectionPct: number | null;
    withReason: number;
    lowSample: boolean;
  }[];
};

export type RqAttention = MdEnvelope & { items: MdInsightDto[] };

export type Requested = {
  from: string;
  to: string | null;
  note: string | null;
  label: string;
  precision: "day" | "month";
};

export type RqListItem = {
  key: string;
  kind: string;
  kindLabel: string;
  id: number;
  employee: {
    id: number;
    name: string;
    code: string | null;
    department: string | null;
    unit: string | null;
    type: string | null;
  };
  what: string;
  requested: Requested | null;
  reason: string | null;
  reasonLabel: string;
  submittedAt: string | null;
  outcome: "waiting" | "approved" | "rejected" | "other";
  ageHours: number | null;
  band: Band | null;
  holder: Holder | null;
  holderLabel: string | null;
  hrCanDecide: boolean;
  decidedAt: string | null;
  decisionHours: number | null;
  decidedBy: string | null;
  decidedByRole: string | null;
  decisionRemark: string | null;
  amount: number | null;
  requestedAmount: number | null;
  partial: boolean;
};

export type RqList = MdEnvelope & {
  status: ListStatus;
  asOf: string;
  items: RqListItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

/** What a drill-down shows: a title, a sentence under it, and the list endpoint's own filters. */
export type Drill = {
  title: string;
  subtitle?: string;
  params: Record<string, string>;
  ask?: string;
};
