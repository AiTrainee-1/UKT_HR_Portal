import type {
  RqAttention,
  RqBottlenecks,
  RqBreakdown,
  RqList,
  RqListItem,
  RqRejections,
  RqSummary,
  RqTrend,
  RqWaiting,
} from "./types";

// A small company (the backend test world of tests_md_requests.py): 8 requests waiting now, W = 9 .. 15 Nov 2026.

const env = {
  generatedAt: "2026-11-20T12:00:00",
  period: { start: "2026-11-09", end: "2026-11-15", preset: "custom", label: "09 Nov – 15 Nov 2026", days: 7 },
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: [
    {
      id: "requests-waiting",
      title: "Requests waiting",
      dataset: "Every kind of request",
      definition: "Requests nobody has decided yet.",
      formula: null,
      rows: 8,
      filters: [],
      caveats: [],
    },
  ],
  notes: [],
};

const bands = (a: number, b: number, c: number, d: number) => [
  { key: "under_1d" as const, label: "Under 1 day", count: a },
  { key: "1_3d" as const, label: "1 to 3 days", count: b },
  { key: "3_7d" as const, label: "3 to 7 days", count: c },
  { key: "over_7d" as const, label: "7 days or more", count: d },
];

const metric = <T extends number | null>(
  value: T,
  previous: T,
  abs: number | null = null,
  p: number | null = null,
) => ({
  value,
  previous,
  change: abs == null ? null : { abs, pct: p },
});

export const summary: RqSummary = {
  ...env,
  notes: ["1 request made in this period was decided before decision times were kept."],
  kind: "all",
  kindLabel: "All requests",
  kinds: [],
  waiting: {
    total: 8,
    oldestHours: 240,
    oldestDays: 10,
    agedDays: 3,
    threeDaysPlus: 3,
    sevenDaysPlus: 2,
    withHr: 4,
    withDepartmentHead: 2,
    withEither: 2,
    hrCanDecide: 6,
    advanceAmount: 30000,
    buckets: bands(3, 2, 1, 2),
    oldestKind: "request",
    agedByKind: { request: 1, advance: 1, missing_punch: 1 },
  },
  metrics: {
    submitted: metric(6, 3, 3, 100),
    decided: metric(5, 2, 3, 150),
    approved: metric(2, 1, 1, 100),
    rejected: metric(3, 1, 2, 200),
    approvalPct: metric(40, 50, -10, -20),
    rejectionPct: metric(60, 50, 10, 20),
    medianHours: metric(24, 2, 22, 1100),
    p90Hours: metric(110.4, 2, 108.4, 5420),
    withinDayPct: metric(40, 100, -60, -60),
  },
  previousPeriod: { start: "2026-11-02", end: "2026-11-08", label: "Previous 7 days", days: 7 },
  slaHours: 24,
  briefing: {
    ask: "Brief me on requests (09 Nov – 15 Nov 2026).",
    sentences: [
      {
        id: "waiting",
        tone: "neutral",
        text: "8 requests are waiting for a decision: 4 with HR, 2 with Department Heads and 2 that HR or the Department Head can decide. HR can act on 6 of them now.",
      },
      { id: "aged", tone: "watch", text: "3 have waited 3 days or more, the oldest 10 days (other requests)." },
    ],
  },
};

export const attention: RqAttention = {
  ...env,
  items: [
    {
      id: "requests.repeat",
      severity: "info",
      title: "1 person made 5 or more requests",
      detail: "The names are on the Requests page.",
      metric: "1",
      page: "requests",
      ask: "Who made 5 or more requests?",
    },
    {
      id: "requests.aging",
      severity: "critical",
      title: "3 requests have waited 3 days or more",
      detail: "The oldest has waited 10 days.",
      metric: "3 waiting",
      page: "requests",
      ask: "Which requests have been waiting 3 days or more?",
    },
  ],
};

export const trend: RqTrend = {
  ...env,
  granularity: "day",
  points: ["09", "10", "11", "12", "13", "14", "15"].map((d, i) => ({
    date: `2026-11-${d}`,
    endDate: `2026-11-${d}`,
    submitted: [1, 2, 0, 1, 1, 1, 0][i],
    byKind: {},
    previousSubmitted: [0, 1, 1, 1, 0, 0, 0][i],
    decided: [1, 1, 1, 1, 0, 0, 1][i],
    approved: 0,
    rejected: 0,
    medianHours: null,
    p90Hours: null,
  })),
  kinds: [],
  totals: { submitted: { value: 6, previous: 3, change: { abs: 3, pct: 100 } }, decided: { value: 5 } },
};

