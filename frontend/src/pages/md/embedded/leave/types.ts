import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";

// The answers of /api/md/leave/* (backend: api/md_portal/analytics/leave.py). The MD only looks at leave: HR and the
// Department Heads decide requests.

export type Change = { abs: number; pct: number | null } | null;
export type Metric<T = number | null> = { value: T; previous: T; change: Change };
export type Sentence = { id: string; tone: string; text: string };

export type LvSummary = MdEnvelope & {
  metrics: {
    leaveDays: Metric<number>;
    employeesOnLeave: Metric<number>;
    daysPerEmployee: Metric;
    leaveRatePct: Metric;
    applied: Metric<number>;
    rejectionPct: Metric;
    shortNoticePct: Metric;
  };
  eligibleHeadcount: number;
  workingDays: number;
  previousPeriod: { start: string; end: string; label: string; days: number };
  requests: { applied: number; approved: number; rejected: number; pending: number; decided: number };
  pending: {
    count: number;
    oldestDays: number | null;
    averageDays: number | null;
    waitingTooLong: number;
    pastStart: number;
    buckets: { label: string; count: number }[];
  };
};

export type LvBriefing = MdEnvelope & { sentences: Sentence[]; text: string; ask: string };

export type LvTrend = MdEnvelope & {
  granularity: "day" | "week" | "month";
  points: { date: string; days: number; leaveDays: number; onLeave: number; byType: Record<string, number> }[];
  previousPoints: { date: string; leaveDays: number }[];
  types: { key: string; label: string; days: number }[];
  totalDays: number;
  averagePerWorkingDay: number | null;
  busiestDay: { date: string; onLeave: number; leaveDays: number } | null;
  momentum: { verdict: "rising" | "falling" | "steady" | "unclear"; text: string };
};

export type GroupBy = "type" | "department" | "unit" | "reason";

export type LvGroupRow = {
  key: string;
  label: string;
  sub: string | null;
  leaveDays: number;
  previousDays: number;
  change: Change;
  sharePct: number | null;
  employeesOnLeave: number;
  requests: number;
  headcount: number | null;
  daysPerEmployee: number | null;
  leaveRatePct: number | null;
  vsCompany: number | null;
  lowSample: boolean;
};

export type LvGroups = MdEnvelope & {
  by: GroupBy;
  rows: LvGroupRow[];
  total: number;
  truncated: boolean;
  average: { leaveDays: number; daysPerEmployee: number | null; headcount: number };
  minGroupHeads: number;
};

export type LvToday = MdEnvelope & {
  date: string;
  weekday: string;
  isToday: boolean;
  holiday: string | null;
  outToday: { people: number; fullDay: number; halfDay: number; pct: number | null; headcount: number };
  week: {
    date: string;
    weekday: string;
    out: number;
    halfDay: number;
    holiday: string | null;
    isSunday: boolean;
    isTarget: boolean;
  }[];
  weekPeople: number;
  startingSoon: number;
  byDepartment: { label: string; out: number; headcount: number | null; outPct: number | null }[];
};

export type LvCasual = {
  entitlement: number;
  tracked: boolean;
  since: string | null;
  cutOver: string;
  employees: number;
  used: number;
  pending: number;
  remaining: number;
  usedPct: number | null;
  exhausted: number;
  low: number;
  lowDays: number;
  untouched: number;
  halfDays: number;
  carryForward: { employees: number; days: number };
  byDepartment: {
    label: string;
    employees: number;
    used: number;
    pending: number;
    usedPct: number | null;
    usedPerEmployee: number | null;
  }[];
  lowest: {
    employeeId: number;
    employeeCode: string;
    employeeName: string;
    department: string;
    unit: string;
    used: number;
    pending: number;
    remaining: number;
    carryForwardDays: number;
  }[];
};

export type LvBalances = MdEnvelope & {
  year: number;
  yearProgressPct: number;
  casual: LvCasual;
  totals: {
    employees: number;
    allocated: number;
    used: number;
    unused: number;
    usedPct: number | null;
    exhausted: number;
    low: number;
  };
};

export type LvPermissionCounts = {
  requested: number;
  approved: number;
  rejected: number;
  pending: number;
  excess: number;
  excessPct: number | null;
  people: number;
};

export type LvPermissions = MdEnvelope & {
  cap: number;
  totals: LvPermissionCounts;
  metrics: Record<"requested" | "approved" | "rejected" | "excess" | "excessPct", Metric>;
  byType: ({ key: string; label: string } & LvPermissionCounts)[];
  byDepartment: ({ key: string; label: string } & LvPermissionCounts)[];
  overCap: {
    employeeId: number;
    employeeCode: string;
    employeeName: string;
    department: string;
    unit: string;
    approved: number;
    excess: number;
  }[];
  overCapTotal: number;
};

export type LvApprovals = MdEnvelope & {
  cohort: {
    applied: number;
    approved: number;
    rejected: number;
    pending: number;
    decided: number;
    rejectionPct: number | null;
    shortNotice: number;
    shortNoticePct: number | null;
  };
  decisionTime: { known: number; decided: number; medianHours: number | null; withinDayPct: number | null };
  rejectionByType: { label: string; applied: number; rejected: number; rejectionPct: number | null }[];
  rejectionByReason: { label: string; applied: number; rejected: number; rejectionPct: number | null }[];
  rejectReasons: {
    rejected: number;
    withReason: number;
    withoutReason: number;
    rows: { key: string; reason: string; count: number; sharePct: number | null }[];
  };
  pending: { count: number; oldestDays: number | null; total: number };
};

export type LvAttention = MdEnvelope & { items: MdInsightDto[] };

export type LvWhat = "requests" | "days" | "out" | "cl" | "permissions";

/** One row of /leave/list: the fields depend on `what` (see the backend's leave_list). */
export type LvListItem = {
  key: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string;
  unit: string;
  requestId?: number;
  type?: string;
  from?: string | null;
  to?: string | null;
  days?: number;
  daysInPeriod?: number;
  halfDay?: string | null;
  status?: string;
  appliedOn?: string | null;
  noticeDays?: number | null;
  waitingDays?: number | null;
  stage?: string | null;
  reasonCategory?: string | null;
  reasonGroup?: string;
  reason?: string | null;
  remark?: string | null;
  decidedBy?: string | null;
  casual?: boolean;
  carryForward?: boolean;
  used?: number;
  pending?: number;
  remaining?: number;
  carryForwardDays?: number;
  carryForwardDates?: string[];
  date?: string;
  time?: string | null;
  overCap?: boolean;
};

export type LvList = MdEnvelope & {
  what: LvWhat;
  title: string;
  items: LvListItem[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type Drill = { title: string; subtitle?: string; params: Record<string, string>; ask?: string };
