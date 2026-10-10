// Fixture responses for the Report Log insights tests: the same small company as the backend's hand-counted tests
// (api/tests_md_reportlog.py), so a number here can be traced to an absence or an export there. Not used by the page itself.

import type { MdInsightDto, Provenance } from "@/lib/md/types";
import type {
  Change,
  GapCalendarDay,
  Metric,
  RlAttention,
  RlBreakdown,
  RlBriefing,
  RlExports,
  RlGaps,
  RlGroupRow,
  RlSummary,
  RlTrend,
  RlTrendPoint,
} from "./types";

export const PERIOD = {
  start: "2026-09-07",
  end: "2026-09-13",
  preset: "custom",
  label: "07 Sep – 13 Sep 2026",
  days: 7,
};
export const SCOPE = {
  branchIds: [] as number[],
  departmentIds: [] as number[],
  employmentType: null,
  description: "All units · all departments · staff and production",
};
const base = { generatedAt: "2026-09-21T10:00:00", period: PERIOD, scope: SCOPE };

const prov = (id: string, title: string, definition: string): Provenance => ({
  id,
  title,
  dataset: "Attendance day records",
  definition,
  formula: null,
  rows: 9,
  filters: [],
  caveats: [],
});

const PROVENANCE: Provenance[] = [
  prov("reportlog-absences", "Absences in the Daily Report", "An absence is a scheduled working day marked absent."),
  prov(
    "reportlog-followup",
    "Followed up (Informed / Not informed)",
    "HR marks each absent person Informed or Not informed.",
  ),
  prov("reportlog-gaps", "Days nobody made the call", "A day with 2 or more absences where none carries a mark."),
  prov("reportlog-exports", "Attendance report exports", "Each export is recorded in the audit trail."),
  prov(
    "reportlog-previous",
    "Comparison with the previous period",
    "Against the period of the same length just before.",
  ),
];

const metric = (value: number | null, previous: number | null, change: Change): Metric => ({ value, previous, change });

export const UNKNOWNS = [
  "Exports made from the Report Log page itself (the Excel, PDF or image of the absent list) are produced in the browser and are not recorded anywhere.",
  "Nothing records that a report was sent to anyone, so 'sent' and 'not sent' cannot be told apart.",
  "There is no schedule or deadline for a report, so a late or missing report cannot be judged.",
  "A failed export is only written to the server log, never to the audit trail, so failures and re-runs cannot be counted.",
  "An Informed / Not informed mark does not record who made it or when, so who followed up an absence is unknown.",
];

export const summary: RlSummary = {
  ...base,
  measured: { start: "2026-09-07", end: "2026-09-13", days: 7 },
  previous: { start: "2026-08-31", end: "2026-09-06", days: 7 },
  previousPeriod: { start: "2026-08-31", end: "2026-09-06", preset: null, label: "Previous 7 days", days: 7 },
  metrics: {
    absences: metric(9, 3, { abs: 6, pct: 200 }),
    informed: metric(2, 1, { abs: 1, pct: 100 }),
    notInformed: metric(2, 1, { abs: 1, pct: 100 }),
    unmarked: metric(5, 1, { abs: 4, pct: 400 }),
    reviewedPct: metric(44.4, 66.7, { abs: -22.3, pct: -33.4 }),
    notInformedPct: metric(22.2, 33.3, { abs: -11.1, pct: -33.3 }),
    exports: metric(6, 4, { abs: 2, pct: 50 }),
    exportsAll: metric(8, 4, { abs: 4, pct: 100 }),
    exporters: metric(2, 2, { abs: 0, pct: 0 }),
    exportDays: metric(5, 4, { abs: 1, pct: 25 }),
  },
  gapDays: 1,
  gapMinAbsences: 2,
  coverage: { expectedDays: 30, recordedDays: 30, missingDays: 0, coveragePct: 100, partial: false },
  latestExport: { at: "2026-09-13T23:50:00", userName: "Priya", report: "Daily Attendance Register" },
  unknowns: UNKNOWNS,
  provenance: PROVENANCE,
  notes: ["Export figures are for the whole company: the audit trail is not split by unit or department."],
};

