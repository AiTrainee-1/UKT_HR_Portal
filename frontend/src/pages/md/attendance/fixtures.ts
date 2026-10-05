// Responses shaped like GET /api/md/attendance/*, for the page's smoke test. The figures are the ones the backend tests work
// out by hand (tests_md_attendance.py: one week, five people), so a number on screen can be checked against them.

import type { Fixtures } from "@/pages/md/testing/renderMdPage";
import type {
  AttendanceDay,
  AttendanceDepartments,
  AttendanceExceptions,
  AttendanceHeatmap,
  AttendanceLeave,
  AttendanceOvertime,
  AttendanceSummary,
  AttendanceTrend,
  AttendanceWeekday,
  GroupRow,
  Metric,
} from "./types";

const base = { generatedAt: "2026-09-21T12:00:00", tookMs: 12, notes: [] as string[] };
const period = { start: "2026-09-07", end: "2026-09-13", preset: "custom", label: "07 Sep – 13 Sep 2026", days: 7 };
const scope = {
  branchIds: [],
  departmentIds: [],
  employmentType: null,
  description: "All units · all departments · staff and production",
};

const metric = (
  value: number | null,
  previous: number | null,
  good: Metric["good"],
  spark: (number | null)[] | null = null,
): Metric => ({
  value,
  previous,
  delta: value != null && previous != null ? { abs: Math.round((value - previous) * 10) / 10, pct: null } : null,
  good,
  spark,
});

const prov = (id: string, title: string) => ({
  id,
  title,
  dataset: "Attendance day records (what payroll pays from)",
  definition: `How ${title} is made.`,
  formula: "a ÷ b",
  rows: 29,
  filters: [],
  caveats: [],
});

export const SUMMARY: AttendanceSummary = {
  ...base,
  period,
  scope,
  measured: { start: "2026-09-07", end: "2026-09-13", days: 7 },
  previous: { start: "2026-08-31", end: "2026-09-06", days: 7 },
  metrics: {
    attendancePct: metric(75.9, 89.6, "up", [100, 80, 50, 60, 90, 75]),
    absenteeismPct: metric(17.2, 8.3, "down", [0, 20, 40, 40, 0, 0]),
    latePct: metric(17.4, 0, "down", [0, 50, 33.3, 0, 20, 0]),
    avgLateMinutes: metric(35, null, "down"),
    overtimeHours: metric(6.5, 1, "down"),
    halfDays: metric(2, 1, "down"),
    missingPunches: metric(2, 1, "down"),
    leaveDays: metric(1, 0, null),
    scheduledDays: metric(29, 24, null),
    coveragePct: metric(100, 100, "up"),
  },
  counts: {
    present: 21,
    half: 2,
    absent: 5,
    leave: 1,
    late: 4,
    worked: 23,
    scheduledWithRecord: 29,
    workedOnDaysOff: 0,
    informedAbsences: 0,
    overtimeDays: 3,
  },
  coverage: { expectedDays: 29, recordedDays: 29, missingDays: 0, coveragePct: 100, partial: false, worstDays: [] },
  live: null,
  provenance: [
    prov("attendance-pct", "attendance %"),
    prov("absenteeism-pct", "absenteeism %"),
    prov("late-pct", "late arrivals %"),
    prov("avg-late-minutes", "average minutes late"),
    prov("overtime-hours", "overtime hours"),
    prov("half-days", "half days"),
    prov("missing-punches", "missing punches"),
    prov("coverage", "data coverage"),
  ],
};

export const LIVE = {
  date: "2026-09-21",
  provisional: true,
  asOf: "2026-09-21T10:42:10",
  isWorkingDay: true,
  expected: 262,
  present: 228,
  leave: 14,
  absent: 20,
  attendancePct: 87,
  workedDayOff: 0,
  byUnit: [
    { name: "Unit 1", id: 1, expected: 180, present: 150, leave: 10, absent: 20, attendancePct: 83.3 },
    { name: "Head Office", id: 2, expected: 82, present: 78, leave: 4, absent: 0, attendancePct: 95.1 },
  ],
  byDepartment: [{ name: "Stitching", expected: 90, present: 70, leave: 0, absent: 20, attendancePct: 77.8 }],
  byType: [],
};

const point = (date: string, att: number | null, absent: number | null, late: number | null) => ({
  date,
  days: 1,
  attendancePct: att,
  absentPct: absent,
  latePct: late,
  present: 4,
  half: 0,
  absent: 1,
  leave: 0,
  late: 1,
  expected: 5,
  rostered: 5,
  coveragePct: 100,
});

