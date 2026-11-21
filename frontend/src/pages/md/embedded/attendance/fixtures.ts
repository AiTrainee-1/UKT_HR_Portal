// Responses for the Staff / Production Attendance Insights tests. The older page's fixtures (pages/md/attendance/fixtures.ts:
// the backend tests' hand-counted week, five people) answer the cards it shares; what the server added on 2026-11-21 is
// here, with the numbers of tests_md_attendance.py DayRulesTests / PeopleDrillTests / TodayBoardTests.

import type { Fixtures } from "@/pages/md/testing/renderMdPage";
import { attendanceFixtures, emptyFixtures, EMPTY_SUMMARY, LIVE, SUMMARY } from "@/pages/md/attendance/fixtures";
import type { EmployeeDaysResponse, InsightsSummary, PeopleResponse, TodayPeopleResponse } from "./types";

const base = { generatedAt: "2026-09-21T12:00:00", tookMs: 9, notes: [] as string[], provenance: [] };
const metric = (value: number | null, previous: number | null, good: "up" | "down" | null) => ({
  value,
  previous,
  delta: value != null && previous != null ? { abs: Math.round((value - previous) * 100) / 100, pct: null } : null,
  good,
  spark: null,
});

export const INSIGHTS_SUMMARY: InsightsSummary = {
  ...SUMMARY,
  metrics: {
    ...SUMMARY.metrics,
    shiftsEarned: metric(3, 0, null),
    shiftsDeducted: metric(1, 0, "down"),
    quarterDays: metric(2, 0, "down"),
    penaltyEarlyOuts: metric(2, 0, "down"),
  },
  counts: { ...SUMMARY.counts, quarterDays: 2, penaltyEarlyOuts: 2 },
  live: {
    ...LIVE,
    board: { present: 220, onDuty: 8, onLeave: 10, cl: 4, leaveApplied: 3, absent: 17 },
  },
  briefing: [
    {
      id: "attendance",
      tone: "bad",
      text: "Attendance was 75.9% of scheduled days (down 13.7 points on the previous period).",
    },
    {
      id: "absence",
      tone: "bad",
      text: "5 unplanned absence days (17.2%) and 4 late arrivals (17.4% of days worked).",
    },
    {
      id: "deductions",
      tone: "bad",
      text: "2 days lost a quarter shift for arriving after the Late window; 2 Penalty Early Outs: 1 shift deducted in all.",
    },
  ],
  dataGaps: [{ date: "2026-09-08", type: "production" }],
  notes: [
    "Left out because no punches arrived (fewer than 1 in 10 people show work): 1 day for production (2026-09-08).",
  ],
};

export const PEOPLE_ABSENT: PeopleResponse = {
  ...base,
  metric: "absent",
  label: "Unplanned absence days",
  day: null,
  window: { start: "2026-09-07", end: "2026-09-13" },
  total: 3,
  totalDays: 5,
  page: 1,
  pageSize: 25,
  rows: [
    {
      employeeId: 2,
      name: "Bala Raj",
      code: "T002",
      department: "Stitching",
      unit: "Unit A",
      type: "staff",
      days: 3,
      dates: ["2026-09-10", "2026-09-09", "2026-09-08"],
      scheduled: 6,
      attendancePct: 33.3,
      shiftsEarned: 2,
      informed: 0,
    },
    {
      employeeId: 1,
      name: "Asha Kumar",
      code: "T001",
      department: "Stitching",
      unit: "Unit A",
      type: "staff",
      days: 1,
      dates: ["2026-09-09"],
      scheduled: 6,
      attendancePct: 75,
      shiftsEarned: 4.5,
      informed: 0,
    },
  ],
};

export const EMPLOYEE_ASHA: EmployeeDaysResponse = {
  ...base,
  employee: { employeeId: 1, name: "Asha Kumar", code: "T001", type: "staff", department: "Stitching", unit: "Unit A" },
  measured: { start: "2026-09-07", end: "2026-09-13", days: 7 },
  totals: {
    scheduled: 6,
    present: 4,
    half: 1,
    absent: 1,
    leave: 0,
    late: 1,
    quarterDays: 1,
    penaltyEarlyOuts: 0,
    attendancePct: 75,
    shiftsEarned: 4.5,
    shiftsDeducted: 0.25,
  },
  days: [
    {
      date: "2026-09-07",
      label: "Present",
      scheduled: true,
      counted: true,
      shiftsEarned: 1,
      firstPunch: "08:58",
      lastPunch: "18:02",
      source: "Biometric",
    },
    {
      date: "2026-09-08",
      label: "Present",
      scheduled: true,
      counted: true,
      shiftsEarned: 0.75,
      late: true,
      lateMinutes: 40,
      quarterOff: true,
      firstPunch: "09:40",
      lastPunch: "18:00",
      source: "Biometric",
    },
    { date: "2026-09-09", label: "Absent", scheduled: true, counted: true, shiftsEarned: 0 },
  ],
};

export const TODAY_ABSENT: TodayPeopleResponse = {
  ...base,
  date: "2026-09-21",
  state: "absent",
  label: "Not in yet",
  total: 1,
  board: { present: 220, onDuty: 8, onLeave: 10, cl: 4, leaveApplied: 3, absent: 17 },
  rows: [
    {
      employeeId: 4,
      name: "Dev Prakash",
      code: "T004",
      department: "Stitching",
      unit: "Unit A",
      type: "production",
      firstPunch: null,
    },
  ],
};

const BRIEF = {
  ...base,
  page: "attendance",
  title: "Staff Attendance",
  domain: "attendance",
  kpis: [],
  insights: [
    {
      id: "attendance.dept-spike",
      severity: "warning",
      title: "Stitching absenteeism is 14%, double its 90-day average",
      detail: "Look at Stitching first.",
      page: "attendance",
      ask: "Why is Stitching absent so often?",
    },
  ],
};

/** Every endpoint the tab and the strip call, answered. */
export function insightsFixtures(overrides: Fixtures = {}): Fixtures {
  return attendanceFixtures({
    "/api/md/attendance/summary": INSIGHTS_SUMMARY,
    "/api/md/attendance/people": PEOPLE_ABSENT,
    "/api/md/attendance/employee/1": EMPLOYEE_ASHA,
    "/api/md/attendance/employee/2": {
      ...EMPLOYEE_ASHA,
      employee: { ...EMPLOYEE_ASHA.employee, employeeId: 2, name: "Bala Raj" },
    },
    "/api/md/attendance/today-people": TODAY_ABSENT,
    "/api/md/brief/attendance": BRIEF,
    "/api/md/brief/attendance-production": { ...BRIEF, page: "attendance-production" },
    ...overrides,
  });
}

export function emptyInsightsFixtures(): Fixtures {
  return {
    ...emptyFixtures(),
    "/api/md/attendance/summary": { ...EMPTY_SUMMARY, live: null, briefing: [], dataGaps: [] },
    "/api/md/attendance/people": { ...PEOPLE_ABSENT, total: 0, totalDays: 0, rows: [] },
    "/api/md/attendance/today-people": { ...TODAY_ABSENT, total: 0, rows: [] },
    "/api/md/brief/attendance": { ...BRIEF, insights: [] },
    "/api/md/brief/attendance-production": { ...BRIEF, insights: [] },
  };
}
