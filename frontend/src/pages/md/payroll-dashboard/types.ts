// The MD Payroll page (owner, 2026-11-14): employee-focused payroll ANALYTICS — what the company spends on salaries each
// month, what is deducted and what employees actually earn, by month, department and employee. This file is the CONTRACT
// of its four read-only endpoints (backend/api/md_portal/analytics/payroll_people.py, routes in routes/payroll.py; every
// call runs inside common.read_only_db()). Money is rupees as numbers (2 decimals), days are numbers (0.5 steps).
//
// Where each figure comes from (one salary slip = one employee's pay for a staff month or a production pay period; the
// slip set is the existing analytics' own: legacy weekly production slips out, parked new joiners not yet added out; a
// staff slip belongs to its month, a production slip to the month its period ENDS in):
//   actualSalary        staff: breakdown earnings.monthlySalary (the full salary if every company day were paid);
//                       production: null (paid per shift, no fixed monthly salary)
//   earnedSalary        gross_salary: what the days paid earned (staff: paid days x daily rate; production: shifts x rate)
//   lossOfPay           staff: actualSalary - earnedSalary (days not paid: absent, unpaid leave, before joining), >= 0;
//                       production: null
//   lateDeduction       the attendance penalties inside the slip's deductions: late / early-out / permission penalties
//   attendanceDeduction lossOfPay + lateDeduction (production: lateDeduction only)
//   overtime, bonus     ot_amount, bonuses
//   deductions          the slip's own deduction lines; total = total_deductions (late is one of the lines)
//   netPaid             net_salary as paid (rounded UP to the rupee, the payroll rule)
//   employerPfEsi       the existing analytics' employer PF + ESI estimate
//   companyCost         earnedSalary + overtime + bonus + employerPfEsi (what the employee cost the company)
//   clDays              staff: APPROVED Casual Leave days that fell on paid days of the slip (half day = 0.5): exactly
//                       the Salary Statement's CL column (payroll_insights.casual_leave_days); production: 0
//   clAmount            clDays x the slip's daily rate (earnings.dailyRate)
//   workingDays         staff: company days of the month (summary.companyDays / totalWorkingDays); production: days in
//                       the period(s)
//   paidDays            staff: summary.effectivePaidDays; production: days worked
//   lopDays             staff: workingDays - paidDays; production: days absent
//   adjustment          an amount HR changed by hand after the slip was computed (+ added / - removed), null when none
//                       (the payroll details page's "Adjustment by HR")

/** One block of money figures: the same keys for a month, a department, an employee's month and the totals. */
export type PayFigures = {
  employees: number;
  actualSalary: number | null;
  earnedSalary: number;
  lossOfPay: number | null;
  lateDeduction: number;
  attendanceDeduction: number;
  overtime: number;
  bonus: number;
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
export type PayMonthRow = PayFigures & { month: string; label: string; status: PayMonthState };

export type PayMonthlyResponse = {
  month: string | null;
  label: string | null;
  months: PayMonthRow[];
  current: PayMonthRow | null;
  previous: PayMonthRow | null;
  change: Partial<
    Record<"companyCost" | "earnedSalary" | "netPaid" | "attendanceDeduction" | "clAmount" | "employees", PayChange>
  > | null;
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