export const emptySummary: RlSummary = {
  ...summary,
  metrics: {
    absences: metric(0, 0, { abs: 0, pct: null }),
    informed: metric(0, 0, { abs: 0, pct: null }),
    notInformed: metric(0, 0, { abs: 0, pct: null }),
    unmarked: metric(0, 0, { abs: 0, pct: null }),
    reviewedPct: metric(null, null, null),
    notInformedPct: metric(null, null, null),
    exports: metric(0, 0, { abs: 0, pct: null }),
    exportsAll: metric(0, 0, { abs: 0, pct: null }),
    exporters: metric(0, 0, { abs: 0, pct: null }),
    exportDays: metric(0, 0, { abs: 0, pct: null }),
  },
  gapDays: 0,
  latestExport: null,
  notes: ["There were no absences on scheduled days in this selection (07 Sep – 13 Sep 2026)."],
};

export const noCompletedDaySummary: RlSummary = {
  ...emptySummary,
  measured: null,
  previous: null,
  metrics: {
    ...emptySummary.metrics,
    absences: metric(null, null, null),
    informed: metric(null, null, null),
    notInformed: metric(null, null, null),
    unmarked: metric(null, null, null),
  },
  notes: ["Today is still running, so this period has no completed day yet: absences are shown once the day is over."],
};

export const briefing: RlBriefing = {
  ...base,
  sentences: [
    {
      id: "followup",
      tone: "bad",
      text: "07 Sep – 13 Sep 2026: 9 absences on scheduled days; 44% have an Informed (2) or Not informed (2) mark, 5 still unmarked.",
    },
    {
      id: "gaps",
      tone: "bad",
      text: "1 day had 2+ absences with nothing marked, so the Daily Report was probably not worked then.",
    },
    { id: "where", tone: "neutral", text: "Stitching has the most unmarked absences: 5 of its 8." },
    {
      id: "exports",
      tone: "neutral",
      text: "6 attendance report exports are on record for 07 sep – 13 sep 2026, by 2 people on 5 of 7 days.",
    },
    {
      id: "limits",
      tone: "neutral",
      text: "Exports from the Report Log page itself, whether a report was sent, and who marked an absence are not recorded.",
    },
  ],
  text: "",
  ask: "Give me a briefing on the Report Log (07 Sep – 13 Sep 2026): are absences being followed up, and who exports attendance reports?",
  provenance: PROVENANCE.slice(0, 4),
  notes: [],
};

export const emptyBriefing: RlBriefing = {
  ...briefing,
  sentences: [
    { id: "followup", tone: "neutral", text: "There were no absences on scheduled days in 07 sep – 13 sep 2026." },
    { id: "exports", tone: "neutral", text: "No attendance report export is on record for 07 sep – 13 sep 2026." },
  ],
};

const item = (
  id: string,
  severity: MdInsightDto["severity"],
  title: string,
  detail: string,
  metricText: string,
): MdInsightDto => ({
  id: `reportlog.${id}`,
  severity,
  title,
  detail,
  metric: metricText,
  page: "report-log",
  ask: `Explain: ${title}`,
});

export const attention: RlAttention = {
  ...base,
  items: [
    item(
      "unmarked",
      "warning",
      "5 of 9 absences have no Informed / Not informed call",
      "07 Sep – 13 Sep 2026: only 44% were followed up on the Daily Report, so who was away without telling anyone is not known for the rest.",
      "44%",
    ),
    item(
      "gap-days",
      "warning",
      "2 days had 2+ absences and nobody made the call",
      "07 Sep – 13 Sep 2026: the Daily Report was probably not worked on those days.",
      "2",
    ),
  ],
  provenance: [
    prov("reportlog-attention", "Needs your attention", "Simple threshold rules over the figures on this page."),
  ],
  notes: [],
};

