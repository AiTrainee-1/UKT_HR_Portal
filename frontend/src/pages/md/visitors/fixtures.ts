// Fixture responses for the Outpass & Visitors page tests: the same figures the backend test fixture produces
// (api/tests_md_visitors.py), typed against types.ts so a change to the contract fails here first.

import type { MdPeriod, MdScope, Provenance } from "@/lib/md/types";
import type {
  ActivityResponse,
  ExceptionsResponse,
  Metric,
  OutpassResponse,
  SummaryResponse,
  TrendResponse,
  UnitsResponse,
  VisitorsResponse,
} from "./types";

export const metric = (value: number | null, previous: number | null): Metric => ({
  value,
  previous,
  change:
    value == null || previous == null
      ? null
      : {
          abs: Math.round((value - previous) * 100) / 100,
          pct: previous === 0 ? null : Math.round(((value - previous) / Math.abs(previous)) * 1000) / 10,
        },
});

export const PERIOD: MdPeriod = {
  start: "2026-09-21",
  end: "2026-10-04",
  preset: "custom",
  label: "21 Sep – 04 Oct 2026",
  days: 14,
};

const SCOPE: MdScope = {
  branchIds: [],
  departmentIds: [],
  employmentType: null,
  description: "All units · all departments · staff and production",
};

const entry = (id: string, title: string, caveats: string[] = []): Provenance => ({
  id,
  title,
  dataset: "Gate data",
  definition: `How ${title.toLowerCase()} is worked out.`,
  formula: null,
  rows: 10,
  filters: [],
  caveats,
});

export const PROVENANCE: Provenance[] = [
  entry("visits", "Visits and unique visitors", ["Visitors are recorded at check-in only."]),
  entry("peak", "Busiest hour and day"),
  entry("after-hours", "After-hours visits"),
  entry("repeat-visitors", "Repeat visitors"),
  entry("purposes", "Why visitors came"),
  entry("hosts", "Who visitors came to meet"),
  entry("heatmap", "Busiest times"),
  entry("passes", "Outpass requests"),
  entry("approvals", "Rejection rate and approvals"),
  entry("turnaround", "Approval time"),
  entry("hours-out", "Hours out"),
  entry("return-rate", "Return rate"),
  entry("funnel", "From request to return"),
  entry("departments", "Time out by department"),
  entry("reasons", "Why people leave"),
  entry("durations", "How long people stay out"),
  entry("waiting", "Requests waiting for a decision"),
  entry("gate-scans", "Gate scans"),
  entry("trend", "Trend"),
  entry("exceptions", "What counts as an exception"),
  entry("activity", "Recent activity"),
];

const envelope = () => ({
  generatedAt: "2026-10-05T10:42:10",
  period: PERIOD,
  scope: SCOPE,
  provenance: PROVENANCE,
  notes: [
    "Visitors are recorded at check-in only (there is no check-out), so who is inside right now and how long a visitor stayed cannot be shown.",
  ],
});

export const SUMMARY: SummaryResponse = {
  ...envelope(),
  previousPeriod: { start: "2026-09-07", end: "2026-09-20", label: "Previous 14 days", days: 14 },
  visitors: {
    visits: metric(11, 4),
    uniqueVisitors: metric(6, 4),
    repeatVisitors: metric(3, 0),
    afterHours: metric(2, 0),
    avgPerDay: metric(0.8, 0.3),
    peakHour: { hour: 11, label: "11:00–11:59", visits: 3 },
    peakDay: { date: "2026-09-22", weekday: "Tue", visits: 2 },
  },
  outpass: {
    requests: metric(12, 5),
    approved: metric(10, 4),
    rejected: metric(1, 1),
    pending: metric(1, 0),
    rejectionRatePct: metric(9.1, 20),
    left: metric(9, 4),
    returned: metric(7, 4),
    notReturned: metric(1, 0),
    returnRatePct: metric(87.5, 100),
    minutesOut: metric(325, 300),
    hoursOut: metric(5.4, 5),
    avgMinutesOut: metric(46, 75),
    turnaroundAvgMinutes: metric(16, 10),
    turnaroundMedianMinutes: metric(10, 10),
    onDutyTrips: metric(1, 0),
    gateFormExits: metric(2, 1),
    outsideNow: 1,
    waitingNow: { waiting: 3, overOneDay: 2, oldestMinutes: 51960 },
  },
};

