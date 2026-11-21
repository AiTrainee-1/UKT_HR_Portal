import type {
  ShiftPeople,
  ShiftsAttendance,
  ShiftsAttention,
  ShiftsBriefing,
  ShiftsChanges,
  ShiftsCoverage,
  ShiftsSummary,
} from "./types";

// A hand-counted company with the production rules in force: 17 active; staff General 5, no shift 2; production 10 =
// Boiler (special) 1 + the default shifts 9.

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
      id: "shift-coverage",
      title: "Employees on a shift",
      dataset: "Employees, shift assignments",
      definition: "Active employees for whom an assignment covers today.",
      formula: null,
      rows: 17,
      filters: [],
      caveats: [],
    },
  ],
  notes: [] as string[],
};

const totals = { first: 2, moved: 1, renewed: 0, started: 3, people: 3, peopleMoved: 1 };

export const summary: ShiftsSummary = {
  ...envelope,
  asOf: "2026-11-21",
  employees: {
    active: 17,
    onShift: 15,
    noShift: 2,
    startsLater: 0,
    neverHadShift: 1,
    coveragePct: 88.2,
    staff: 7,
    production: 10,
  },
  shifts: { active: 1, inUse: 1, unused: 0, staff: 1, production: 3 },
  biggest: null,
  changes: {
    ...totals,
    scheduled: 0,
    specialStarts: 1,
    previous: { ...totals, moved: 3, started: 3, first: 0 },
    change: { moved: { abs: -2, pct: -66.7 }, started: { abs: 0, pct: 0 } },
  },
  watch: { days: 14, endingSoon: 1, overlapping: 0, startsLater: 1 },
  balance: { groups: 0, flagged: 0 },
  production: { inForce: true, workers: 10, onSpecial: 1, defaults: 2, specials: 1 },
  previousPeriod: { start: "2026-10-11", end: "2026-10-31", preset: null, label: "Previous 21 days", days: 21 },
};

export const briefing: ShiftsBriefing = {
  ...envelope,
  briefing: {
    sentences: [
      { id: "coverage", text: "15 of 17 active employees (88.2%) are on a shift today; 2 have none.", tone: "watch" },
      {
        id: "production",
        text: "10 production workers follow the production shifts of Settings (Day, Night); 1 is on a special shift.",
        tone: "neutral",
      },
    ],
    text: "",
    ask: "Give me a briefing on the shifts this month.",
  },
};

const group = (id: number, label: string, start: string) => ({
  id,
  label,
  kind: "day",
  appliesOn: "mon_sat",
  appliesOnText: "Monday to Saturday",
  start,
  firstPunchFrom: "06:30",
  firstPunchTo: "11:30",
  mainOut: "20:00",
  mainOutNextDay: false,
});

export const coverage: ShiftsCoverage = {
  ...envelope,
  asOf: "2026-11-21",
  total: 17,
  onShift: 15,
  shifts: [
    {
      id: null,
      key: "production",
      label: "Production shifts (Settings)",
      name: "Production shifts (Settings)",
      unit: null,
      unitId: null,
      type: "production",
      start: null,
      end: null,
      source: "production",
      detail: "Day 08:30, Night 21:00",
      people: 9,
      staff: 0,
      production: 9,
      sharePct: 52.9,
      departments: 2,
    },
    {
      id: 3,
      key: "3",
      label: "General",
      name: "General",
      unit: "Unit 1",
      unitId: 1,
      type: "staff",
      start: "09:00",
      end: "17:30",
      source: "template",
      people: 5,
      staff: 5,
      production: 0,
      sharePct: 29.4,
      departments: 2,
    },
    {
      id: 7,
      key: "special-7",
      label: "Boiler (special)",
      name: "Boiler",
      unit: null,
      unitId: null,
      type: "production",
      start: "07:00",
      end: null,
      source: "special",
      people: 1,
      staff: 0,
      production: 1,
      sharePct: 5.9,
      departments: 1,
    },
  ],
  shiftsTotal: 3,
  noShift: { people: 2, sharePct: 11.8 },
  byType: { staff: 7, production: 10 },
  templates: { active: 1, inUse: 1, unused: 0, staff: 1, production: 3 },
  production: {
    inForce: true,
    effectiveFrom: "2026-09-01",
    workers: 10,
    onDefaults: 9,
    onSpecial: 1,
    defaults: [
      group(1, "Day", "08:30"),
      { ...group(2, "Night", "21:00"), kind: "night", mainOut: "05:30", mainOutNextDay: true },
    ],
    specials: [
      {
        ...group(7, "Boiler", "07:00"),
        kind: "custom",
        appliesOn: "all",
        appliesOnText: "Every day",
        key: "special-7",
        people: 1,
      },
    ],
  },
};

