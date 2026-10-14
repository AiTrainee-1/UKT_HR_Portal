import type {
  BalanceDetail,
  BalanceRow,
  BirthdayRow,
  BirthdaysResponse,
  CompensationCreditRow,
  CompensationReport,
  CompensationWindow,
  HolidayWorkClaim,
  HolidayWorkEligibleEmployee,
  HolidayWorkEligibleResponse,
  OvertimeConfig,
  OvertimeRow,
  ReportPeriod,
  ReportRow,
  ReportSection,
  ReportType,
} from "@/lib/api-client/custom-hooks";
import type { CompensationSettings } from "@/lib/api-client/custom-hooks";
import type { ApprovalProgress } from "@/lib/approval-workflow";
import { REPORT_TYPES } from "./history/history-logic";

// A small, realistic October 2026 for the render tests of the Compensation page (today is Wednesday 14 October; Sunday 11
// October is the day somebody worked): staff with Type 1 allowances, Type 2 candidates, an assigned and a rejected record
// and two older records; the announcements, claims and balances; the birthdays; and a report with every type.

export const TODAY = "2026-10-14";
export const SUNDAY = "2026-10-11";

// ── OT ──

export const ot = (id: number, over: Partial<OvertimeRow> = {}): OvertimeRow => ({
  id,
  employeeId: 10 + id,
  employeeCode: `E${10 + id}`,
  employeeName: `Employee ${id}`,
  department: "Sales",
  date: "2026-10-05",
  shiftEndTime: "17:30",
  lastPunchOut: "19:00",
  lastPunchNextDay: false,
  otMinutes: 90,
  otType: "allowance",
  allowanceMinutes: 30,
  suggestedShifts: null,
  shifts: null,
  claimDate: null,
  status: "auto",
  statusLabel: "Automatic",
  compensationType: null,
  announcedBy: null,
  announcedAt: null,
  allowanceUsed: false,
  usedOn: null,
  usedMinutes: null,
  allowanceStatus: null,
  canAssign: false,
  ...over,
});

export const OT_ROWS: OvertimeRow[] = [
  // Type 1
  ot(1, {
    employeeId: 11,
    employeeCode: "E11",
    employeeName: "Asha Kumar",
    date: "2026-10-06",
    allowanceUsed: true,
    allowanceStatus: "used",
    usedOn: "2026-10-07",
    usedMinutes: 18,
  }),
  ot(2, {
    employeeId: 12,
    employeeCode: "E12",
    employeeName: "Bala Raj",
    department: "Cutting",
    date: "2026-10-07",
    lastPunchOut: "19:30",
    otMinutes: 120,
    allowanceMinutes: 60,
    allowanceStatus: "not_used",
  }),
  // Type 2 waiting for HR
  ot(3, {
    employeeId: 13,
    employeeCode: "E13",
    employeeName: "Chitra Devi",
    date: "2026-10-05",
    lastPunchOut: "21:30",
    otMinutes: 240,
    otType: "shift",
    allowanceMinutes: 0,
    suggestedShifts: 0.5,
    status: "detected",
    statusLabel: "Detected",
    allowanceUsed: null,
    canAssign: true,
  }),
  ot(4, {
    employeeId: 11,
    employeeCode: "E11",
    employeeName: "Asha Kumar",
    date: "2026-10-09",
    lastPunchOut: "01:00",
    lastPunchNextDay: true,
    otMinutes: 450,
    otType: "shift",
    allowanceMinutes: 0,
    suggestedShifts: 0.75,
    status: "detected",
    statusLabel: "Detected",
    allowanceUsed: null,
    canAssign: true,
  }),
  // Type 2 assigned and rejected
  ot(5, {
    employeeId: 14,
    employeeCode: "E14",
    employeeName: "Dev Anand",
    department: "Cutting",
    date: "2026-10-02",
    lastPunchOut: "21:10",
    otMinutes: 220,
    otType: "shift",
    allowanceMinutes: 0,
    suggestedShifts: 0.5,
    shifts: 0.5,
    claimDate: "2026-10-12",
    status: "announced",
    statusLabel: "Assigned",
    compensationType: "relaxation",
    announcedBy: "Meena",
    announcedAt: "2026-10-10T09:00:00+05:30",
    allowanceUsed: null,
  }),
  ot(6, {
    employeeId: 12,
    employeeCode: "E12",
    employeeName: "Bala Raj",
    department: "Cutting",
    date: "2026-10-03",
    lastPunchOut: "21:40",
    otMinutes: 250,
    otType: "shift",
    allowanceMinutes: 0,
    suggestedShifts: 0.5,
    status: "rejected",
    statusLabel: "Rejected",
    allowanceUsed: null,
  }),
  // older records
  ot(7, {
    employeeId: 15,
    employeeCode: "E15",
    employeeName: "Esha Rao",
    date: "2026-10-01",
    otMinutes: 180,
    otType: "legacy",
    allowanceMinutes: 0,
    status: "announced",
    statusLabel: "Announced",
    compensationType: "pay",
    announcedBy: "Meena",
    allowanceUsed: null,
  }),
  ot(8, {
    employeeId: 15,
    employeeCode: "E15",
    employeeName: "Esha Rao",
    date: "2026-10-08",
    otMinutes: 200,
    otType: "legacy",
    allowanceMinutes: 0,
    status: "detected",
    statusLabel: "Detected",
    allowanceUsed: null,
  }),
];

