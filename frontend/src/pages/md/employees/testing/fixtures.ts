// Responses of the Employees endpoints for the tests: one coherent company, so the numbers on every card agree.
//   last 12 months: 1,252 people at the start, 165 joined, 177 left (net -12), 1,240 today (310 staff + 930 production).

import type { MdEnvelope, MdPeriod, Provenance } from "@/lib/md/types";
import type {
  EmployeeProfile,
  EmployeesAttrition,
  EmployeesComposition,
  EmployeesDirectory,
  EmployeesInsights,
  EmployeesMilestones,
  EmployeesMovement,
  EmployeesSummary,
  MovementPoint,
} from "../types";

export const prov = (id: string, title: string, caveats: string[] = []): Provenance => ({
  id,
  title,
  dataset: "Employee records",
  definition: `How ${title.toLowerCase()} is worked out.`,
  formula: null,
  rows: 1240,
  filters: [],
  caveats,
});

const period: MdPeriod = {
  start: "2025-11-01",
  end: "2026-10-05",
  preset: "last_12_months",
  label: "Last 12 months",
  days: 339,
};
const previousPeriod: MdPeriod = {
  start: "2024-12-02",
  end: "2025-10-31",
  preset: null,
  label: "Previous 339 days",
  days: 339,
};

const base = (extra: Partial<MdEnvelope> = {}): MdEnvelope => ({
  generatedAt: "2026-10-05T10:42:10",
  period,
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: [],
  notes: [],
  ...extra,
});

export const summary: EmployeesSummary = {
  ...base({
    notes: [
      "12 people have a missing or unusable join date: they are counted as having been here since before the period.",
    ],
    provenance: [
      prov("headcount", "Active headcount"),
      prov("reconstructed-headcount", "Headcount at the start and end of the period", [
        "The system keeps no headcount history: headcount on a past day is rebuilt from join dates and exit dates.",
      ]),
      prov("joiners-leavers", "Joiners, leavers and net change"),
      prov("attrition", "Attrition %"),
      prov("tenure", "Average tenure"),
      prov("early-attrition", "Early attrition"),
      prov("gender-age", "Gender split and average age"),
    ],
  }),
  asOf: "2026-10-05",
  headcount: {
    current: 1240,
    staff: 310,
    production: 930,
    other: 0,
    opening: 1252,
    closing: 1240,
    change: { abs: -12, pct: -1.0 },
  },
  joiners: { count: 165, previous: 150, change: { abs: 15, pct: 10.0 } },
  leavers: { count: 177, previous: 160, change: { abs: 17, pct: 10.6 }, approximate: 3 },
  net: { count: -12, previous: -10, change: { abs: -2, pct: -20.0 } },
  attrition: {
    pct: 14.2,
    annualisedPct: 15.3,
    averageHeadcount: 1246,
    previousPct: 12.1,
    change: { abs: 2.1, pct: 17.4 },
  },
  tenure: { averageYears: 3.4, previousYears: 3.3, change: { abs: 0.1, pct: 3.0 }, unknown: 12 },
  earlyAttrition: { count: 14, pctOfLeavers: 7.9, previous: 12, change: { abs: 2, pct: 16.7 } },
  gender: { male: 730, female: 450, other: 0, unspecified: 60, recorded: 1180, femalePct: 38.1 },
  age: { average: 31.2, known: 1180 },
  previousPeriod,
  dataQuality: { noJoinDate: 12, futureJoinDate: 0, exitBeforeJoin: 0, unplaced: 12 },
};

const JOINERS = [7, 10, 18, 12, 16, 14, 13, 15, 17, 16, 24, 3];
const LEAVERS = [9, 14, 21, 15, 12, 20, 16, 17, 14, 13, 21, 5];
const HEADCOUNT = [1250, 1246, 1243, 1240, 1244, 1238, 1235, 1233, 1236, 1239, 1242, 1240];
const MONTH_KEYS = [
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
  "2026-10",
];

export const movementMonthly: EmployeesMovement = {
  ...base({ provenance: [prov("movement", "Joiners, leavers and headcount over time")] }),
  grain: "month",
  points: MONTH_KEYS.map((key, i): MovementPoint => ({
    key,
    label: key,
    start: `${key}-01`,
    end: `${key}-28`,
    joiners: JOINERS[i],
    leavers: LEAVERS[i],
    net: JOINERS[i] - LEAVERS[i],
    headcount: HEADCOUNT[i],
  })),
  totals: { joiners: 165, leavers: 177, net: -12, opening: 1252, closing: 1240 },
};

