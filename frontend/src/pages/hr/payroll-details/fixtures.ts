import type {
  IssueCode,
  IssueSeverity,
  PayrollBreakdownResponse,
  PayrollDay,
  PayrollDetails,
  PayrollIssue,
  PayrollStatutory,
  RuleGroup,
} from "@/lib/api-client/custom-hooks";

// Realistic payrolls for the details page tests: a staff payroll for October 2026 with late / early / half-day / absent
// / unpaid-leave days and a late deduction, whose rules include one that was changed in Settings after the payroll was
// generated; a Production weekly payroll; a clean payroll with nothing to flag; and a payroll with no stored payslip.
// 1 Oct 2026 is a Thursday, so 13 Oct is the Tuesday the brief's examples use.

const GENERATED_AT = "2026-10-13T10:42:00+05:30";
const FIRST_GENERATED_AT = "2026-10-12T09:10:00+05:30";

type DaySpec = Partial<PayrollDay> & { date: string };

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const weekdayOf = (iso: string) => WEEKDAY[new Date(`${iso}T00:00:00Z`).getUTCDay()];

function day(spec: DaySpec): PayrollDay {
  return {
    day: weekdayOf(spec.date),
    status: "present",
    firstIn: "09:02",
    lastOut: "18:07",
    shifts: 1,
    flags: [],
    note: null,
    ...spec,
  };
}

const sunday = (date: string): PayrollDay =>
  day({ date, status: "holiday", firstIn: null, lastOut: null, shifts: 0, note: "Weekly off" });

function issue(
  payrollId: number,
  code: IssueCode,
  severity: IssueSeverity,
  title: string,
  detail: string,
  over: Partial<PayrollIssue> = {},
): PayrollIssue {
  const date = over.date === undefined ? null : over.date;
  return {
    id: `${payrollId}:${code}:${date ?? "period"}`,
    payrollId,
    employeeId: 42,
    employeeCode: "UKT-0142",
    employeeName: "Meena Subramanian",
    department: "Accounts",
    designation: "Senior Accountant",
    code,
    category: "attendance",
    severity,
    title,
    detail,
    date,
    detectedAt: GENERATED_AT,
    impact: null,
    rule: null,
    ...over,
  };
}

// ── Staff: October 2026 ───────────────────────────────────────────────────────

// Staff payroll lists the WORKING days only (the engine's breakdown has no entry for a Sunday or a company holiday), each
// with one of four statuses: a half day is a present day at 0.5 shifts with a half-day issue on it, and the day's note is
// the late reason the attendance engine wrote. Production payroll (below) lists every day of its period.
const OCT_DAYS: PayrollDay[] = Array.from({ length: 31 }, (_, i) => "2026-10-" + String(i + 1).padStart(2, "0"))
  .filter((date) => weekdayOf(date) !== "Sun" && date !== "2026-10-02") // 4 Sundays and the 2 Oct holiday: 26 working days
  .map((date) => {
    switch (date) {
      case "2026-10-06":
        return day({ date, status: "absent", firstIn: null, lastOut: null, shifts: 0, flags: ["absent"] });
      case "2026-10-07":
        return day({ date, status: "unpaid_leave", firstIn: null, lastOut: null, shifts: 0, flags: ["unpaid_leave"] });
      case "2026-10-08":
      case "2026-10-09":
        return day({ date, status: "paid_leave", firstIn: null, lastOut: null, shifts: 0 });
      case "2026-10-13":
        return day({
          date,
          firstIn: "09:42",
          flags: ["late_in"],
          note: "Morning late-in: first punch 09:42 is after the 09:10 deadline",
        });
      case "2026-10-14":
        return day({
          date,
          firstIn: "09:25",
          flags: ["late_in"],
          marks: ["late", "permission"],
          note: "Morning late-in: first punch 09:25 is after the 09:10 deadline",
        });
      // the attendance categories the server marks (payroll_day_marks.py): a permission, an On-Duty day with an approved
      // geo-punch, a permission beyond the cap, an On-Duty day
      case "2026-10-15":
        return day({ date, marks: ["permission"] });
      case "2026-10-16":
        return day({ date, marks: ["on_duty", "on_duty_punch"] });
      case "2026-10-19":
        return day({ date, marks: ["excess_permission"] });
      case "2026-10-21":
        return day({ date, marks: ["on_duty"] });
      case "2026-10-20":
        return day({
          date,
          lastOut: "16:40",
          flags: ["early_out"],
          note: "Evening early-out: last punch 16:40 is before the 17:50 limit",
        });
      case "2026-10-22":
        return day({
          date,
          firstIn: "09:04",
          lastOut: "13:05",
          shifts: 0.5,
          flags: ["half_day"],
          marks: ["permission"],
        });
      case "2026-10-27":
        return day({ date, lastOut: null, flags: ["missing_punch"] });
      case "2026-10-29":
        return day({
          date,
          firstIn: "09:18",
          flags: ["late_in"],
          note: "Morning late-in: first punch 09:18 is after the 09:10 deadline",
        });
      default:
        return day({ date });
    }
  });