export const TREND: AttendanceTrend = {
  ...base,
  period,
  scope,
  granularity: "day",
  points: [
    point("2026-09-07", 100, 0, 0),
    point("2026-09-08", 80, 20, 50),
    point("2026-09-09", 50, 40, 33.3),
    point("2026-09-10", 60, 40, 0),
    point("2026-09-11", 90, 0, 20),
    point("2026-09-12", 75, 0, 0),
  ],
  average: { attendancePct: 75.9, absentPct: 17.2, latePct: 17.4 },
  provenance: [prov("attendance-pct", "attendance %")],
};

export const WEEKDAY: AttendanceWeekday = {
  ...base,
  period,
  scope,
  weekdays: [
    { weekday: 0, name: "Mon", days: 1, attendancePct: 100, absentPct: 0, latePct: 0, absent: 0, scheduledDays: 5 },
    { weekday: 2, name: "Wed", days: 1, attendancePct: 50, absentPct: 40, latePct: 33.3, absent: 2, scheduledDays: 5 },
  ],
  lowest: {
    weekday: 2,
    name: "Wed",
    days: 1,
    attendancePct: 50,
    absentPct: 40,
    latePct: 33.3,
    absent: 2,
    scheduledDays: 5,
  },
  mondayEffect: { mondayAbsentPct: 0, otherDaysAbsentPct: 20.8, gapPts: -20.8, mondays: 1 },
  heatmap: { weeks: ["2026-09-07"], weekdays: ["Mon", "Wed"], values: [[100], [50]] },
  provenance: [prov("weekday-pattern", "attendance by weekday")],
};

export const HEATMAP: AttendanceHeatmap = {
  ...base,
  period,
  scope,
  days: ["2026-09-07", "2026-09-08", "2026-09-09"],
  departments: ["Stitching", "Cutting"],
  values: [
    [100, 66.7, 16.7],
    [100, 100, null],
  ],
  totalDepartments: 2,
  shownDepartments: 2,
  capped: false,
  provenance: [prov("department-heatmap", "department attendance by day")],
};

const row = (name: string, att: number | null, extra: Partial<GroupRow> = {}): GroupRow => ({
  key: name,
  name,
  headcount: 3,
  scheduledDays: 18,
  attendancePct: att,
  absenteeismPct: att == null ? null : Math.round((100 - att) * 10) / 10,
  latePct: 8.3,
  halfDays: 2,
  absentDays: 5,
  overtimeHours: 3.5,
  previous: { attendancePct: 83.3, absenteeismPct: 13.3, latePct: 0 },
  delta: { attendancePct: -22.2, absenteeismPct: 14.5, latePct: 8.3 },
  spark: [null, null, null, null, null, null, 83.3, att],
  hasRecords: att != null,
  ...extra,
});

export const DEPARTMENTS: AttendanceDepartments = {
  ...base,
  period,
  scope,
  baseline: { attendancePct: 75.9, absenteeismPct: 17.2, latePct: 17.4 },
  departments: [
    row("Stitching", 61.1, { gapPts: -14.8, belowBaseline: true }),
    row("Cutting", 100, {
      headcount: 1,
      absentDays: 0,
      overtimeHours: 0,
      delta: { attendancePct: 0, absenteeismPct: 0, latePct: 60 },
    }),
  ],
  units: [row("Unit A", 69.6, { id: 1, headcount: 4 }), row("Head Office", 100, { id: 2, headcount: 1 })],
  types: [row("Production", 75, { key: "production" }), row("Staff", 76.1, { key: "staff" })],
  total: 2,
  limit: 50,
  provenance: [prov("department-ranking", "department ranking")],
};

const person = { employeeId: 2, name: "Bala Raj", code: "T002", department: "Stitching", unit: "Unit A" };

