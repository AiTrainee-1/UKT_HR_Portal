// Fixtures for the Gate Pass and Visitors Insights tests: the shapes /api/md/visitors/* returns, with small hand-counted
// numbers (Nov 2026, Unit 1). Every figure a test asserts is written here once.

import type { MdEnvelope } from "@/lib/md/types";
import type {
  Checkout,
  ExceptionsResponse,
  OutpassResponse,
  PassList,
  StoryResponse,
  SummaryResponse,
  TrendResponse,
  VisitList,
  VisitorsResponse,
} from "./types";

const env = (label = "Nov 2026"): MdEnvelope => ({
  generatedAt: "2026-11-21T10:00:00",
  period: { start: "2026-11-01", end: "2026-11-21", preset: "this_month", label, days: 21 },
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: [
    {
      id: "passes",
      title: "Outpass requests",
      dataset: "Outpass requests",
      definition: "Every request an employee made to leave during the shift.",
      formula: null,
      rows: 12,
      filters: [],
      caveats: [],
    },
  ],
  notes: [],
});

const m = (value: number | null, previous: number | null) => ({
  value,
  previous,
  change: value != null && previous != null ? { abs: Math.round((value - previous) * 100) / 100, pct: null } : null,
});

export const summary: SummaryResponse = {
  ...env(),
  notes: [
    "Check-out is recorded from 18 Nov 2026 ... has no check-out and so no time inside.",
    "Today is still in progress.",
  ],
  previousPeriod: { start: "2026-10-11", end: "2026-10-31", label: "Previous 21 days", days: 21 },
  visitors: {
    visits: m(40, 32),
    uniqueVisitors: m(25, 22),
    repeatVisitors: m(6, 5),
    afterHours: m(3, 1),
    avgPerDay: m(1.9, 1.5),
    peakHour: { hour: 11, label: "11:00 am", visits: 9 },
    peakDay: { date: "2026-11-19", weekday: "Thu", visits: 6 },
    checkedOut: m(12, null),
    checkedOutPct: m(75, null),
    avgMinutesInside: m(48, null),
    medianMinutesInside: 40,
    leftWithoutCheckout: 4,
    checkoutEligible: 16,
    insideNow: 2,
    longStayNow: 1,
    checkedOutToday: 3,
    visitsToday: 5,
  },
  outpass: {
    requests: m(12, 9),
    approved: m(10, 8),
    rejected: m(1, 1),
    pending: m(1, 0),
    rejectionRatePct: m(9.1, 11.1),
    left: m(9, 7),
    returned: m(7, 6),
    notReturned: m(1, 0),
    returnRatePct: m(87.5, 100),
    minutesOut: m(330, 300),
    hoursOut: m(5.5, 5),
    avgMinutesOut: m(47, 50),
    turnaroundAvgMinutes: m(35, 40),
    turnaroundMedianMinutes: m(20, 25),
    onDutyTrips: m(2, 1),
    gateFormExits: m(0, 1),
    outsideNow: 1,
    overdueNow: 1,
    waitingNow: { waiting: 2, overOneDay: 1, oldestMinutes: 2000 },
  },
};

export const story = (focus: "outpass" | "visitors"): StoryResponse => ({
  ...env(),
  focus,
  sentences:
    focus === "outpass"
      ? [
          { id: "volume", tone: "neutral", text: "12 gate passes in Nov 2026 (up 3 on the period before)." },
          { id: "time", tone: "watch", text: "People spent 5.5 hours out; 1 pass was never scanned back." },
        ]
      : [
          { id: "volume", tone: "neutral", text: "40 visits by 25 different visitors in Nov 2026." },
          { id: "checkout", tone: "watch", text: "12 of 16 visits since check-out began were checked out (75%)." },
        ],
  text: "",
  ask: `Explain ${focus} in Nov 2026.`,
});

export const trend: TrendResponse = {
  ...env(),
  granularity: "day",
  points: [
    {
      key: "2026-11-19",
      start: "2026-11-19",
      end: "2026-11-19",
      days: 1,
      visits: 6,
      passes: 3,
      left: 3,
      returned: 2,
      minutesOut: 90,
      gateFormExits: 0,
    },
    {
      key: "2026-11-20",
      start: "2026-11-20",
      end: "2026-11-20",
      days: 1,
      visits: 4,
      passes: 2,
      left: 1,
      returned: 1,
      minutesOut: 45,
      gateFormExits: 0,
    },
  ],
};

export const exceptions: ExceptionsResponse = {
  ...env(),
  attention: [
    {
      id: "visitors.not-returned",
      severity: "warning",
      title: "1 gate pass was never scanned back in",
      detail: "The employee left on an earlier day.",
      metric: "1 pass",
      page: "outpass",
      ask: "Which outpasses were never returned?",
    },
    {
      id: "visitors.long-stay",
      severity: "warning",
      title: "1 visitor has been inside for over 2 hours",
      detail: "Checked in today and not checked out yet.",
      metric: "1 visitor",
      page: "visitors",
      ask: "Which visitors have been inside for more than 2 hours?",
    },
  ],
};

