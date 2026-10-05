// Fixture responses for the Tea Break tests: the same small company as the backend's hand-counted tests
// (api/tests_md_tea_break.py), so a number here can be traced to a break there. Not used by the page itself.

import type { Provenance } from "@/lib/md/types";
import type {
  Change,
  Metric,
  TeaAttention,
  TeaBreakdown,
  TeaGroupRow,
  TeaHeatCell,
  TeaHeatmap,
  TeaOffenders,
  TeaRule,
  TeaSummary,
  TeaTrend,
  TeaTrendPoint,
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
  dataset: "Gate tea-break scans",
  definition,
  formula: null,
  rows: 28,
  filters: [],
  caveats: [],
});

const PROVENANCE: Provenance[] = [
  prov("tea-breaks", "Breaks taken", "One record for each trip to the tea break."),
  prov("tea-overrun", "Overrun and overrun rate", "A break that lasted longer than the 15 minutes HR allows."),
  prov("tea-minutes-lost", "Minutes lost to overruns", "Time on break beyond the allowance."),
  prov("tea-average", "Average break", "The mean length of the breaks that could be measured."),
  prov("tea-compliance", "Within allowance", "The share of measured breaks within the allowance."),
  prov("tea-repeat", "Repeat overrunners", "Employees who overran at least 3 times."),
];

const metric = (value: number | null, previous: number | null, change: Change): Metric => ({ value, previous, change });

export const summary: TeaSummary = {
  ...base,
  allowedMinutes: 15,
  metrics: {
    breaks: metric(28, 8, { abs: 20, pct: 250 }),
    employees: metric(6, 5, { abs: 1, pct: 20 }),
    measured: metric(24, 8, { abs: 16, pct: 200 }),
    avgMinutes: metric(22.2, 20.8, { abs: 1.4, pct: 6.7 }),
    overruns: metric(14, 4, { abs: 10, pct: 250 }),
    overrunPct: metric(58.3, 50, { abs: 8.3, pct: 16.6 }),
    compliancePct: metric(41.7, 50, { abs: -8.3, pct: -16.6 }),
    minutesLost: metric(200, 60, { abs: 140, pct: 233.3 }),
  },
  hoursLost: 3.3,
  withinAllowance: 10,
  previousPeriod: { start: "2026-08-18", end: "2026-08-31", preset: null, label: "Previous 14 days", days: 14 },
  coverage: {
    activeEmployees: 6,
    employeesScanning: 5,
    participationPct: 83.3,
    daysWithScans: 13,
    daysInPeriod: 14,
    breaks: 28,
    measured: 24,
    longCompleted: 2,
    noReturn: 2,
    inProgress: 0,
    unmeasured: 4,
    unmeasuredPct: 14.3,
  },
  provenance: PROVENANCE,
  notes: [
    "5 of 6 active employees (83%) scanned at least one break. 4 of 28 breaks (14%) could not be measured and are left out of overruns and averages: 2 lasted over 60 minutes (a scan was probably missed); 2 have no return scan.",
  ],
};

export const attention: TeaAttention = {
  ...base,
  items: [
    {
      id: "tea-break.trend",
      severity: "critical",
      title: "Break overruns rose to 58% from 50%",
      detail: "01 Sep – 14 Sep 2026 against the previous 14 days: up 8.3 points.",
      metric: "+8.3 pts",
      page: "tea-break",
      ask: "Why did tea-break overruns rise from 50% to 58%, and where?",
    },
    {
      id: "tea-break.repeat",
      severity: "info",
      title: "2 people overran their break 3 or more times",
      detail: "They account for 75% of the minutes lost to overruns.",
      metric: "2",
      page: "tea-break",
      ask: "Who are the repeat tea-break overrunners?",
    },
  ],
  provenance: [prov("tea-attention", "Needs your attention", "Simple threshold rules over the figures on this page.")],
  notes: [],
};

const DAILY: [string, number, number, number, number | null, number | null][] = [
  // date, breaks, measured, overruns, minutes lost, overrun %
  ["2026-09-01", 1, 1, 0, 0, 0],
  ["2026-09-02", 5, 5, 2, 8, 40],
  ["2026-09-03", 4, 4, 3, 17, 75],
  ["2026-09-04", 4, 4, 3, 35, 75],
  ["2026-09-05", 4, 4, 3, 45, 75],
  ["2026-09-06", 2, 2, 1, 45, 50],
  ["2026-09-07", 1, 1, 1, 45, 100],
  ["2026-09-08", 2, 1, 0, 0, 0],
  ["2026-09-09", 1, 0, 0, null, null],
  ["2026-09-10", 1, 1, 0, 0, 0],
  ["2026-09-11", 0, 0, 0, null, null],
  ["2026-09-12", 1, 0, 0, null, null],
  ["2026-09-13", 1, 0, 0, null, null],
  ["2026-09-14", 1, 1, 1, 5, 100],
];