/** The same summary for a period with nothing in it. */
export const SUMMARY_EMPTY: SummaryResponse = {
  ...SUMMARY,
  visitors: {
    visits: metric(0, 0),
    uniqueVisitors: metric(0, 0),
    repeatVisitors: metric(0, 0),
    afterHours: metric(0, 0),
    avgPerDay: metric(0, 0),
    peakHour: null,
    peakDay: null,
  },
  outpass: {
    requests: metric(0, 0),
    approved: metric(0, 0),
    rejected: metric(0, 0),
    pending: metric(0, 0),
    rejectionRatePct: metric(null, null),
    left: metric(0, 0),
    returned: metric(0, 0),
    notReturned: metric(0, 0),
    returnRatePct: metric(null, null),
    minutesOut: metric(null, null),
    hoursOut: metric(null, null),
    avgMinutesOut: metric(null, null),
    turnaroundAvgMinutes: metric(null, null),
    turnaroundMedianMinutes: metric(null, null),
    onDutyTrips: metric(0, 0),
    gateFormExits: metric(0, 0),
    outsideNow: 0,
    waitingNow: { waiting: 0, overOneDay: 0, oldestMinutes: null },
  },
};

const day = (n: number) => `2026-09-${String(n).padStart(2, "0")}`;

export const TREND: TrendResponse = {
  ...envelope(),
  granularity: "day",
  points: Array.from({ length: 14 }, (_, i) => {
    const d = 21 + i;
    const key = d <= 30 ? day(d) : `2026-10-${String(d - 30).padStart(2, "0")}`;
    return {
      key,
      start: key,
      end: key,
      days: 1,
      visits: i % 5 === 0 ? 2 : i % 3 === 0 ? 1 : 0,
      passes: i % 4 === 0 ? 2 : 1,
      left: 1,
      returned: 1,
      minutesOut: 20 + i * 5,
      gateFormExits: i === 1 ? 1 : 0,
    };
  }),
  totals: { visits: 11, passes: 12, left: 9, returned: 7, minutesOut: 325, gateFormExits: 2 },
};

export const TREND_EMPTY: TrendResponse = {
  ...TREND,
  points: TREND.points.map((p) => ({
    ...p,
    visits: 0,
    passes: 0,
    left: 0,
    returned: 0,
    minutesOut: 0,
    gateFormExits: 0,
  })),
  totals: { visits: 0, passes: 0, left: 0, returned: 0, minutesOut: 0, gateFormExits: 0 },
};

const HEAT = (() => {
  const values = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  values[0][15] = 1;
  values[1][10] = 2;
  values[1][14] = 1;
  values[2][11] = 2;
  values[3][9] = 2;
  values[4][11] = 1;
  values[4][19] = 1;
  values[5][6] = 1;
  return {
    weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    hours: Array.from({ length: 24 }, (_, h) => h),
    values,
    max: 2,
  };
})();

