// Fixture responses for the Geo Attendance insights tests: the same small company as the backend's hand-counted tests
// (api/tests_md_geo.py), so a number here can be traced to a session or a punch there. Not used by the page itself.

import type { MdInsightDto, Provenance } from "@/lib/md/types";
import type {
  Change,
  GeoAttention,
  GeoBreakdown,
  GeoBriefing,
  GeoGroupRow,
  GeoLive,
  GeoPeople,
  GeoReach,
  GeoSummary,
  GeoTrend,
  GeoTrendPoint,
  GeoUnusual,
  GeoVerification,
  Metric,
} from "./types";

export const PERIOD = {
  start: "2026-09-01",
  end: "2026-09-14",
  preset: "custom",
  label: "01 Sep – 14 Sep 2026",
  days: 14,
};
export const SCOPE = {
  branchIds: [] as number[],
  departmentIds: [] as number[],
  employmentType: null,
  description: "All units · all departments · staff and production",
};
const base = { generatedAt: "2026-09-15T15:30:00", period: PERIOD, scope: SCOPE };

const prov = (id: string, title: string, definition: string): Provenance => ({
  id,
  title,
  dataset: "On-duty (geo attendance) requests",
  definition,
  formula: null,
  rows: 14,
  filters: [],
  caveats: [],
});

const PROVENANCE: Provenance[] = [
  prov("geo-sessions", "On-duty sessions and people out", "One session is one request to work away from the unit."),
  prov("geo-punches", "On-duty punches", "One punch is one of the day's attendance punches taken while on duty."),
  prov("geo-office-punches", "Office geo punches", "Punches made with the phone from inside a unit's geofence."),
  prov("geo-verification", "Verification status", "Every punch is held until HR approves it."),
  prov("geo-turnaround", "How long verification takes", "The median time between a punch and HR's decision."),
  prov("geo-distance", "Distance from the unit", "The straight-line distance to the unit's geofence centre."),
  prov("geo-backlog", "Waiting for HR now", "Punches and requests still pending at this moment."),
  prov("geo-previous", "Comparison with the previous period", "Against the period of the same length just before."),
];

const metric = (value: number | null, previous: number | null, change: Change): Metric => ({ value, previous, change });

export const summary: GeoSummary = {
  ...base,
  metrics: {
    sessions: metric(10, 4, { abs: 6, pct: 150 }),
    people: metric(6, 2, { abs: 4, pct: 200 }),
    punches: metric(14, 3, { abs: 11, pct: 366.7 }),
    officePunches: metric(4, 1, { abs: 3, pct: 300 }),
    verifiedPct: metric(57.1, 66.7, { abs: -9.6, pct: -14.4 }),
    rejectedPct: metric(21.4, 33.3, { abs: -11.9, pct: -35.7 }),
    pendingPunches: metric(3, 0, { abs: 3, pct: null }),
    medianVerifyHours: metric(3, 4, { abs: -1, pct: -25 }),
    mockedPunches: metric(2, 0, { abs: 2, pct: null }),
    farPunches: metric(1, 0, { abs: 1, pct: null }),
    oddPunches: metric(3, 0, { abs: 3, pct: null }),
  },
  headcount: 6,
  participationPct: 83.3,
  officePeople: 2,
  previousPeriod: { start: "2026-08-18", end: "2026-08-31", preset: null, label: "Previous 14 days", days: 14 },
  provenance: PROVENANCE,
  notes: ["Office geo punches count only punches inside the unit's radius: a punch outside is refused and not stored."],
};

export const emptySummary: GeoSummary = {
  ...summary,
  metrics: {
    sessions: metric(0, 0, { abs: 0, pct: null }),
    people: metric(0, 0, { abs: 0, pct: null }),
    punches: metric(0, 0, { abs: 0, pct: null }),
    officePunches: metric(0, 0, { abs: 0, pct: null }),
    verifiedPct: metric(null, null, null),
    rejectedPct: metric(null, null, null),
    pendingPunches: metric(0, 0, { abs: 0, pct: null }),
    medianVerifyHours: metric(null, null, null),
    mockedPunches: metric(0, 0, { abs: 0, pct: null }),
    farPunches: metric(0, 0, { abs: 0, pct: null }),
    oddPunches: metric(0, 0, { abs: 0, pct: null }),
  },
  participationPct: null,
  officePeople: 0,
  notes: [
    "No on-duty sessions, on-duty punches or office geo punches were recorded for this selection (01 Sep – 14 Sep 2026).",
  ],
};