const point = ([date, breaks, measured, overruns, minutesLost, overrunPct]: (typeof DAILY)[number]): TeaTrendPoint => ({
  date,
  days: 1,
  breaks,
  measured,
  overruns,
  overrunPct,
  minutesLost,
  avgMinutes: null,
  maOverrunPct: overrunPct,
  maMinutesLost: minutesLost,
});

export const trend: TeaTrend = {
  ...base,
  allowedMinutes: 15,
  granularity: "day",
  points: DAILY.map(point),
  momentum: {
    windowDays: 7,
    verdict: "worse",
    text: "Getting worse: 33.3% of breaks ran over in the 7 days to 14 Sep, up 16.6 points on the 7 days before (16.7%).",
    current: { start: "2026-09-08", end: "2026-09-14", breaks: 7, measured: 3, overrunPct: 33.3, minutesLost: 5 },
    previous: { start: "2026-09-01", end: "2026-09-07", breaks: 21, measured: 21, overrunPct: 16.7, minutesLost: 195 },
    overrunPctChange: { abs: 16.6, pct: 99.4 },
    minutesLostChange: null,
  },
  worstDay: { date: "2026-09-05", overrunPct: 75, overruns: 3, measured: 4, minutesLost: 45 },
  provenance: [prov("tea-trend", "Trend", "Each day's overrun rate is its overruns divided by its measured breaks.")],
  notes: [],
};

const row = (
  key: string,
  label: string,
  r: Partial<TeaGroupRow> & Pick<TeaGroupRow, "breaks" | "measured" | "overruns">,
): TeaGroupRow => ({
  key,
  label,
  sub: null,
  headcount: null,
  employees: 0,
  participationPct: null,
  avgMinutes: null,
  overrunPct: r.measured ? Math.round((1000 * r.overruns) / r.measured) / 10 : null,
  minutesLost: null,
  shareOfLostPct: null,
  lowSample: true,
  previous: { breaks: 0, overrunPct: null, minutesLost: null },
  change: { overrunPct: null, minutesLost: null },
  ...r,
});

const average = { overrunPct: 58.3, avgMinutes: 22.2, measured: 24, minutesLost: 200 };

function breakdown(by: TeaBreakdown["by"], rows: TeaGroupRow[], id: string): TeaBreakdown {
  return {
    ...base,
    by,
    allowedMinutes: 15,
    rows,
    total: rows.length,
    truncated: false,
    average,
    minSample: 20,
    provenance: [prov(id, "Ranking", "Ranked by minutes lost, biggest first.")],
    notes: [],
  };
}

export const departments: TeaBreakdown = breakdown(
  "department",
  [
    row("Stitching", "Stitching", {
      breaks: 15,
      measured: 12,
      overruns: 8,
      minutesLost: 150,
      avgMinutes: 26.5,
      shareOfLostPct: 75,
      headcount: 2,
      employees: 3,
      participationPct: 100,
      previous: { breaks: 3, overrunPct: 33.3, minutesLost: 35 },
      change: { overrunPct: { abs: 33.4, pct: 100.3 }, minutesLost: { abs: 115, pct: 328.6 } },
    }),
    row("Cutting", "Cutting", {
      breaks: 11,
      measured: 10,
      overruns: 6,
      minutesLost: 50,
      avgMinutes: 19,
      shareOfLostPct: 25,
      headcount: 2,
      employees: 2,
      participationPct: 100,
      previous: { breaks: 4, overrunPct: 50, minutesLost: 20 },
      change: { overrunPct: { abs: 10, pct: 20 }, minutesLost: { abs: 30, pct: 150 } },
    }),
    row("Admin", "Admin", {
      breaks: 2,
      measured: 2,
      overruns: 0,
      minutesLost: 0,
      avgMinutes: 12.5,
      shareOfLostPct: 0,
      headcount: 1,
      employees: 1,
      participationPct: 100,
      previous: { breaks: 1, overrunPct: 100, minutesLost: 5 },
      change: { overrunPct: { abs: -100, pct: -100 }, minutesLost: { abs: -5, pct: -100 } },
    }),
    row("__none__", "No department", { breaks: 0, measured: 0, overruns: 0, headcount: 1, participationPct: 0 }),
  ],
  "tea-grouping",
);