export const movementWeekly: EmployeesMovement = {
  ...movementMonthly,
  grain: "week",
  points: [
    {
      key: "2026-09-06",
      label: "06 Sep - 12 Sep",
      start: "2026-09-06",
      end: "2026-09-12",
      joiners: 2,
      leavers: 4,
      net: -2,
      headcount: 1250,
    },
    {
      key: "2026-09-13",
      label: "13 Sep - 19 Sep",
      start: "2026-09-13",
      end: "2026-09-19",
      joiners: 5,
      leavers: 3,
      net: 2,
      headcount: 1252,
    },
    {
      key: "2026-09-20",
      label: "20 Sep - 26 Sep",
      start: "2026-09-20",
      end: "2026-09-26",
      joiners: 1,
      leavers: 6,
      net: -5,
      headcount: 1247,
    },
  ],
};

export const composition: EmployeesComposition = {
  ...base({
    period: undefined,
    provenance: [
      prov("composition", "Workforce composition"),
      prov("age-tenure-bands", "Age and length of service"),
      prov("staffing-plan", "Planned vs actual staff"),
    ],
  }),
  asOf: "2026-10-05",
  total: 1240,
  byType: [
    { key: "staff", label: "Staff", count: 310, pct: 25.0 },
    { key: "production", label: "Production", count: 930, pct: 75.0 },
  ],
  byUnit: [
    { id: 1, label: "Unit 1", count: 820, pct: 66.1, staff: 180, production: 640 },
    { id: 2, label: "Head Office", count: 420, pct: 33.9, staff: 130, production: 290 },
  ],
  byDepartment: [
    { id: 10, label: "Stitching (Unit 1)", unit: "Unit 1", count: 410, pct: 33.1, staff: 10, production: 400 },
    { id: 12, label: "Stitching (Unit 2)", unit: "Head Office", count: 280, pct: 22.6, staff: 6, production: 274 },
    { id: 11, label: "Cutting", unit: "Unit 1", count: 150, pct: 12.1, staff: 24, production: 126 },
    { id: 13, label: "Accounts", unit: "Head Office", count: 60, pct: 4.8, staff: 60, production: 0 },
    { id: null, label: "Other (4)", count: 340, pct: 27.4, staff: 210, production: 130, other: true },
  ],
  departmentsTotal: 8,
  byDesignation: [
    { id: null, label: "Operator", count: 800, pct: 64.5 },
    { id: null, label: "Helper", count: 130, pct: 10.5 },
    { id: null, label: "Other (9)", count: 310, pct: 25.0, other: true },
  ],
  designationsTotal: 11,
  byGender: [
    { key: "male", label: "Male", count: 730, pct: 58.9 },
    { key: "female", label: "Female", count: 450, pct: 36.3 },
    { key: "unspecified", label: "Not recorded", count: 60, pct: 4.8 },
  ],
  byAgeBand: [
    { label: "Under 18", count: 0, pct: 0 },
    { label: "18-25", count: 300, pct: 24.2 },
    { label: "26-35", count: 520, pct: 41.9 },
    { label: "36-45", count: 280, pct: 22.6 },
    { label: "46-55", count: 80, pct: 6.5 },
    { label: "56+", count: 0, pct: 0 },
    { label: "Not recorded", count: 60, pct: 4.8 },
  ],
  byTenureBand: [
    { label: "Under 1 year", count: 380, pct: 30.6 },
    { label: "1-3 years", count: 410, pct: 33.1 },
    { label: "3-5 years", count: 230, pct: 18.5 },
    { label: "5-10 years", count: 160, pct: 12.9 },
    { label: "10+ years", count: 48, pct: 3.9 },
    { label: "Not known", count: 12, pct: 1.0 },
  ],
  staffing: {
    rows: [
      { departmentId: 13, label: "Accounts", unit: "Head Office", required: 70, actual: 60, gap: 10, fillPct: 85.7 },
      { departmentId: 11, label: "Cutting", unit: "Unit 1", required: 24, actual: 24, gap: 0, fillPct: 100 },
    ],
    required: 94,
    actual: 84,
    vacancies: 10,
    departmentsBelow: 1,
    planned: true,
  },
};