export const VISITORS: VisitorsResponse = {
  ...envelope(),
  visits: 11,
  uniqueVisitors: 6,
  purposes: {
    categories: [
      { key: "supplier", label: "Supplier, vendor or sales", visits: 4, sharePct: 36.4 },
      { key: "audit", label: "Audit, inspection or officials", visits: 2, sharePct: 18.2 },
      { key: "delivery", label: "Delivery or transport", visits: 2, sharePct: 18.2 },
      { key: "personal", label: "Family, friend or personal", visits: 1, sharePct: 9.1 },
      { key: "interview", label: "Interview or job enquiry", visits: 1, sharePct: 9.1 },
      { key: "meeting", label: "Meeting or discussion", visits: 1, sharePct: 9.1 },
    ],
    otherSharePct: 0,
    otherSamples: [],
    typedTop: [{ text: "Courier delivery", visits: 2 }],
  },
  hostDepartments: [
    { department: "Stitching", visits: 6, uniqueVisitors: 3, sharePct: 54.5 },
    { department: "Accounts", visits: 2, uniqueVisitors: 1, sharePct: 18.2 },
  ],
  hostsNotLinked: { visits: 3, sharePct: 27.3 },
  topHosts: [
    {
      employeeId: 1,
      name: "Asha Rao",
      code: "A1",
      department: "Stitching",
      linked: true,
      visits: 4,
      uniqueVisitors: 1,
    },
    {
      employeeId: 4,
      name: "Dev Anand",
      code: "D4",
      department: "Accounts",
      linked: true,
      visits: 2,
      uniqueVisitors: 1,
    },
    { employeeId: null, name: "Stores", code: null, department: null, linked: false, visits: 2, uniqueVisitors: 1 },
  ],
  repeatVisitors: {
    total: 3,
    visits: 8,
    sharePct: 72.7,
    frequentFrom: 4,
    rows: [
      {
        visitorId: 1,
        visitorName: "Ravi Supplier",
        visits: 4,
        hostsMet: 1,
        firstVisitAt: "2026-09-22T10:15:00",
        lastVisitAt: "2026-10-02T11:00:00",
        lastPurpose: "Sales demo",
      },
      {
        visitorId: 3,
        visitorName: "Inspector Raj",
        visits: 2,
        hostsMet: 1,
        firstVisitAt: "2026-09-24T09:30:00",
        lastVisitAt: "2026-10-01T09:45:00",
        lastPurpose: "Audit follow up",
      },
    ],
  },
  afterHours: { total: 2, sharePct: 18.2, startHour: 8, endHour: 18, label: "before 8:00 am or from 6:00 pm" },
  peakHour: { hour: 11, label: "11:00–11:59", visits: 3 },
  peakDay: { date: "2026-09-22", weekday: "Tue", visits: 2 },
  busiestWeekday: { weekday: "Tue", visits: 3 },
  heatmap: HEAT,
};

export const VISITORS_EMPTY: VisitorsResponse = {
  ...VISITORS,
  visits: 0,
  uniqueVisitors: 0,
  purposes: { categories: [], otherSharePct: null, otherSamples: [], typedTop: [] },
  hostDepartments: [],
  hostsNotLinked: { visits: 0, sharePct: null },
  topHosts: [],
  repeatVisitors: { total: 0, visits: 0, sharePct: null, frequentFrom: 4, rows: [] },
  afterHours: { ...VISITORS.afterHours, total: 0, sharePct: null },
  peakHour: null,
  peakDay: null,
  busiestWeekday: null,
  heatmap: { ...HEAT, values: HEAT.values.map((r) => r.map(() => 0)), max: 0 },
};

