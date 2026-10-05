// The shapes of GET /api/md/attendance/* (backend: api/md_portal/analytics/attendance.py). Percentages are 0-100 floats and
// `null` means "no data" (never 0); dates are ISO strings in the factory's calendar.

import type { MdEnvelope, MdInsightDto } from "@/lib/md/types";

/** A figure with the previous period's value and the change (percentage points for a percentage). */
export type Metric = {
  value: number | null;
  previous: number | null;
  delta: { abs: number; pct: number | null } | null;
  /** The direction that is good news: "up" for attendance, "down" for absenteeism; null = neither. */
  good: "up" | "down" | null;
  spark: (number | null)[] | null;
};

export type MetricKey =
  | "attendancePct"
  | "absenteeismPct"
  | "latePct"
  | "avgLateMinutes"
  | "overtimeHours"
  | "halfDays"
  | "missingPunches"
  | "leaveDays"
  | "scheduledDays"
  | "coveragePct";

export type Coverage = {
  expectedDays: number;
  recordedDays: number;
  missingDays: number;
  coveragePct: number | null;
  partial: boolean;
  worstDays: { date: string; expected: number; recorded: number; coveragePct: number | null }[];
};

export type LiveGroup = {
  name: string;
  id?: number | null;
  expected: number;
  present: number;
  leave: number;
  absent: number;
  attendancePct: number | null;
};

/** Today so far, from the punch log: provisional by nature (`absent` means "not in yet"). */
export type LiveToday = {
  date: string;
  provisional: boolean;
  asOf: string | null;
  isWorkingDay: boolean;
  expected: number;
  present: number;
  leave: number;
  absent: number;
  attendancePct: number | null;
  workedDayOff: number;
  byUnit: LiveGroup[];
  byDepartment: LiveGroup[];
  byType: LiveGroup[];
};

export type Window = { start: string; end: string; days: number };

export type AttendanceSummary = MdEnvelope & {
  /** The complete days the figures cover (today is left out); null when the period has none yet. */
  measured: Window | null;
  previous: Window | null;
  metrics: Partial<Record<MetricKey, Metric>>;
  counts: Partial<
    Record<
      | "present"
      | "half"
      | "absent"
      | "leave"
      | "late"
      | "worked"
      | "scheduledWithRecord"
      | "workedOnDaysOff"
      | "informedAbsences"
      | "overtimeDays",
      number
    >
  >;
  coverage: Coverage | null;
  live: LiveToday | null;
};

export type TrendPoint = {
  date: string;
  days: number;
  attendancePct: number | null;
  absentPct: number | null;
  latePct: number | null;
  present: number;
  half: number;
  absent: number;
  leave: number;
  late: number;
  expected: number;
  rostered: number;
  coveragePct: number | null;
};

export type AttendanceTrend = MdEnvelope & {
  granularity: "day" | "week";
  points: TrendPoint[];
  average: { attendancePct: number | null; absentPct: number | null; latePct: number | null } | null;
};

export type WeekdayRow = {
  weekday: number;
  name: string;
  days: number;
  attendancePct: number | null;
  absentPct: number | null;
  latePct: number | null;
  absent: number;
  scheduledDays: number;
};

export type MondayEffect = { mondayAbsentPct: number; otherDaysAbsentPct: number; gapPts: number; mondays: number };

export type AttendanceWeekday = MdEnvelope & {
  weekdays: WeekdayRow[];
  lowest: WeekdayRow | null;
  mondayEffect: MondayEffect | null;
  heatmap: { weeks: string[]; weekdays: string[]; values: (number | null)[][] };
};

export type AttendanceHeatmap = MdEnvelope & {
  days: string[];
  departments: string[];
  values: (number | null)[][];
  totalDepartments: number;
  shownDepartments: number;
  capped: boolean;
};

export type GroupRow = {
  key: string | number;
  name: string;
  /** Units only: the unit id the scope filter takes. */
  id?: number | null;
  headcount: number;
  scheduledDays: number;
  attendancePct: number | null;
  absenteeismPct: number | null;
  latePct: number | null;
  halfDays: number;
  absentDays: number;
  overtimeHours: number;
  previous: { attendancePct: number | null; absenteeismPct: number | null; latePct: number | null };
  /** Percentage points against the previous period. */
  delta: { attendancePct: number | null; absenteeismPct: number | null; latePct: number | null };
  /** Attendance % of eight consecutive 7-day windows ending with the period, oldest first. */
  spark: (number | null)[];
  hasRecords: boolean;
  gapPts?: number | null;
  belowBaseline?: boolean;
};