export const units: TeaBreakdown = breakdown(
  "unit",
  [
    row("Unit 1", "Unit 1", {
      breaks: 24,
      measured: 20,
      overruns: 12,
      minutesLost: 180,
      avgMinutes: 22.9,
      shareOfLostPct: 90,
      headcount: 4,
    }),
    row("Unit 2", "Unit 2", {
      breaks: 4,
      measured: 4,
      overruns: 2,
      minutesLost: 20,
      avgMinutes: 19,
      shareOfLostPct: 10,
      headcount: 1,
    }),
  ],
  "tea-grouping",
);

export const types: TeaBreakdown = breakdown(
  "type",
  [
    row("production", "Production", {
      breaks: 20,
      measured: 17,
      overruns: 12,
      minutesLost: 179,
      avgMinutes: 24.5,
      shareOfLostPct: 89.5,
      headcount: 3,
    }),
    row("staff", "Staff", {
      breaks: 8,
      measured: 7,
      overruns: 2,
      minutesLost: 21,
      avgMinutes: 16.6,
      shareOfLostPct: 10.5,
      headcount: 3,
    }),
  ],
  "tea-grouping",
);

export const shifts: TeaBreakdown = breakdown(
  "shift",
  [
    row("2", "Evening", {
      sub: "14:00–22:00 · Production",
      breaks: 8,
      measured: 8,
      overruns: 6,
      minutesLost: 135,
      avgMinutes: 30.9,
      employees: 2,
      shareOfLostPct: 67.5,
    }),
    row("1", "Morning (Unit 1)", {
      sub: "09:00–17:30 · Staff",
      breaks: 13,
      measured: 9,
      overruns: 6,
      minutesLost: 45,
      avgMinutes: 19.4,
      employees: 4,
      shareOfLostPct: 22.5,
    }),
    row("3", "Morning (Unit 2)", {
      sub: "07:00–15:30 · Production",
      breaks: 4,
      measured: 4,
      overruns: 2,
      minutesLost: 20,
      avgMinutes: 19,
      employees: 1,
      shareOfLostPct: 10,
    }),
    row("__none__", "No shift assigned", {
      breaks: 3,
      measured: 3,
      overruns: 0,
      minutesLost: 0,
      avgMinutes: 11.7,
      employees: 2,
      shareOfLostPct: 0,
    }),
  ],
  "tea-shift",
);

const SLOT_LABELS = Array.from({ length: 13 }, (_, i) => {
  const slot = 20 + i;
  return { index: slot, label: `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}` };
});

const cell = (
  weekday: number,
  slot: number,
  breaks: number,
  measured: number,
  overruns: number,
  rate: number | null,
): TeaHeatCell => ({
  weekday,
  slot,
  breaks,
  measured,
  overruns,
  overrunPct: rate,
  minutesLost: measured ? overruns * 10 : null,
});

export const heatmap: TeaHeatmap = {
  ...base,
  allowedMinutes: 15,
  weekdays: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
  slots: SLOT_LABELS, // 10:00 to 16:00, the range from the first to the last half hour that has a break
  cells: [
    cell(1, 20, 1, 1, 0, null),
    cell(1, 21, 1, 1, 0, null),
    cell(2, 20, 4, 3, 1, null),
    cell(2, 21, 1, 1, 1, null),
    cell(2, 30, 1, 1, 0, null),
    cell(3, 20, 4, 4, 2, null),
    cell(3, 21, 1, 1, 1, null),
    cell(4, 32, 1, 1, 1, null),
    cell(5, 20, 3, 3, 2, 66.7),
    cell(5, 21, 1, 1, 1, null),
  ],
  totalBreaks: 18,
  minCellBreaks: 3,
  busiestSlots: [
    { slot: 20, label: "10:00", breaks: 12, sharePct: 66.7 },
    { slot: 21, label: "10:30", breaks: 4, sharePct: 22.2 },
  ],
  worstCells: [{ weekday: "Sat", slot: 20, label: "10:00", overrunPct: 66.7, measured: 3, minutesLost: 30 }],
  byWeekday: [],
  provenance: [prov("tea-slots", "Time of day and weekday", "Each break counts in the half hour in which it started.")],
  notes: [],
};

