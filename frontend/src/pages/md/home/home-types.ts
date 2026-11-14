import type { Provenance } from "@/lib/md/types";

// GET /api/md/dashboard/home (backend api/md_portal/analytics/home.py): what the Dashboard shows under the welcome card.

/** Of the people due that day: present (punched in), CL (approved Casual Leave, no punch) and absent (everybody else,
 *  the people on approved leave included; `onLeave` says how many of them). */
export type DayCounts = {
  expected: number;
  present: number;
  absent: number;
  onLeave: number;
  cl: number;
  presentPct: number | null;
  absentPct: number | null;
  clPct: number | null;
};

/** Active employees by gender ("notRecorded" = no gender on the employee record). */
export type GenderCounts = { male: number; female: number; other: number; notRecorded: number; total: number };

export type HomeGender = { staff: GenderCounts; production: GenderCounts; all: GenderCounts };

export type EmployeeUnit = { id: number | null; name: string; staff: number; production: number; total: number };

export type HomeEmployees = {
  total: number;
  staff: number;
  production: number;
  staffPct: number | null;
  productionPct: number | null;
  /** Largest first; "No unit" last among equals. */
  units: EmployeeUnit[];
  /** Men and women among staff, production and everyone (2026-11-13; absent on an older backend). */
  gender?: HomeGender;
};

export type AttendanceUnit = DayCounts & { id: number | null; name: string; staff: DayCounts; production: DayCounts };

export type TrendDay = DayCounts & { date: string; today: boolean; staff: DayCounts; production: DayCounts };

export type HomeAttendance = DayCounts & {
  date: string;
  /** "2026-11-13T17:26" (the factory's clock). */
  asOf: string;
  /** Always true: today is still running, so "absent" also means "not in yet". */
  provisional: boolean;
  isWorkingDay: boolean;
  /** People who punched in on a day they were not due (a Sunday, a holiday). */
  workedDayOff: number;
  staff: DayCounts;
  production: DayCounts;
  units: AttendanceUnit[];
  /** The last 14 days, oldest first, today last. */
  trend: TrendDay[];
};

export type PayrollFigures = {
  grossPay: number;
  salaryEarned: number;
  overtimePay: number;
  totalDeductions: number;
  netPay: number;
  headcount: number;
  slips: number;
  costPerHead: number | null;
};

export type PayrollMonth = {
  /** "2026-11" */
  month: string;
  /** "November 2026" */
  label: string;
  state: "paid" | "part_paid" | "finalized" | "generated" | "in_progress" | "not_generated" | "not_started" | "no_data";
  stateLabel: string;
  monthEnded: boolean;
  slips: number;
  headcount: number;
  paidSlips: number;
  unpaidSlips: number;
  /** The month that is running now. */
  current: boolean;
  /** Null when no slip has been generated for the month. */
  figures: PayrollFigures | null;
  staff: PayrollFigures | null;
  production: PayrollFigures | null;
};

export type DashboardHome = {
  generatedAt: string;
  today: string;
  employees: HomeEmployees;
  attendance: HomeAttendance;
  /** The last 6 calendar months, oldest first, the current month last. */
  payroll: { months: PayrollMonth[] };
  provenance?: Provenance[];
  notes?: string[];
};