export const EXCEPTIONS: AttendanceExceptions = {
  ...base,
  period,
  scope,
  thresholds: {
    chronicAbsent: { minDays: 3, minPctOfScheduledDays: 10 },
    habitualLate: { minDays: 4, minPctOfWorkedDays: 15 },
    longAbsence: { minDays: 3 },
    missingPunches: { minRequests: 3 },
    afterOff: { minAbsences: 3, minSharePct: 60 },
    belowBaseline: { gapPts: 3, minHeadcount: 5 },
  },
  chronicAbsentees: {
    total: 1,
    rows: [
      {
        ...person,
        absentDays: 3,
        scheduledDays: 6,
        absentPct: 50,
        informedDays: 0,
        leaveDays: 1,
        dates: ["2026-09-10", "2026-09-09", "2026-09-08"],
      },
    ],
  },
  habitualLate: { total: 0, rows: [] },
  longAbsences: {
    total: 1,
    rows: [
      { ...person, streakDays: 3, from: "2026-09-08", to: "2026-09-10", ongoing: false, lastWorked: "2026-09-11" },
    ],
  },
  missingPunches: {
    total: 1,
    rows: [
      {
        ...person,
        employeeId: 1,
        name: "Asha Kumar",
        code: "T001",
        requests: 3,
        pending: 2,
        approved: 1,
        rejected: 0,
        dates: ["2026-09-10", "2026-09-09", "2026-09-08"],
      },
    ],
  },
  afterOffAbsences: { total: 0, rows: [] },
  belowBaseline: { total: 1, rows: [row("Stitching", 61.1, { gapPts: -14.8, belowBaseline: true })] },
  mondayEffect: null,
  counts: {},
  attention: [
    {
      id: "attendance.long-absence",
      severity: "warning",
      title: "1 employee has been absent 3+ days in a row without explanation",
      detail: "The longest run is 3 days.",
      metric: "1",
      page: null,
      ask: "Which employees have been absent 3 or more days in a row?",
    },
    {
      id: "attendance.dept-below-baseline",
      severity: "warning",
      title: "1 department is well below the company's attendance",
      detail: "Stitching is at 61.1% against 75.9% for the company.",
      metric: "61.1%",
      page: null,
      ask: "Why is attendance low in Stitching?",
    },
  ],
  provenance: [prov("exceptions-absence", "chronic absentees and long absences")],
};

export const OVERTIME: AttendanceOvertime = {
  ...base,
  period,
  scope,
  totalHours: 6.5,
  previousHours: 1,
  delta: { abs: 5.5, pct: 550 },
  days: 3,
  employees: 2,
  pctOfScheduledHours: 3.5,
  scheduledHours: 184,
  decisions: {
    announcedPay: { days: 1, hours: 2 },
    announcedRelaxation: { days: 1, hours: 3 },
    detected: { days: 1, hours: 1.5 },
    rejected: { days: 1, hours: 1 },
  },
  tracking: { featureEnabled: true, detectionEnabled: true },
  byDepartment: [
    { name: "Stitching", hours: 3.5, days: 2, employees: 1, sharePct: 53.8 },
    { name: "Accounts", hours: 3, days: 1, employees: 1, sharePct: 46.2 },
  ],
  departmentsTotal: 2,
  topEarners: [
    { employeeId: 1, name: "Asha Kumar", code: "T001", department: "Stitching", unit: "Unit A", hours: 3.5, days: 2 },
  ],
  earnersTotal: 2,
  trend: {
    granularity: "day",
    points: [
      { date: "2026-09-09", hours: 2, employees: 1 },
      { date: "2026-09-10", hours: 1.5, employees: 1 },
    ],
  },
  provenance: [prov("overtime-hours", "overtime hours")],
};

export const LEAVE: AttendanceLeave = {
  ...base,
  period,
  scope,
  pending: [
    { kind: "leave", label: "Leave requests", count: 2, oldestDays: 20, oldestOn: "2026-09-01" },
    { kind: "permission", label: "Permission requests", count: 1, oldestDays: 3, oldestOn: "2026-09-18" },
    { kind: "casual_leave", label: "Casual leave requests", count: 0, oldestDays: null, oldestOn: null },
    { kind: "missing_punch", label: "Missing punch requests", count: 0, oldestDays: null, oldestOn: null },
  ],
  pendingTotal: 3,
  oldestPendingDays: 20,
  totalDays: 3.5,
  previousDays: 1,
  delta: { abs: 2.5, pct: 250 },
  byType: [
    { key: "t1", name: "Sick Leave", days: 1.5, requests: 2, paid: true },
    { key: "t2", name: "Casual Leave", days: 1, requests: 1, paid: true },
  ],
  employeesOnLeave: 3,
  casualLeaveDays: 1,
  permissions: {
    approved: 2,
    previousApproved: 1,
    delta: { abs: 1, pct: 100 },
    byType: [{ type: "Morning late-in", count: 1 }],
  },
  provenance: [prov("leave-by-type", "leave days by type")],
};