export const emptyAttention: RlAttention = { ...attention, items: [] };

// date, absences, informed, notInformed, unmarked, exports
const DAYS: [string, number, number, number, number, number][] = [
  ["2026-09-07", 1, 0, 1, 0, 1],
  ["2026-09-08", 2, 0, 0, 2, 1],
  ["2026-09-09", 2, 1, 0, 1, 2],
  ["2026-09-10", 3, 1, 0, 2, 1],
  ["2026-09-11", 1, 0, 1, 0, 0],
  ["2026-09-12", 0, 0, 0, 0, 0],
  ["2026-09-13", 0, 0, 0, 0, 1],
];

export const trendPoints: RlTrendPoint[] = DAYS.map(([date, absences, informed, notInformed, unmarked, exports]) => ({
  date,
  days: 1,
  absences,
  informed,
  notInformed,
  unmarked,
  reviewedPct: absences ? Math.round(((informed + notInformed) / absences) * 1000) / 10 : null,
  exports,
}));

export const trend: RlTrend = {
  ...base,
  granularity: "day",
  points: trendPoints,
  measured: { start: "2026-09-07", end: "2026-09-13", days: 7 },
  provenance: PROVENANCE.slice(0, 4),
  notes: [],
};

export const weeklyTrend: RlTrend = {
  ...trend,
  granularity: "week",
  points: [
    {
      ...trendPoints[0],
      date: "2026-08-31",
      days: 7,
      absences: 3,
      informed: 1,
      notInformed: 1,
      unmarked: 1,
      reviewedPct: 66.7,
      exports: 4,
    },
    {
      ...trendPoints[0],
      date: "2026-09-07",
      days: 7,
      absences: 9,
      informed: 2,
      notInformed: 2,
      unmarked: 5,
      reviewedPct: 44.4,
      exports: 6,
    },
  ],
};

export const emptyTrend: RlTrend = {
  ...trend,
  points: trendPoints.map((p) => ({
    ...p,
    absences: 0,
    informed: 0,
    notInformed: 0,
    unmarked: 0,
    reviewedPct: null,
    exports: 0,
  })),
};

const WEEKDAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export const gaps: RlGaps = {
  ...base,
  days: DAYS.map(([date, absences, informed, notInformed, unmarked, exports], i): GapCalendarDay => ({
    date,
    weekday: WEEKDAY[i],
    absences,
    informed,
    notInformed,
    unmarked,
    exports,
  })),
  truncated: false,
  gapDays: [{ date: "2026-09-08", weekday: "Tue", absences: 2, unmarked: 2 }],
  gapDayCount: 1,
  minAbsences: 2,
  daysWithAbsences: 5,
  daysFullyMarked: 2,
  measured: { start: "2026-09-07", end: "2026-09-13", days: 7 },
  provenance: [PROVENANCE[2], PROVENANCE[1]],
  notes: [],
};

export const emptyGaps: RlGaps = {
  ...gaps,
  days: gaps.days.map((d) => ({ ...d, absences: 0, informed: 0, notInformed: 0, unmarked: 0 })),
  gapDays: [],
  gapDayCount: 0,
  daysWithAbsences: 0,
  daysFullyMarked: 0,
};

const group = (key: string, label: string, over: Partial<RlGroupRow>): RlGroupRow => ({
  key,
  label,
  headcount: 0,
  absences: 0,
  informed: 0,
  notInformed: 0,
  unmarked: 0,
  reviewedPct: null,
  notInformedPct: null,
  unmarkedPct: null,
  lowSample: false,
  previous: { absences: 0, reviewedPct: null },
  change: { absences: null, reviewedPct: null },
  ...over,
});