export const OT_CONFIG: OvertimeConfig = {
  masterEnabled: true,
  allowanceEnabled: true,
  shiftEnabled: true,
  relaxationEnabled: true,
  payEnabled: true,
  shiftMinExtraMinutes: 150,
};

/** What GET /api/compensation/config answers: the rules the "How it is worked out" notes read. */
export const CONFIG: CompensationSettings = {
  masterEnabled: true,
  allowance: { enabled: true, effectiveFrom: "2026-10-01" },
  shift: { enabled: true, minExtraMinutes: 150, relaxationEnabled: true, payEnabled: true },
  windows: { enabled: true },
  holidayWork: { enabled: true },
  birthday: { enabled: true, effectiveFrom: "2026-10-01" },
  allowanceRules: [
    { id: 1, label: "1 hour", enabled: true, minExtraMinutes: 60, allowanceMinutes: 30, sortOrder: 1 },
    { id: 2, label: "2 hours", enabled: true, minExtraMinutes: 120, allowanceMinutes: 60, sortOrder: 2 },
  ],
  shiftRules: [
    { id: 5, label: "Up to 9:00 PM", enabled: true, untilMinutes: 1260, shifts: 0.25, sortOrder: 1 },
    { id: 6, label: "Up to midnight", enabled: true, untilMinutes: 1440, shifts: 0.5, sortOrder: 2 },
    { id: 7, label: "No limit", enabled: true, untilMinutes: null, shifts: 1, sortOrder: 3 },
  ],
  updatedBy: null,
  updatedAt: null,
};

// ── Windows ──

export const windowOf = (id: number, over: Partial<CompensationWindow> = {}): CompensationWindow => ({
  id,
  date: "2026-10-20",
  kind: "late_in",
  kindLabel: "Late-in",
  time: "10:30",
  reason: "Heavy rain",
  branchId: null,
  branch: null,
  departmentId: null,
  department: null,
  employeeIds: [],
  employeeCount: 0,
  covers: 214,
  allStaff: true,
  announcedBy: "Meena",
  createdAt: "2026-10-13T08:00:00+05:30",
  canDelete: true,
  ...over,
});

export const WINDOWS: CompensationWindow[] = [
  windowOf(901),
  windowOf(900, {
    date: "2026-10-10",
    kind: "early_out",
    kindLabel: "Early-out",
    time: "16:00",
    reason: "Transport strike",
    canDelete: false,
  }),
  windowOf(899, {
    date: "2026-09-20",
    kind: "day",
    kindLabel: "Day exemption",
    time: null,
    reason: "Festival",
    canDelete: false,
  }),
];

// ── Holiday / Sunday work ──

const claimApproval = (state: "pending" | "approved" | "rejected", by?: string): ApprovalProgress => ({
  workflow: "holiday_work",
  label: "Holiday / Sunday work compensation",
  enabled: true,
  steps: [
    {
      roles: ["hod"],
      mandatory: true,
      label: "HOD",
      index: 0,
      state,
      ...(by ? { by, at: "2026-10-12T10:00:00+05:30", decidedBy: "hod" as const } : {}),
    },
  ],
  currentStep: state === "pending" ? 0 : null,
  waitingFor: state === "pending" ? ["hod"] : [],
  canAct: { hod: state === "pending", hr: false },
  canReject: { hod: state === "pending", hr: false },
});

