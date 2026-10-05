// Fixtures for the Dashboard's tests: a realistic company (1,240 people), the same company with a failed page, and an
// empty one. They have the shape of the real responses (backend: analytics/dashboard.py).

import type { Provenance } from "@/lib/md/types";
import type {
  AttendanceTrend,
  DashboardKpi,
  DashboardOverview,
  DashboardTrends,
  MovementTrend,
  PayrollTrend,
  SourceStatus,
  UnitsToday,
} from "./types";

const prov = (id: string, title: string, definition: string): Provenance => ({
  id,
  title,
  dataset: "Test data",
  definition,
  formula: null,
  rows: null,
  filters: [],
  caveats: [],
});

const PROVENANCE: Provenance[] = [
  prov("dashboard-kpis", "Headline figures", "Each card is the figure its own page shows."),
  prov("dashboard-attention", "Needs your attention", "Exceptions merged from every page."),
  prov("dashboard-briefing", "Today's briefing", "Written by fixed rules; no AI."),
  prov("dashboard-units", "Today by unit", "Who has punched in so far."),
  prov("employees:headcount", "Active headcount", "Everyone whose status is Active."),
  prov("attendance:live-today", "In so far today", "Punched in out of scheduled."),
  prov("attendance:absenteeism-pct", "Absenteeism %", "Unplanned absence days out of scheduled days."),
  prov("employees:attrition", "Attrition over 12 months", "Leavers over average headcount."),
  prov("payroll:gross-pay", "Gross pay", "Salary earned plus overtime, before deductions."),
  prov("payroll:overtime", "Overtime", "Overtime pay."),
  prov("recruitment:open-positions", "Open positions", "Positions open today."),
  prov("visitors:visits", "Visits", "Visitors who signed in."),
];

const kpi = (
  id: string,
  module: string,
  page: string,
  label: string,
  value: number | null,
  format: DashboardKpi["format"],
  display: string | null,
  extra: Partial<DashboardKpi> = {},
): DashboardKpi => ({
  id,
  module,
  page,
  label,
  value,
  format,
  display,
  sub: null,
  delta: null,
  spark: null,
  provenanceIds: [],
  ...extra,
});

export const KPIS: DashboardKpi[] = [
  kpi("employees.headcount", "employees", "employees", "Active headcount", 1240, "number", "1,240", {
    sub: "Staff 310 · Production 930",
    delta: { abs: 12, pct: 1, good: "up" },
    spark: [1210, 1218, 1225, 1232, 1240],
    provenanceIds: ["employees:headcount"],
  }),
  kpi("attendance-today", "attendance", "attendance", "Attendance today", 90.3, "pct", "90.3%", {
    sub: "1,075 of 1,190 in so far · provisional, the day is running",
    spark: [92.1, 93, 91.4, 92.6, 93.1],
    provenanceIds: ["attendance:live-today"],
  }),
  kpi("absenteeism-30d", "attendance", "attendance", "Absenteeism, 30 days", 4.2, "pct", "4.2%", {
    sub: "3.8% in the previous 30 days",
    delta: { abs: 0.4, pct: 10.5, good: "down" },
    spark: [3.6, 3.9, 4.1, 4, 4.2],
    provenanceIds: ["attendance:absenteeism-pct"],
  }),
  kpi("employees.attrition-12m", "employees", "employees", "Attrition (12 months)", 14.2, "pct", "14.2%", {
    sub: "176 left in the last 12 months",
    delta: { abs: 1.1, pct: 8.4, good: "down" },
    spark: [10, 14, 12, 15, 18],
    provenanceIds: ["employees:attrition"],
  }),
  kpi("payroll-gross", "payroll", "payroll", "Payroll cost", 24_000_000, "inr_compact", "₹2.4 Cr", {
    sub: "Sep 2026 · 1,200 people paid",
    delta: { abs: 1_000_000, pct: 4.3, good: "down" },
    spark: [21e6, 22e6, 22.5e6, 23e6, 24e6],
    provenanceIds: ["payroll:gross-pay"],
  }),
  kpi("payroll-overtime", "payroll", "payroll", "Overtime cost", 1_500_000, "inr_compact", "₹15 L", {
    sub: "6.3% of payroll",
    delta: { abs: 200_000, pct: 15.4, good: "down" },
    provenanceIds: ["payroll:overtime"],
  }),
  kpi("recruitment.open_positions", "recruitment", "recruitment", "Open positions", 12, "number", "12", {
    sub: "9 vacancies against plan · 3 over 45 days",
    provenanceIds: ["recruitment:open-positions"],
  }),
  kpi("visitors-today", "visitors", "visitors", "Visitors today", 18, "number", "18", {
    sub: "21 yesterday",
    spark: [14, 19, 22, 21, 18],
    provenanceIds: ["visitors:visits"],
  }),
];