const LATE_RULE = {
  label: "Late free allowance and slabs",
  settingsPath: "/hr/settings?tab=late_detection#late-slabs",
};
const LOP_RULE = { label: "Loss of pay on absence", settingsPath: "/hr/settings?tab=payroll#loss-of-pay" };

const STAFF_ISSUES: PayrollIssue[] = [
  issue(101, "absent", "critical", "Absent", "No punches on Tue 6 Oct and no approved leave: counted as loss of pay.", {
    date: "2026-10-06",
    impact: { days: 1, amount: 1134.62 },
    rule: LOP_RULE,
  }),
  issue(101, "unpaid_leave", "warning", "Unpaid leave", "Personal leave approved without pay on Wed 7 Oct.", {
    date: "2026-10-07",
    impact: { days: 1, amount: 1134.62 },
    rule: LOP_RULE,
  }),
  issue(101, "late_in", "warning", "Late arrival", "First punch 09:42, after General 09:00 + 10 min grace (09:10)", {
    date: "2026-10-13",
    facts: { firstIn: "09:42", shift: "General 09:00-18:00", graceMinutes: 10 },
    rule: LATE_RULE,
  }),
  issue(101, "late_in", "warning", "Late arrival", "First punch 09:25, after General 09:00 + 10 min grace (09:10)", {
    date: "2026-10-14",
    facts: { firstIn: "09:25", shift: "General 09:00-18:00", graceMinutes: 10 },
    rule: LATE_RULE,
  }),
  issue(101, "early_out", "warning", "Early leaving", "Last punch 16:40, before General 18:00 - 10 min grace (17:50)", {
    date: "2026-10-20",
    facts: { lastOut: "16:40", shift: "General 09:00-18:00" },
    rule: LATE_RULE,
  }),
  issue(
    101,
    "half_day",
    "warning",
    "Half day",
    "Punches only in the morning half (09:04 and 13:05); nothing at or after 14:30.",
    {
      date: "2026-10-22",
      impact: { days: 0.5, amount: 567.31 },
      facts: { firstIn: "09:04", lastOut: "13:05", secondHalfStart: "14:30" },
      rule: { label: "Half-day times", settingsPath: "/hr/settings?tab=attendance#half-day-times" },
    },
  ),
  issue(101, "missing_punch", "warning", "Missing punch", "No evening punch was recorded on Tue 27 Oct.", {
    date: "2026-10-27",
    facts: { firstIn: "09:03", lastOut: null },
  }),
  issue(101, "late_in", "warning", "Late arrival", "First punch 09:18, after General 09:00 + 10 min grace (09:10)", {
    date: "2026-10-29",
    facts: { firstIn: "09:18", shift: "General 09:00-18:00", graceMinutes: 10 },
    rule: LATE_RULE,
  }),
  issue(
    101,
    "late_penalty",
    "warning",
    "Late deduction",
    "3 late-in + 1 early-out = 4 occurrences; 2 free, 2 billable: 0.5 shift deducted.",
    {
      category: "pay",
      impact: { shifts: 0.5, amount: 567.31 },
      facts: { lateIn: 3, earlyOut: 1, excessPermission: 0, freeAllowance: 2, billable: 2, shiftsDeducted: 0.5 },
      rule: LATE_RULE,
    },
  ),
  issue(101, "advance_recovery", "info", "Advance recovery", "Advance #12: instalment 3 of 10 recovered this month.", {
    category: "pay",
    impact: { amount: 1000 },
  }),
  issue(
    101,
    "esi_number_missing",
    "info",
    "ESI number missing",
    "No ESI number is recorded on the employee's profile.",
    {
      category: "profile",
    },
  ),
];

