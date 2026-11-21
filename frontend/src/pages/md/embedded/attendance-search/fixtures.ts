// Responses for the Attendance Search Insights tests, with the numbers of the backend's hand-counted world
// (tests_md_punches.py: 3 people, Mon 7 - Wed 9 Sep 2026, 11 punches).

import type { Fixtures } from "@/pages/md/testing/renderMdPage";
import type {
  EmployeePunches,
  Family,
  PunchAttention,
  PunchManual,
  PunchMissing,
  PunchSources,
  PunchSummary,
} from "./types";

const base = { generatedAt: "2026-09-21T12:00:00", tookMs: 7, notes: [] as string[], provenance: [] };
const scope = {
  branchIds: [],
  departmentIds: [],
  employmentType: null,
  description: "All units · all departments · staff and production",
};
const period = { start: "2026-09-07", end: "2026-09-09", preset: "custom", label: "07 Sep – 09 Sep 2026", days: 3 };
const m = (value: number | null, previous: number | null) => ({
  value,
  previous,
  change: value != null && previous != null ? { abs: value - previous, pct: null } : null,
});

const fam = (key: Family["key"], label: string, punches: number): Family => ({
  key,
  label,
  punches,
  sharePct: punches ? Math.round((1000 * punches) / 11) / 10 : 0,
  previous: 0,
  previousSharePct: null,
});

const FAMILIES: Family[] = [
  fam("biometric", "Biometric devices", 4),
  fam("geo", "Geo Punch", 2),
  fam("on_duty", "On-Duty", 0),
  fam("import", "Excel import", 0),
  fam("missing_punch", "Missing Punch", 1),
  fam("manual", "HR Entry", 2),
  fam("auto", "Auto Attendance", 2),
  fam("other", "Other", 0),
];

export const SUMMARY: PunchSummary = {
  ...base,
  period,
  scope,
  metrics: {
    punches: m(11, 0),
    employees: m(3, 0),
    handEntered: m(3, 0),
    handEnteredPct: m(null, null),
    missingDays: m(1, 0),
    missingPct: m(null, null),
    coveragePct: m(100, null),
  },
  families: FAMILIES,
  devices: {
    listed: 2,
    reporting: 1,
    silent: 1,
    unlisted: 0,
    silentRows: [{ key: "dev2", label: "Line 2", daysSilent: 3, statusText: "Nothing for 3 working days" }],
  },
  missing: {
    complete: true,
    days: 1,
    punchDays: 7,
    pct: 14.3,
    people: 1,
    repeaters: 0,
    withRequest: 0,
    withoutRequest: 1,
    minDays: 3,
  },
  unmatched: { available: true, unresolved: 0, activeInPeriod: 0, punches: 0 },
  coverage: { coveragePct: 100, punchDays: 7 },
  heldOnDuty: { pending: 1, rejected: 1, people: 1 },
  previousPeriod: { start: "2026-09-04", end: "2026-09-06", label: "Previous 3 days" },
  briefing: {
    sentences: [
      "07 Sep – 09 Sep 2026: 11 punches. 36.4% came from biometric devices and 27.3% (3) were entered by hand.",
      "1 On-Duty punch is still waiting for HR to verify, so it is not attendance yet.",
    ],
    text: "",
    ask: "Explain how punches arrived in 07 Sep – 09 Sep 2026.",
  },
};

export const SOURCES: PunchSources = {
  ...base,
  period,
  scope,
  granularity: "day",
  families: FAMILIES,
  points: [
    {
      date: "2026-09-07",
      biometric: 2,
      geo: 2,
      on_duty: 0,
      import: 0,
      missing_punch: 0,
      manual: 0,
      auto: 0,
      other: 0,
      total: 4,
      handEntered: 0,
      handEnteredPct: 0,
    },
    {
      date: "2026-09-08",
      biometric: 1,
      geo: 0,
      on_duty: 0,
      import: 0,
      missing_punch: 0,
      manual: 0,
      auto: 2,
      other: 0,
      total: 3,
      handEntered: 0,
      handEnteredPct: 0,
    },
    {
      date: "2026-09-09",
      biometric: 1,
      geo: 0,
      on_duty: 0,
      import: 0,
      missing_punch: 1,
      manual: 2,
      auto: 0,
      other: 0,
      total: 4,
      handEntered: 3,
      handEnteredPct: 75,
    },
  ],
};

const person = (employeeId: number, employeeName: string, employeeCode: string) => ({
  employeeId,
  employeeName,
  employeeCode,
  department: "Line",
  unit: "Unit P",
  type: "Staff",
});

