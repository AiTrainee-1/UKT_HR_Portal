import type { Provenance } from "@/lib/md/types";

// GET /api/md/dashboard/home[?month=YYYY-MM] (backend api/md_portal/analytics/home.py): everything the Dashboard shows under
// the welcome card, in one answer.

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

/** The chosen month's attendance: person-days over its complete days (today, still running, is not in them). */
export type HomeMonth = DayCounts & {
  /** "2026-11" */
  month: string;
  /** "November 2026" */
  label: string;
  /** The month that is running now. */
  current: boolean;
  from: string;
  to: string;
  completeDays: number;
  staff: DayCounts;
  production: DayCounts;
  units: AttendanceUnit[];
};

/** Leave, permission and outpass requests still pending (the welcome card's "N requests waiting"). */
export type HomeWaiting = { leave: number; permission: number; outpass: number; total: number };

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
  /** Every day of the chosen month up to today, oldest first (today last in the running month). */
  trend: TrendDay[];
  /** The chosen month's totals (absent on an older backend). */
  month?: HomeMonth;
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
  /** The month the attendance and payroll figures are for ("2026-11"; absent on an older backend). */
  month?: string;
  employees: HomeEmployees;
  attendance: HomeAttendance;
  /** The 6 calendar months ending with the chosen one, oldest first. */
  payroll: { months: PayrollMonth[] };
  /** Requests still pending (absent on an older backend). */
  waiting?: HomeWaiting;
  provenance?: Provenance[];
  notes?: string[];
};