const STAFF_RULES: RuleGroup[] = [
  {
    group: "Attendance",
    items: [
      {
        key: "attendance_mode",
        label: "Attendance mode",
        value: "Strict (4-punch)",
        detail: "Morning in, lunch out, lunch in and evening out are all checked",
        source: "settings",
        settingsPath: "/hr/settings?tab=attendance#attendance-mode",
        applied: "Strict (4-punch)",
        changed: false,
      },
      {
        key: "half_day_times",
        label: "Half-day times",
        value: "Morning half until 13:30, evening half from 14:30",
        source: "settings",
        settingsPath: "/hr/settings?tab=attendance#half-day-times",
        applied: "Morning half until 13:30, evening half from 14:30",
        changed: false,
      },
      {
        key: "working_days",
        label: "Working days",
        value: "Monday to Saturday, 26 working days in October",
        detail: "Sundays and the company holiday on 2 Oct are not worked",
        source: "settings",
        settingsPath: "/hr/settings?tab=payroll#working-days",
      },
    ],
  },
  {
    group: "Shift",
    items: [
      { key: "shift", label: "Assigned shift", value: "General 09:00-18:00", source: "shift", settingsPath: null },
      { key: "grace", label: "Grace period", value: "10 minutes", source: "shift", settingsPath: null },
    ],
  },
  {
    group: "Late detection",
    items: [
      {
        key: "late_free_allowance",
        label: "Free late marks a month",
        value: "3 free, then slabs",
        detail: "Occurrences beyond the free allowance are billed by the slabs",
        source: "settings",
        settingsPath: "/hr/settings?tab=late_detection#late-free-allowance",
        applied: "2 free, then slabs",
        changed: true,
      },
      {
        key: "late_slabs",
        label: "Late slabs",
        value: "1-2 billable: half a shift, 3 or more: one shift",
        source: "settings",
        settingsPath: "/hr/settings?tab=late_detection#late-slabs",
        applied: "1-2 billable: half a shift, 3 or more: one shift",
        changed: false,
      },
      {
        key: "permission_cap",
        label: "Permissions a month",
        value: "2 approved permissions",
        source: "settings",
        settingsPath: "/hr/settings?tab=late_detection#permission-cap",
      },
    ],
  },
  {
    group: "Pay",
    items: [
      {
        key: "salary_basis",
        label: "Salary basis",
        value: "Monthly salary ₹29,500",
        detail: "Prorated by paid days over working days",
        source: "employee",
        settingsPath: null,
      },
      {
        key: "salary_split",
        label: "Salary split",
        value: "50% Basic + DA + Retaining | 50% Other + HRA + Special",
        source: "employee",
        settingsPath: null,
      },
      {
        key: "loss_of_pay",
        label: "Loss of pay",
        value: "One daily rate for every absent or unpaid day",
        source: "settings",
        settingsPath: "/hr/settings?tab=payroll#loss-of-pay",
      },
      {
        key: "pf_rules",
        label: "Provident fund (PF)",
        value: "12% of Basic + DA + Retaining when Basic is ₹0 to ₹25,000",
        detail: "Co Emp employees only: this employee is on the Co Emp list",
        source: "settings",
        settingsPath: "/hr/settings?tab=pf_esi#staff-pf-rules",
        applied: "12% of Basic + DA + Retaining when Basic is ₹0 to ₹25,000",
        changed: false,
      },
      {
        key: "esi_rules",
        label: "ESI",
        value: "0.75% of Basic + DA + Retaining when Basic is ₹0 to ₹21,000",
        detail: "No ESI rule matched: this employee's Basic salary is above it",
        source: "settings",
        settingsPath: "/hr/settings?tab=pf_esi#staff-esi-rules",
      },
    ],
  },
  {
    group: "Employee",
    items: [
      {
        key: "employment_type",
        label: "Employment type",
        value: "Staff, monthly salary",
        source: "employee",
        settingsPath: null,
      },
      {
        key: "advance",
        label: "Advance recovery",
        value: "₹1,000 a month until advance #12 is cleared",
        source: "employee",
        settingsPath: null,
      },
    ],
  },
];

