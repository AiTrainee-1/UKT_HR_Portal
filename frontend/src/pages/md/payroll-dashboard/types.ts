// The MD Payroll page (owner, 2026-11-14): employee-focused payroll ANALYTICS — what the company spends on salaries each
// month, what is deducted and what employees actually earn, by month, department and employee. Since 2026-11-21 it is
// split into STAFF (monthly, the four endpoints below with type=staff) and PRODUCTION (per pay cycle and period, the
// production/* endpoints at the end), like the HRMS. This file is the CONTRACT of its read-only endpoints
// (backend/api/md_portal/analytics/payroll_people.py + payroll_production.py, routes in routes/payroll.py; every call runs
// inside common.read_only_db()). Money is rupees as numbers (2 decimals), days are numbers (0.5 steps).
//
// Where each figure comes from (one salary slip = one employee's pay for a staff month or a production pay period; the
// slip set is the existing analytics' own: legacy weekly production slips out, parked new joiners not yet added out; a
// staff slip belongs to its month, a production slip to the month its period ENDS in):
//   actualSalary        staff: breakdown earnings.monthlySalary (the full salary if every company day were paid);
//                       production: null (paid per shift, no fixed monthly salary)
//   earnedSalary        gross_salary: what the days paid earned (staff: paid days x daily rate; production: shifts x rate).
//                       HR's Excess / Detection is not in it (it is the bonus line)
//   lossOfPay           staff: actualSalary - earnedSalary (days not paid: absent, unpaid leave, before joining), >= 0;
//                       production: null
//   lateDeduction       the attendance penalties inside the slip's deductions: late / early-out / permission penalties
//   attendanceDeduction lossOfPay + lateDeduction (production: lateDeduction only)
//   overtime            ot_amount
//   bonus               the payroll row's bonus = HR's Excess - Detection of the month (payroll_excess.py, 2026-11-20);
//                       excess / detection are its two sides (an older HR bonus counts as excess)
//   deductions          total = the payroll row's deductions (as HR's pages and the Salary Statement); PF / ESI / advance
//                       / late from the slip, TDS from the payroll row; other = whatever else (late is one of the lines)
//   netPaid             the payroll row's final_salary as paid (rounded UP to the rupee, the payroll rule; the bank file)
//   employerPfEsi       the existing analytics' employer PF + ESI estimate
//   companyCost         earnedSalary + overtime + bonus + employerPfEsi (what the employee cost the company)
//   clDays              staff: APPROVED Casual Leave days that fell on paid days of the slip (half day = 0.5): exactly
//                       the Salary Statement's CL column (payroll_insights.casual_leave_days); production: 0
//   clAmount            clDays x the slip's daily rate (earnings.dailyRate)
//   workingDays         staff: company days of the month (summary.companyDays / totalWorkingDays); production: days in
//                       the period(s)
//   paidDays            staff: summary.effectivePaidDays; production: days worked
//   lopDays             staff: workingDays - paidDays; production: days absent
//   adjustment          what HR changed the deductions by after the slip was computed, as money to the employee (+ =
//                       deductions taken off, - = added), null when none. Excess / Detection is its own line (bonus)

/** One block of money figures: the same keys for a month, a department, an employee's month and the totals. */
export type PayFigures = {
  employees: number;
  actualSalary: number | null;
  earnedSalary: number;
  lossOfPay: number | null;
  lateDeduction: number;
  attendanceDeduction: number;
  overtime: number;
  /** HR's Excess - Detection (can be below 0) */
  bonus: number;
  excess: number;
  detection: number;
  deductions: { pf: number; esi: number; tds: number; advance: number; late: number; other: number; total: number };
  netPaid: number;
  employerPfEsi: number;
  companyCost: number;
  clDays: number;
  clAmount: number;
  workingDays: number;
  paidDays: number;
  lopDays: number;
};

export type PayChange = { abs: number; pct: number | null } | null;

