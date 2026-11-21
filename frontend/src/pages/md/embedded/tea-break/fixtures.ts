// Fixtures for the Tea Break Insights tests: what /api/md/tea-break/* returns, with small hand-counted numbers.

import type { MdEnvelope } from "@/lib/md/types";
import type {
  TeaAttention,
  TeaGroupBy,
  TeaGroups,
  TeaOffenders,
  TeaRecords,
  TeaStory,
  TeaSummary,
  TeaTrend,
} from "./types";

const env = (): MdEnvelope => ({
  generatedAt: "2026-11-21T10:00:00",
  period: { start: "2026-11-01", end: "2026-11-21", preset: "this_month", label: "This month", days: 21 },
  scope: { branchIds: [], departmentIds: [], employmentType: null, description: "All units" },
  provenance: [],
  notes: [],
});

const m = (value: number | null, previous: number | null) => ({
  value,
  previous,
  change: value != null && previous != null ? { abs: Math.round((value - previous) * 10) / 10, pct: null } : null,
});

export const summary: TeaSummary = {
  ...env(),
  notes: ["Allowed minutes used: 15."],
  allowedMinutes: 15,
  metrics: {
    breaks: m(28, 8),
    employees: m(6, 5),
    measured: m(24, 8),
    avgMinutes: m(22.2, 17.5),
    overruns: m(14, 4),
    overrunPct: m(58.3, 50),
    compliancePct: m(41.7, 50),
    minutesLost: m(200, 60),
  },
  hoursLost: 3.3,
  withinAllowance: 10,
  coverage: {
    activeEmployees: 6,
    employeesScanning: 5,
    participationPct: 83.3,
    breaks: 28,
    measured: 24,
    longCompleted: 2,
    noReturn: 2,
    inProgress: 0,
    unmeasured: 4,
    unmeasuredPct: 14.3,
  },
  refused: m(3, 1),
};

export const story: TeaStory = {
  ...env(),
  sentences: [
    { id: "volume", tone: "neutral", text: "28 breaks by 6 people this month." },
    { id: "overruns", tone: "bad", text: "58.3% ran over the 15 minutes allowed, losing 200 minutes." },
  ],
  text: "",
  ask: "Explain tea-break discipline this month.",
};

export const trend: TeaTrend = {
  ...env(),
  allowedMinutes: 15,
  granularity: "day",
  points: [
    {
      date: "2026-11-19",
      days: 1,
      breaks: 10,
      measured: 9,
      overruns: 5,
      overrunPct: 55.6,
      minutesLost: 60,
      avgMinutes: 21,
      maOverrunPct: null,
      maMinutesLost: null,
    },
    {
      date: "2026-11-20",
      days: 1,
      breaks: 8,
      measured: 8,
      overruns: 3,
      overrunPct: 37.5,
      minutesLost: 30,
      avgMinutes: 18,
      maOverrunPct: null,
      maMinutesLost: null,
    },
  ],
  momentum: { verdict: "better", text: "Better than the week before: 10 points fewer breaks over the allowance." },
  worstDay: { date: "2026-11-19", overrunPct: 55.6, overruns: 5, measured: 9, minutesLost: 60 },
};

const row = (key: string, label: string, minutesLost: number, extra: Partial<TeaGroups["rows"][number]> = {}) => ({
  key,
  label,
  sub: null,
  headcount: 10,
  employees: 3,
  participationPct: 30,
  breaks: 10,
  measured: 9,
  avgMinutes: 20,
  overruns: 4,
  overrunPct: 44.4,
  minutesLost,
  shareOfLostPct: 50,
  lowSample: true,
  ...extra,
});

export const groups = (params: URLSearchParams): TeaGroups => {
  const by = (params.get("by") ?? "department") as TeaGroupBy;
  const rows =
    by === "gate"
      ? [
          row("Gate 1", "Gate 1", 50, { headcount: null, refused: 0 }),
          row("Gate 2", "Gate 2", 20, { headcount: null, refused: 3 }),
        ]
      : by === "unit"
        ? [row("Unit 1", "Unit 1", 180)]
        : by === "type"
          ? [row("production", "Production", 150), row("staff", "Staff", 50)]
          : [row("Stitching", "Stitching", 130), row("Cutting", "Cutting", 50)];
  return {
    ...env(),
    by,
    allowedMinutes: 15,
    rows,
    total: rows.length,
    truncated: false,
    average: { overrunPct: 58.3, avgMinutes: 22.2, measured: 24, minutesLost: 200 },
    minSample: 20,
  };
};

export const offenders: TeaOffenders = {
  ...env(),
  allowedMinutes: 15,
  threshold: 3,
  total: 1,
  overrunners: 4,
  rows: [
    {
      employeeId: 33,
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
      worstDate: "2026-11-06",
    },
  ],
  truncated: false,
  shareOfMinutesLostPct: 60,
};

export const attention: TeaAttention = {
  ...env(),
  items: [
    {
      id: "tea-break.dept",
      severity: "critical",
      title: "Stitching overran 72% of breaks",
      detail: "Twice the company rate.",
      metric: "72%",
      page: "tea-break",
      ask: "Why does Stitching overrun?",
    },
  ],
};

export const records = (params: URLSearchParams): TeaRecords => ({
  ...env(),
  allowedMinutes: 15,
  page: 1,
  pageSize: 25,
  total: params.get("status") === "in_progress" ? 2 : 1,
  hasMore: false,
  filters: params.get("status") === "refused" ? ["Refused at the gate"] : [],
  items: [
    params.get("status") === "refused"
      ? {
          id: "scan-9",
          employeeId: 33,
          employeeCode: "C",
          employeeName: "Chitra Test",
          department: "Stitching",
          date: "2026-11-19",
          outAt: "2026-11-19T10:00:00",
          inAt: null,
          minutes: null,
          overMinutes: null,
          status: "refused",
          statusLabel: "Refused at the gate",
          outGate: "Gate 2",
          inGate: null,
        }
      : {
          id: "break-4",
          employeeId: 33,
          employeeCode: "C",
          employeeName: "Chitra Test",
          department: "Stitching",
          date: "2026-11-19",
          outAt: "2026-11-19T10:00:00",
          inAt: "2026-11-19T10:30:00",
          minutes: 30,
          overMinutes: 15,
          status: "overrun",
          statusLabel: "Over the allowance",
          outGate: "Gate 1",
          inGate: "Gate 1",
        },
  ],
});

export const brief = {
  page: "tea-break",
  title: "Tea Break",
  domain: "tea_break",
  kpis: [{ id: "tea-break.overrun-pct", label: "Break overruns", value: 58.3, format: "pct", page: "tea-break" }],
  insights: attention.items,
  provenance: [],
  notes: [],
  generatedAt: "2026-11-21T10:00:00",
};

export const emptySummary: TeaSummary = {
  ...summary,
  notes: [],
  metrics: { ...summary.metrics, breaks: m(0, 0), overrunPct: m(null, null), minutesLost: m(null, null) },
  refused: m(0, 0),
};
export const emptyTrend: TeaTrend = { ...trend, points: [], worstDay: null };
export const emptyStory: TeaStory = { ...story, sentences: [] };