export const waiting: RqWaiting = {
  ...env,
  total: 8,
  oldestHours: 240,
  threeDaysPlus: 3,
  buckets: bands(3, 2, 1, 2),
  byKind: [
    {
      key: "missing_punch",
      label: "Missing punch",
      total: 2,
      buckets: bands(0, 1, 1, 0),
      threeDaysPlus: 1,
      oldestHours: 96,
      withHr: 1,
      withDepartmentHead: 1,
      withEither: 0,
    },
    {
      key: "request",
      label: "Other requests",
      total: 1,
      buckets: bands(0, 0, 0, 1),
      threeDaysPlus: 1,
      oldestHours: 240,
      withHr: 1,
      withDepartmentHead: 0,
      withEither: 0,
    },
  ],
  byHolder: [
    {
      key: "hr",
      label: "HR",
      total: 4,
      buckets: bands(1, 0, 1, 2),
      threeDaysPlus: 3,
      oldestHours: 240,
      hrCanDecide: 4,
    },
    {
      key: "hod",
      label: "Department Head",
      total: 2,
      buckets: bands(0, 2, 0, 0),
      threeDaysPlus: 0,
      oldestHours: 48,
      hrCanDecide: 0,
    },
    {
      key: "either",
      label: "HR or Department Head",
      total: 2,
      buckets: bands(2, 0, 0, 0),
      threeDaysPlus: 0,
      oldestHours: 18,
      hrCanDecide: 2,
    },
  ],
};

const row = (
  key: string,
  label: string,
  submitted: number,
  decided: number,
  approvalPct: number | null,
  waitingN: number,
) => ({
  key,
  label,
  submitted,
  people: submitted,
  decided,
  approved: 0,
  rejected: 0,
  approvalPct,
  rejectionPct: null,
  medianHours: decided ? 24 : null,
  p90Hours: null,
  withinDayPct: null,
  waiting: waitingN,
  threeDaysPlus: 0,
  oldestHours: null,
  lowSample: decided < 5,
  previous: { submitted: 0 },
  change: { submitted: null },
});

export function breakdown(params: URLSearchParams): RqBreakdown {
  const by = (params.get("by") ?? "kind") as RqBreakdown["by"];
  const rows =
    by === "department"
      ? [row("Stitching", "Stitching", 3, 2, 50, 5), row("Accounts", "Accounts", 2, 1, 100, 1)]
      : [row("leave", "Leave", 2, 2, 50, 1), row("advance", "Advance", 2, 1, 100, 1)];
  return {
    ...env,
    by,
    rows,
    total: rows.length,
    truncated: false,
    overall: { submitted: 6, decided: 5, approvalPct: 40, medianHours: 24 },
    minSample: 5,
  };
}

export const bottlenecks: RqBottlenecks = {
  ...env,
  holders: [],
  departments: [
    {
      key: "Stitching",
      label: "Stitching",
      waiting: 5,
      threeDaysPlus: 1,
      oldestHours: 168,
      withDepartmentHead: 2,
      departmentHeadThreeDaysPlus: 0,
      decided: 2,
      medianHours: 14,
      p90Hours: 22,
      lowSample: true,
    },
  ],
  departmentsTotal: 1,
  approvers: [
    {
      approverName: "Head Kumar",
      role: "hod",
      roleLabel: "Department Head",
      decided: 1,
      approved: 0,
      rejected: 1,
      medianHours: 24,
      p90Hours: 24,
      lowSample: true,
    },
  ],
  approversTotal: 1,
  agedDays: 3,
};

export const rejections: RqRejections = {
  ...env,
  rejected: { value: 3, previous: 1, change: { abs: 2, pct: 200 } },
  withReason: 2,
  withoutReason: 1,
  reasons: [
    {
      key: "too many permissions",
      reason: "Too many  permissions",
      count: 2,
      sharePct: 100,
      kinds: [
        { key: "casual_leave", label: "Casual leave" },
        { key: "permission", label: "Permission" },
      ],
    },
  ],
  otherReasons: { distinct: 0, count: 0 },
  byKind: [{ key: "leave", label: "Leave", rejected: 1, decided: 2, rejectionPct: 50, withReason: 0, lowSample: true }],
};