/** The month's payroll state in words (the existing analytics' status: Generated / Payroll Done, payment pending N days /
 *  Paid on <date>, Cleared = verified; production by its own rule). */
export type PayMonthState = { state: string; label: string; detail: string | null };

export type ScopeEcho = { branch: string | null; department: string | null; type: "staff" | "production" | null };

// ── 1. GET /api/md/payroll/monthly?month=YYYY-MM&months=12&branch=<id>&department=<name>&type=staff|production ────────
// The selected month (default: the latest month that has ENDED and has slips: a running month is provisional) and the
// months before it, oldest first, every figure for
// the scope. `change` compares the selected month with the one before it.
/** Where the month stands in HR's month workflow (2026-11-10), as numbers: Payroll Done locks it, Mark as Paid pays it;
 *  Cleared is a verification only. Held salaries are in the figures (on the statement, not in the bank file); new joiners
 *  waiting and production workers parked in a period's New Joiners are NOT (they are not payroll yet). leftSince = people
 *  in the figures who are inactive today (HR's lists show active employees only). */
export type PayMonthWorkflow = {
  staffState: string | null;
  productionState: string | null;
  locked: boolean;
  finalizedAt: string | null;
  markedPaidAt: string | null;
  paymentPendingDays: number | null;
  daysToPay: number | null;
  slips: number;
  paidSlips: number;
  unpaidSlips: number;
  unpaidNet: number;
  clearedSlips: number;
  provisionalSlips: number;
  onHold: number;
  onHoldNet: number;
  newJoinersWaiting: number;
  newJoinersNet: number;
  paidSeparately: number;
  productionParked: number;
  leftSince: number;
  leftSinceNet: number;
};

export type PayMonthRow = PayFigures & {
  month: string;
  label: string;
  status: PayMonthState;
  workflow: PayMonthWorkflow;
};

export type PayMonthChangeKey =
  "companyCost" | "earnedSalary" | "netPaid" | "attendanceDeduction" | "clAmount" | "employees";

/** Some months of one year added up (only the months with slips). */
export type PayYearBlock = PayFigures & { year: number; label: string; from: string; to: string; months: number };

export type PayYearChangeKey = "companyCost" | "earnedSalary" | "netPaid" | "deductions" | "bonus" | "employees";

export type PayYearPoint = { companyCost: number; netPaid: number; employees: number };

/** One month of the year-on-year chart: the chosen year's month (null after the chosen month or without payroll) beside
 *  the same month a year before. */
export type PayYearMonth = {
  month: number;
  label: string;
  current: PayYearPoint | null;
  previous: PayYearPoint | null;
};

/** The year so far (January to the chosen month) against the same months a year before, the whole year before, and the
 *  chosen month against the same month a year before. */
export type PayYearly = {
  current: PayYearBlock | null;
  previous: PayYearBlock | null;
  previousFull: PayYearBlock | null;
  change: Partial<Record<PayYearChangeKey, PayChange>> | null;
  sameMonthLastYear: PayMonthRow | null;
  sameMonthChange: Partial<Record<PayMonthChangeKey, PayChange>> | null;
  /** January to December, this year beside the year before */
  months: PayYearMonth[];
};

/** Active staff of the scope, joined by the month's end, with NO payroll row for the month (HR's Skipped "Not generated"):
 *  no_salary = no monthly salary on the profile. The first 20 are listed. */
export type PayNotIncluded = {
  count: number;
  noSalary: number;
  notGenerated: number;
  people: {
    employeeId: number;
    code: string;
    name: string;
    department: string | null;
    reason: "no_salary" | "not_generated";
  }[];
};

/** A department the page's kind of employee belongs to (Department.category), for the department filter. */
export type PayDepartmentOption = { id: number; name: string; branchId: number | null };

