import type {
  Briefing,
  EmpComposition,
  EmpExceptions,
  EmpMovement,
  EmpSummary,
  EmpWorkforce,
  PeopleList,
} from "./types";

// A hand-counted company for the Employees Insights tests (Nov 2026 so far): 120 here today (80 staff, 40 production),
// 6 joined and 4 left in the month (1 within 90 days), 9 Factory Employees.

const envelope = {
  generatedAt: "2026-11-21T10:00:00",
  period: { start: "2026-11-01", end: "2026-11-21", preset: "this_month", label: "This month", days: 21 },
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: [
    {
      id: "headcount",
      title: "Active headcount",
      dataset: "Employee records",
      definition: "Everyone whose status is Active today.",
      formula: null,
      rows: 120,
      filters: [],
      caveats: [],
    },
  ],
  notes: [] as string[],
};

export const summary: EmpSummary = {
  ...envelope,
  asOf: "2026-11-21",
  headcount: {
    current: 120,
    staff: 80,
    production: 40,
    other: 0,
    factory: 9,
    opening: 118,
    closing: 120,
    change: { abs: 2, pct: 1.7 },
  },
  joiners: { count: 6, previous: 3, change: { abs: 3, pct: 100 } },
  leavers: { count: 4, previous: 5, change: { abs: -1, pct: -20 }, approximate: 1 },
  net: { count: 2, previous: -2, change: { abs: 4, pct: null } },
  attrition: {
    pct: 3.4,
    annualisedPct: 58.5,
    averageHeadcount: 119,
    previousPct: 4.2,
    change: { abs: -0.8, pct: -19 },
  },
  tenure: { averageYears: 4.2, previousYears: 4.1, change: { abs: 0.1, pct: 2.4 }, unknown: 3 },
  earlyAttrition: { count: 1, pctOfLeavers: 25, previous: 0, change: { abs: 1, pct: null } },
  previousPeriod: { start: "2026-10-11", end: "2026-10-31", preset: null, label: "Previous 21 days", days: 21 },
};

export const briefing: Briefing = {
  ...envelope,
  briefing: {
    sentences: [
      {
        id: "headcount",
        text: "120 people are here today: 80 staff and 40 production; 9 of them are Factory Employees.",
        tone: "neutral",
      },
      {
        id: "movement",
        text: "This month: 6 joined and 4 left (net +2), against 3 and 5 in the 21 days before.",
        tone: "good",
      },
      {
        id: "cycles",
        text: "2 production workers have no pay cycle, so no production payroll includes them yet.",
        tone: "watch",
      },
    ],
    text: "",
    ask: "Give me a briefing on the workforce (This month).",
  },
};

export const movement: EmpMovement = {
  ...envelope,
  grain: "week",
  points: [
    {
      key: "2026-11-02",
      label: "02 Nov",
      start: "2026-11-02",
      end: "2026-11-08",
      joiners: 2,
      leavers: 1,
      net: 1,
      headcount: 119,
    },
    {
      key: "2026-11-09",
      label: "09 Nov",
      start: "2026-11-09",
      end: "2026-11-15",
      joiners: 3,
      leavers: 2,
      net: 1,
      headcount: 120,
    },
    {
      key: "2026-11-16",
      label: "16 Nov",
      start: "2026-11-16",
      end: "2026-11-21",
      joiners: 1,
      leavers: 1,
      net: 0,
      headcount: 120,
    },
  ],
  totals: { joiners: 6, leavers: 4, net: 2, opening: 118, closing: 120 },
};

export const attention: EmpExceptions = {
  ...envelope,
  items: [
    {
      id: "employees.hotspot",
      severity: "warning",
      title: "Stitching lost 3 people this month",
      detail: "Twice the company rate.",
      metric: "3",
      page: "employees",
      ask: "Why is Stitching losing people?",
    },
    {
      id: "employees.long-service",
      severity: "good",
      title: "4 people complete 5 years this month",
      detail: null,
      metric: "4",
      page: "employees",
      ask: null,
    },
  ],
  total: 2,
};