export type AttendanceDepartments = MdEnvelope & {
  baseline: { attendancePct: number | null; absenteeismPct: number | null; latePct: number | null } | null;
  departments: GroupRow[];
  units: GroupRow[];
  types: GroupRow[];
  total: number;
  limit: number;
};

export type PersonRow = { employeeId: number; name: string; code: string; department: string; unit: string };

export type ChronicRow = PersonRow & {
  absentDays: number;
  scheduledDays: number;
  absentPct: number | null;
  informedDays: number;
  leaveDays: number;
  dates: string[];
};
export type LateRow = PersonRow & {
  lateDays: number;
  workedDays: number;
  latePct: number | null;
  avgLateMinutes: number | null;
  dates: string[];
};
export type LongAbsenceRow = PersonRow & {
  streakDays: number;
  from: string;
  to: string;
  ongoing: boolean;
  lastWorked: string | null;
};
export type PunchRow = PersonRow & {
  requests: number;
  pending: number;
  approved: number;
  rejected: number;
  dates: string[];
};
export type AfterOffRow = PersonRow & {
  absences: number;
  afterOffAbsences: number;
  mondayAbsences: number;
  sharePct: number | null;
  dates: string[];
};

export type Block<T> = { total: number; rows: T[] };

export type ExceptionsThresholds = {
  chronicAbsent: { minDays: number; minPctOfScheduledDays: number };
  habitualLate: { minDays: number; minPctOfWorkedDays: number };
  longAbsence: { minDays: number };
  missingPunches: { minRequests: number };
  afterOff: { minAbsences: number; minSharePct: number };
  belowBaseline: { gapPts: number; minHeadcount: number };
};

export type ExceptionKey = "chronicAbsentees" | "habitualLate" | "longAbsences" | "missingPunches" | "afterOffAbsences";

export type AttendanceExceptions = MdEnvelope & {
  thresholds: ExceptionsThresholds;
  chronicAbsentees: Block<ChronicRow>;
  habitualLate: Block<LateRow>;
  longAbsences: Block<LongAbsenceRow>;
  missingPunches: Block<PunchRow>;
  afterOffAbsences: Block<AfterOffRow>;
  belowBaseline: Block<GroupRow>;
  mondayEffect: MondayEffect | null;
  counts: Partial<Record<string, number>>;
  /** Findings of the period, most severe first (same shape as the Dashboard's insights; `page` is always null here). */
  attention: MdInsightDto[];
};

export type OvertimeDecision = { days: number; hours: number };

export type AttendanceOvertime = MdEnvelope & {
  totalHours: number | null;
  previousHours?: number | null;
  delta?: { abs: number; pct: number | null } | null;
  days?: number;
  employees?: number;
  pctOfScheduledHours?: number | null;
  scheduledHours?: number | null;
  decisions?: Record<"announcedPay" | "announcedRelaxation" | "detected" | "rejected", OvertimeDecision>;
  tracking: { featureEnabled: boolean; detectionEnabled: boolean };
  byDepartment: { name: string; hours: number; days: number; employees: number; sharePct: number | null }[];
  departmentsTotal?: number;
  topEarners: (PersonRow & { hours: number; days: number })[];
  earnersTotal?: number;
  trend: { granularity: "day" | "week"; points: { date: string; hours: number; employees: number }[] };
};

export type PendingApproval = {
  kind: string;
  label: string;
  count: number;
  oldestDays: number | null;
  oldestOn: string | null;
};

export type AttendanceLeave = MdEnvelope & {
  pending: PendingApproval[];
  pendingTotal: number;
  oldestPendingDays: number | null;
  totalDays: number | null;
  previousDays?: number | null;
  delta?: { abs: number; pct: number | null } | null;
  byType: { key: string; name: string; days: number; requests: number; paid: boolean | null }[];
  employeesOnLeave: number | null;
  casualLeaveDays?: number;
  permissions: {
    approved: number | null;
    previousApproved: number | null;
    delta: { abs: number; pct: number | null } | null;
    byType: { type: string; count: number }[];
  } | null;
};

export type DayGroup = {
  name: string;
  id?: number | null;
  expected: number;
  present: number;
  half?: number | null;
  absent: number;
  leave: number;
  late?: number | null;
  notRecorded?: number | null;
  attendancePct: number | null;
  absentPct?: number | null;
};

export type AttendanceDay = MdEnvelope & {
  date: string;
  weekday: string;
  isToday: boolean;
  provisional: boolean;
  source: string | null;
  isWorkingDay: boolean | null;
  asOf?: string | null;
  totals: (DayGroup & { workedDayOff?: number }) | null;
  byUnit: DayGroup[];
  byDepartment: DayGroup[];
  byType: DayGroup[];
  coverage?: Coverage;
};