export const OUTPASS: OutpassResponse = {
  ...envelope(),
  requests: 12,
  funnel: {
    requested: 12,
    approved: 10,
    left: 9,
    returned: 7,
    dropOffs: { rejected: 1, waiting: 1, approvedNotUsed: 1, outsideNow: 0, notReturned: 1, earlyDismissal: 1 },
    onDutyTrips: 1,
  },
  byDepartment: [
    {
      department: "Stitching",
      requests: 8,
      employees: 3,
      headcount: 3,
      requestsPer100: 266.7,
      returned: 6,
      minutesOut: 310,
      avgMinutes: 52,
      notReturned: 0,
    },
    {
      department: "Cutting",
      requests: 2,
      employees: 1,
      headcount: 1,
      requestsPer100: 200,
      returned: 1,
      minutesOut: 15,
      avgMinutes: 15,
      notReturned: 1,
    },
    {
      department: "Accounts",
      requests: 2,
      employees: 1,
      headcount: 1,
      requestsPer100: 200,
      returned: 0,
      minutesOut: null,
      avgMinutes: null,
      notReturned: 0,
    },
  ],
  departmentsTotal: 3,
  byReason: [
    {
      key: "official",
      label: "Official / mill duty",
      requests: 2,
      sharePct: 16.7,
      returned: 2,
      minutesOut: 165,
      avgMinutes: 83,
    },
    {
      key: "personal",
      label: "Personal emergency",
      requests: 8,
      sharePct: 66.7,
      returned: 4,
      minutesOut: 130,
      avgMinutes: 33,
    },
    {
      key: "early_dismissal",
      label: "Early shift dismissal",
      requests: 1,
      sharePct: 8.3,
      returned: 0,
      minutesOut: null,
      avgMinutes: null,
    },
    {
      key: "unspecified",
      label: "Type not stated",
      requests: 1,
      sharePct: 8.3,
      returned: 1,
      minutesOut: 30,
      avgMinutes: 30,
    },
  ],
  durations: {
    buckets: [
      { key: "under_15", label: "Under 15 min", passes: 1, sharePct: 14.3 },
      { key: "15_30", label: "15 to 30 min", passes: 1, sharePct: 14.3 },
      { key: "30_60", label: "30 min to 1 hour", passes: 3, sharePct: 42.9 },
      { key: "1_2h", label: "1 to 2 hours", passes: 1, sharePct: 14.3 },
      { key: "2_4h", label: "2 to 4 hours", passes: 1, sharePct: 14.3 },
      { key: "over_4h", label: "4 hours or more", passes: 0, sharePct: 0 },
    ],
    measured: 7,
    medianMinutes: 30,
    avgMinutes: 46,
    longestMinutes: 150,
  },
  totals: { minutesOut: 325, hoursOut: 5.4, avgMinutesOut: 46, returnRatePct: 87.5 },
  approvals: {
    turnaround: { avgMinutes: 16, medianMinutes: 10, decisions: 10 },
    rejectionRatePct: 9.1,
    aging: {
      waiting: 3,
      overOneDay: 2,
      oldestMinutes: 51960,
      buckets: [
        { key: "under_1h", label: "Under 1 hour", count: 0 },
        { key: "1_4h", label: "1 to 4 hours", count: 1 },
        { key: "4_24h", label: "4 to 24 hours", count: 0 },
        { key: "over_24h", label: "Over 24 hours", count: 2 },
      ],
    },
  },
  gateScans: {
    attempts: 6,
    successful: 3,
    refused: 3,
    refusedPct: 50,
    byReason: [
      { key: "expired", label: "Pass expired", count: 1 },
      { key: "invalid_qr", label: "Unreadable or invalid QR", count: 1 },
      { key: "not_approved", label: "Request not approved", count: 1 },
    ],
    byGate: [
      { gate: "Gate 1", exits: 2, returns: 1, refused: 1 },
      { gate: "Gate 2", exits: 0, returns: 0, refused: 2 },
    ],
  },
};

export const OUTPASS_EMPTY: OutpassResponse = {
  ...OUTPASS,
  requests: 0,
  funnel: {
    requested: 0,
    approved: 0,
    left: 0,
    returned: 0,
    dropOffs: { rejected: 0, waiting: 0, approvedNotUsed: 0, outsideNow: 0, notReturned: 0, earlyDismissal: 0 },
    onDutyTrips: 0,
  },
  byDepartment: [],
  departmentsTotal: 0,
  byReason: [],
  durations: { buckets: [], measured: 0, medianMinutes: null, avgMinutes: null, longestMinutes: null },
  totals: { minutesOut: null, hoursOut: null, avgMinutesOut: null, returnRatePct: null },
  approvals: {
    turnaround: { avgMinutes: null, medianMinutes: null, decisions: 0 },
    rejectionRatePct: null,
    aging: { waiting: 0, overOneDay: 0, oldestMinutes: null, buckets: [] },
  },
  gateScans: { attempts: 0, successful: 0, refused: 0, refusedPct: null, byReason: [], byGate: [] },
};

const person = (employeeId: number, name: string, code: string, department: string) => ({
  employeeId,
  name,
  code,
  department,
});

