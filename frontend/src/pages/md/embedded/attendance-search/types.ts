// What the Attendance Search Insights read: GET /api/md/punches/* (backend api/md_portal/analytics/punches.py). Only the
// fields the tab shows are typed; percentages are 0-100, null is "no data".

import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";

export type Change = { abs: number; pct: number | null } | null;
export type PunchMetric = { value: number | null; previous: number | null; change: Change };

export type FamilyKey = "biometric" | "geo" | "on_duty" | "import" | "missing_punch" | "manual" | "auto" | "other";

export type Family = {
  key: FamilyKey;
  label: string;
  punches: number;
  sharePct: number | null;
  previous: number;
  previousSharePct: number | null;
};

export type SilentDevice = { key: string; label: string; daysSilent: number | null; statusText: string };

export type PunchSummary = MdEnvelope & {
  metrics: Record<
    "punches" | "employees" | "handEntered" | "handEnteredPct" | "missingDays" | "missingPct" | "coveragePct",
    PunchMetric
  >;
  families: Family[];
  devices: { listed: number; reporting: number; silent: number; unlisted: number; silentRows: SilentDevice[] };
  missing: {
    complete: boolean;
    days: number | null;
    punchDays: number;
    pct: number | null;
    people: number | null;
    repeaters: number | null;
    withRequest: number | null;
    withoutRequest: number | null;
    minDays: number;
  };
  unmatched: { available: boolean; unresolved: number | null; activeInPeriod: number | null; punches: number | null };
  coverage: { coveragePct: number | null; punchDays: number } | null;
  heldOnDuty?: { pending: number; rejected: number; people: number };
  previousPeriod: { start: string; end: string; label: string };
  briefing: { sentences: string[]; text: string; ask: string };
};

export type SourcePoint = Record<FamilyKey, number> & {
  date: string;
  total: number;
  handEntered: number;
  handEnteredPct: number | null;
};

export type PunchSources = MdEnvelope & { granularity: "day" | "week"; points: SourcePoint[]; families: Family[] };

export type DeviceRow = {
  key: string;
  label: string;
  kind: string;
  configured: boolean;
  punches: number;
  previous: number;
  sharePct: number | null;
  people: number;
  lastPunchDate: string | null;
  daysSilent: number | null;
  status: string;
  silent: boolean;
  statusText: string;
};

export type PunchDevices = MdEnvelope & {
  rows: DeviceRow[];
  total: number;
  listed: number;
  reporting: number;
  silent: number;
};

export type PersonFields = {
  employeeId: number;
  employeeCode: string | null;
  employeeName: string;
  department: string;
  unit: string | null;
  type: string;
};

export type MissingRow = PersonFields & {
  missingDays: number;
  daysWithPunches: number | null;
  missingPct: number | null;
  requestsRaised: number;
  dates: string[];
};

export type PunchMissing = MdEnvelope & {
  days: number | null;
  pct: number | null;
  people: number | null;
  repeaters: number | null;
  withoutRequest: number | null;
  requests: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    oldestPendingDays: number | null;
  } | null;
  rows: MissingRow[];
  total: number;
};

export type PunchManual = MdEnvelope & {
  byEmployee: (PersonFields & { manualPunches: number; days: number })[];
  byDepartment: {
    label: string;
    punches: number;
    handEntered: number;
    sharePct: number | null;
    smallSample: boolean;
  }[];
};

export type PunchAttention = MdEnvelope & { items: MdInsightDto[] };

export type EmployeePunch = { time: string; type: string; family: FamilyKey; label: string; device: string | null };

export type EmployeePunchDay = {
  date: string;
  punches: EmployeePunch[];
  held: { time: string; type: string; status: "pending" | "rejected" }[];
  request: string | null;
  count: number;
  odd: boolean;
};

export type EmployeePunches = MdEnvelope & {
  employee: {
    employeeId: number;
    name: string;
    code: string;
    type: string;
    department: string;
    unit: string | null;
  };
  totals: {
    punches: number;
    days: number;
    oddDays: number;
    handEntered: number;
    handEnteredPct: number | null;
    heldPending: number;
    heldRejected: number;
    requests: number;
  };
  families: { key: FamilyKey; label: string; punches: number; sharePct: number | null }[];
  days: EmployeePunchDay[];
};

/** What the drill-down sheet shows. */
export type PunchDrill =
  | { kind: "missing" }
  | { kind: "manual" }
  | { kind: "devices" }
  | { kind: "employee"; employeeId: number; name: string; back?: PunchDrill };