export const attrition: EmployeesAttrition = {
  ...base({
    provenance: [
      prov("attrition-by-group", "Attrition by department, unit and employee type"),
      prov("tenure-at-exit", "How long people stayed"),
      prov("leaving-reasons", "Why people leave", [
        "The reasons are free writing, so the grouping is a keyword match.",
      ]),
      prov("early-leavers", "Left within 90 days"),
    ],
    notes: ["3 of the 177 leavers have only an approximate exit date."],
  }),
  company: { leavers: 177, averageHeadcount: 1246, attritionPct: 14.2, annualisedPct: 15.3 },
  byDepartment: [
    {
      id: 10,
      label: "Stitching (Unit 1)",
      unit: "Unit 1",
      leavers: 90,
      averageHeadcount: 420,
      attritionPct: 21.4,
      opening: 430,
      closing: 410,
      hotspot: true,
    },
    {
      id: 11,
      label: "Cutting",
      unit: "Unit 1",
      leavers: 20,
      averageHeadcount: 150,
      attritionPct: 13.3,
      opening: 150,
      closing: 150,
    },
    {
      id: 13,
      label: "Accounts",
      unit: "Head Office",
      leavers: 3,
      averageHeadcount: 60,
      attritionPct: 5.0,
      opening: 60,
      closing: 60,
    },
  ],
  departmentsWithLeavers: 3,
  departmentsTotal: 8,
  byUnit: [
    { id: 1, label: "Unit 1", leavers: 130, averageHeadcount: 830, attritionPct: 15.7, opening: 840, closing: 820 },
    { id: 2, label: "Head Office", leavers: 47, averageHeadcount: 416, attritionPct: 11.3, opening: 412, closing: 420 },
  ],
  byType: [
    {
      id: "production",
      label: "Production",
      leavers: 150,
      averageHeadcount: 940,
      attritionPct: 16.0,
      opening: 950,
      closing: 930,
    },
    { id: "staff", label: "Staff", leavers: 27, averageHeadcount: 306, attritionPct: 8.8, opening: 302, closing: 310 },
  ],
  hotspots: [
    {
      id: 10,
      label: "Stitching (Unit 1)",
      unit: "Unit 1",
      leavers: 90,
      averageHeadcount: 420,
      attritionPct: 21.4,
      opening: 430,
      closing: 410,
      hotspot: true,
    },
  ],
  tenureAtExit: [
    { key: "early", label: "Within 90 days", count: 14, pct: 7.9 },
    { key: "under1y", label: "3-12 months", count: 60, pct: 33.9 },
    { key: "1to3", label: "1-3 years", count: 70, pct: 39.5 },
    { key: "3to5", label: "3-5 years", count: 20, pct: 11.3 },
    { key: "5plus", label: "5+ years", count: 10, pct: 5.6 },
    { key: "unknown", label: "Not known", count: 3, pct: 1.7 },
  ],
  reasons: [
    { key: "better_pay", label: "Better pay or opportunity", count: 70, pct: 39.5 },
    { key: "personal", label: "Family or personal reasons", count: 40, pct: 22.6 },
    { key: "health", label: "Health", count: 10, pct: 5.6 },
    { key: "other", label: "Other reasons", count: 20, pct: 11.3 },
    { key: "none", label: "No reason recorded", count: 37, pct: 20.9 },
  ],
  early: {
    count: 14,
    pctOfLeavers: 7.9,
    items: [
      {
        id: 501,
        name: "Jaya Lakshmi",
        code: "E501",
        department: "Stitching (Unit 1)",
        designation: "Operator",
        unit: "Unit 1",
        joined: "2026-08-01",
        left: "2026-09-20",
        days: 50,
        reason: "Family or personal reasons",
        approximate: false,
      },
      {
        id: 502,
        name: "Ilango Selvam",
        code: "E502",
        department: "Stitching (Unit 1)",
        designation: "Operator",
        unit: "Unit 1",
        joined: "2026-07-20",
        left: "2026-09-12",
        days: 54,
        reason: "Better pay or opportunity",
        approximate: true,
      },
    ],
  },
  approximateExits: 3,
};