export const EXCEPTIONS: ExceptionsResponse = {
  ...envelope(),
  thresholds: {
    repeatOutpass: { per30Days: 3, forThisPeriod: 3, criticalFrom: 6 },
    longOutpass: { minMinutes: 120, factorOfTypical: 2, typicalMinutes: 30, forThisPeriod: 120 },
    approvalWaitHours: 24,
    afterHours: { startHour: 8, endHour: 18, label: "before 8:00 am or from 6:00 pm" },
    frequentVisitor: { per30Days: 4, forThisPeriod: 4 },
  },
  attention: [
    {
      id: "visitors.repeat-outpass",
      severity: "warning",
      title: "1 employee took 3 or more outpasses between 21 Sep – 04 Oct 2026",
      detail: "The most is 4 passes (4h 30m out).",
      metric: "1 person",
      page: "visitors",
      ask: "Which employees took 3 or more outpasses, and how many hours were they out?",
    },
    {
      id: "visitors.approvals-waiting",
      severity: "critical",
      title: "2 outpass requests waiting more than 24 hours for a decision",
      detail: "The oldest has waited 36 days 2 hours.",
      metric: "2 waiting",
      page: "visitors",
      ask: "Which outpass requests have been waiting more than 24 hours, and with whom?",
    },
    {
      id: "visitors.after-hours",
      severity: "info",
      title: "2 visits outside 8:00 am to 6:00 pm between 21 Sep – 04 Oct 2026",
      detail: "Check-ins before opening time or after closing time.",
      metric: "2 visits",
      page: "visitors",
      ask: "Who visited the factory after hours, and whom did they come to see?",
    },
  ],
  repeatOutpass: {
    total: 1,
    minimum: 3,
    rows: [
      {
        ...person(1, "Asha Rao", "A1", "Stitching"),
        passes: 4,
        personal: 3,
        official: 1,
        earlyDismissal: 0,
        notStated: 0,
        minutesOut: 270,
        lastPassAt: "2026-09-28T15:00:00",
      },
    ],
  },
  notReturned: {
    total: 2,
    neverReturned: 1,
    outsideNow: 1,
    sharePct: 12.5,
    rows: [
      {
        ...person(6, "Farid Khan", "F6", "No department"),
        state: "outside_now",
        stateLabel: "Outside now",
        passType: "personal",
        passTypeLabel: "Personal emergency",
        destination: "Bank",
        exitedAt: "2026-10-05T08:30:00",
        daysAgo: 0,
        minutesOutsideSoFar: 210,
        expectedReturnAt: null,
      },
      {
        ...person(3, "Chitra Devi", "C3", "Cutting"),
        state: "not_returned",
        stateLabel: "Never returned",
        passType: "personal",
        passTypeLabel: "Personal emergency",
        destination: "Home",
        exitedAt: "2026-09-29T13:35:00",
        daysAgo: 6,
        minutesOutsideSoFar: null,
        expectedReturnAt: null,
      },
    ],
  },
  longOutpasses: {
    total: 1,
    thresholdMinutes: 120,
    medianMinutes: 30,
    rows: [
      {
        ...person(1, "Asha Rao", "A1", "Stitching"),
        minutes: 150,
        passType: "official",
        passTypeLabel: "Official / mill duty",
        destination: "Bank",
        exitedAt: "2026-09-25T09:10:00",
        enteredAt: "2026-09-25T11:40:00",
      },
    ],
  },
  approvalsWaiting: {
    total: 2,
    pendingTotal: 3,
    oldestMinutes: 51960,
    rows: [
      {
        ...person(3, "Chitra Devi", "C3", "Cutting"),
        requestedAt: "2026-08-30T10:00:00",
        waitingMinutes: 51960,
        passType: "personal",
        passTypeLabel: "Personal emergency",
        destination: "Bank",
        reason: "Personal work",
      },
      {
        ...person(4, "Dev Anand", "D4", "Accounts"),
        requestedAt: "2026-10-03T14:00:00",
        waitingMinutes: 2760,
        passType: "personal",
        passTypeLabel: "Personal emergency",
        destination: "Bank",
        reason: "Personal work",
      },
    ],
  },
  afterHoursVisits: {
    total: 2,
    rows: [
      {
        visitId: 8,
        visitedAt: "2026-09-26T06:45:00",
        visitorName: "Early Bird",
        hostName: "Mr Kumar",
        hostLinked: false,
        hostDepartment: null,
        purpose: "Interview",
      },
      {
        visitId: 7,
        visitedAt: "2026-09-25T19:30:00",
        visitorName: "Late Guest",
        hostName: "Bala Kumar",
        hostLinked: true,
        hostDepartment: "Stitching",
        purpose: "Meeting",
      },
    ],
  },
  frequentVisitors: { total: 1, minimum: 4, rows: VISITORS.repeatVisitors.rows.slice(0, 1) },
};