export const MISSING: PunchMissing = {
  ...base,
  period,
  scope,
  days: 4,
  pct: 14.3,
  people: 1,
  repeaters: 1,
  withoutRequest: 4,
  requests: { total: 0, pending: 0, approved: 0, rejected: 0, oldestPendingDays: null },
  total: 1,
  rows: [
    {
      ...person(1, "Anil T", "P001"),
      missingDays: 4,
      daysWithPunches: 20,
      missingPct: 20,
      requestsRaised: 0,
      dates: ["2026-09-08"],
    },
  ],
};

export const MANUAL: PunchManual = {
  ...base,
  byEmployee: [{ ...person(1, "Anil T", "P001"), manualPunches: 2, days: 1 }],
  byDepartment: [{ label: "Line", punches: 11, handEntered: 3, sharePct: 27.3, smallSample: true }],
};

export const ATTENTION: PunchAttention = {
  ...base,
  items: [
    {
      id: "punches.silent",
      severity: "critical",
      title: "Line 2 has stopped sending punches",
      detail: "Nothing for 3 working days.",
      ask: "Why has Line 2 stopped sending?",
    },
  ],
};

export const EMPLOYEE: EmployeePunches = {
  ...base,
  employee: { employeeId: 1, name: "Anil T", code: "P001", type: "staff", department: "Line", unit: "Unit P" },
  totals: {
    punches: 5,
    days: 3,
    oddDays: 1,
    handEntered: 2,
    handEnteredPct: 40,
    heldPending: 0,
    heldRejected: 0,
    requests: 0,
  },
  families: [
    { key: "biometric", label: "Biometric devices", punches: 3, sharePct: 60 },
    { key: "manual", label: "HR Entry", punches: 2, sharePct: 40 },
  ],
  days: [
    {
      date: "2026-09-09",
      punches: [
        { time: "09:00:00", type: "IN", family: "manual", label: "HR Entry", device: null },
        { time: "18:00:00", type: "OUT", family: "manual", label: "Manual Punch-View", device: null },
      ],
      held: [],
      request: null,
      count: 2,
      odd: false,
    },
    {
      date: "2026-09-08",
      punches: [{ time: "09:00:00", type: "IN", family: "biometric", label: "Biometric", device: "dev1" }],
      held: [{ time: "11:00:00", type: "IN", status: "pending" }],
      request: null,
      count: 1,
      odd: true,
    },
  ],
};

const BRIEF = {
  ...base,
  page: "attendance-search",
  title: "Attendance Search",
  domain: "punches",
  kpis: [],
  insights: ATTENTION.items,
};

export function punchFixtures(overrides: Fixtures = {}): Fixtures {
  return {
    "/api/md/punches/summary": SUMMARY,
    "/api/md/punches/sources": SOURCES,
    "/api/md/punches/missing": MISSING,
    "/api/md/punches/manual": MANUAL,
    "/api/md/punches/devices": {
      ...base,
      listed: 2,
      reporting: 1,
      silent: 1,
      total: 2,
      rows: [
        {
          key: "dev2",
          label: "Line 2",
          kind: "adms",
          configured: true,
          punches: 0,
          previous: 40,
          sharePct: 0,
          people: 0,
          lastPunchDate: "2026-09-04",
          daysSilent: 3,
          status: "silent",
          silent: true,
          statusText: "Nothing for 3 working days",
        },
        {
          key: "dev1",
          label: "dev1",
          kind: "adms",
          configured: true,
          punches: 4,
          previous: 0,
          sharePct: 100,
          people: 2,
          lastPunchDate: "2026-09-09",
          daysSilent: 0,
          status: "ok",
          silent: false,
          statusText: "Sending",
        },
      ],
    },
    "/api/md/punches/attention": ATTENTION,
    "/api/md/punches/employee/1": EMPLOYEE,
    "/api/md/brief/attendance-search": BRIEF,
    ...overrides,
  };
}

export function emptyPunchFixtures(): Fixtures {
  return punchFixtures({
    "/api/md/punches/summary": {
      ...SUMMARY,
      metrics: Object.fromEntries(Object.keys(SUMMARY.metrics).map((k) => [k, m(null, null)])),
      families: FAMILIES.map((f) => ({ ...f, punches: 0, sharePct: null })),
      devices: { listed: 0, reporting: 0, silent: 0, unlisted: 0, silentRows: [] },
      missing: { ...SUMMARY.missing, complete: false, days: null, pct: null, withoutRequest: null },
      coverage: null,
      heldOnDuty: { pending: 0, rejected: 0, people: 0 },
      briefing: {
        sentences: ["No punches were recorded in 07 Sep – 09 Sep 2026 for this selection."],
        text: "",
        ask: "x",
      },
      notes: ["No punches were recorded in this period."],
    },
    "/api/md/punches/sources": { ...SOURCES, points: [], families: [] },
    "/api/md/punches/missing": { ...MISSING, rows: [], total: 0 },
    "/api/md/punches/attention": { ...ATTENTION, items: [] },
    "/api/md/brief/attendance-search": { ...BRIEF, insights: [] },
  });
}