export const briefing: GeoBriefing = {
  ...base,
  sentences: [
    {
      id: "volume",
      tone: "neutral",
      text: "01 Sep – 14 Sep 2026: 10 on-duty sessions by 6 people (up 150% on the previous 14 days), 14 on-duty punches and 4 office geo punches.",
    },
    {
      id: "verification",
      tone: "bad",
      text: "HR has verified 57% of the on-duty punches, rejected 3, 3 still waiting; HR typically decides in 3.0 hours.",
    },
    { id: "where", tone: "neutral", text: "Sales has the most on-duty sessions: 8 (80% of all), by 4 people." },
    {
      id: "unusual",
      tone: "bad",
      text: "Worth a look: 2 punches with simulated GPS, 1 punch over 100 km from the unit, 2 sessions left open past their day, 1 person with repeated rejections.",
    },
    {
      id: "now",
      tone: "neutral",
      text: "Right now 2 people are on duty (2 awaiting approval, 1 with no location signal).",
    },
  ],
  text: "",
  ask: "Give me a briefing on geo attendance and on-duty work (01 Sep – 14 Sep 2026): what stands out, and why?",
  provenance: PROVENANCE.slice(0, 3),
  notes: [],
};

export const emptyBriefing: GeoBriefing = {
  ...briefing,
  sentences: [
    {
      id: "volume",
      tone: "neutral",
      text: "No on-duty sessions or geo punches were recorded in 01 sep – 14 sep 2026.",
    },
  ],
};

const item = (
  id: string,
  severity: MdInsightDto["severity"],
  title: string,
  detail: string,
  metricText: string,
): MdInsightDto => ({
  id: `geo.${id}`,
  severity,
  title,
  detail,
  metric: metricText,
  page: "geo-attendance",
  ask: `Explain: ${title}`,
});

export const attention: GeoAttention = {
  ...base,
  items: [
    item(
      "backlog",
      "critical",
      "2 punches and 1 request waiting more than 2 days for HR",
      "The oldest has waited 10.5 days. Until HR decides, on-duty days do not count as attendance.",
      "10.5 days",
    ),
    item(
      "mocked",
      "warning",
      "2 on-duty punches used a simulated GPS location",
      "01 Sep – 14 Sep 2026: 1 person. A simulated location means the position the app reported is not real.",
      "2",
    ),
    item(
      "rejections",
      "warning",
      "1 person had 2 or more on-duty rejections",
      "01 Sep – 14 Sep 2026: requests or punches HR rejected, more than once for the same person.",
      "1",
    ),
    item(
      "stale",
      "warning",
      "2 on-duty sessions are still open after their day",
      "The 11 pm day-end close should have ended them.",
      "2",
    ),
    item(
      "far",
      "info",
      "1 on-duty punch was more than 100 km from the unit",
      "Field visits can be far; worth checking that the destination explains it.",
      "1",
    ),
    item(
      "long",
      "info",
      "3 on-duty sessions ran longer than 16 hours",
      "Open from the request until the employee or the 11 pm close ended it.",
      "3",
    ),
  ],
  provenance: [prov("geo-attention", "Needs your attention", "Simple threshold rules over the figures on this page.")],
  notes: [],
};

export const emptyAttention: GeoAttention = { ...attention, items: [] };