const STAFF_EMPLOYEE: PayrollDetails["employee"] = {
  id: 42,
  code: "UKT-0142",
  name: "Meena Subramanian",
  department: "Accounts",
  designation: "Senior Accountant",
  branch: "Head Office",
  employmentType: "staff",
  status: "active",
  joinDate: "2021-06-14",
  salaryAmount: 29500,
  salaryPerShift: null,
  payCycle: null,
  bank: { hasAccount: true, bankName: "State Bank of India", hasIfsc: true, accountLast4: "4821" },
  phone: "9876543210",
  pfNumber: "TN/MAS/0012345/000/0142",
  esiNumber: null,
  split: {
    first: 14750,
    second: 14750,
    components: [
      { key: "basic", label: "Basic", amount: 10000 },
      { key: "da", label: "DA", amount: 3000 },
      { key: "retaining", label: "Retaining allowance", amount: 1750 },
      { key: "other", label: "Other allowance", amount: 6000 },
      { key: "hra", label: "HRA", amount: 5000 },
      { key: "special", label: "Special allowance", amount: 3750 },
    ],
  },
};

export function staffDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  return {
    payrollId: 101,
    kind: "staff",
    slipId: 7001,
    slipNumber: "SLP-2026-10-0142",
    status: "pending",
    generatedAt: GENERATED_AT,
    firstGeneratedAt: FIRST_GENERATED_AT,
    period: {
      label: "October 2026",
      start: "2026-10-01",
      end: "2026-10-31",
      month: 10,
      year: 2026,
      days: 31,
      cycle: null,
      cycleLabel: null,
    },
    employee: STAFF_EMPLOYEE,
    money: {
      gross: 26663.46,
      deductions: 3167.23,
      bonus: 0,
      otAmount: 0,
      net: 23496.23,
      monthlySalary: 29500,
      dailyRate: 1134.62,
    },
    summary: {
      totalWorkingDays: 26,
      presentDays: 21,
      paidLeaveDays: 2,
      absentDays: 1,
      unpaidLeaveDays: 1,
      halfShiftDays: 1,
      lateDays: 3,
      earlyOutDays: 1,
      effectivePaidDays: 23.5,
    },
    earnings: [
      { key: "monthly_salary", label: "Monthly salary", note: "Fixed monthly salary", amount: 29500, kind: "info" },
      {
        key: "daily_rate",
        label: "Daily rate",
        note: "₹29,500 / 26 working days",
        amount: 1134.62,
        kind: "info",
      },
      {
        key: "earned",
        label: "Earned salary",
        note: "₹1,134.62 x 23.5 paid days (21 present + 0.5 half day + 2 paid leave)",
        amount: 26663.46,
        kind: "earning",
      },
      { key: "gross", label: "Gross salary", note: null, amount: 26663.46, kind: "subtotal" },
    ],
    deductions: [
      {
        key: "pf",
        label: "Provident fund",
        note: "12% of Basic + DA + Retaining ₹13,332.69",
        amount: 1599.92,
        kind: "deduction",
        ruleKey: "pf_rules",
      },
      {
        key: "late",
        label: "Late deduction",
        note: "4 occurrences, 2 free, 2 billable: 0.5 shift",
        amount: 567.31,
        kind: "deduction",
        ruleKey: "late_slabs",
      },
      {
        key: "advance",
        label: "Advance recovery",
        note: "Advance #12, instalment 3 of 10",
        amount: 1000,
        kind: "deduction",
      },
      { key: "total_deductions", label: "Total deductions", note: null, amount: 3167.23, kind: "subtotal" },
    ],
    rules: STAFF_RULES,
    issues: STAFF_ISSUES,
    issueCounts: {
      total: 11,
      bySeverity: { critical: 1, warning: 8, info: 2 },
      byCode: {
        absent: 1,
        unpaid_leave: 1,
        late_in: 3,
        early_out: 1,
        half_day: 1,
        missing_punch: 1,
        late_penalty: 1,
        advance_recovery: 1,
        esi_number_missing: 1,
      },
    },
    days: OCT_DAYS,
    advances: [{ advanceId: 12, repaymentId: 88, amount: 1000, notes: "Instalment 3 of 10" }],
    notes: null,
    history: [
      { payrollId: 90, label: "September 2026", net: 25480, status: "paid", issues: 2 },
      { payrollId: 79, label: "August 2026", net: 26120.5, status: "paid", issues: 0 },
      { payrollId: 66, label: "July 2026", net: 24900, status: "paid", issues: 4 },
    ],
    neighbours: { previousId: 100, nextId: 102, position: 3, total: 42 },
    context: { kind: "staff", month: 10, year: 2026, cycle: null, periodStart: null, periodEnd: null },
    ...over,
  };
}

