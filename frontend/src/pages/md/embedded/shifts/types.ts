import type { MdEnvelope, MdInsightDto, MdPeriod } from "@/lib/md/types";
import type { BriefingSentence } from "../employees/types";

// What the Manage Shift Insights tab reads (backend: api/md_portal/analytics/shifts.py).

export type ShiftSource = "template" | "production" | "special" | "none";

export type ShiftRef = {
  id: number | null;
  key: string;
  label: string;
  name: string;
  unit: string | null;
  unitId: number | null;
  type: "staff" | "production" | null;
  start?: string | null;
  end?: string | null;
  isActive?: boolean;
  source?: ShiftSource;
  detail?: string | null;
};

export type ShiftRow = ShiftRef & {
  people: number;
  staff: number;
  production: number;
  sharePct: number | null;
  departments: number;
};

export type ProductionGroup = {
  id: number;
  label: string;
  kind: string;
  appliesOn: string;
  appliesOnText: string;
  start: string | null;
  firstPunchFrom: string | null;
  firstPunchTo: string | null;
  mainOut: string | null;
  mainOutNextDay: boolean;
};

export type ShiftsCoverage = MdEnvelope & {
  asOf: string;
  total: number;
  onShift: number;
  shifts: ShiftRow[];
  shiftsTotal: number;
  noShift: { people: number; sharePct: number | null };
  byType: { staff: number; production: number };
  templates: { active: number; inUse: number; unused: number; staff: number; production: number };
  production: {
    inForce: boolean;
    effectiveFrom: string | null;
    workers: number;
    onDefaults: number | null;
    onSpecial: number | null;
    defaults: ProductionGroup[];
    specials: (ProductionGroup & { key: string; people: number })[];
  };
};

export type Change = { abs: number; pct: number | null } | null;

export type ChangeTotals = {
  first: number;
  moved: number;
  renewed: number;
  started: number;
  people: number;
  peopleMoved: number;
};

export type ShiftsSummary = MdEnvelope & {
  asOf: string;
  employees: {
    active: number;
    onShift: number;
    noShift: number;
    startsLater: number;
    neverHadShift: number;
    coveragePct: number | null;
    staff: number;
    production: number;
  };
  shifts: ShiftsCoverage["templates"];
  biggest: ShiftRow | null;
  changes: ChangeTotals & {
    scheduled: number;
    specialStarts?: number;
    previous: ChangeTotals;
    change: { moved: Change; started: Change };
  };
  watch: { days: number; endingSoon: number; overlapping: number; startsLater: number };
  balance: { groups: number; flagged: number };
  production?: { inForce: boolean; workers: number; onSpecial: number | null; defaults: number; specials: number };
  previousPeriod: MdPeriod;
};

export type ShiftsBriefing = MdEnvelope & { briefing: { sentences: BriefingSentence[]; text: string; ask: string } };

export type ShiftsChanges = MdEnvelope & {
  granularity: "day" | "week";
  points: { date: string; days: number; first: number; moved: number; renewed: number; started: number }[];
};

export type ShiftsAttendance = MdEnvelope & {
  rows: (ShiftRef & {
    people: number;
    workedDays: number;
    lateDays: number;
    latePct: number | null;
    attendancePct: number | null;
    lowSample: boolean;
  })[];
  overall: { latePct: number | null; attendancePct: number | null; workedDays: number } | null;
  minSample: number;
};

export type ShiftsAttention = MdEnvelope & { items: MdInsightDto[] };

export type ShiftPeople = MdEnvelope & {
  shift: ShiftRef;
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  rows: {
    employeeId: number;
    employeeCode: string;
    employeeName: string;
    department: string;
    unit: string;
    type: string;
    since: string | null;
    until: string | null;
  }[];
};