const DAYS: [string, number, number, number, number, number, number][] = [
  // date, sessions, punches, approved, rejected, pending, office
  ["2026-09-01", 0, 0, 0, 0, 0, 0],
  ["2026-09-02", 3, 5, 5, 0, 0, 3],
  ["2026-09-03", 2, 3, 2, 1, 0, 1],
  ["2026-09-04", 1, 2, 0, 2, 0, 0],
  ["2026-09-05", 1, 2, 0, 0, 2, 0],
  ["2026-09-06", 1, 1, 1, 0, 0, 0],
  ["2026-09-07", 0, 0, 0, 0, 0, 0],
  ["2026-09-08", 1, 0, 0, 0, 0, 0],
  ["2026-09-09", 0, 0, 0, 0, 0, 0],
  ["2026-09-10", 0, 0, 0, 0, 0, 0],
  ["2026-09-11", 0, 0, 0, 0, 0, 0],
  ["2026-09-12", 0, 0, 0, 0, 0, 0],
  ["2026-09-13", 0, 0, 0, 0, 0, 0],
  ["2026-09-14", 1, 1, 0, 0, 1, 0],
];

export const trendPoints: GeoTrendPoint[] = DAYS.map(
  ([date, sessions, punches, approved, rejected, pending, office], i) => ({
    date,
    days: 1,
    sessions,
    punches,
    approved,
    rejected,
    pending,
    officePunches: office,
    maSessions: Math.round((DAYS.slice(Math.max(0, i - 6), i + 1).reduce((n, d) => n + d[1], 0) / 7) * 10) / 10,
  }),
);

export const trend: GeoTrend = {
  ...base,
  granularity: "day",
  points: trendPoints,
  momentum: {
    windowDays: 7,
    verdict: "falling",
    text: "On-duty requests are falling: 2 in the last 7 days against 8 in the 7 before.",
    current: { start: "2026-09-08", end: "2026-09-14", sessions: 2 },
    previous: { start: "2026-09-01", end: "2026-09-07", sessions: 8 },
    sessionsChange: { abs: -6, pct: -75 },
  },
  busiestDay: { date: "2026-09-02", sessions: 3, punches: 5 },
  provenance: PROVENANCE.slice(0, 3),
  notes: [],
};

export const weeklyTrend: GeoTrend = {
  ...trend,
  granularity: "week",
  points: [
    { ...trendPoints[0], date: "2026-08-31", days: 7, sessions: 8, punches: 13, maSessions: null },
    { ...trendPoints[0], date: "2026-09-07", days: 7, sessions: 2, punches: 1, maSessions: null },
  ],
};

export const emptyTrend: GeoTrend = {
  ...trend,
  points: trendPoints.map((p) => ({
    ...p,
    sessions: 0,
    punches: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
    officePunches: 0,
  })),
  momentum: {
    ...trend.momentum,
    verdict: "unclear",
    text: "Too few on-duty sessions in the last 7 days and the 7 before to see a direction.",
  },
  busiestDay: null,
};

export const verification: GeoVerification = {
  ...base,
  sessions: { requested: 10, awaitingHod: 0, awaitingHr: 1, approved: 7, active: 1, completed: 6, rejected: 2 },
  punches: { captured: 14, approved: 8, rejected: 1, voided: 2, pending: 3 },
  verifiedPct: 57.1,
  rejectedPct: 21.4,
  decisionTime: {
    punches: { decided: 9, medianHours: 3, p90Hours: 28.8, within24hPct: 88.9 },
    requests: { decided: 9, medianHours: 3, p90Hours: 25.2, within24hPct: 88.9 },
  },
  backlog: {
    pendingPunches: 4,
    pendingSessions: 2,
    oldestPunchHours: 251,
    oldestSessionHours: 173.5,
    overdueHours: 48,
    overduePunches: 2,
    overdueSessions: 1,
    ageBuckets: [
      { label: "Under a day", punches: 2, sessions: 1 },
      { label: "1 to 2 days", punches: 0, sessions: 0 },
      { label: "2 to 7 days", punches: 0, sessions: 0 },
      { label: "Over a week", punches: 2, sessions: 1 },
    ],
  },
  provenance: PROVENANCE.slice(3, 7),
  notes: [],
};

export const emptyVerification: GeoVerification = {
  ...verification,
  sessions: { requested: 0, awaitingHod: 0, awaitingHr: 0, approved: 0, active: 0, completed: 0, rejected: 0 },
  punches: { captured: 0, approved: 0, rejected: 0, voided: 0, pending: 0 },
  verifiedPct: null,
  rejectedPct: null,
  decisionTime: {
    punches: { decided: 0, medianHours: null, p90Hours: null, within24hPct: null },
    requests: { decided: 0, medianHours: null, p90Hours: null, within24hPct: null },
  },
  backlog: {
    ...verification.backlog,
    pendingPunches: 0,
    pendingSessions: 0,
    oldestPunchHours: null,
    oldestSessionHours: null,
    overduePunches: 0,
    overdueSessions: 0,
    ageBuckets: verification.backlog.ageBuckets.map((b) => ({ ...b, punches: 0, sessions: 0 })),
  },
};