export const milestones: EmployeesMilestones = {
  ...base({
    period: undefined,
    provenance: [
      prov("anniversaries", "Work anniversaries"),
      prov("birthdays", "Birthdays"),
      prov("probation", "Probation and confirmation"),
    ],
    notes: ["12 of 1,240 people have no date of birth, so their birthday is not listed."],
  }),
  asOf: "2026-10-05",
  windowDays: 30,
  anniversaries: {
    minYears: 5,
    total: 2,
    today: 1,
    items: [
      {
        id: 2,
        name: "Arun Kumar",
        code: "A2",
        department: "Accounts",
        designation: "Accountant",
        date: "2026-10-05",
        years: 5,
        joined: "2021-10-05",
      },
      {
        id: 1,
        name: "Anita Raman",
        code: "A1",
        department: "Accounts",
        designation: "Accountant",
        date: "2026-10-12",
        years: 7,
        joined: "2019-10-12",
      },
    ],
  },
  birthdays: {
    windowDays: 7,
    total: 1,
    items: [
      {
        id: 4,
        name: "Chitra Devi",
        code: "A4",
        department: "Stitching (Unit 1)",
        designation: "Operator",
        date: "2026-10-07",
      },
    ],
  },
  probation: {
    recorded: 3,
    dueSoonDays: 30,
    dueSoon: 1,
    pendingConfirmation: 1,
    items: [
      {
        id: 4,
        name: "Chitra Devi",
        code: "A4",
        department: "Stitching (Unit 1)",
        designation: "Operator",
        date: "2026-10-20",
      },
    ],
  },
};

export const insights: EmployeesInsights = {
  ...base({ provenance: [prov("exceptions", "What needs attention")] }),
  total: 3,
  items: [
    {
      id: "employees.attrition-hotspot.10",
      severity: "critical",
      title: "Stitching (Unit 1) attrition is 21.4%, against 14.2% across the company",
      detail: "90 people left from an average of 420 in last 12 months.",
      metric: "21.4%",
      page: "employees",
      ask: "Why is attrition high in Stitching (Unit 1)?",
    },
    {
      id: "employees.staffing-gap",
      severity: "warning",
      title: "Accounts has 60 staff against 70 planned",
      detail: "1 department(s) are below their planned staff, 10 vacancies in all.",
      metric: "-10",
      page: "employees",
      ask: "Which departments are below their planned staffing?",
    },
    {
      id: "employees.long-service",
      severity: "good",
      title: "2 people complete 5+ years of service in the next 30 days",
      detail: "Worth a word of thanks.",
      metric: "2",
      page: "employees",
      ask: "Who completes 5 or more years of service in the next 30 days?",
    },
  ],
};

export const directory: EmployeesDirectory = {
  ...base({ period: undefined, provenance: [prov("directory", "People directory")] }),
  total: 23,
  page: 1,
  pageSize: 10,
  pages: 3,
  rows: [
    {
      id: 1,
      name: "Anita Raman",
      code: "A1",
      designation: "Accountant",
      department: "Accounts",
      unit: "Head Office",
      type: "staff",
      joinDate: "2019-10-12",
      tenure: "6y 11m",
      tenureYears: 6.9,
      status: "active",
      leftOn: null,
    },
    {
      id: 2,
      name: "Arun Kumar",
      code: "A2",
      designation: "Accountant",
      department: "Accounts",
      unit: "Head Office",
      type: "staff",
      joinDate: "2021-10-05",
      tenure: "5y",
      tenureYears: 5,
      status: "active",
      leftOn: null,
    },
    {
      id: 3,
      name: "Balu Chandran",
      code: "A3",
      designation: "Cutting Master",
      department: "Cutting",
      unit: "Unit 1",
      type: "staff",
      joinDate: "2016-03-01",
      tenure: "10y 7m",
      tenureYears: 10.6,
      status: "active",
      leftOn: null,
    },
    {
      id: 7,
      name: "Farida Banu",
      code: "A7",
      designation: "Operator",
      department: "Stitching (Unit 2)",
      unit: "Head Office",
      type: "production",
      joinDate: null,
      tenure: null,
      tenureYears: null,
      status: "active",
      leftOn: null,
    },
    {
      id: 9,
      name: "Karthik Subbu",
      code: "L3",
      designation: "Accountant",
      department: "Accounts",
      unit: "Head Office",
      type: "staff",
      joinDate: "2018-01-15",
      tenure: "8y 8m",
      tenureYears: 8.7,
      status: "inactive",
      leftOn: "2026-09-30",
    },
  ],
  options: { designations: ["Operator", "Helper", "Accountant", "Cutting Master"] },
};