// ── Production: one week ──────────────────────────────────────────────────────

const WEEK_DAYS: PayrollDay[] = [
  day({ date: "2026-10-05", shifts: 1 }),
  day({ date: "2026-10-06", firstIn: "08:21", shifts: 1, flags: ["late_in"] }),
  day({ date: "2026-10-07", shifts: 1 }),
  day({
    date: "2026-10-08",
    status: "half_shift",
    lastOut: "12:58",
    shifts: 0.5,
    flags: ["half_day"],
    note: "Left at noon",
  }),
  day({ date: "2026-10-09", shifts: 1 }),
  day({ date: "2026-10-10", status: "absent", firstIn: null, lastOut: null, shifts: 0, flags: ["absent"] }),
  sunday("2026-10-11"),
];

const PROD_ISSUE = (
  code: IssueCode,
  severity: IssueSeverity,
  title: string,
  detail: string,
  over: Partial<PayrollIssue> = {},
): PayrollIssue => ({
  ...issue(301, code, severity, title, detail, over),
  employeeId: 77,
  employeeCode: "P-0007",
  employeeName: "Ravi Kumar",
  department: "Weaving",
  designation: "Loom Operator",
});

export function productionDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  return {
    payrollId: 301,
    kind: "production",
    slipId: 8101,
    slipNumber: "SLP-P-2026-W41-0007",
    status: "pending",
    generatedAt: "2026-10-12T18:30:00+05:30",
    firstGeneratedAt: "2026-10-12T18:30:00+05:30",
    period: {
      label: "5 Oct - 11 Oct 2026",
      start: "2026-10-05",
      end: "2026-10-11",
      month: 10,
      year: 2026,
      days: 7,
      cycle: "weekly",
      cycleLabel: "Weekly",
    },
    employee: {
      id: 77,
      code: "P-0007",
      name: "Ravi Kumar",
      department: "Weaving",
      designation: "Loom Operator",
      branch: "Unit 1",
      employmentType: "production",
      status: "active",
      joinDate: "2025-06-01",
      phone: null,
      salaryAmount: null,
      salaryPerShift: 650,
      payCycle: "weekly",
      bank: { hasAccount: false, bankName: null, hasIfsc: false, accountLast4: null },
      pfNumber: null,
      esiNumber: null,
      split: null,
    },
    money: { gross: 2925, deductions: 651, bonus: 0, otAmount: 0, net: 2274, monthlySalary: null, dailyRate: null },
    summary: { daysWorked: 5, daysAbsent: 1, totalShifts: 4.5, totalSessions: null },
    earnings: [
      { key: "rate", label: "Rate per shift", note: "Set on the employee's profile", amount: 650, kind: "info" },
      { key: "shifts", label: "Shifts earned", note: "4.5 shifts x ₹650", amount: 2925, kind: "earning" },
      { key: "gross", label: "Gross salary", note: null, amount: 2925, kind: "subtotal" },
    ],
    deductions: [
      {
        key: "pf",
        label: "PF",
        note: "12% of Basic + DA + Retaining ₹2,925",
        amount: 351,
        kind: "deduction",
        ruleKey: "pf_rules",
      },
      { key: "advance", label: "Advance recovery", note: "Advance #31", amount: 300, kind: "deduction" },
      { key: "total_deductions", label: "Total deductions", note: null, amount: 651, kind: "subtotal" },
    ],
    rules: [
      {
        group: "Pay cycle",
        items: [
          {
            key: "pay_cycle",
            label: "Pay cycle",
            value: "Weekly, weeks start on Monday",
            source: "cycle",
            settingsPath: "/hr/settings?tab=production_payroll#weekly-first-period",
          },
        ],
      },
      {
        group: "Late detection",
        items: [
          {
            key: "late_free_allowance",
            label: "Free late marks a period",
            value: "2 free, then slabs",
            source: "settings",
            settingsPath: "/hr/settings?tab=production_payroll#late-rules",
            applied: "2 free, then slabs",
            changed: false,
          },
        ],
      },
      {
        group: "Pay",
        items: [
          { key: "rate_per_shift", label: "Rate per shift", value: "₹650", source: "employee", settingsPath: null },
          {
            key: "pf_rules",
            label: "PF",
            value: "12% of the first 50% of the pay when the monthly equivalent is ₹0 to ₹25,000",
            source: "settings",
            settingsPath: "/hr/settings?tab=pf_esi#production-pf-rules",
          },
        ],
      },
    ],
    issues: [
      PROD_ISSUE(
        "late_in",
        "warning",
        "Late arrival",
        "First punch 08:21, after Production 08:00 + 15 min grace (08:15)",
        {
          date: "2026-10-06",
          facts: { firstIn: "08:21" },
          rule: { label: "Free late marks a period", settingsPath: "/hr/settings?tab=production_payroll#late-rules" },
        },
      ),
      PROD_ISSUE("half_day", "warning", "Half day", "Left at 12:58, before the second half (13:30).", {
        date: "2026-10-08",
        impact: { shifts: 0.5, amount: 325 },
      }),
      PROD_ISSUE("absent", "critical", "Absent", "No punches on Sat 10 Oct.", {
        date: "2026-10-10",
        impact: { shifts: 1, amount: 650 },
      }),
      PROD_ISSUE("bank_missing", "warning", "Bank details missing", "No bank account is recorded for Ravi Kumar.", {
        category: "profile",
      }),
      PROD_ISSUE("advance_recovery", "info", "Advance recovery", "Advance #31: ₹300 recovered this week.", {
        category: "pay",
        impact: { amount: 300 },
      }),
    ],
    issueCounts: {
      total: 5,
      bySeverity: { critical: 1, warning: 3, info: 1 },
      byCode: { late_in: 1, half_day: 1, absent: 1, bank_missing: 1, advance_recovery: 1 },
    },
    days: WEEK_DAYS,
    advances: [{ advanceId: 31, repaymentId: 144, amount: 300, notes: null }],
    notes: "Bonus held back until the audit closes.",
    history: [
      { payrollId: 290, label: "28 Sep - 4 Oct 2026", net: 3250, status: "paid", issues: 1 },
      { payrollId: 281, label: "21 Sep - 27 Sep 2026", net: 3575, status: "paid", issues: 0 },
    ],
    neighbours: { previousId: null, nextId: 302, position: 1, total: 18 },
    context: {
      kind: "production",
      month: 10,
      year: 2026,
      cycle: "weekly",
      periodStart: "2026-10-05",
      periodEnd: "2026-10-11",
    },
    ...over,
  };
}