const group = (key: string, label: string, over: Partial<GeoGroupRow>): GeoGroupRow => ({
  key,
  label,
  headcount: 0,
  people: 0,
  participationPct: null,
  sessions: 0,
  shareOfSessionsPct: null,
  sessionsPerPerson: null,
  rejectedSessions: 0,
  punches: 0,
  rejectedPunches: 0,
  mockedPunches: 0,
  farPunches: 0,
  lowSample: false,
  previous: { sessions: 0 },
  change: { sessions: null },
  ...over,
});

const breakdown = (by: GeoBreakdown["by"], rows: GeoGroupRow[]): GeoBreakdown => ({
  ...base,
  by,
  rows,
  total: rows.length,
  truncated: false,
  average: { sessions: 10, people: 6, sessionsPerPerson: 1.7, participationPct: 83.3 },
  minSample: 5,
  provenance: [prov("geo-grouping", "Comparison", "Sessions and punches grouped by department, unit or type.")],
  notes: [],
});

export const departments = breakdown("department", [
  group("Sales", "Sales", {
    headcount: 3,
    people: 4,
    participationPct: 100,
    sessions: 8,
    shareOfSessionsPct: 80,
    sessionsPerPerson: 2,
    rejectedSessions: 2,
    punches: 13,
    rejectedPunches: 3,
    mockedPunches: 2,
    farPunches: 1,
    previous: { sessions: 4 },
    change: { sessions: { abs: 4, pct: 100 } },
  }),
  group("Stores", "Stores", {
    headcount: 1,
    people: 1,
    participationPct: 100,
    sessions: 1,
    shareOfSessionsPct: 10,
    sessionsPerPerson: 1,
    punches: 1,
    lowSample: true,
  }),
  group("Admin", "Admin", {
    headcount: 1,
    people: 1,
    participationPct: 100,
    sessions: 1,
    shareOfSessionsPct: 10,
    sessionsPerPerson: 1,
    lowSample: true,
  }),
]);

export const units = breakdown("unit", [
  group("Unit 1", "Unit 1", {
    headcount: 5,
    people: 5,
    participationPct: 80,
    sessions: 8,
    shareOfSessionsPct: 80,
    punches: 11,
  }),
  group("Unit 2", "Unit 2", {
    headcount: 1,
    people: 1,
    participationPct: 100,
    sessions: 2,
    shareOfSessionsPct: 20,
    punches: 3,
    lowSample: true,
  }),
]);

export const types = breakdown("type", [
  group("production", "Production", {
    headcount: 3,
    people: 4,
    participationPct: 100,
    sessions: 6,
    shareOfSessionsPct: 60,
    punches: 9,
  }),
  group("staff", "Staff", {
    headcount: 3,
    people: 2,
    participationPct: 66.7,
    sessions: 4,
    shareOfSessionsPct: 40,
    punches: 5,
  }),
]);

export const emptyBreakdown = (by: GeoBreakdown["by"]): GeoBreakdown => ({
  ...breakdown(by, []),
  average: { sessions: 0, people: 0, sessionsPerPerson: null, participationPct: null },
  notes: ["No on-duty sessions, on-duty punches or office geo punches were recorded for this selection."],
});