const UNITS: UnitsToday = {
  date: "2026-10-05",
  asOf: "2026-10-05T14:10:00",
  provisional: true,
  isWorkingDay: true,
  lateKnown: false,
  total: { expected: 1190, present: 1075, late: null, leave: 20, absent: 95, attendancePct: 90.3 },
  rows: [
    { id: 1, name: "Unit 1", expected: 700, present: 595, late: null, leave: 10, absent: 95, attendancePct: 85 },
    { id: 2, name: "Unit 2", expected: 490, present: 480, late: null, leave: 10, absent: 0, attendancePct: 98 },
  ],
  weakestDepartment: { name: "Stitching", expected: 400, present: 330, absent: 70, attendancePct: 82.5 },
};

export const UNITS_WITH_LATE: UnitsToday = {
  ...UNITS,
  lateKnown: true,
  total: { ...UNITS.total, late: 41 },
  rows: [
    { ...UNITS.rows[0], late: 30 },
    { ...UNITS.rows[1], late: 11 },
  ],
};

const source = (title: string, page: string, kpis: number, insights: number, extra: Partial<SourceStatus> = {}) => ({
  title,
  page,
  ok: true,
  tookMs: 40,
  kpis,
  insights,
  ...extra,
});

const SOURCES: Record<string, SourceStatus> = {
  attendance: source("Attendance Analytics", "attendance", 3, 2),
  employees: source("Employees", "employees", 3, 1),
  payroll: source("Payroll Analysis", "payroll", 3, 1),
  recruitment: source("Recruitment", "recruitment", 3, 1),
  visitors: source("Outpass & Visitors", "visitors", 3, 0),
  tea_break: source("Tea Break", "tea-break", 2, 0),
  activity: source("Activity Logs", "activity", 3, 1),
};

const SENTENCES = [
  {
    id: "attendance",
    page: "attendance",
    tone: "watch" as const,
    text: "Attendance is 90.3% so far today, 3.1 points below the 30-day average of 93.4%.",
  },
  {
    id: "weakest",
    page: "attendance",
    tone: "watch" as const,
    text: "Unit 1 is the weakest unit so far today, at 85% (595 of 700 in), and Stitching the weakest department, at 82.5%.",
  },
  {
    id: "payroll",
    page: "payroll",
    tone: "neutral" as const,
    text: "Payroll for Sep 2026 came to ₹2.4 Cr, 4.3% more than Aug 2026.",
  },
  {
    id: "hiring",
    page: "employees",
    tone: "neutral" as const,
    text: "This month 14 people joined and 9 left (net +5); attrition over the last 12 months is 14.2%, with 12 positions open.",
  },
  {
    id: "decisions",
    page: "recruitment",
    tone: "watch" as const,
    text: "2 resignations are waiting for a decision (oldest waiting 12 days).",
  },
  {
    id: "exception",
    page: "attendance",
    tone: "watch" as const,
    text: "The most important item: Stitching absenteeism is 14%, double its 90-day average. 2 other items also need a look.",
  },
];