export const DAY: AttendanceDay = {
  ...base,
  period,
  scope,
  date: "2026-09-20",
  weekday: "Sun",
  isToday: false,
  provisional: false,
  source: "attendance day records",
  isWorkingDay: true,
  totals: {
    name: "All",
    expected: 5,
    present: 3,
    half: 1,
    absent: 2,
    leave: 0,
    late: 1,
    notRecorded: 0,
    attendancePct: 50,
    absentPct: 40,
  },
  byUnit: [
    {
      name: "Unit A",
      id: 1,
      expected: 4,
      present: 2,
      half: 1,
      absent: 2,
      leave: 0,
      late: 1,
      notRecorded: 0,
      attendancePct: 37.5,
      absentPct: 50,
    },
  ],
  byDepartment: [
    {
      name: "Stitching",
      expected: 3,
      present: 1,
      half: 1,
      absent: 2,
      leave: 0,
      late: 0,
      notRecorded: 0,
      attendancePct: 16.7,
      absentPct: 66.7,
    },
  ],
  byType: [],
  provenance: [prov("attendance-pct", "attendance %")],
};

/** The page with every endpoint answered. Pass overrides to change one (or `{status, body}` for an error). */
export function attendanceFixtures(overrides: Fixtures = {}): Fixtures {
  return {
    "/api/md/attendance/summary": SUMMARY,
    "/api/md/attendance/trend": TREND,
    "/api/md/attendance/weekday": WEEKDAY,
    "/api/md/attendance/heatmap": HEATMAP,
    "/api/md/attendance/departments": DEPARTMENTS,
    "/api/md/attendance/exceptions": EXCEPTIONS,
    "/api/md/attendance/overtime": OVERTIME,
    "/api/md/attendance/leave": LEAVE,
    "/api/md/attendance/day": DAY,
    ...overrides,
  };
}

/** Nothing recorded: no employees, no day records. Every figure is null, every list empty. */
export const EMPTY_SUMMARY: AttendanceSummary = {
  ...SUMMARY,
  metrics: Object.fromEntries(
    Object.keys(SUMMARY.metrics).map((k) => [k, { value: null, previous: null, delta: null, good: null, spark: null }]),
  ),
  counts: {},
  coverage: { expectedDays: 0, recordedDays: 0, missingDays: 0, coveragePct: null, partial: false, worstDays: [] },
  notes: ["No attendance day records exist for these days: HR has not opened or processed them in Attendance yet."],
};

export function emptyFixtures(): Fixtures {
  return attendanceFixtures({
    "/api/md/attendance/summary": EMPTY_SUMMARY,
    "/api/md/attendance/trend": { ...TREND, points: [], average: null },
    "/api/md/attendance/weekday": {
      ...WEEKDAY,
      weekdays: [],
      lowest: null,
      mondayEffect: null,
      heatmap: { weeks: [], weekdays: [], values: [] },
    },
    "/api/md/attendance/heatmap": {
      ...HEATMAP,
      days: [],
      departments: [],
      values: [],
      totalDepartments: 0,
      shownDepartments: 0,
    },
    "/api/md/attendance/departments": {
      ...DEPARTMENTS,
      departments: [],
      units: [],
      types: [],
      total: 0,
      baseline: null,
    },
    "/api/md/attendance/exceptions": {
      ...EXCEPTIONS,
      chronicAbsentees: { total: 0, rows: [] },
      longAbsences: { total: 0, rows: [] },
      missingPunches: { total: 0, rows: [] },
      belowBaseline: { total: 0, rows: [] },
      attention: [],
    },
    "/api/md/attendance/overtime": {
      ...OVERTIME,
      totalHours: null,
      previousHours: null,
      delta: null,
      byDepartment: [],
      topEarners: [],
      decisions: undefined,
      pctOfScheduledHours: null,
      trend: { granularity: "day", points: [] },
      tracking: { featureEnabled: true, detectionEnabled: false },
    },
    "/api/md/attendance/leave": {
      ...LEAVE,
      pending: [],
      pendingTotal: 0,
      oldestPendingDays: null,
      totalDays: null,
      previousDays: null,
      delta: null,
      byType: [],
      employeesOnLeave: null,
      permissions: null,
    },
    "/api/md/attendance/day": { ...DAY, totals: null, byUnit: [], byDepartment: [], isWorkingDay: false },
  });
}