const breakdown = (by: RlBreakdown["by"], rows: RlGroupRow[]): RlBreakdown => ({
  ...base,
  by,
  rows,
  total: rows.length,
  truncated: false,
  average: {
    absences: 9,
    informed: 2,
    notInformed: 2,
    unmarked: 5,
    reviewedPct: 44.4,
    notInformedPct: 22.2,
    unmarkedPct: 55.6,
  },
  minSample: 5,
  provenance: [
    prov(
      "reportlog-grouping",
      "Comparison",
      "Absences grouped by the department, unit or type each employee belongs to.",
    ),
  ],
  notes: [],
});

export const departments = breakdown("department", [
  group("Stitching", "Stitching", {
    headcount: 3,
    absences: 8,
    informed: 2,
    notInformed: 1,
    unmarked: 5,
    reviewedPct: 37.5,
    notInformedPct: 12.5,
    unmarkedPct: 62.5,
    previous: { absences: 3, reviewedPct: 66.7 },
    change: { absences: { abs: 5, pct: 166.7 }, reviewedPct: { abs: -29.2, pct: -43.8 } },
  }),
  group("Cutting", "Cutting", {
    headcount: 1,
    absences: 1,
    notInformed: 1,
    reviewedPct: 100,
    notInformedPct: 100,
    unmarkedPct: 0,
    lowSample: true,
  }),
]);

export const units = breakdown("unit", [
  group("Unit A", "Unit A", { headcount: 4, absences: 9, informed: 2, notInformed: 2, unmarked: 5, reviewedPct: 44.4 }),
]);

export const types = breakdown("type", [
  group("Staff", "Staff", { headcount: 3, absences: 7, informed: 1, notInformed: 2, unmarked: 4, reviewedPct: 42.9 }),
  group("Production", "Production", {
    headcount: 1,
    absences: 2,
    informed: 1,
    unmarked: 1,
    reviewedPct: 50,
    lowSample: true,
  }),
]);

export const emptyBreakdown = (by: RlBreakdown["by"]): RlBreakdown => ({
  ...breakdown(by, []),
  average: {
    absences: 0,
    informed: 0,
    notInformed: 0,
    unmarked: 0,
    reviewedPct: null,
    notInformedPct: null,
    unmarkedPct: null,
  },
});

export const exportsData: RlExports = {
  ...base,
  totals: {
    attendance: 6,
    all: 8,
    otherReports: 2,
    exporters: 2,
    days: 5,
    daysInPeriod: 7,
    previousAttendance: 4,
    change: { abs: 2, pct: 50 },
  },
  byUser: [
    { userName: "Priya", exports: 4, days: 4, sharePct: 66.7, lastAt: "2026-09-13T23:50:00" },
    { userName: "Ravi", exports: 2, days: 2, sharePct: 33.3, lastAt: "2026-09-09T15:00:00" },
  ],
  usersTotal: 2,
  byReport: [
    { report: "Daily Attendance Register", exports: 3, sharePct: 50 },
    { report: "Late Coming Summary (Counts)", exports: 2, sharePct: 33.3 },
    { report: "Attendance Search (punch export)", exports: 1, sharePct: 16.7 },
  ],
  reportsTotal: 3,
  latest: [
    { at: "2026-09-13T23:50:00", userName: "Priya", report: "Daily Attendance Register" },
    { at: "2026-09-10T11:00:00", userName: "Priya", report: "Attendance Search (punch export)" },
    { at: "2026-09-09T15:00:00", userName: "Ravi", report: "Late Coming Summary (Counts)" },
  ],
  unknowns: UNKNOWNS,
  provenance: [PROVENANCE[3], PROVENANCE[4]],
  notes: ["Exports made from the Report Log page itself are not recorded, so they are not in these figures."],
};

export const emptyExports: RlExports = {
  ...exportsData,
  totals: {
    attendance: 0,
    all: 0,
    otherReports: 0,
    exporters: 0,
    days: 0,
    daysInPeriod: 7,
    previousAttendance: 0,
    change: null,
  },
  byUser: [],
  usersTotal: 0,
  byReport: [],
  reportsTotal: 0,
  latest: [],
  notes: ["No attendance report export is on record for 07 Sep – 13 Sep 2026."],
};