export const overview: DashboardOverview = {
  generatedAt: "2026-10-05T14:10:00",
  today: "2026-10-05",
  settled: true,
  kpis: KPIS,
  insights: [
    {
      id: "attendance.dept-spike",
      module: "attendance",
      severity: "critical",
      title: "Stitching absenteeism is 14%, double its 90-day average",
      detail: "132 unplanned absence days in the last 7 days across 400 employees.",
      metric: "14%",
      page: "attendance",
      ask: "Why is absenteeism high in Stitching over the last 7 days, and who is absent?",
    },
    {
      id: "employees.hotspot",
      module: "employees",
      severity: "warning",
      title: "Stitching attrition is 21.4%, against 14.2% across the company",
      detail: "31 leavers in the last 90 days.",
      metric: "21.4%",
      page: "employees",
      ask: "Why are people leaving Stitching?",
    },
    {
      id: "payroll.unpaid-2026-09",
      module: "payroll",
      severity: "warning",
      title: "12 of 1,200 slips for Sep 2026 are not marked paid",
      detail: "Salary day was the 5th, 0 day(s) ago.",
      metric: "₹3.1 L",
      page: "payroll",
      ask: "Which September salary slips are still not marked paid?",
    },
    {
      id: "recruitment.stale",
      module: "recruitment",
      severity: "info",
      title: "3 positions have been open more than 45 days",
      detail: null,
      metric: "3",
      page: "recruitment",
      ask: "Which positions have been open the longest?",
    },
    {
      id: "attendance.improved",
      module: "attendance",
      severity: "good",
      title: "Attendance rose 1.8 points to 93.4%",
      detail: "Against 91.6% in the previous 30 days.",
      metric: "93.4%",
      page: "attendance",
      ask: "What drove the improvement in attendance?",
    },
  ],
  insightsTotal: 7,
  briefing: {
    sentences: SENTENCES,
    text: SENTENCES.map((s) => s.text).join(" "),
    ask: "Give me a briefing on how the company is doing today",
  },
  units: UNITS,
  sources: SOURCES,
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: PROVENANCE,
  notes: [],
};

/** Payroll could not be read: its cards and exceptions are missing and a reserve card has taken a place. */
export const overviewWithFailedPayroll: DashboardOverview = {
  ...overview,
  kpis: [
    ...KPIS.filter((k) => k.module !== "payroll"),
    kpi("late-30d", "attendance", "attendance", "Late arrivals, 30 days", 6, "pct", "6%", {
      sub: "5.2% in the previous 30 days",
    }),
    kpi("recruitment.joined_this_month", "recruitment", "recruitment", "Joined this month", 14, "number", "14", {
      sub: "9 left · net +5",
    }),
  ],
  insights: overview.insights.filter((i) => i.module !== "payroll"),
  insightsTotal: 6,
  briefing: {
    ...overview.briefing,
    sentences: SENTENCES.filter((s) => s.id !== "payroll"),
    text: SENTENCES.filter((s) => s.id !== "payroll")
      .map((s) => s.text)
      .join(" "),
  },
  sources: {
    ...SOURCES,
    payroll: source("Payroll Analysis", "payroll", 0, 0, {
      ok: false,
      error: "Payroll Analysis could not be loaded just now.",
    }),
  },
  notes: ["Payroll Analysis could not be loaded, so what it adds is missing here."],
};

/** Everything answered, but today's count by unit failed on its own. */
export const overviewWithFailedUnits: DashboardOverview = {
  ...overview,
  units: { error: "Attendance Analytics could not be loaded just now." },
  sources: {
    ...SOURCES,
    attendance: source("Attendance Analytics", "attendance", 3, 2, {
      ok: false,
      error: "Attendance Analytics could not be loaded just now.",
    }),
  },
  notes: ["Attendance Analytics could not be loaded, so what it adds is missing here."],
};