const item = (over: Partial<RqListItem>): RqListItem => ({
  key: "request-4",
  kind: "request",
  kindLabel: "Other requests",
  id: 4,
  employee: { id: 5, name: "Esha Test", code: "R005", department: "Accounts", unit: "Head Office", type: "staff" },
  what: "General Query · Salary letter",
  requested: null,
  reason: "For a bank loan",
  reasonLabel: "Description",
  submittedAt: "2026-11-10T12:00:00",
  outcome: "waiting",
  ageHours: 240,
  band: "over_7d",
  holder: "hr",
  holderLabel: "HR",
  hrCanDecide: true,
  decidedAt: null,
  decisionHours: null,
  decidedBy: null,
  decidedByRole: null,
  decisionRemark: null,
  amount: null,
  requestedAmount: null,
  partial: false,
  ...over,
});

export const listItems: RqListItem[] = [
  item({}),
  item({
    key: "permission-12",
    kind: "permission",
    kindLabel: "Permission",
    id: 12,
    employee: { id: 2, name: "Bala Test", code: "R002", department: "Stitching", unit: "Unit A", type: "staff" },
    what: "Permission · Evening Early-Out",
    requested: { from: "2026-11-10", to: null, note: "at 17:00", label: "Requested date", precision: "day" },
    reason: "Doctor",
    reasonLabel: "Reason",
    outcome: "rejected",
    ageHours: null,
    band: null,
    holder: null,
    holderLabel: null,
    hrCanDecide: false,
    decidedAt: "2026-11-11T10:00:00",
    decisionHours: 24,
    decidedBy: "Head Kumar",
    decidedByRole: "Department Head",
    decisionRemark: "Too many  permissions",
  }),
];

export function list(params: URLSearchParams): RqList {
  const status = (params.get("status") ?? "waiting") as RqList["status"];
  const items = status === "rejected" ? listItems.slice(1) : status === "waiting" ? listItems.slice(0, 1) : listItems;
  return { ...env, status, asOf: "2026-11-20T12:00:00", items, total: items.length, page: 1, pageSize: 25, pages: 1 };
}

// ── empty ──
const emptyWaiting = {
  ...summary.waiting,
  total: 0,
  oldestHours: null,
  oldestDays: null,
  threeDaysPlus: 0,
  sevenDaysPlus: 0,
  withHr: 0,
  withDepartmentHead: 0,
  withEither: 0,
  hrCanDecide: 0,
  advanceAmount: 0,
  buckets: bands(0, 0, 0, 0),
  oldestKind: null,
  agedByKind: {},
};
export const emptySummary: RqSummary = {
  ...summary,
  notes: [],
  waiting: emptyWaiting,
  metrics: {
    submitted: metric(0, 0),
    decided: metric(0, 0),
    approved: metric(0, 0),
    rejected: metric(0, 0),
    approvalPct: metric(null, null),
    rejectionPct: metric(null, null),
    medianHours: metric(null, null),
    p90Hours: metric(null, null),
    withinDayPct: metric(null, null),
  } as RqSummary["metrics"],
  briefing: {
    ask: "Brief me",
    sentences: [{ id: "waiting", tone: "good", text: "Nothing is waiting for a decision right now." }],
  },
};
export const emptyAttention: RqAttention = { ...env, items: [] };
export const emptyTrend: RqTrend = {
  ...trend,
  points: trend.points.map((p) => ({ ...p, submitted: 0, decided: 0, previousSubmitted: 0 })),
};
export const emptyWaitingResponse: RqWaiting = {
  ...waiting,
  total: 0,
  oldestHours: null,
  threeDaysPlus: 0,
  buckets: bands(0, 0, 0, 0),
  byKind: [],
  byHolder: [],
};
export const emptyBreakdown = (params: URLSearchParams): RqBreakdown => ({ ...breakdown(params), rows: [], total: 0 });
export const emptyBottlenecks: RqBottlenecks = { ...bottlenecks, departments: [], approvers: [] };
export const emptyRejections: RqRejections = {
  ...rejections,
  rejected: { value: 0, previous: 0, change: null },
  withReason: 0,
  withoutReason: 0,
  reasons: [],
  byKind: [],
};