// ── A clean payroll: nothing to flag ──────────────────────────────────────────

export function cleanDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  const base = staffDetails();
  return staffDetails({
    payrollId: 102,
    employee: { ...STAFF_EMPLOYEE, id: 43, code: "UKT-0143", name: "Arun Prasad", esiNumber: "31001234560000999" },
    money: {
      gross: 29500,
      deductions: 1880.63,
      bonus: 0,
      otAmount: 0,
      net: 27619.37,
      monthlySalary: 29500,
      dailyRate: 1134.62,
    },
    summary: {
      ...base.summary,
      presentDays: 24,
      paidLeaveDays: 2,
      absentDays: 0,
      unpaidLeaveDays: 0,
      halfShiftDays: 0,
      lateDays: 0,
      earlyOutDays: 0,
      effectivePaidDays: 26,
    },
    deductions: [
      {
        key: "pf",
        label: "Provident fund",
        note: "12% of Basic + DA + Retaining ₹14,750",
        amount: 1770,
        kind: "deduction",
      },
      { key: "esi", label: "ESI", note: "0.75% of Basic + DA + Retaining ₹14,750", amount: 110.63, kind: "deduction" },
      { key: "total_deductions", label: "Total deductions", note: null, amount: 1880.63, kind: "subtotal" },
    ],
    rules: STAFF_RULES.map((g) => ({
      ...g,
      items: g.items.map((item) => ({
        ...item,
        changed: item.applied ? false : item.changed,
        applied: item.applied ? item.value : item.applied,
      })),
    })),
    issues: [],
    issueCounts: { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, byCode: {} },
    days: OCT_DAYS.map((d) =>
      d.flags.length > 0 || d.status === "absent" || d.status === "unpaid_leave" ? day({ date: d.date }) : d,
    ),
    advances: [],
    history: [{ payrollId: 91, label: "September 2026", net: 27619.37, status: "paid", issues: 0 }],
    neighbours: { previousId: 101, nextId: 103, position: 4, total: 42 },
    ...over,
  });
}