/** A company with no data yet: nothing is scheduled, no payroll, no joiners or leavers. */
export const emptyOverview: DashboardOverview = {
  ...overview,
  kpis: [
    kpi("employees.headcount", "employees", "employees", "Active headcount", 0, "number", "0", {
      sub: "Staff 0 · Production 0",
    }),
    kpi("attendance-today", "attendance", "attendance", "Attendance today", null, "pct", null, {
      sub: "Weekly off or holiday today",
    }),
    kpi("absenteeism-30d", "attendance", "attendance", "Absenteeism, 30 days", null, "pct", null),
    kpi("employees.attrition-12m", "employees", "employees", "Attrition (12 months)", null, "pct", null),
    kpi("payroll-gross", "payroll", "payroll", "Payroll cost", null, "inr_compact", null, {
      sub: "No payroll processed yet",
    }),
    kpi("recruitment.open_positions", "recruitment", "recruitment", "Open positions", 0, "number", "0", {
      sub: "No staffing plan set",
    }),
    kpi("visitors-today", "visitors", "visitors", "Visitors today", 0, "number", "0", { sub: "0 yesterday" }),
  ],
  insights: [
    {
      id: "activity.silent",
      module: "activity",
      severity: "info",
      title: "No system activity was recorded in the last 7 days",
      detail: "No actions and no sign-ins.",
      metric: "0",
      page: "activity",
      ask: "Why was no activity recorded in the system in the last 7 days?",
    },
  ],
  insightsTotal: 1,
  briefing: {
    sentences: [
      {
        id: "exception",
        page: null,
        tone: "good",
        text: "Nothing across attendance, people, payroll, hiring, visitors, tea breaks or system activity needs your attention right now.",
      },
    ],
    text: "Nothing across attendance, people, payroll, hiring, visitors, tea breaks or system activity needs your attention right now.",
    ask: "Give me a briefing on how the company is doing today",
  },
  units: {
    ...UNITS,
    isWorkingDay: false,
    rows: [],
    weakestDepartment: null,
    total: { expected: 0, present: 0, late: null, leave: 0, absent: 0, attendancePct: null },
  },
};

const ISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const attendancePoints = (): AttendanceTrend["points"] => {
  const points: AttendanceTrend["points"] = [];
  for (let back = 28; back >= 1; back--) {
    const day = new Date(2026, 9, 5 - back);
    if (day.getDay() === 0) continue; // no Sundays
    const dip = back === 9 ? 6 : 0;
    const attendancePct = Math.round((93.4 + ((back * 7) % 5) * 0.4 - 0.8 - dip) * 10) / 10;
    points.push({
      date: ISO(day),
      days: 1,
      attendancePct,
      absentPct: Math.round((100 - attendancePct - 2) * 10) / 10,
      latePct: 5.5,
      present: Math.round(11.9 * attendancePct),
      absent: Math.round(11.9 * (100 - attendancePct - 2)),
      expected: 1190,
    });
  }
  return points;
};

const ATTENDANCE: AttendanceTrend = {
  granularity: "day",
  points: attendancePoints(),
  average: { attendancePct: 93.4, absentPct: 4.2, latePct: 6 },
  provenance: [prov("attendance-pct", "Attendance %", "Days present out of scheduled days.")],
  notes: [],
};

const MONTHS = [
  "2025-10",
  "2025-11",
  "2025-12",
  "2026-01",
  "2026-02",
  "2026-03",
  "2026-04",
  "2026-05",
  "2026-06",
  "2026-07",
  "2026-08",
  "2026-09",
];
const MONTH_NAMES = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];