export const offenders: TeaOffenders = {
  ...base,
  allowedMinutes: 15,
  threshold: 3,
  total: 2,
  overrunners: 5,
  rows: [
    {
      employeeCode: "C",
      employeeName: "Chitra Test",
      department: "Stitching",
      unit: "Unit 1",
      type: "Production",
      breaks: 9,
      measured: 6,
      overruns: 5,
      overrunPct: 83.3,
      minutesLost: 120,
      averageOverBy: 24,
      worstMinutes: 60,
      worstOverBy: 45,
      worstDate: "2026-09-06",
    },
    {
      employeeCode: "B",
      employeeName: "Babu Test",
      department: "Cutting",
      unit: "Unit 1",
      type: "Production",
      breaks: 5,
      measured: 5,
      overruns: 4,
      overrunPct: 80,
      minutesLost: 29,
      averageOverBy: 7.2,
      worstMinutes: 30,
      worstOverBy: 15,
      worstDate: "2026-09-05",
    },
  ],
  truncated: false,
  minutesLostByRepeaters: 149,
  shareOfMinutesLostPct: 74.5,
  provenance: [PROVENANCE[5]],
  notes: [],
};

export const rule: TeaRule = {
  generatedAt: base.generatedAt,
  provenance: [prov("tea-rule", "The tea-break rule", "HR sets one allowed length for a tea break.")],
  notes: [],
  allowedMinutes: 15,
  isDefault: false,
  updatedAt: "2026-09-03",
  missedScanMinutes: 60,
  notReturnedMinutes: 60,
  leftOpenHours: 12,
  repeatMinOverruns: 3,
  minSampleBreaks: 20,
  hasGrace: false,
  hasWindows: false,
  statements: [
    "A tea break may last up to 15 minutes. A finished break counts as an overrun when it lasted longer than that, measured to the nearest whole minute.",
    "There is no grace period on top and no fixed break times: the rule is one number, the same for every employee, unit and shift.",
    "A finished break longer than 60 minutes is treated as a probable missed scan and is left out of overruns, averages and minutes lost; it is counted separately.",
  ],
};

// ─── the same endpoints with nothing in the database ────────────────────────────────────────────────────────────

const none = metric(null, null, null);

export const emptySummary: TeaSummary = {
  ...summary,
  metrics: {
    breaks: metric(0, 0, { abs: 0, pct: null }),
    employees: metric(0, 0, { abs: 0, pct: null }),
    measured: metric(0, 0, { abs: 0, pct: null }),
    avgMinutes: none,
    overruns: metric(0, 0, { abs: 0, pct: null }),
    overrunPct: none,
    compliancePct: none,
    minutesLost: none,
  },
  hoursLost: null,
  withinAllowance: null,
  coverage: {
    ...summary.coverage,
    employeesScanning: 0,
    participationPct: null,
    daysWithScans: 0,
    breaks: 0,
    measured: 0,
    longCompleted: 0,
    noReturn: 0,
    unmeasured: 0,
    unmeasuredPct: null,
  },
  notes: ["No tea-break scans were recorded for this selection (01 Sep – 14 Sep 2026)."],
};

export const emptyAttention: TeaAttention = { ...attention, items: [] };

export const emptyTrend: TeaTrend = {
  ...trend,
  points: DAILY.map(([date]) => ({
    date,
    days: 1,
    breaks: 0,
    measured: 0,
    overruns: 0,
    overrunPct: null,
    minutesLost: null,
    avgMinutes: null,
    maOverrunPct: null,
    maMinutesLost: null,
  })),
  momentum: {
    ...trend.momentum,
    verdict: "unclear",
    text: "Not enough measured breaks in the 7 days to 14 Sep and the 7 days before to say whether break discipline is getting better or worse.",
    overrunPctChange: null,
  },
  worstDay: null,
};

export const emptyBreakdown = (by: TeaBreakdown["by"]): TeaBreakdown => ({
  ...breakdown(by, [], "tea-grouping"),
  average: { overrunPct: null, avgMinutes: null, measured: 0, minutesLost: null },
});

export const emptyHeatmap: TeaHeatmap = {
  ...heatmap,
  slots: [],
  cells: [],
  totalBreaks: 0,
  busiestSlots: [],
  worstCells: [],
};

export const emptyOffenders: TeaOffenders = {
  ...offenders,
  total: 0,
  overrunners: 0,
  rows: [],
  minutesLostByRepeaters: null,
  shareOfMinutesLostPct: null,
};