export type PayMonthlyResponse = {
  month: string | null;
  label: string | null;
  months: PayMonthRow[];
  current: PayMonthRow | null;
  previous: PayMonthRow | null;
  change: Partial<Record<PayMonthChangeKey, PayChange>> | null;
  yearly: PayYearly | null;
  notIncluded: PayNotIncluded | null;
  departments: PayDepartmentOption[];
  /** months with slips, newest first (for the month picker) */
  available: string[];
  scope: ScopeEcho;
  notes: string[];
};

// ── 2. GET /api/md/payroll/department-breakdown?month=&branch=&type= ──────────────────────────────────────────────
// Every department with a slip in the month (the employee's CURRENT department and unit, as the rest of the analytics).
export type PayDepartmentRow = PayFigures & {
  department: string;
  unit: string | null;
  /** earnedSalary / employees */
  averageEarned: number;
  /** netPaid / employees */
  averageNetPaid: number;
  /** paidDays / workingDays x 100 (staff and production together), null without working days */
  attendancePct: number | null;
  /** this department's companyCost / the total's x 100 */
  sharePct: number;
  previousCompanyCost: number | null;
  change: PayChange;
};

export type PayDepartmentsResponse = {
  month: string | null;
  label: string | null;
  rows: PayDepartmentRow[];
  totals: PayFigures & { averageEarned: number; averageNetPaid: number; attendancePct: number | null };
  scope: ScopeEcho;
  notes: string[];
};

// ── 3. GET /api/md/payroll/people?month=&branch=&department=&type=&q=&sort=&dir=asc|desc&page=1&pageSize=25 ────────
// The employees with a slip in the month (a production worker's period slips in the month are added up into one row).
// q matches the name or the employee code (case-insensitive, contains). sort: name | code | department | actualSalary |
// earnedSalary | attendanceDeduction | deductions | netPaid | companyCost | clDays | clAmount (default name asc).
export type PayPersonRow = PayFigures & {
  employeeId: number;
  code: string;
  name: string;
  department: string | null;
  unit: string | null;
  designation: string | null;
  type: "staff" | "production";
  /** the employee's status today (active / inactive ...) */
  status: string;
  onHold: boolean;
  paymentStatus: string | null;
  /** production: how many pay periods were added up */
  periods: number;
};

export type PayPeopleResponse = {
  month: string | null;
  label: string | null;
  total: number;
  page: number;
  pageSize: number;
  rows: PayPersonRow[];
  /** the figures of EVERY matching employee (not only this page) */
  totals: PayFigures;
  scope: ScopeEcho;
  notes: string[];
};

// ── 4. GET /api/md/payroll/people/<employee_id>?months=24 ──────────────────────────────────────────────────────────
// One employee's complete monthly salary history (every month they have slips, newest first, up to `months`).
export type PayPersonMonth = PayFigures & {
  month: string;
  label: string;
  status: PayMonthState;
  dailyRate: number | null;
  presentDays: number;
  holidayDays: number;
  lateDays: number;
  adjustment: number | null;
  onHold: boolean;
  paymentStatus: string | null;
  paymentPaidAt: string | null;
  /** production: the pay periods of the month */
  periods: {
    start: string;
    end: string;
    cycle: string | null;
    netPaid: number;
    shifts: number;
    ratePerShift: number | null;
  }[];
};

export type PayPersonResponse = {
  employee: {
    id: number;
    code: string;
    name: string;
    department: string | null;
    unit: string | null;
    designation: string | null;
    type: "staff" | "production";
    status: string;
    joinDate: string | null;
    /** today's full monthly salary (staff) */
    monthlySalary: number | null;
  };
  months: PayPersonMonth[];
  /** the months above added up */
  totals: PayFigures;
  notes: string[];
};