export const outpass: OutpassResponse = {
  ...env(),
  requests: 12,
  funnel: {
    requested: 12,
    approved: 10,
    left: 9,
    returned: 7,
    dropOffs: { rejected: 1, waiting: 1, approvedNotUsed: 1, outsideNow: 0, notReturned: 1, earlyDismissal: 1 },
    onDutyTrips: 2,
  },
  byDepartment: [
    {
      department: "Stitching",
      requests: 8,
      employees: 5,
      headcount: 40,
      requestsPer100: 20,
      returned: 5,
      minutesOut: 240,
      avgMinutes: 48,
      notReturned: 1,
    },
    {
      department: "Cutting",
      requests: 4,
      employees: 3,
      headcount: 20,
      requestsPer100: 20,
      returned: 2,
      minutesOut: 90,
      avgMinutes: 45,
      notReturned: 0,
    },
  ],
  byReason: [
    {
      key: "personal",
      label: "Personal emergency",
      requests: 9,
      sharePct: 75,
      returned: 6,
      minutesOut: 280,
      avgMinutes: 47,
    },
    {
      key: "official",
      label: "Official / mill duty",
      requests: 3,
      sharePct: 25,
      returned: 1,
      minutesOut: 50,
      avgMinutes: 50,
    },
  ],
  byGate: [
    {
      gateId: 1,
      gate: "Gate 1",
      wentOut: 6,
      cameBack: 5,
      stillOut: 0,
      notReturned: 1,
      avgMinutesOut: 50,
      minutesOut: 250,
    },
    {
      gateId: null,
      gate: "Gate not recorded",
      wentOut: 3,
      cameBack: 2,
      stillOut: 0,
      notReturned: 0,
      avgMinutesOut: 40,
      minutesOut: 80,
    },
  ],
  durations: {
    buckets: [
      { key: "15_30", label: "15 to 30 min", passes: 3, sharePct: 42.9 },
      { key: "30_60", label: "30 min to 1 hour", passes: 4, sharePct: 57.1 },
    ],
    measured: 7,
    medianMinutes: 40,
    avgMinutes: 47,
    longestMinutes: 95,
  },
  approvals: { turnaround: { avgMinutes: 35, medianMinutes: 20, decisions: 11 }, rejectionRatePct: 9.1 },
  gateScans: {
    attempts: 20,
    successful: 17,
    refused: 3,
    refusedPct: 15,
    byReason: [
      { key: "expired", label: "Pass expired", count: 2 },
      { key: "not_allowed_here", label: "Not allowed at this gate", count: 1 },
    ],
    byGate: [{ gate: "Gate 1", exits: 9, returns: 8, refused: 3 }],
  },
};

const CHECKOUT: Checkout = {
  visits: 40,
  checkoutEligible: 16,
  checkedOut: 12,
  checkedOutPct: 75,
  insideNow: 2,
  longStayNow: 1,
  leftWithoutCheckout: 4,
  avgMinutesInside: 48,
  medianMinutesInside: 40,
  longestMinutesInside: 150,
  stayBands: [
    { key: "under_30", label: "Under 30 min", visits: 3, sharePct: 25 },
    { key: "30_60", label: "30 min to 1 hour", visits: 7, sharePct: 58.3 },
    { key: "2_4h", label: "2 to 4 hours", visits: 2, sharePct: 16.7 },
  ],
  longStayFromMinutes: 120,
  since: "2026-11-18",
};

export const visitors: VisitorsResponse = {
  ...env(),
  notes: ["A company is asked only when HR or a reception desk registers the visit."],
  visits: 40,
  uniqueVisitors: 25,
  purposes: {
    categories: [
      { key: "supplier", label: "Supplier, vendor or sales", visits: 18, sharePct: 45 },
      { key: "delivery", label: "Delivery or transport", visits: 12, sharePct: 30 },
      { key: "other", label: "Other (not matched)", visits: 10, sharePct: 25 },
    ],
  },
  hostDepartments: [
    { department: "Stitching", visits: 20, uniqueVisitors: 12, sharePct: 50 },
    { department: "Accounts", visits: 8, uniqueVisitors: 6, sharePct: 20 },
  ],
  hostsNotLinked: { visits: 12, sharePct: 30 },
  topHosts: [
    {
      employeeId: 7,
      name: "Asha Rao",
      code: "A1",
      department: "Stitching",
      linked: true,
      visits: 9,
      uniqueVisitors: 4,
    },
    { employeeId: null, name: "Stores", code: null, department: null, linked: false, visits: 6, uniqueVisitors: 3 },
  ],
  repeatVisitors: { total: 6, visits: 18, sharePct: 45, frequentFrom: 3, rows: [] },
  afterHours: { total: 3, sharePct: 7.5, label: "before 8:00 am or from 6:00 pm" },
  peakHour: { hour: 11, label: "11:00 am", visits: 9 },
  busiestWeekday: { weekday: "Thu", visits: 10 },
  checkout: CHECKOUT,
  sources: [
    { key: "qr", label: "QR self check-in", visits: 30, sharePct: 75, checkedOut: 4, avgMinutesInside: 35 },
    { key: "reception", label: "Reception desk", visits: 10, sharePct: 25, checkedOut: 8, avgMinutesInside: 55 },
  ],
  desks: [{ deskId: 3, desk: "Front Desk", checkIns: 10, checkOuts: 8 }],
  companies: { visitsWithCompany: 6, companies: 2, rows: [{ company: "Acme Ltd", visits: 4, uniqueVisitors: 2 }] },
};

