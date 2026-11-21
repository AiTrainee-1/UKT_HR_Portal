import type {
  LvApprovals,
  LvAttention,
  LvBalances,
  LvBriefing,
  LvGroups,
  LvList,
  LvListItem,
  LvPermissions,
  LvSummary,
  LvToday,
  LvTrend,
} from "./types";

// The backend test world of tests_md_leave.py: W = 9 .. 15 Nov 2026, 4 staff, 6 leave days.

const env = {
  generatedAt: "2026-11-20T10:00:00",
  period: { start: "2026-11-09", end: "2026-11-15", preset: "custom", label: "09 Nov – 15 Nov 2026", days: 7 },
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: [
    {
      id: "leave-days",
      title: "Leave days taken",
      dataset: "Leave requests (approved), casual leave requests",
      definition: "Days of approved leave inside the period.",
      formula: null,
      rows: 5,
      filters: [],
      caveats: [],
    },
  ],
  notes: [],
};

const m = <T extends number | null>(value: T, previous: T, abs: number | null = null, pctv: number | null = null) => ({
  value,
  previous,
  change: abs == null ? null : { abs, pct: pctv },
});

export const summary: LvSummary = {
  ...env,
  notes: ["1 approved leave request by production employees are not counted: attendance does not use leave for them."],
  metrics: {
    leaveDays: m(6, 1, 5, 500),
    employeesOnLeave: m(4, 1, 3, 300),
    daysPerEmployee: m(1.5, 0.25, 1.25, 500),
    leaveRatePct: m(30, 4.2, 25.8, 614.3),
    applied: m(4, 2, 2, 100),
    rejectionPct: m(33.3, 0, 33.3, null),
    shortNoticePct: m(50, 0, 50, null),
  },
  eligibleHeadcount: 4,
  workingDays: 5,
  previousPeriod: { start: "2026-11-02", end: "2026-11-08", label: "Previous 7 days", days: 7 },
  requests: { applied: 4, approved: 2, rejected: 1, pending: 1, decided: 3 },
  pending: { count: 1, oldestDays: 8, averageDays: 8, waitingTooLong: 1, pastStart: 0, buckets: [] },
};

export const briefing: LvBriefing = {
  ...env,
  ask: "Give me a briefing on leave and holidays.",
  text: "",
  sentences: [
    {
      id: "volume",
      tone: "watch",
      text: "09 Nov – 15 Nov 2026: 6 days of approved leave taken by 4 employees, 30% of working days.",
    },
    {
      id: "permissions",
      tone: "neutral",
      text: "5 permissions dated in 09 Nov – 15 Nov 2026, 3 approved; 2 of the approved went beyond the monthly cap of 3 and shift nothing.",
    },
  ],
};

export const attention: LvAttention = {
  ...env,
  items: [
    {
      id: "leave.pending",
      severity: "warning",
      title: "1 leave request has waited 8 days",
      detail: "Bala Test's leave for 23 Nov.",
      metric: "8 days",
      page: "leave",
      ask: "Which leave requests are waiting too long?",
    },
  ],
};

export const trend: LvTrend = {
  ...env,
  granularity: "day",
  points: ["09", "10", "11", "12", "13", "14", "15"].map((d, i) => ({
    date: `2026-11-${d}`,
    days: 1,
    leaveDays: [1, 1, 1, 1, 1, 1, 0][i],
    onLeave: [1, 1, 1, 1, 2, 1, 0][i],
    byType: { "casual-paid": [0, 0, 0, 1, 0.5, 0, 0][i], "x:casual": [1, 1, 1, 0, 0.5, 1, 0][i] },
  })),
  previousPoints: ["02", "03", "04", "05", "06", "07", "08"].map((d, i) => ({
    date: `2026-11-${d}`,
    leaveDays: i === 1 ? 1 : 0,
  })),
  types: [
    { key: "x:casual", label: "Casual (untyped)", days: 4.5 },
    { key: "casual-paid", label: "Casual leave", days: 1.5 },
  ],
  totalDays: 6,
  averagePerWorkingDay: 1.2,
  busiestDay: { date: "2026-11-13", onLeave: 2, leaveDays: 1 },
  momentum: {
    verdict: "rising",
    text: "Leave is rising: 6 days in the 7 days to 15 Nov, up 500% on the 7 days before (1 day).",
  },
};