const PAYROLL: PayrollTrend = {
  hasData: true,
  month: "2026-09",
  months: MONTHS.map((month, i) => ({
    month,
    label: `${MONTH_NAMES[i]} ${month.slice(0, 4)}`,
    hasData: true,
    state: i === 11 ? "generated" : "paid",
    provisionalSlips: 0,
    grossPay: 21_000_000 + i * 270_000,
    netPay: 19_000_000 + i * 250_000,
    headcount: 1100 + i * 9,
    costPerHead: 19_000,
    overtimePay: 1_200_000,
  })),
  average: 22_500_000,
  highest: { month: "2026-09", label: "Sep 2026", grossPay: 23_970_000 },
  lowest: { month: "2025-10", label: "Oct 2025", grossPay: 21_000_000 },
  provenance: [prov("gross-pay", "Gross pay", "Salary earned plus overtime, before deductions.")],
  notes: [],
};

const MOVEMENT: MovementTrend = {
  grain: "month",
  points: MONTHS.map((month, i) => ({
    key: month,
    label: `${MONTH_NAMES[i]} ${month.slice(0, 4)}`,
    start: `${month}-01`,
    end: `${month}-28`,
    joiners: 10 + ((i * 3) % 7),
    leavers: 8 + ((i * 5) % 9),
    net: 2 - ((i * 2) % 5),
    headcount: 1100 + i * 9,
  })),
  totals: { joiners: 165, leavers: 177, net: -12, opening: 1252, closing: 1240 },
  provenance: [prov("movement", "Joiners, leavers and headcount over time", "Rebuilt from join and exit dates.")],
  notes: [],
};

export const trends: DashboardTrends = {
  generatedAt: "2026-10-05T14:10:00",
  today: "2026-10-05",
  attendance: ATTENDANCE,
  payroll: PAYROLL,
  movement: MOVEMENT,
  scope: overview.scope,
  provenance: [prov("dashboard-trends", "Trends", "The pages' own trend figures.")],
  notes: [],
};

export const trendsWithFailedPayroll: DashboardTrends = {
  ...trends,
  payroll: { error: "Payroll Analysis could not be loaded just now." },
  notes: ["Payroll Analysis could not be loaded, so what it adds is missing here."],
};

export const emptyTrends: DashboardTrends = {
  ...trends,
  attendance: {
    granularity: "day",
    points: [],
    average: null,
    provenance: [],
    notes: ["No attendance records exist for the days of this period yet."],
  },
  payroll: {
    hasData: false,
    months: [],
    average: null,
    highest: null,
    lowest: null,
    provenance: [],
    notes: ["No payroll has been processed yet."],
  },
  movement: {
    grain: "month",
    points: MOVEMENT.points.map((p) => ({ ...p, joiners: 0, leavers: 0, net: 0, headcount: 0 })),
    totals: { joiners: 0, leavers: 0, net: 0, opening: 0, closing: 0 },
    provenance: [],
    notes: [],
  },
};

const page = (id: string, title: string, summary: string) => ({ id, title, path: `/md/${id}`, summary });

export const ME = {
  id: 1,
  username: "md",
  name: "R. Murugan",
  assignedAt: null,
  serverTime: "2026-10-05T14:10:00",
  pages: [
    page("dashboard", "Dashboard", "The company at a glance."),
    page("attendance", "Attendance Analytics", "Attendance, absenteeism, lateness and overtime over any period."),
    page("employees", "Employees", "Workforce composition, tenure, movement and a people directory."),
    page("visitors", "Outpass & Visitors", "Visitors and employee outpasses: volumes, time out, approvals."),
    page("tea-break", "Tea Break", "Tea-break discipline: overruns, minutes lost, by department and shift."),
    page("payroll", "Payroll Analysis", "Payroll cost and its trend, what changed against last month and why."),
    page("reports", "Reports", "Executive reports and the full report library."),
    page("recruitment", "Recruitment", "Open positions, the hiring funnel, new joinees and resignations."),
    page("activity", "Activity Logs", "What people did in the system: volume, sensitive actions, sign-ins."),
  ],
};