export const changes: ShiftsChanges = {
  ...envelope,
  granularity: "day",
  points: [
    { date: "2026-11-02", days: 1, first: 2, moved: 0, renewed: 0, started: 2 },
    { date: "2026-11-03", days: 1, first: 0, moved: 1, renewed: 0, started: 1 },
  ],
};

export const late: ShiftsAttendance = {
  ...envelope,
  rows: [
    {
      id: null,
      key: "production",
      label: "Production shifts (Settings)",
      name: "Production shifts (Settings)",
      unit: null,
      unitId: null,
      type: "production",
      source: "production",
      people: 9,
      workedDays: 150,
      lateDays: 12,
      latePct: 8.0,
      attendancePct: 95.0,
      lowSample: false,
    },
    {
      id: 3,
      key: "3",
      label: "General",
      name: "General",
      unit: "Unit 1",
      unitId: 1,
      type: "staff",
      source: "template",
      people: 5,
      workedDays: 14,
      lateDays: 1,
      latePct: 7.1,
      attendancePct: 100,
      lowSample: true,
    },
  ],
  overall: { latePct: 7.9, attendancePct: 95.5, workedDays: 164 },
  minSample: 20,
};

export const attention: ShiftsAttention = {
  ...envelope,
  items: [
    {
      id: "shifts.unassigned",
      severity: "critical",
      title: "2 employees have no shift",
      detail: "2 of 17 active employees (11.8%).",
      metric: "2",
      page: "shifts",
      ask: "Who has no shift?",
    },
  ],
};

export function people(params: URLSearchParams): ShiftPeople {
  const shift = params.get("shift") ?? "none";
  const rows =
    shift === "none"
      ? [
          {
            employeeId: 8,
            employeeCode: "H",
            employeeName: "Person H",
            department: "Admin",
            unit: "Unit 1",
            type: "staff",
            since: null,
            until: null,
          },
          {
            employeeId: 9,
            employeeCode: "I",
            employeeName: "Person I",
            department: "Cutting",
            unit: "Unit 1",
            type: "staff",
            since: null,
            until: null,
          },
        ]
      : [
          {
            employeeId: 12,
            employeeCode: "M",
            employeeName: "Person M",
            department: "Cutting",
            unit: "Unit 1",
            type: "production",
            since: "2026-10-01",
            until: null,
          },
        ];
  const label =
    shift === "none"
      ? "No shift assigned"
      : shift === "special-7"
        ? "Boiler (special)"
        : "Production shifts (Settings)";
  return {
    ...envelope,
    shift: { id: null, key: shift, label, name: label, unit: null, unitId: null, type: null },
    total: rows.length,
    page: 1,
    pageSize: 25,
    pages: 1,
    rows,
  };
}

export const brief = {
  page: "shifts",
  title: "Manage Shift",
  domain: "shifts",
  kpis: [
    {
      id: "shifts.unassigned",
      label: "Employees without a shift",
      value: 2,
      format: "number",
      sub: null,
      delta: null,
      spark: null,
    },
  ],
  insights: [attention.items[0]],
  provenance: [],
  notes: [],
  generatedAt: "2026-11-21T10:00:00",
};