export const people: GeoPeople = {
  ...base,
  threshold: 1,
  total: 6,
  frequent: 0,
  frequentMin: 5,
  rows: [
    {
      employeeCode: "A",
      employeeName: "Asha Test",
      department: "Sales",
      unit: "Unit 1",
      type: "Staff",
      sessions: 3,
      daysOut: 3,
      lastDate: "2026-09-04",
      rejectedSessions: 2,
      punches: 5,
      rejectedPunches: 1,
      mockedPunches: 0,
      farPunches: 0,
      oddPunches: 0,
      frequent: false,
    },
    {
      employeeCode: "B",
      employeeName: "Babu Test",
      department: "Sales",
      unit: "Unit 1",
      type: "Production",
      sessions: 2,
      daysOut: 2,
      lastDate: "2026-09-05",
      rejectedSessions: 0,
      punches: 4,
      rejectedPunches: 0,
      mockedPunches: 2,
      farPunches: 1,
      oddPunches: 2,
      frequent: false,
    },
    {
      employeeCode: "D",
      employeeName: "Dinesh Test",
      department: "Sales",
      unit: "Unit 2",
      type: "Production",
      sessions: 2,
      daysOut: 2,
      lastDate: "2026-09-14",
      rejectedSessions: 0,
      punches: 3,
      rejectedPunches: 0,
      mockedPunches: 0,
      farPunches: 0,
      oddPunches: 1,
      frequent: false,
    },
  ],
  truncated: true,
  provenance: [prov("geo-people", "Who is out, and how often", "Employees ranked by on-duty sessions in the period.")],
  notes: [],
};

export const emptyPeople: GeoPeople = {
  ...people,
  total: 0,
  frequent: 0,
  rows: [],
  truncated: false,
  notes: ["Nobody went on duty in this period (01 Sep – 14 Sep 2026)."],
};

export const reach: GeoReach = {
  ...base,
  bands: [
    { key: "at_unit", label: "At the unit", punches: 1, people: 1, sharePct: 7.1 },
    { key: "upto_2", label: "Up to 2 km", punches: 2, people: 1, sharePct: 14.3 },
    { key: "upto_10", label: "2 to 10 km", punches: 5, people: 2, sharePct: 35.7 },
    { key: "upto_50", label: "10 to 50 km", punches: 1, people: 1, sharePct: 7.1 },
    { key: "upto_100", label: "50 to 100 km", punches: 1, people: 1, sharePct: 7.1 },
    { key: "beyond", label: "Over 100 km", punches: 1, people: 1, sharePct: 7.1 },
    { key: "unknown", label: "Unit has no location", punches: 3, people: 1, sharePct: 21.4 },
  ],
  punches: 14,
  farKm: 100,
  farPunches: 1,
  farPeople: 1,
  unknownPunches: 3,
  farthestKm: 250.2,
  provenance: [PROVENANCE[5]],
  notes: [
    "3 of 14 punches are by people whose unit has no location set (Manage Branches), so their distance is unknown.",
  ],
};

export const emptyReach: GeoReach = {
  ...reach,
  bands: reach.bands.map((b) => ({ ...b, punches: 0, people: 0, sharePct: null })),
  punches: 0,
  farPunches: 0,
  farPeople: 0,
  unknownPunches: 0,
  farthestKm: null,
  notes: ["No on-duty punches were recorded for this selection (01 Sep – 14 Sep 2026)."],
};

export const unusual: GeoUnusual = {
  ...base,
  counts: {
    sessionsFlagged: 6,
    mockedSessions: 2,
    farSessions: 1,
    oddSessions: 3,
    longSessions: 3,
    staleSessions: 2,
    rejectedPunchSessions: 1,
    repeatRejectedPeople: 1,
  },
  rows: [
    {
      sessionId: 5,
      employeeCode: "B",
      employeeName: "Babu Test",
      department: "Sales",
      unit: "Unit 1",
      date: "2026-09-05",
      destination: "Site visit",
      status: "active",
      severity: "critical",
      reasons: [
        { code: "mocked", label: "Simulated GPS location (1 punch)" },
        { code: "far", label: "More than 100 km from the unit (1 punch), farthest 250 km" },
        { code: "odd", label: "Punch at odd hours (22:00 to 05:00) (1 punch)" },
        { code: "long", label: "Open for more than 16 hours (251.5 h)" },
        { code: "stale", label: "Still open after its day" },
      ],
    },
    {
      sessionId: 4,
      employeeCode: "B",
      employeeName: "Babu Test",
      department: "Sales",
      unit: "Unit 1",
      date: "2026-09-02",
      destination: "Site visit",
      status: "completed",
      severity: "critical",
      reasons: [
        { code: "mocked", label: "Simulated GPS location (1 punch)" },
        { code: "odd", label: "Punch at odd hours (22:00 to 05:00) (1 punch)" },
      ],
    },
    {
      sessionId: 6,
      employeeCode: "C",
      employeeName: "Chitra Test",
      department: "Stores",
      unit: "Unit 1",
      date: "2026-09-02",
      destination: "Site visit",
      status: "completed",
      severity: "warning",
      reasons: [{ code: "long", label: "Open for more than 16 hours (16.5 h)" }],
    },
  ],
  truncated: true,
  repeatRejected: [
    {
      employeeCode: "A",
      employeeName: "Asha Test",
      department: "Sales",
      unit: "Unit 1",
      rejectedSessions: 2,
      rejectedPunches: 1,
      rejections: 3,
    },
  ],
  thresholds: { longSessionHours: 16, farKm: 100, oddFromHour: 22, oddBeforeHour: 5, repeatMinRejections: 2 },
  provenance: [prov("geo-unusual", "What counts as unusual", "A session is listed when one of these rules is true.")],
  notes: [],
};