// ── A payroll with no stored payslip ──────────────────────────────────────────

export function noSlipDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  return staffDetails({ slipId: null, slipNumber: null, ...over });
}

// ── Payrolls with no day-by-day breakdown behind them ─────────────────────────

const NOTHING_BEHIND = {
  rules: [],
  issues: [],
  issueCounts: { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, byCode: {} },
  days: [],
  advances: [],
  history: [],
} satisfies Partial<PayrollDetails>;

/** An older session-based production payroll: only the money, and the server's own explanation in the notes. */
export function legacyDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  return productionDetails({
    payrollId: 304,
    kind: "legacy_session",
    ...NOTHING_BEHIND,
    summary: {},
    notes:
      "This payroll was calculated by the older session-based production engine: its day-by-day detail, rules and issues are not available here.",
    neighbours: { previousId: null, nextId: null, position: 1, total: 1 },
    ...over,
  });
}

/** A staff payroll with no stored salary slip, so no breakdown: its days, rules and issues are not there. */
export function noBreakdownDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  return staffDetails({
    payrollId: 105,
    slipId: null,
    slipNumber: null,
    ...NOTHING_BEHIND,
    summary: { totalWorkingDays: 26, presentDays: 22, absentDays: 4 },
    notes:
      "No day-by-day breakdown is stored for this payroll (it has no salary slip), so the days, rules and issues that come from it are not available here.",
    ...over,
  });
}

