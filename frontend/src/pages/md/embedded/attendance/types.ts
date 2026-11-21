// The shapes the Staff / Production Attendance Insights read (backend api/md_portal/analytics/attendance.py). The older
// analytics page's types (pages/md/attendance/types.ts) still describe most of it; what the server added on 2026-11-21 is
// here: the briefing, the shifts as payroll pays them, the data-gap days, today's six cards and the drill-downs.

import type { MdEnvelope } from "@/lib/md/types";
import type { AttendanceSummary, LiveToday, Metric } from "@/pages/md/attendance/types";

export type { Metric };

/** HR's Attendance page has six status cards; these are their keys, in its order. */
export type BoardState = "present" | "onDuty" | "onLeave" | "cl" | "leaveApplied" | "absent";

export type LiveTodayV2 = LiveToday & { board?: Record<BoardState, number> };

export type BriefLine = { id: string; tone: "good" | "bad" | "neutral" | string; text: string };

export type NewMetricKey = "shiftsEarned" | "shiftsDeducted" | "quarterDays" | "penaltyEarlyOuts";

export type InsightsSummary = Omit<AttendanceSummary, "live" | "metrics" | "counts"> & {
  metrics: AttendanceSummary["metrics"] & Partial<Record<NewMetricKey, Metric>>;
  counts: AttendanceSummary["counts"] & { quarterDays?: number; penaltyEarlyOuts?: number };
  live: LiveTodayV2 | null;
  briefing?: BriefLine[];
  dataGaps?: { date: string; type: string }[];
};

/** What a click on a figure lists (GET attendance/people ?metric=). */
export type PeopleMetric = "absent" | "late" | "half" | "leave" | "quarter" | "penalty" | "worked" | "workedOff";

export type PersonRow = {
  employeeId: number;
  name: string;
  code: string;
  department: string;
  unit: string;
  type: string;
  days: number;
  dates: string[];
  scheduled: number;
  attendancePct: number | null;
  shiftsEarned: number;
  avgLateMinutes?: number | null;
  informed?: number;
};

export type PeopleResponse = MdEnvelope & {
  metric: PeopleMetric;
  label: string;
  day: string | null;
  window: { start: string; end: string } | null;
  total: number;
  totalDays: number;
  page: number;
  pageSize: number;
  rows: PersonRow[];
};

export type EmployeeDay = {
  date: string;
  label: string;
  status?: string;
  scheduled: boolean;
  counted?: boolean;
  dataGap?: boolean;
  shiftsEarned?: number;
  late?: boolean;
  lateMinutes?: number | null;
  quarterOff?: boolean;
  penaltyEarlyOut?: boolean;
  penaltyDeduction?: number;
  earlyOutMinutes?: number;
  firstPunch?: string | null;
  lastPunch?: string | null;
  punches?: number;
  source?: string | null;
  manual?: boolean;
  informed?: boolean | null;
  reason?: string | null;
};

export type EmployeeDaysResponse = MdEnvelope & {
  employee: { employeeId: number; name: string; code: string; type: string; department: string; unit: string };
  measured: { start: string; end: string; days: number } | null;
  totals: {
    scheduled: number;
    present: number;
    half: number;
    absent: number;
    leave: number;
    late: number;
    quarterDays: number;
    penaltyEarlyOuts: number;
    attendancePct: number | null;
    shiftsEarned: number;
    shiftsDeducted: number;
  };
  days: EmployeeDay[];
};

export type TodayPeopleResponse = MdEnvelope & {
  date: string;
  state: BoardState;
  label: string;
  total: number;
  board: Record<BoardState, number>;
  rows: {
    employeeId: number;
    name: string;
    code: string;
    department: string;
    unit: string;
    type: string;
    firstPunch: string | null;
  }[];
};

/** What the drill-down sheet shows: the people behind a figure, a person's days, or the people on one of today's cards. */
export type Drill =
  | { kind: "people"; metric: PeopleMetric; department?: string; branch?: string; day?: string; title?: string }
  | { kind: "employee"; employeeId: number; name: string; back?: Drill }
  | { kind: "today"; state: BoardState };