// ══ PRODUCTION (owner 2026-11-21): paid per pay period of a cycle, read the way HR's Production Payroll pages read it ══
// GET /api/md/payroll/production/overview | departments | people | people/<id>
//   ?cycle=weekly|biweekly|monthly|none&periodStart=YYYY-MM-DD&periodEnd=YYYY-MM-DD&branch=<id>&department=<name>
// Default cycle: the one most workers are paid on (most payslips in its latest ended period); default period: its latest
// ENDED period. The payslips are the period's main payroll: workers parked in its New Joiners are out, workers who have
// since left stay in (leftSince says how many). A payslip's cycle is the one stamped on it, else its worker's cycle now.
//   grossPay      shifts x rate per shift (gross_salary); bonus / excess / detection: HR's Excess - Detection of the period
//   deductions    the payroll row's total (PF / ESI / advance / late from the payslip, TDS from the payroll row)
//   netPaid       the payroll row's final_salary (rounded UP to the rupee); companyCost = gross + bonus + employer PF/ESI
//   daysPaid      the days the payslip pays (the whole period; fewer / more after a change of pay cycle); periodDays: the
//                 period's own length; attendancePct = daysWorked / (daysWorked + daysAbsent) x 100

export type ProdCycle = "weekly" | "biweekly" | "monthly" | "none";

/** Generated (open) -> Payroll Done (locked, payment pending) -> Paid (Mark as Paid); Part paid = some payslips paid
 *  without the period being closed. Cleared is HR's verification, never payment. */
export type ProdPeriodState = "generated" | "part_paid" | "finalized" | "paid";

export type ProdDeductions = {
  pf: number;
  esi: number;
  tds: number;
  advance: number;
  late: number;
  other: number;
  total: number;
};

export type ProdFigures = {
  employees: number;
  slips: number;
  shifts: number;
  daysWorked: number;
  daysAbsent: number;
  daysPaid: number;
  grossPay: number;
  excess: number;
  detection: number;
  bonus: number;
  deductions: ProdDeductions;
  netPaid: number;
  employerPfEsi: number;
  companyCost: number;
  /** grossPay / shifts, null without shifts */
  averageRatePerShift: number | null;
  averageNetPerWorker: number;
  shiftsPerWorker: number;
  attendancePct: number | null;
};

export type ProdPeriodBrief = {
  start: string;
  end: string;
  /** "start_end", the page's ?period= */
  key: string;
  label: string;
  state: ProdPeriodState;
  stateLabel: string;
  ended: boolean;
  slips: number;
};

export type ProdCycleInfo = {
  cycle: ProdCycle;
  label: string;
  periods: number;
  latestStart: string;
  latestEnd: string;
  /** active production workers on the cycle now (in the unit / department chosen) */
  assigned: number;
};

export type ProdPeriodStatus = {
  state: ProdPeriodState;
  label: string;
  detail: string;
  ended: boolean;
  locked: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  paidOn: string | null;
  daysToPay: number | null;
  paymentPendingDays: number | null;
  slips: number;
  paidSlips: number;
  unpaidSlips: number;
  unpaidNet: number;
  clearedSlips: number;
  /** workers waiting in the period's New Joiners (not in the figures) */
  parked: { count: number; newJoiners: number; movedIn: number; net: number };
  leftSince: number;
  leftSinceNet: number;
};

export type ProdPeriodRow = ProdPeriodBrief & ProdFigures;

/** One month (the month a period ENDS in), every cycle together, with each cycle's part. */
export type ProdMonthRow = ProdFigures & {
  month: string;
  label: string;
  periods: number;
  cycles: { cycle: ProdCycle; label: string; employees: number; netPaid: number; companyCost: number }[];
};

export type ProdYearBlock = ProdFigures & { year: number; label: string; from: string; to: string; months: number };

export type ProdChangeKey = "companyCost" | "grossPay" | "netPaid" | "deductions" | "bonus" | "shifts" | "employees";

export type ProdYearly = {
  current: ProdYearBlock | null;
  previous: ProdYearBlock | null;
  previousFull: ProdYearBlock | null;
  change: Partial<Record<ProdChangeKey, PayChange>> | null;
  /** January to December, this year beside the year before (every cycle) */
  months: PayYearMonth[];
};