export const EXCEPTIONS_EMPTY: ExceptionsResponse = {
  ...EXCEPTIONS,
  attention: [],
  repeatOutpass: { total: 0, minimum: 3, rows: [] },
  notReturned: { total: 0, neverReturned: 0, outsideNow: 0, sharePct: null, rows: [] },
  longOutpasses: { total: 0, thresholdMinutes: 120, medianMinutes: null, rows: [] },
  approvalsWaiting: { total: 0, pendingTotal: 0, oldestMinutes: null, rows: [] },
  afterHoursVisits: { total: 0, rows: [] },
  frequentVisitors: { total: 0, minimum: 4, rows: [] },
};

export const ACTIVITY: ActivityResponse = {
  ...envelope(),
  page: 1,
  pageSize: 25,
  total: 25,
  hasMore: true,
  kind: "all",
  q: "",
  counts: { visits: 11, outpasses: 12, gateForm: 2 },
  items: [
    {
      kind: "outpass",
      id: "pass-12",
      at: "2026-10-04T08:00:00",
      ...person(5, "Esha Gupta", "E5", "Stitching"),
      passType: "personal",
      passTypeLabel: "Personal emergency",
      destination: "Bank",
      status: "approved",
      outcome: "approved_unused",
      outcomeLabel: "Approved, not used",
      exitedAt: null,
      enteredAt: null,
      minutesOut: null,
    },
    {
      kind: "visit",
      id: "visit-11",
      at: "2026-10-02T11:00:00",
      visitorName: "Ravi Supplier",
      hostName: "Asha Rao",
      hostLinked: true,
      hostDepartment: "Stitching",
      purpose: "Sales demo",
      branch: "Unit 1",
    },
    {
      kind: "outpass",
      id: "pass-8",
      at: "2026-10-01T09:30:00",
      ...person(3, "Chitra Devi", "C3", "Cutting"),
      passType: "official",
      passTypeLabel: "Official / mill duty",
      destination: "Bank",
      status: "approved",
      outcome: "returned",
      outcomeLabel: "Returned",
      exitedAt: "2026-10-01T09:40:00",
      enteredAt: "2026-10-01T09:55:00",
      minutesOut: 15,
    },
    {
      kind: "gate_form",
      id: "form-2",
      at: "2026-09-30T13:00:00",
      employeeId: null,
      name: "Unknown",
      code: "X99",
      department: null,
      matched: false,
      destination: "Home",
      branch: "Unit 2",
    },
  ],
};

export const ACTIVITY_EMPTY: ActivityResponse = {
  ...ACTIVITY,
  total: 0,
  hasMore: false,
  counts: { visits: 0, outpasses: 0, gateForm: 0 },
  items: [],
};

export const UNITS: UnitsResponse = {
  ...envelope(),
  units: [
    {
      unitId: 1,
      unit: "Unit 1",
      visits: 8,
      uniqueVisitors: 4,
      afterHours: 2,
      requests: 8,
      approved: 8,
      minutesOut: 295,
      avgMinutes: 49,
      notReturned: 1,
      headcount: 4,
      requestsPer100: 200,
    },
    {
      unitId: 2,
      unit: "Unit 2",
      visits: 3,
      uniqueVisitors: 2,
      afterHours: 0,
      requests: 4,
      approved: 2,
      minutesOut: 30,
      avgMinutes: 30,
      notReturned: 0,
      headcount: 2,
      requestsPer100: 200,
    },
  ],
};

/** A single unit: nothing to compare, so the page shows no card. */
export const UNITS_ONE: UnitsResponse = { ...UNITS, units: UNITS.units.slice(0, 1) };