// ── A TDS employee: TDS instead of PF and ESI ─────────────────────────────────

/** An employee on the TDS list: 10% of the earned gross is deducted as TDS, and no PF or ESI ever is. */
export function tdsDetails(over: Partial<PayrollDetails> = {}): PayrollDetails {
  const base = cleanDetails();
  return staffDetails({
    payrollId: 106,
    employee: { ...STAFF_EMPLOYEE, id: 44, code: "UKT-0144", name: "Karthik Rajan", pfNumber: null, esiNumber: null },
    money: {
      gross: 29500,
      deductions: 2950,
      bonus: 0,
      otAmount: 0,
      net: 26550,
      monthlySalary: 29500,
      dailyRate: 1134.62,
    },
    summary: { ...base.summary },
    deductions: [
      { key: "tds", label: "TDS (10%)", note: "10% of the earned gross ₹29,500", amount: 2950, kind: "deduction" },
      { key: "total_deductions", label: "Total deductions", note: null, amount: 2950, kind: "subtotal" },
    ],
    rules: [],
    issues: [],
    issueCounts: { total: 0, bySeverity: { critical: 0, warning: 0, info: 0 }, byCode: {} },
    days: [],
    advances: [],
    history: [],
    neighbours: { previousId: 105, nextId: null, position: 6, total: 42 },
    ...over,
  });
}

// ── What payroll stored about PF / ESI / TDS (the details page reads it from the payslip's breakdown) ──────────

/** A Co Emp employee: the PF rule matched (12% below ₹25,000 of Basic), no ESI rule did. */
export const CO_EMP_STATUTORY: PayrollStatutory = {
  category: "co_emp",
  pfWages: 13332.69,
  firstPortionMonthly: 14750,
  pfRule: {
    id: "pf1",
    label: "PF below 25,000",
    basis: "basic",
    minAmount: 0,
    maxAmount: 25000,
    ratePercent: 12,
    amountTested: 10000,
  },
  esiRule: null,
  eligibility: { basic: 10000, firstPortion: 14750, total: 29500 },
  rulesScope: "global",
  branchId: null,
  tds: null,
  reason: null,
};

export const TDS_STATUTORY: PayrollStatutory = {
  category: "tds",
  pfWages: null,
  pfRule: null,
  esiRule: null,
  eligibility: null,
  rulesScope: "global",
  tds: { percent: 10, base: 29500, amount: 2950 },
  reason: null,
};

export const NOT_CO_EMP_STATUTORY: PayrollStatutory = {
  category: "none",
  pfRule: null,
  esiRule: null,
  tds: null,
  reason: "Not a Co Emp employee: no PF/ESI",
};

/** The breakdown answer of /api/payroll/<id>/breakdown with just the part the details page reads. */
export function breakdownOf(
  payrollId: number,
  deductions: Partial<NonNullable<PayrollBreakdownResponse["breakdown"]>["deductions"]>,
  salaryMode: "monthly" | "shift" = "monthly",
): PayrollBreakdownResponse {
  return {
    payrollId,
    employee: { id: 42, code: "UKT-0142", name: "Meena Subramanian", employmentType: "staff", salary: 29500 },
    month: 10,
    year: 2026,
    salaryMode,
    status: "pending",
    summary: { grossSalary: 0, deductions: 0, bonus: 0, netSalary: 0 },
    breakdown: {
      type: salaryMode === "shift" ? "production" : "staff",
      days: [],
      summary: {},
      earnings: { grossSalary: 0 },
      deductions: { advances: 0, advanceDetails: [], total: 0, ...deductions },
      netSalary: 0,
    },
  };
}