export const claim = (id: number, over: Partial<HolidayWorkClaim> = {}): HolidayWorkClaim => ({
  id,
  employeeId: 20 + id,
  employeeCode: `E${20 + id}`,
  employeeName: `Worker ${id}`,
  department: "Cutting",
  departmentId: 3,
  designation: null,
  branch: "Head Office",
  branchId: 2,
  employmentType: "staff",
  workDate: SUNDAY,
  dayKind: "sunday",
  holidayName: null,
  shifts: 0.5,
  reason: "Dispatch rush",
  status: "pending",
  requestedBy: "Meena",
  reviewedBy: null,
  reviewComment: null,
  reviewedAt: null,
  createdAt: "2026-10-12T06:00:00+00:00",
  hodName: "Suresh Raj",
  credited: false,
  approval: claimApproval("pending"),
  ...over,
});

export const CLAIMS: HolidayWorkClaim[] = [
  claim(3001, { employeeId: 23, employeeCode: "E23", employeeName: "Hari Om" }),
  claim(3002, {
    employeeId: 24,
    employeeCode: "E24",
    employeeName: "Indu Nair",
    shifts: 1,
    status: "approved",
    reviewedBy: "Suresh Raj",
    reviewedAt: "2026-10-12T05:00:00+00:00",
    credited: true,
    approval: claimApproval("approved", "Suresh Raj"),
  }),
  claim(3003, {
    employeeId: 25,
    employeeCode: "E25",
    employeeName: "Jai Singh",
    status: "rejected",
    reviewedBy: "Suresh Raj",
    reviewedAt: "2026-10-12T05:30:00+00:00",
    reviewComment: "Not authorised",
    approval: claimApproval("rejected", "Suresh Raj"),
  }),
];

const person = (
  code: string,
  name: string,
  over: Partial<HolidayWorkEligibleEmployee> = {},
): HolidayWorkEligibleEmployee => ({
  employeeId: Number(code.slice(1)),
  employeeCode: code,
  employeeName: name,
  department: "Cutting",
  departmentId: 3,
  designation: null,
  branch: "Head Office",
  branchId: 2,
  employmentType: "staff",
  punchCount: 2,
  firstPunch: "09:00",
  lastPunch: "17:30",
  spanMinutes: 510,
  attendanceStatus: "present",
  eligible: true,
  reason: null,
  claim: null,
  ...over,
});

export const ELIGIBLE_SUNDAY: HolidayWorkEligibleResponse = {
  date: SUNDAY,
  dayKind: "sunday",
  holidayName: null,
  claimable: true,
  message: null,
  maxAgeDays: 45,
  earliestDate: "2026-08-30",
  enabled: { master: true, holidayWork: true, workflow: true, canRaise: true },
  counts: { worked: 3, eligible: 2 },
  employees: [
    person("E21", "Fara Khan"),
    person("E22", "Gopal Das", { punchCount: 4, firstPunch: "10:00", lastPunch: "14:00", spanMinutes: 240 }),
    person("E23", "Hari Om", {
      eligible: false,
      reason: "Hari Om already has a claim for 11 Oct 2026 that is pending.",
      claim: { id: 3001, status: "pending", shifts: 0.5 },
    }),
  ],
};

export const ELIGIBLE_WEEKDAY: HolidayWorkEligibleResponse = {
  ...ELIGIBLE_SUNDAY,
  date: "2026-10-13",
  dayKind: null,
  claimable: false,
  message: "13 Oct 2026 is neither a Sunday nor a declared holiday, so there is no holiday work to claim.",
  counts: { worked: 0, eligible: 0 },
  employees: [],
};

// ── Balance ──

export const BALANCES: BalanceRow[] = [
  { employeeId: 21, employeeCode: "E21", employeeName: "Fara Khan", department: "Cutting", balance: 1.5 },
  { employeeId: 24, employeeCode: "E24", employeeName: "Indu Nair", department: "Sales", balance: 0.25 },
  { employeeId: 26, employeeCode: "E26", employeeName: "Kiran Paul", department: "Sales", balance: 0 },
];