export type ProdOverviewResponse = {
  /** the cycles that have payroll in the selection */
  cycles: ProdCycleInfo[];
  cycle: ProdCycle | null;
  cycleLabel: string | null;
  /** every period of the cycle with payslips, newest first */
  periods: ProdPeriodBrief[];
  period: ProdPeriodBrief | null;
  current: ProdFigures | null;
  status: ProdPeriodStatus | null;
  /** the period before on the same cycle */
  previous: ProdPeriodRow | null;
  change: Partial<Record<ProdChangeKey, PayChange>> | null;
  /** the cycle's periods up to the chosen one (at most ?periods=12), oldest first */
  trend: ProdPeriodRow[];
  /** production months up to the chosen period's month (12 at most, only months with payslips), oldest first */
  months: ProdMonthRow[];
  yearly: ProdYearly | null;
  departments: PayDepartmentOption[];
  scope: ScopeEcho;
  notes: string[];
};

export type ProdDepartmentRow = ProdFigures & {
  department: string;
  unit: string | null;
  sharePct: number;
  previousCompanyCost: number | null;
  previousNetPaid: number | null;
  change: PayChange;
};

export type ProdDepartmentsResponse = {
  cycle: ProdCycle | null;
  cycleLabel: string | null;
  period: ProdPeriodBrief | null;
  rows: ProdDepartmentRow[];
  totals: ProdFigures;
  previousPeriod: ProdPeriodBrief | null;
  scope: ScopeEcho;
  notes: string[];
};

// sort: name | code | department | shifts | ratePerShift | grossPay | bonus | deductions | netPaid | companyCost |
// daysAbsent | lateDays
export type ProdWorkerFigures = {
  ratePerShift: number | null;
  shifts: number;
  daysWorked: number;
  daysAbsent: number;
  daysPaid: number;
  periodDays: number;
  lateDays: number;
  grossPay: number;
  excess: number;
  detection: number;
  bonus: number;
  deductions: ProdDeductions;
  netPaid: number;
  employerPfEsi: number;
  companyCost: number;
};

export type ProdWorkerRow = ProdWorkerFigures & {
  employeeId: number;
  code: string;
  name: string;
  department: string | null;
  unit: string | null;
  designation: string | null;
  status: string;
  paymentStatus: string | null;
  cleared: boolean;
};

export type ProdPeopleResponse = {
  cycle: ProdCycle | null;
  cycleLabel: string | null;
  period: ProdPeriodBrief | null;
  total: number;
  page: number;
  pageSize: number;
  rows: ProdWorkerRow[];
  /** every matching worker, not only this page */
  totals: ProdFigures;
  scope: ScopeEcho;
  notes: string[];
};

export type ProdDay = {
  date: string;
  day: string;
  status: string;
  shifts: number;
  late: boolean;
  firstPunch: string | null;
  lastPunch: string | null;
  lastPunchNextDay: boolean;
};

export type ProdWorkerPeriod = ProdWorkerFigures & {
  cycle: ProdCycle;
  cycleLabel: string;
  start: string;
  end: string;
  key: string;
  label: string;
  state: ProdPeriodState;
  stateLabel: string;
  paymentStatus: string | null;
  paymentPaidAt: string | null;
  cleared: boolean;
  days: ProdDay[];
};

// GET /api/md/payroll/production/people/<employee_id>?periods=12 (every cycle, newest first; 404 for no such employee)
export type ProdPersonResponse = {
  employee: {
    id: number;
    code: string;
    name: string;
    department: string | null;
    unit: string | null;
    designation: string | null;
    type: "staff" | "production";
    status: string;
    joinDate: string | null;
    cycle: ProdCycle | null;
    cycleLabel: string | null;
    ratePerShift: number | null;
  };
  periods: ProdWorkerPeriod[];
  totals: ProdFigures;
  notes: string[];
};
