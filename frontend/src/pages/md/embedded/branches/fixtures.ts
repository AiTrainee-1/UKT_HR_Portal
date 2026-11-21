import type { MetricDef, MetricEntry, MetricId, UnitProfile, UnitsAttention, UnitsSummary, UnitsTrend } from "./types";

// Two units, hand-counted (Nov 2026 so far): Unit 1 has 80 active, attendance 92.0%; Unit 2 has 40, attendance 80.0%;
// the company 88.0%.

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
      id: "units-comparison",
      title: "How units are compared",
      dataset: "Employees, attendance day records",
      definition: "One row per unit.",
      formula: null,
      rows: 2,
      filters: [],
      caveats: [],
    },
  ],
  notes: [] as string[],
};

const def = (
  id: MetricId,
  label: string,
  format: MetricDef["format"],
  good: MetricDef["good"],
  kind: MetricDef["kind"],
): MetricDef => ({
  id,
  label,
  format,
  good,
  kind,
  group: "attendance",
  window: "period",
  rankBy: kind === "total" ? "largest" : "best",
  hint: label,
});

export const METRICS: MetricDef[] = [
  def("headcount", "Active headcount", "number", null, "total"),
  def("attendancePct", "Attendance", "pct", "up", "rate"),
  def("absenteeismPct", "Absenteeism", "pct", "down", "rate"),
  def("latePct", "Late arrivals", "pct", "down", "rate"),
  def("overtimeHours", "Overtime hours", "hours", "down", "total"),
  def("overtimePerHead", "Overtime per staff member", "hours", "down", "average"),
  def("attritionPct", "Attrition (12 months)", "pct", "down", "rate"),
  def("joiners", "Joiners", "number", null, "total"),
  def("leavers", "Leavers", "number", "down", "total"),
  def("avgTenureYears", "Average tenure", "years", "up", "average"),
  def("payrollCost", "Payroll cost", "inr_compact", null, "total"),
  def("costPerHead", "Cost per person", "inr_compact", null, "average"),
];

const entry = (value: number | null, reference: number | null, extra: Partial<MetricEntry> = {}): MetricEntry => ({
  value,
  reference,
  diff: value != null && reference != null ? Math.round((value - reference) * 10) / 10 : null,
  diffPct: null,
  sharePct: null,
  rank: 1,
  of: 2,
  verdict: null,
  previous: null,
  delta: null,
  ...extra,
});

const COMPANY = {
  headcount: 120,
  attendancePct: 88.0,
  absenteeismPct: 9.0,
  latePct: 4.0,
  overtimeHours: 30.5,
  overtimePerHead: 0.5,
  attritionPct: 12.5,
  joiners: 6,
  leavers: 4,
  avgTenureYears: 4.2,
  payrollCost: 2450000,
  costPerHead: 20416.67,
} as Record<MetricId, number | null>;

function metrics(
  values: Partial<Record<MetricId, number>>,
  verdicts: Partial<Record<MetricId, MetricEntry["verdict"]>>,
) {
  return Object.fromEntries(
    METRICS.map((m) => [m.id, entry(values[m.id] ?? null, COMPANY[m.id], { verdict: verdicts[m.id] ?? null })]),
  ) as Record<MetricId, MetricEntry>;
}

export const summary: UnitsSummary = {
  ...envelope,
  today: "2026-11-21",
  measured: { start: "2026-11-01", end: "2026-11-20", days: 20 },
  previous: { start: "2026-10-12", end: "2026-10-31", days: 20 },
  payrollMonth: { key: "2026-10", label: "Oct 2026", ended: true, previousLabel: "Sep 2026" },
  metrics: METRICS,
  unitCount: 2,
  company: {
    label: "Company",
    headcount: 120,
    staff: 80,
    production: 40,
    factory: 9,
    metrics: COMPANY,
    previous: { ...COMPANY, attendancePct: 86.5, absenteeismPct: 10.0, latePct: 4.5 },
  },
  rows: [
    {
      id: 1,
      name: "Unit 1",
      isHeadOffice: false,
      isActive: true,
      headcount: 80,
      staff: 50,
      production: 30,
      factory: 6,
      metrics: metrics(
        { headcount: 80, attendancePct: 92.0, absenteeismPct: 6.0, latePct: 3.0, costPerHead: 21000 },
        { attendancePct: "better", absenteeismPct: "better", latePct: "similar" },
      ),
    },
    {
      id: 2,
      name: "Unit 2",
      isHeadOffice: false,
      isActive: true,
      headcount: 40,
      staff: 30,
      production: 10,
      factory: 3,
      metrics: metrics(
        { headcount: 40, attendancePct: 80.0, absenteeismPct: 15.0, latePct: 6.0, costPerHead: 19250 },
        { attendancePct: "worse", absenteeismPct: "worse", latePct: "worse" },
      ),
    },
  ],
  otTracked: true,
  briefing: {
    sentences: [
      {
        id: "units",
        text: "The company has 2 units and 120 active people; Unit 1 is the largest with 80 (67%).",
        tone: "neutral",
      },
      {
        id: "attendance",
        text: "Attendance was 88.0%: Unit 1 led at 92.0% and Unit 2 trailed at 80.0%.",
        tone: "watch",
      },
    ],
    text: "",
    ask: "Compare our units.",
  },
};

export function trend(params: URLSearchParams): UnitsTrend {
  const metric = (params.get("metric") ?? "attendancePct") as MetricId;
  return {
    ...envelope,
    metric: METRICS.find((m) => m.id === metric)!,
    granularity: "week",
    buckets: [
      { key: "2026-11-02", label: "02 Nov" },
      { key: "2026-11-09", label: "09 Nov" },
    ],
    units: [
      { id: 1, name: "Unit 1", values: [91, 93] },
      { id: 2, name: "Unit 2", values: [82, 78] },
    ],
    company: [88, 88],
  };
}

export const attention: UnitsAttention = {
  ...envelope,
  items: [
    {
      id: "units.attendance-gap",
      severity: "critical",
      title: "Unit 2 attendance is 8.0 points below the company average",
      detail: "This month: Unit 2 80.0% against 88.0% for the company.",
      metric: "-8.0 pts",
      page: "branches",
      ask: "Why is Unit 2 behind?",
    },
  ],
};

export const profile: UnitProfile = {
  ...envelope,
  unit: { id: 2, name: "Unit 2", isHeadOffice: false, isActive: true },
  row: summary.rows[1],
  company: summary.company,
  departments: {
    referenceLabel: "Unit 2",
    reference: summary.company,
    total: 1,
    rows: [{ ...summary.rows[1], id: 21, name: "Stitching" }],
  },
  payrollMonth: summary.payrollMonth,
};

export const people = {
  ...envelope,
  group: "active",
  value: null,
  title: "People here today",
  total: 1,
  page: 1,
  pageSize: 25,
  pages: 1,
  rows: [
    {
      id: 9,
      name: "Kavya S",
      code: "U2-9",
      type: "production",
      designation: "Operator",
      department: "Stitching",
      unit: "Unit 2",
      joinDate: "2024-02-01",
      leftOn: null,
      exitApproximate: null,
      tenure: "2 years",
      status: "active",
      factoryLabel: null,
      cycle: "Weekly",
      statutory: "Neither",
    },
  ],
};

export const brief = {
  page: "branches",
  title: "Branches",
  domain: "units",
  kpis: [
    { id: "units.count", label: "Units", value: 2, format: "number", sub: "120 active people", delta: null, spark: [] },
  ],
  insights: [attention.items[0]],
  provenance: [],
  notes: [],
  generatedAt: "2026-11-21T10:00:00",
};