export const LEDGERS: Record<number, BalanceDetail> = {
  21: {
    employeeId: 21,
    employeeCode: "E21",
    employeeName: "Fara Khan",
    balance: 1.5,
    entries: [
      {
        id: 12,
        type: "debit",
        shifts: 0.5,
        date: "2026-10-09",
        source: "redemption",
        note: "Redeemed on 2026-10-09",
        createdBy: "Meena",
        createdAt: "2026-10-08T10:00:00+05:30",
        counted: true,
      },
      {
        id: 9,
        type: "credit",
        shifts: 1,
        date: "2026-10-04",
        source: "holiday_work",
        note: null,
        createdBy: "HOD",
        createdAt: "2026-10-05T10:00:00+05:30",
        counted: true,
      },
      {
        id: null,
        type: "credit",
        shifts: 1,
        date: "2026-09-12",
        source: "legacy_credit",
        note: "Alternative Day credit from an earlier overtime announcement",
        createdBy: null,
        createdAt: null,
        counted: true,
        legacyCreditId: 4,
      },
    ],
  },
  24: { employeeId: 24, employeeCode: "E24", employeeName: "Indu Nair", balance: 0.25, entries: [] },
};

export const CREDITS: CompensationCreditRow[] = [
  {
    id: 4,
    employeeId: 21,
    employeeCode: "E21",
    employeeName: "Fara Khan",
    status: "available",
    usedDate: null,
    sourceDate: "2026-09-12",
    createdAt: "2026-09-13T10:00:00+05:30",
  },
  {
    id: 5,
    employeeId: 27,
    employeeCode: "E27",
    employeeName: "Lata Roy",
    status: "used",
    usedDate: "2026-09-30",
    sourceDate: "2026-09-02",
    createdAt: "2026-09-03T10:00:00+05:30",
  },
];

// ── Birthdays ──

const birthday = (code: string, name: string, day: string, over: Partial<BirthdayRow> = {}): BirthdayRow => ({
  employeeId: Number(code.slice(1)),
  employeeCode: code,
  employeeName: name,
  department: "Sales",
  departmentId: 1,
  designation: null,
  branch: "Head Office",
  branchId: 2,
  employmentType: "staff",
  birthday: day,
  weekday: "Wednesday",
  benefits: true,
  reason: null,
  attendanceStatus: "present",
  applied: true,
  compensationKind: "birthday",
  firstPunch: "10:40",
  lastPunch: "16:00",
  shiftsEarned: 1,
  ...over,
});

const BIRTHDAYS_TODAY: BirthdayRow[] = [birthday("E31", "Mala Iyer", TODAY)];
const BIRTHDAYS_WEEK: BirthdayRow[] = [
  birthday("E32", "Naveen Das", "2026-10-12", {
    weekday: "Monday",
    attendanceStatus: "absent",
    firstPunch: null,
    lastPunch: null,
  }),
  ...BIRTHDAYS_TODAY,
  birthday("E33", "Omar Ali", "2026-10-18", {
    weekday: "Sunday",
    benefits: false,
    reason: "18 Oct 2026 is a Sunday: it is already a day off.",
    attendanceStatus: null,
    applied: false,
    compensationKind: null,
    firstPunch: null,
    lastPunch: null,
    shiftsEarned: null,
  }),
];

export function birthdaysOf(period: ReportPeriod, date: string, enabled = true): BirthdaysResponse {
  const range =
    period === "today"
      ? { from: date, to: date }
      : period === "week"
        ? { from: "2026-10-12", to: "2026-10-18" }
        : { from: "2026-10-01", to: "2026-10-31" };
  const results = period === "today" ? BIRTHDAYS_TODAY : BIRTHDAYS_WEEK;
  return {
    period,
    date,
    ...range,
    enabled: { master: true, birthday: enabled, effectiveFrom: "2026-10-01" },
    count: results.length,
    benefitCount: results.filter((r) => r.benefits).length,
    results,
  };
}

// ── Reports ──

const rowOf = (type: ReportType, over: Partial<ReportRow>): ReportRow => ({
  type,
  employeeId: 11,
  employeeCode: "E11",
  employeeName: "Asha Kumar",
  department: "Sales",
  departmentId: 1,
  designation: "Executive",
  branch: "Head Office",
  branchId: 2,
  employmentType: "staff",
  date: TODAY,
  workDate: null,
  usedOn: null,
  time: null,
  firstPunch: null,
  lastPunch: null,
  minutes: null,
  minutesUsed: null,
  extraMinutes: null,
  allowanceMinutes: null,
  shifts: null,
  status: null,
  statusLabel: null,
  amount: null,
  amountEstimated: false,
  assignedBy: null,
  approvedBy: null,
  grantedOn: null,
  reason: null,
  detail: "",
  ...over,
});