export const workforce: EmpWorkforce = {
  ...envelope,
  asOf: "2026-11-21",
  active: 120,
  types: { staff: 80, production: 40, other: 0 },
  factory: {
    people: 9,
    sharePct: 7.5,
    labels: [
      { id: 1, label: "Driver", people: 5, staff: 5, production: 0, sharePct: 55.6 },
      { id: 4, label: "Security", people: 3, staff: 1, production: 2, sharePct: 33.3 },
      { id: null, label: "No label", people: 1, staff: 1, production: 0, sharePct: 11.1 },
    ],
  },
  cycles: {
    production: 40,
    unassigned: 2,
    rows: [
      { key: "weekly", label: "Weekly", people: 10, sharePct: 25 },
      { key: "biweekly", label: "BiWeekly", people: 28, sharePct: 70 },
      { key: "monthly", label: "Monthly", people: 0, sharePct: 0 },
      { key: "none", label: "Not assigned", people: 2, sharePct: 5 },
    ],
  },
  statutory: [
    { key: "co_emp", label: "Co Emp (PF and ESI)", people: 70, sharePct: 58.3 },
    { key: "tds", label: "TDS", people: 6, sharePct: 5 },
    { key: "none", label: "Neither", people: 44, sharePct: 36.7 },
  ],
};

export const composition: EmpComposition = {
  ...envelope,
  total: 120,
  byDepartment: [
    { id: 10, label: "Stitching", count: 50, staff: 10, production: 40, pct: 41.7 },
    { id: 12, label: "Accounts", count: 12, staff: 12, production: 0, pct: 10 },
  ],
  departmentsTotal: 2,
  byUnit: [{ id: 1, label: "Unit 1", count: 120, pct: 100 }],
};

const person = (id: number, name: string, extra: Partial<PeopleList["rows"][number]> = {}) => ({
  id,
  name,
  code: `E${id}`,
  type: "staff",
  designation: "Operator",
  department: "Stitching",
  unit: "Unit 1",
  joinDate: "2026-11-03",
  leftOn: null,
  exitApproximate: null,
  tenure: "2 years",
  status: "active" as const,
  factoryLabel: null,
  cycle: null,
  statutory: "Neither",
  ...extra,
});

export function people(params: URLSearchParams): PeopleList {
  const group = (params.get("group") ?? "active") as PeopleList["group"];
  const rows =
    group === "joiners"
      ? [person(7, "Asha Devi", { joinDate: "2026-11-12" }), person(8, "Ravi Kumar", { joinDate: "2026-11-03" })]
      : group === "factory"
        ? [person(21, "Mani Driver", { factoryLabel: "Driver" })]
        : group === "cycle"
          ? []
          : [person(1, "Anita Raman"), person(2, "Balu Chandran")];
  return {
    ...envelope,
    group,
    value: params.get("value"),
    title: group === "joiners" ? "Joiners" : group === "factory" ? "Factory Employees" : "People here today",
    total: rows.length,
    page: 1,
    pageSize: 25,
    pages: 1,
    rows,
  };
}

export const brief = {
  page: "employees",
  title: "Employees",
  domain: "employees",
  kpis: [
    { id: "employees.headcount", label: "Headcount", value: 120, format: "number", sub: null, delta: null, spark: [] },
    {
      id: "employees.attrition",
      label: "Attrition (30 days)",
      value: 3.4,
      format: "pct",
      sub: null,
      delta: null,
      spark: [],
    },
  ],
  insights: [
    {
      id: "employees.hotspot",
      severity: "warning",
      title: "Stitching lost 3 people this month",
      detail: "Twice the company rate.",
      metric: "3",
      page: "employees",
      ask: "Why?",
    },
  ],
  provenance: [],
  notes: [],
  generatedAt: "2026-11-21T10:00:00",
};