const g = (key: string, label: string, days: number, prev: number, share: number | null, people: number) => ({
  key,
  label,
  sub: null,
  leaveDays: days,
  previousDays: prev,
  change: null,
  sharePct: share,
  employeesOnLeave: people,
  requests: people,
  headcount: null,
  daysPerEmployee: null,
  leaveRatePct: null,
  vsCompany: null,
  lowSample: false,
});

export function groups(params: URLSearchParams): LvGroups {
  const by = (params.get("by") ?? "type") as LvGroups["by"];
  const rows =
    by === "reason"
      ? [
          g("Sick Leave", "Sick Leave", 3, 0, 50, 1),
          g("Casual leave", "Casual leave", 1.5, 0, 25, 2),
          g("Reason not picked", "Reason not picked", 0, 1, 0, 0),
        ]
      : [g("x:casual", "Casual (untyped)", 4.5, 1, 75, 3), g("casual-paid", "Casual leave", 1.5, 0, 25, 2)];
  return {
    ...env,
    by,
    rows,
    total: rows.length,
    truncated: false,
    average: { leaveDays: 6, daysPerEmployee: 1.5, headcount: 4 },
    minGroupHeads: 5,
  };
}

export const today: LvToday = {
  ...env,
  date: "2026-11-20",
  weekday: "Fri",
  isToday: true,
  holiday: null,
  outToday: { people: 1, fullDay: 1, halfDay: 0, pct: 25, headcount: 4 },
  week: ["16", "17", "18", "19", "20", "21", "22"].map((d, i) => ({
    date: `2026-11-${d}`,
    weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i],
    out: [1, 1, 0, 0, 1, 0, 0][i],
    halfDay: 0,
    holiday: null,
    isSunday: i === 6,
    isTarget: i === 4,
  })),
  weekPeople: 2,
  startingSoon: 1,
  byDepartment: [{ label: "Cutting", out: 1, headcount: 1, outPct: 100 }],
};

export const balances: LvBalances = {
  ...env,
  year: 2026,
  yearProgressPct: 88.5,
  totals: { employees: 0, allocated: 0, used: 0, unused: 0, usedPct: null, exhausted: 0, low: 0 },
  casual: {
    entitlement: 12,
    tracked: true,
    since: "2026-11-02",
    cutOver: "2026-11-02",
    employees: 4,
    used: 2.5,
    pending: 0.5,
    remaining: 45,
    usedPct: 5.2,
    exhausted: 0,
    low: 0,
    lowDays: 2,
    untouched: 0,
    halfDays: 2,
    carryForward: { employees: 1, days: 1 },
    byDepartment: [{ label: "Cutting", employees: 1, used: 1, pending: 0, usedPct: 8.3, usedPerEmployee: 1 }],
    lowest: [],
  },
};

export const permissions: LvPermissions = {
  ...env,
  cap: 3,
  totals: { requested: 5, approved: 3, rejected: 1, pending: 1, excess: 2, excessPct: 66.7, people: 3 },
  metrics: {
    requested: m(5, 3, 2, 66.7),
    approved: m(3, 3, 0, 0),
    rejected: m(1, 0, 1, null),
    excess: m(2, 0, 2, null),
    excessPct: m(66.7, 0, 66.7, null),
  },
  byType: [
    {
      key: "evening_early_out",
      label: "Evening Early-Out",
      requested: 3,
      approved: 2,
      rejected: 1,
      pending: 0,
      excess: 2,
      excessPct: 100,
      people: 2,
    },
    {
      key: "morning_late_in",
      label: "Morning Late-In",
      requested: 1,
      approved: 1,
      rejected: 0,
      pending: 0,
      excess: 0,
      excessPct: 0,
      people: 1,
    },
  ],
  byDepartment: [],
  overCap: [
    {
      employeeId: 11,
      employeeCode: "L001",
      employeeName: "Asha Test",
      department: "Stitching",
      unit: "Unit A",
      approved: 2,
      excess: 2,
    },
  ],
  overCapTotal: 1,
};