const SECTION_ROWS: Record<ReportType, ReportRow[]> = {
  ot_allowance: [
    rowOf("ot_allowance", {
      date: "2026-10-13",
      workDate: "2026-10-13",
      lastPunch: "19:00",
      minutes: 30,
      extraMinutes: 90,
      allowanceMinutes: 30,
      usedOn: "2026-10-14",
      minutesUsed: 18,
      firstPunch: "09:48",
      status: "used",
      statusLabel: "Used",
      assignedBy: "Automatic",
      detail: "Worked until 19:00 (90 min past the shift end); 30 min allowed.",
    }),
    rowOf("ot_allowance", {
      employeeId: 12,
      employeeCode: "E12",
      employeeName: "Bala Raj",
      department: "Cutting",
      date: "2026-10-13",
      workDate: "2026-10-13",
      lastPunch: "19:30",
      minutes: 60,
      extraMinutes: 120,
      allowanceMinutes: 60,
      status: "pending",
      statusLabel: "Pending",
      assignedBy: "Automatic",
    }),
  ],
  ot_shift_relaxation: [
    rowOf("ot_shift_relaxation", {
      employeeId: 14,
      employeeCode: "E14",
      employeeName: "Dev Anand",
      department: "Cutting",
      date: TODAY,
      workDate: "2026-10-02",
      minutes: 220,
      extraMinutes: 220,
      shifts: 0.5,
      status: "applied",
      statusLabel: "Applied",
      assignedBy: "Meena",
      grantedOn: "2026-10-10",
      usedOn: TODAY,
      detail: "Relaxation (alternative day off) on 2026-10-14.",
    }),
  ],
  ot_shift_pay: [
    rowOf("ot_shift_pay", {
      employeeId: 13,
      employeeCode: "E13",
      employeeName: "Chitra Devi",
      date: TODAY,
      workDate: "2026-10-05",
      minutes: 240,
      extraMinutes: 240,
      shifts: 0.5,
      amount: 450,
      amountEstimated: true,
      status: "pending_payroll",
      statusLabel: "Waiting for payroll",
      assignedBy: "Meena",
      grantedOn: "2026-10-10",
    }),
  ],
  window_late_in: [
    rowOf("window_late_in", {
      date: TODAY,
      workDate: TODAY,
      usedOn: TODAY,
      time: "10:30",
      firstPunch: "10:15",
      lastPunch: "18:00",
      status: "used",
      statusLabel: "Used",
      assignedBy: "Meena",
      grantedOn: "2026-10-13",
      reason: "Heavy rain",
    }),
  ],
  window_early_out: [],
  holiday_work: [
    rowOf("holiday_work", {
      employeeId: 24,
      employeeCode: "E24",
      employeeName: "Indu Nair",
      department: "Sales",
      date: SUNDAY,
      workDate: SUNDAY,
      shifts: 1,
      status: "approved",
      statusLabel: "Approved",
      assignedBy: "Meena",
      approvedBy: "Suresh Raj",
      grantedOn: "2026-10-12",
      reason: "Dispatch rush",
      detail: "Added to the compensation balance.",
    }),
  ],
  birthday: [
    rowOf("birthday", {
      employeeId: 31,
      employeeCode: "E31",
      employeeName: "Mala Iyer",
      date: TODAY,
      workDate: TODAY,
      usedOn: TODAY,
      firstPunch: "10:40",
      lastPunch: "16:00",
      shifts: 1,
      status: "applied",
      statusLabel: "Applied",
      assignedBy: "Automatic",
      detail: "Paid birthday leave: present for the whole day, no attendance detection.",
    }),
  ],
};