export const profile: EmployeeProfile = {
  ...base({ period: undefined, scope: undefined, provenance: [prov("profile", "Employee profile")] }),
  found: true,
  asOf: "2026-10-05",
  profile: {
    id: 1,
    name: "Anita Raman",
    code: "A1",
    status: "active",
    type: "staff",
    designation: "Accountant",
    department: "Accounts",
    unit: "Head Office",
    reportsTo: "Balu Chandran",
    gender: "female",
    ageBand: "36-45",
    joinDate: "2019-10-12",
    tenure: "6y 11m",
    tenureYears: 6.9,
    leftOn: null,
    exitApproximate: null,
    leavingReason: null,
    leavingReasonText: null,
    probationEnd: null,
    confirmedOn: null,
  },
  history: [
    { type: "increment", date: "2025-04-01", title: "Increment given", detail: "7.8%" },
    { type: "promotion", date: "2023-04-01", title: "Promoted to Accountant", detail: "From Junior Accountant" },
    { type: "joined", date: "2019-10-12", title: "Joined the company", detail: null },
  ],
  attendance: {
    from: "2026-07-07",
    to: "2026-10-04",
    attendancePct: 72.7,
    presentDays: 7,
    halfDays: 2,
    absentDays: 2,
    leaveDays: 1,
    lateDays: 2,
    recordedDays: 14,
    coveragePct: 15.6,
  },
  leaveBalance: [{ type: "Casual Leave", allocated: 12, used: 2.5, remaining: 9.5 }],
  documents: { required: 6, onFile: 4, missing: ["Bank Passbook", "Staff Letter"] },
};

export const emptySummary: EmployeesSummary = {
  ...summary,
  provenance: [],
  notes: [],
  headcount: { current: 0, staff: 0, production: 0, other: 0, opening: 0, closing: 0, change: { abs: 0, pct: null } },
  joiners: { count: 0, previous: 0, change: { abs: 0, pct: null } },
  leavers: { count: 0, previous: 0, change: { abs: 0, pct: null }, approximate: 0 },
  net: { count: 0, previous: 0, change: { abs: 0, pct: null } },
  attrition: { pct: null, annualisedPct: null, averageHeadcount: 0, previousPct: null, change: null },
  tenure: { averageYears: null, previousYears: null, change: null, unknown: 0 },
  earlyAttrition: { count: 0, pctOfLeavers: null, previous: 0, change: { abs: 0, pct: null } },
  gender: { male: 0, female: 0, other: 0, unspecified: 0, recorded: 0, femalePct: null },
  age: { average: null, known: 0 },
  dataQuality: { noJoinDate: 0, futureJoinDate: 0, exitBeforeJoin: 0, unplaced: 0 },
};

export const emptyComposition: EmployeesComposition = {
  ...composition,
  total: 0,
  byType: [],
  byUnit: [],
  byDepartment: [],
  departmentsTotal: 0,
  byDesignation: [],
  designationsTotal: 0,
  byGender: [],
  byAgeBand: [],
  byTenureBand: [],
  staffing: { rows: [], required: 0, actual: 0, vacancies: 0, departmentsBelow: 0, planned: false },
  notes: [
    "No required headcount is set for these departments (Recruitment, Required Roles), so staffing gaps cannot be shown.",
  ],
};

export const emptyMovement: EmployeesMovement = {
  ...movementMonthly,
  points: [],
  totals: { joiners: 0, leavers: 0, net: 0, opening: 0, closing: 0 },
};

export const emptyAttrition: EmployeesAttrition = {
  ...attrition,
  company: { leavers: 0, averageHeadcount: 0, attritionPct: null, annualisedPct: null },
  byDepartment: [],
  departmentsWithLeavers: 0,
  departmentsTotal: 0,
  byUnit: [],
  byType: [],
  hotspots: [],
  tenureAtExit: [],
  reasons: [],
  early: { count: 0, pctOfLeavers: null, items: [] },
  approximateExits: 0,
  notes: [],
};

export const emptyMilestones: EmployeesMilestones = {
  ...milestones,
  anniversaries: { minYears: 5, total: 0, today: 0, items: [] },
  birthdays: { windowDays: 7, total: 0, items: [] },
  probation: { recorded: 0, dueSoonDays: 30, dueSoon: 0, pendingConfirmation: 0, items: [] },
};

export const emptyInsights: EmployeesInsights = { ...insights, items: [], total: 0 };
export const emptyDirectory: EmployeesDirectory = {
  ...directory,
  total: 0,
  pages: 1,
  rows: [],
  options: { designations: [] },
};
