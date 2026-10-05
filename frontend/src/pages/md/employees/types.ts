// What the Employees endpoints send (backend: api/md_portal/analytics/employees.py, routed under /api/md/employees/).
// Percentages are 0-100 floats, "no data" is null (never 0), dates are ISO strings.

import type { MdEnvelope, MdPeriod } from "@/lib/md/types";

/** {abs, pct} between two figures; null when either side is missing, pct null when the previous figure was 0. */
export type Change = { abs: number | null; pct: number | null } | null;

export type EmployeesSummary = MdEnvelope & {
  asOf: string;
  headcount: {
    current: number;
    staff: number;
    production: number;
    other: number;
    /** Reconstructed at the start and end of the period (there is no headcount history). */
    opening: number | null;
    closing: number | null;
    change: Change;
  };
  joiners: { count: number; previous: number; change: Change };
  leavers: { count: number; previous: number; change: Change; approximate: number };
  net: { count: number; previous: number; change: Change };
  attrition: {
    pct: number | null;
    annualisedPct: number | null;
    averageHeadcount: number | null;
    previousPct: number | null;
    change: Change;
  };
  tenure: { averageYears: number | null; previousYears: number | null; change: Change; unknown: number };
  earlyAttrition: { count: number; pctOfLeavers: number | null; previous: number; change: Change };
  gender: {
    male: number;
    female: number;
    other: number;
    unspecified: number;
    recorded: number;
    femalePct: number | null;
  };
  age: { average: number | null; known: number };
  previousPeriod: MdPeriod;
  dataQuality: { noJoinDate: number; futureJoinDate: number; exitBeforeJoin: number; unplaced: number };
};

export type ShareRow = { label: string; count: number; pct: number | null };
export type KeyedShareRow = ShareRow & { key: string };

export type GroupRow = ShareRow & { id: number | null; staff?: number; production?: number; other?: boolean };
export type DepartmentRow = GroupRow & { unit?: string | null };

export type StaffingRow = {
  departmentId: number;
  label: string;
  unit: string | null;
  required: number;
  actual: number;
  /** Planned minus actual: positive = vacancies, negative = more people than planned. */
  gap: number;
  fillPct: number | null;
};

export type EmployeesComposition = MdEnvelope & {
  asOf: string;
  total: number;
  byType: KeyedShareRow[];
  byUnit: GroupRow[];
  byDepartment: DepartmentRow[];
  departmentsTotal: number;
  byDesignation: GroupRow[];
  designationsTotal: number;
  byGender: KeyedShareRow[];
  byAgeBand: ShareRow[];
  byTenureBand: ShareRow[];
  staffing: {
    rows: StaffingRow[];
    required: number;
    actual: number;
    vacancies: number;
    departmentsBelow: number;
    planned: boolean;
  };
};

export type MovementGrain = "day" | "week" | "month";

export type MovementPoint = {
  key: string;
  label: string;
  start: string;
  end: string;
  joiners: number;
  leavers: number;
  net: number;
  /** Reconstructed headcount at the end of the step. */
  headcount: number;
};

export type EmployeesMovement = MdEnvelope & {
  grain: MovementGrain;
  points: MovementPoint[];
  totals: { joiners: number; leavers: number; net: number; opening: number | null; closing: number | null };
};

export type AttritionRow = {
  id: number | string | null;
  label: string;
  leavers: number;
  averageHeadcount: number | null;
  attritionPct: number | null;
  opening: number | null;
  closing: number | null;
  unit?: string | null;
  hotspot?: boolean;
};

export type EarlyLeaver = {
  id: number;
  name: string;
  code: string;
  department: string;
  designation: string | null;
  unit: string;
  joined: string | null;
  left: string | null;
  days: number | null;
  reason: string;
  approximate: boolean;
};

export type EmployeesAttrition = MdEnvelope & {
  company: {
    leavers: number;
    averageHeadcount: number | null;
    attritionPct: number | null;
    annualisedPct: number | null;
  };
  byDepartment: AttritionRow[];
  departmentsWithLeavers: number;
  departmentsTotal: number;
  byUnit: AttritionRow[];
  byType: AttritionRow[];
  hotspots: AttritionRow[];
  tenureAtExit: KeyedShareRow[];
  reasons: KeyedShareRow[];
  early: { count: number; pctOfLeavers: number | null; items: EarlyLeaver[] };
  approximateExits: number;
};

export type MilestonePerson = {
  id: number;
  name: string;
  code: string;
  department: string;
  designation: string | null;
  date: string;
};

export type EmployeesMilestones = MdEnvelope & {
  asOf: string;
  windowDays: number;
  anniversaries: {
    minYears: number;
    total: number;
    today: number;
    items: (MilestonePerson & { years: number; joined: string })[];
  };
  birthdays: { windowDays: number; total: number; items: MilestonePerson[] };
  probation: {
    recorded: number;
    dueSoonDays: number;
    dueSoon: number;
    pendingConfirmation: number;
    items: MilestonePerson[];
  };
};

export type EmployeesInsights = MdEnvelope & {
  items: {
    id: string;
    severity: "critical" | "warning" | "info" | "good";
    title: string;
    detail: string;
    metric: string;
    page: string;
    ask: string;
  }[];
  total: number;
};

export type DirectoryStatus = "active" | "inactive" | "all";
export type DirectorySort = "name" | "code" | "department" | "joined";

export type DirectoryPerson = {
  id: number;
  name: string;
  code: string;
  designation: string | null;
  department: string | null;
  unit: string | null;
  type: string | null;
  joinDate: string | null;
  tenure: string | null;
  tenureYears: number | null;
  status: "active" | "inactive";
  leftOn: string | null;
};

export type EmployeesDirectory = MdEnvelope & {
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  rows: DirectoryPerson[];
  options: { designations: string[] };
};

export type ProfileEvent = {
  type: "joined" | "promotion" | "increment" | "exit";
  date: string;
  title: string;
  detail: string | null;
};

export type EmployeeProfile = MdEnvelope & {
  found: boolean;
  asOf: string;
  profile: {
    id: number;
    name: string;
    code: string;
    status: "active" | "inactive";
    type: string | null;
    designation: string | null;
    department: string | null;
    unit: string | null;
    reportsTo: string | null;
    gender: string | null;
    ageBand: string | null;
    joinDate: string | null;
    tenure: string | null;
    tenureYears: number | null;
    leftOn: string | null;
    exitApproximate: boolean | null;
    leavingReason: string | null;
    leavingReasonText: string | null;
    probationEnd: string | null;
    confirmedOn: string | null;
  };
  history: ProfileEvent[];
  attendance: {
    from: string;
    to: string;
    attendancePct: number | null;
    presentDays: number;
    halfDays: number;
    absentDays: number;
    leaveDays: number;
    lateDays: number;
    recordedDays: number;
    coveragePct: number | null;
  };
  leaveBalance: { type: string; allocated: number; used: number; remaining: number }[];
  /** The required documents (identity, education, bank passbook, the staff letter or production documents) that have a file. */
  documents: { required: number; onFile: number; missing: string[] };
};