const SUMMARIES: Record<ReportType, Record<string, number>> = {
  ot_allowance: { earned: 2, earnedMinutes: 90, used: 1, usedMinutes: 18, notUsed: 0, pending: 1, employees: 2 },
  ot_shift_relaxation: { records: 1, shifts: 0.5, applied: 1, scheduled: 0, notApplied: 0, employees: 1 },
  ot_shift_pay: {
    records: 1,
    shifts: 0.5,
    amount: 0,
    estimatedAmount: 450,
    inPayroll: 0,
    pendingPayroll: 1,
    employees: 1,
  },
  window_late_in: { announcements: 1, staffCovered: 214, used: 1, employees: 1 },
  window_early_out: { announcements: 0, staffCovered: 0, used: 0, employees: 0 },
  holiday_work: {
    claims: 1,
    pending: 0,
    approved: 1,
    rejected: 0,
    approvedShifts: 1,
    pendingShifts: 0,
    redeemedShifts: 0.5,
    employees: 1,
  },
  birthday: { birthdays: 1, applied: 1, pending: 0, notApplied: 0, shifts: 1, employees: 1 },
};

const REDEMPTION = rowOf("holiday_work", {
  employeeId: 21,
  employeeCode: "E21",
  employeeName: "Fara Khan",
  department: "Cutting",
  date: "2026-10-12",
  usedOn: "2026-10-12",
  shifts: 0.5,
  status: "redeemed",
  statusLabel: "Redeemed",
  assignedBy: "Meena",
  grantedOn: "2026-10-11",
  detail: "Redeemed on 2026-10-12",
});

const ROW_KEYS = Object.keys(rowOf("birthday", {}));

/** What GET /api/compensation/reports answers for these query parameters (types, period, date, filters). */
export function reportOf(qs: URLSearchParams, switchedOff: ReportType[] = []): CompensationReport {
  const period = (qs.get("period") ?? "today") as ReportPeriod;
  const date = qs.get("date") ?? TODAY;
  const wanted = qs.get("type");
  const types = wanted ? REPORT_TYPES.filter((t) => wanted.split(",").includes(t)) : REPORT_TYPES;
  const range =
    period === "today"
      ? { from: date, to: date }
      : period === "week"
        ? { from: "2026-10-12", to: "2026-10-18" }
        : { from: "2026-10-01", to: "2026-10-31" };
  const sections: ReportSection[] = types.map((type) => ({
    type,
    label: type,
    enabled: !switchedOff.includes(type),
    summary: SUMMARIES[type],
    rows: SECTION_ROWS[type],
    ...(type === "holiday_work" ? { redemptions: [REDEMPTION] } : {}),
  }));
  const everyone = new Set(sections.flatMap((s) => s.rows.map((r) => r.employeeId)));
  return {
    period,
    date,
    ...range,
    filters: {
      departmentId: qs.get("departmentId") ? Number(qs.get("departmentId")) : null,
      branchId: qs.get("branchId") ? Number(qs.get("branchId")) : null,
    },
    types,
    rowKeys: ROW_KEYS,
    totals: { rows: sections.reduce((n, s) => n + s.rows.length, 0), employees: everyone.size },
    sections,
  };
}

/** A report with every section empty (a quiet day). */
export function emptyReport(qs: URLSearchParams): CompensationReport {
  const full = reportOf(qs);
  return {
    ...full,
    totals: { rows: 0, employees: 0 },
    sections: full.sections.map((s) => ({
      ...s,
      summary: Object.fromEntries(Object.keys(s.summary).map((k) => [k, 0])),
      rows: [],
      ...(s.type === "holiday_work" ? { redemptions: [] } : {}),
    })),
  };
}

export const DEPARTMENTS = [
  { id: 1, name: "Sales" },
  { id: 3, name: "Cutting" },
];
export const BRANCHES = [
  { id: 2, name: "Head Office" },
  { id: 5, name: "Unit 2" },
];
export const CTC_ROWS = [
  {
    employeeId: 11,
    employeeCode: "E11",
    employeeName: "Asha Kumar",
    department: "Sales",
    designation: "Executive",
    branch: "Head Office",
    employmentType: "staff",
    firstPortion: 12000,
    secondPortion: 12000,
    splitRecorded: false,
    employerPf: 1440,
    employerEsi: 0,
    grossMonthly: 24000,
    annualCtc: 305280,
    basic: 6000,
    da: 3000,
    retainingAllowance: 3000,
    otherAllowance: 2000,
    petrolAllowance: 1000,
    hra: 4000,
    specialAllowance: 3000,
    ca: 2000,
  },
];