export const passList = (params: URLSearchParams): PassList => ({
  ...env(),
  page: Number(params.get("page") || 1),
  pageSize: 25,
  total: params.get("outcome") === "outside_now" && params.get("period") === "today" ? 1 : 2,
  hasMore: false,
  filters: params.get("outcome") === "not_returned" ? ["Never returned"] : [],
  items: [
    {
      passId: 31,
      employeeId: 7,
      name: "Asha Rao",
      code: "A1",
      department: "Stitching",
      passType: "Personal emergency",
      destination: "Bank",
      reason: "Bank work",
      requestedAt: "2026-11-19T09:00:00",
      approvedAt: "2026-11-19T09:05:00",
      exitedAt: "2026-11-19T09:10:00",
      enteredAt: null,
      expectedReturnAt: null,
      minutesOut: null,
      outcome: "not_returned",
      outcomeLabel: "Never returned",
      exitGate: "Gate 1",
      entryGate: null,
      reviewComment: null,
    },
    {
      passId: 32,
      employeeId: 8,
      name: "Bala Kumar",
      code: "B2",
      department: "Cutting",
      passType: "Personal emergency",
      destination: "Home",
      reason: "Family",
      requestedAt: "2026-11-18T10:00:00",
      approvedAt: null,
      exitedAt: null,
      enteredAt: null,
      expectedReturnAt: null,
      minutesOut: null,
      outcome: "rejected",
      outcomeLabel: "Rejected",
      exitGate: null,
      entryGate: null,
      reviewComment: "Not a valid reason",
    },
  ],
});

export const visitList = (params: URLSearchParams): VisitList => ({
  ...env(),
  page: 1,
  pageSize: 25,
  total: params.get("status") === "inside" ? 2 : 1,
  hasMore: false,
  filters: params.get("status") === "checked_out" ? ["Checked out"] : [],
  items: [
    {
      visitId: 51,
      visitedAt: "2026-11-20T10:00:00",
      checkedOutAt: "2026-11-20T10:45:00",
      minutesInside: 45,
      status: "checked_out",
      statusLabel: "Checked out",
      visitorName: "Ravi Supplier",
      purpose: "Fabric sales",
      purposeCategory: "Supplier, vendor or sales",
      hostEmployeeId: 7,
      hostName: "Asha Rao",
      hostDepartment: "Stitching",
      hostLinked: true,
      company: "Acme Ltd",
      source: "reception",
      sourceLabel: "Reception desk",
      peopleCount: 1,
      unit: "Unit 1",
      desk: "Front Desk",
      checkoutDesk: "Front Desk",
    },
  ],
});

/** Every list is empty and every figure zero: a unit nobody visits. */
export const emptySummary: SummaryResponse = {
  ...summary,
  notes: [],
  visitors: { ...summary.visitors, visits: m(0, 0), insideNow: 0, checkedOut: m(0, 0) },
  outpass: { ...summary.outpass, requests: m(0, 0), outsideNow: 0 },
};
export const emptyTrend: TrendResponse = { ...trend, points: [] };
export const emptyStory = (focus: "outpass" | "visitors"): StoryResponse => ({ ...story(focus), sentences: [] });
export const emptyExceptions: ExceptionsResponse = { ...exceptions, attention: [] };
export const emptyOutpass: OutpassResponse = {
  ...outpass,
  byDepartment: [],
  byReason: [],
  byGate: [],
  funnel: {
    ...outpass.funnel,
    requested: 0,
    approved: 0,
    left: 0,
    returned: 0,
    dropOffs: { rejected: 0, waiting: 0, approvedNotUsed: 0, outsideNow: 0, notReturned: 0, earlyDismissal: 0 },
    onDutyTrips: 0,
  },
};
export const emptyVisitors: VisitorsResponse = {
  ...visitors,
  visits: 0,
  purposes: { categories: [] },
  hostDepartments: [],
  hostsNotLinked: { visits: 0, sharePct: null },
  topHosts: [],
  checkout: { ...CHECKOUT, checkoutEligible: 0, checkedOut: 0 },
  sources: [],
  desks: [],
};

export const BRIEF = (page: string) => ({
  page,
  title: page,
  domain: "visitors",
  kpis: [
    { id: "visitors-today", label: "Visitors today", value: 5, format: "number", page: "visitors" },
    { id: "outpasses-today", label: "Outpasses today", value: 3, format: "number", page: "outpass" },
  ],
  insights: exceptions.attention,
  provenance: [],
  notes: [],
  generatedAt: "2026-11-21T10:00:00",
});