export const emptyUnusual: GeoUnusual = {
  ...unusual,
  counts: {
    sessionsFlagged: 0,
    mockedSessions: 0,
    farSessions: 0,
    oddSessions: 0,
    longSessions: 0,
    staleSessions: 0,
    rejectedPunchSessions: 0,
    repeatRejectedPeople: 0,
  },
  rows: [],
  truncated: false,
  repeatRejected: [],
  notes: ["Nothing unusual was found in this period (01 Sep – 14 Sep 2026)."],
};

export const live: GeoLive = {
  generatedAt: "2026-09-15T15:30:00",
  scope: SCOPE,
  asOf: "2026-09-15T15:30:00",
  onDutyNow: 2,
  leftOpen: 2,
  awaitingApproval: 2,
  withSignal: 1,
  noSignal: 1,
  silentMinutes: 30,
  activeHeadcount: 6,
  outPct: 66.7,
  total: 4,
  truncated: false,
  rows: [
    {
      employeeCode: "B",
      employeeName: "Babu Test",
      department: "Sales",
      unit: "Unit 1",
      destination: "Site visit",
      since: "2026-09-05T09:00:00",
      minutesOut: 14790,
      stale: true,
      approved: true,
      punchesToday: 0,
      pendingPunches: 0,
      lastPunch: null,
      mockedPunches: 0,
      tracked: false,
      lastSeen: null,
      minutesSinceSeen: null,
      lastSeenMocked: false,
      distanceFromUnitKm: null,
    },
    {
      employeeCode: "A",
      employeeName: "Asha Test",
      department: "Sales",
      unit: "Unit 1",
      destination: "Dyeing unit, Tiruppur",
      since: "2026-09-15T00:05:00",
      minutesOut: 925,
      stale: false,
      approved: false,
      punchesToday: 0,
      pendingPunches: 0,
      lastPunch: null,
      mockedPunches: 0,
      tracked: true,
      lastSeen: "2026-09-15T14:00:00",
      minutesSinceSeen: 90,
      lastSeenMocked: false,
      distanceFromUnitKm: 30,
    },
    {
      employeeCode: "C",
      employeeName: "Chitra Test",
      department: "Stores",
      unit: "Unit 1",
      destination: "Site visit",
      since: "2026-09-15T09:30:00",
      minutesOut: 360,
      stale: false,
      approved: true,
      punchesToday: 1,
      pendingPunches: 1,
      lastPunch: "10:00",
      mockedPunches: 0,
      tracked: true,
      lastSeen: "2026-09-15T15:10:00",
      minutesSinceSeen: 20,
      lastSeenMocked: false,
      distanceFromUnitKm: 5,
    },
  ],
  provenance: [prov("geo-live", "On duty now", "Everyone whose on-duty session is open.")],
  notes: [],
};

export const emptyLive: GeoLive = {
  ...live,
  onDutyNow: 0,
  leftOpen: 0,
  awaitingApproval: 0,
  withSignal: 0,
  noSignal: 0,
  outPct: 0,
  total: 0,
  rows: [],
  notes: ["Nobody has an open on-duty session right now."],
};