export const approvals: LvApprovals = {
  ...env,
  cohort: {
    applied: 4,
    approved: 2,
    rejected: 1,
    pending: 1,
    decided: 3,
    rejectionPct: 33.3,
    shortNotice: 2,
    shortNoticePct: 50,
  },
  decisionTime: { known: 2, decided: 3, medianHours: 6.5, withinDayPct: 100 },
  rejectionByType: [],
  rejectionByReason: [{ label: "Personal", applied: 1, rejected: 0, rejectionPct: 0 }],
  rejectReasons: {
    rejected: 1,
    withReason: 1,
    withoutReason: 0,
    rows: [{ key: "busy month", reason: "Busy month", count: 1, sharePct: 100 }],
  },
  pending: { count: 1, oldestDays: 8, total: 1 },
};

const listRow = (over: Partial<LvListItem>): LvListItem => ({
  key: "leave-5",
  employeeId: 15,
  employeeCode: "L005",
  employeeName: "Esha Test",
  department: "Accounts",
  unit: "Head Office",
  requestId: 5,
  type: "Casual (untyped)",
  from: "2026-11-12",
  to: "2026-11-12",
  days: 1,
  status: "rejected",
  appliedOn: "2026-11-10",
  noticeDays: 2,
  reasonCategory: null,
  reason: null,
  remark: "Busy month",
  decidedBy: "Priya",
  ...over,
});

export function list(params: URLSearchParams): LvList {
  const what = (params.get("what") ?? "requests") as LvList["what"];
  const items =
    what === "cl"
      ? [
          listRow({
            key: "cl-11",
            employeeId: 11,
            employeeCode: "L001",
            employeeName: "Asha Test",
            department: "Stitching",
            unit: "Unit A",
            requestId: undefined,
            type: undefined,
            from: undefined,
            to: undefined,
            days: undefined,
            status: undefined,
            remark: undefined,
            decidedBy: undefined,
            appliedOn: undefined,
            noticeDays: undefined,
            used: 1,
            pending: 0,
            remaining: 11,
            carryForwardDays: 1,
            carryForwardDates: ["2026-09-28"],
          }),
        ]
      : [listRow({})];
  return { ...env, what, title: "Leave", items, total: items.length, page: 1, pageSize: 25, pages: 1 };
}

// ── empty ──
export const emptySummary: LvSummary = {
  ...summary,
  notes: [],
  metrics: {
    leaveDays: m(0, 0),
    employeesOnLeave: m(0, 0),
    daysPerEmployee: m(null, null),
    leaveRatePct: m(null, null),
    applied: m(0, 0),
    rejectionPct: m(null, null),
    shortNoticePct: m(null, null),
  } as LvSummary["metrics"],
  eligibleHeadcount: 0,
  requests: { applied: 0, approved: 0, rejected: 0, pending: 0, decided: 0 },
  pending: { count: 0, oldestDays: null, averageDays: null, waitingTooLong: 0, pastStart: 0, buckets: [] },
};
export const emptyBriefing: LvBriefing = {
  ...briefing,
  sentences: [{ id: "volume", tone: "neutral", text: "No approved leave was taken in 09 Nov – 15 Nov 2026." }],
};
export const emptyAttention: LvAttention = { ...env, items: [] };
export const emptyTrend: LvTrend = {
  ...trend,
  points: [],
  previousPoints: [],
  types: [],
  totalDays: 0,
  busiestDay: null,
};
export const emptyGroups = (params: URLSearchParams): LvGroups => ({ ...groups(params), rows: [], total: 0 });
export const emptyBalances: LvBalances = {
  ...balances,
  casual: { ...balances.casual, employees: 0, used: 0, pending: 0, byDepartment: [] },
};
export const emptyPermissions: LvPermissions = {
  ...permissions,
  totals: { requested: 0, approved: 0, rejected: 0, pending: 0, excess: 0, excessPct: null, people: 0 },
  byType: [],
  overCap: [],
};
export const emptyApprovals: LvApprovals = {
  ...approvals,
  cohort: { ...approvals.cohort, applied: 0, approved: 0, rejected: 0, pending: 0, decided: 0, rejectionPct: null },
  pending: { count: 0, oldestDays: null, total: 0 },
};
