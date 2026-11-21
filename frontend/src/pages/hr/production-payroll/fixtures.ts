import type {
  CycleSummary,
  EmployeeRules,
  ExcessEntry,
  NotIncludedEmployee,
  PayCycle,
  PayrollExcessData,
  ProductionNotIncluded,
  ProductionPayslipRow,
  ProductionPayslips,
  PayrollIssue,
  PayrollIssuesResponse,
  PayrollPeriodInfo,
  PayrollRulesResponse,
  PeriodEmployee,
  ProductionCyclesSummary,
  ProductionPayrollItem,
  ProductionPeriods,
  ProductionSkipCheck,
  SalarySlipItem,
  SalaryStatement,
  StatementColumn,
  StatementRow,
} from "@/lib/api-client/custom-hooks";
import { ISSUE_META } from "@/components/payroll/kit/issue-meta";
import { formatPeriod } from "./logic";

// A small, realistic February 2026 of the Weekly cycle for the render tests of the Production Payroll pages: three
// employees (Asha has a pending payslip, Bala is ready to be generated, Esha has no rate and is blocked), the issues
// payroll found for Asha, the rules each is paid under, and the statement and slips built from the same payrolls.

export const WEEK = { periodStart: "2026-02-02", periodEnd: "2026-02-08" };
export const PREVIOUS_WEEK = { periodStart: "2026-01-26", periodEnd: "2026-02-01" };
/** An older week than the default list offers: it is only reachable through its address or by typing a date inside it. */
export const OLD_WEEK = { periodStart: "2025-11-03", periodEnd: "2025-11-09" };
export const DETECTED_AT = "2026-02-09T10:15:00+05:30";
/** What the fake server says "today" is, for whether a period has ended. */
export const TODAY = "2026-10-13";

export const LABEL: Record<PayCycle, string> = { weekly: "Weekly", biweekly: "BiWeekly", monthly: "Monthly" };
export const DAYS: Record<PayCycle, number> = { weekly: 7, biweekly: 14, monthly: 28 };

// ── payroll rows and the roster ──

export const payroll = (
  id: number,
  employeeId: number,
  name: string,
  code: string,
  over: Partial<ProductionPayrollItem> = {},
): ProductionPayrollItem =>
  ({
    id,
    employeeId,
    employeeName: name,
    employeeCode: code,
    departmentId: 4,
    departmentName: "Weaving",
    salaryMode: "shift",
    month: 2,
    year: 2026,
    periodStart: WEEK.periodStart,
    periodEnd: WEEK.periodEnd,
    totalWorkingDays: 7,
    presentDays: 7,
    absentDays: 0,
    otHours: 0,
    otAmount: 0,
    baseSalary: 3500,
    grossSalary: 3500,
    deductions: 500,
    bonus: 0,
    finalSalary: 3000,
    status: "pending",
    bankAccount: "",
    bankIfsc: "",
    bankName: "",
    email: "",
    payCycle: "weekly",
    notes: null,
    ...over,
  }) as ProductionPayrollItem;

export const person = (id: number, name: string, code: string, over: Partial<PeriodEmployee> = {}): PeriodEmployee => ({
  employeeId: id,
  employeeCode: code,
  name,
  departmentName: "Weaving",
  salaryPerShift: 500,
  payroll: null,
  blockedReason: null,
  ...over,
});

export const NO_RATE = "No Salary Per Shift set on this employee's profile";

export const ASHA = person(1, "Asha Worker", "PC-W1", { payroll: payroll(11, 1, "Asha Worker", "PC-W1") });
export const BALA = person(2, "Bala Worker", "PC-W2");
export const ESHA = person(3, "Esha Worker", "PC-N1", { salaryPerShift: null, blockedReason: NO_RATE });

export const WEEKLY_PEOPLE: PeriodEmployee[] = [ASHA, BALA, ESHA];

/** Bala with a payslip for WEEK, already paid (3,300 earned, 500 deducted). */
export const balaPaid = (): PeriodEmployee =>
  person(2, "Bala Worker", "PC-W2", {
    payroll: payroll(12, 2, "Bala Worker", "PC-W2", { status: "paid", grossSalary: 3300, finalSalary: 2800 }),
  });

// ── the cycles and their periods ──

export const summaryOf = (cycle: PayCycle, over: Partial<CycleSummary> = {}): CycleSummary => ({
  cycle,
  label: LABEL[cycle],
  days: DAYS[cycle],
  assigned: cycle === "weekly" ? 3 : 0,
  configured: true,
  configError: null,
  weekStart: "monday",
  anchorDate: "2026-02-02",
  next: { ...WEEK, periodEnded: true },
  pending: { records: 1, employees: 1, amount: 3000 },
  ...over,
});

export const cyclesOf = (over: Partial<ProductionCyclesSummary> = {}): ProductionCyclesSummary => ({
  cycles: (["weekly", "biweekly", "monthly"] as PayCycle[]).map((c) => summaryOf(c)),
  totalProduction: 6,
  unassigned: 0,
  ...over,
});

export const periodsOf = (cycle: PayCycle, roster: number): ProductionPeriods => ({
  cycle,
  label: LABEL[cycle],
  days: DAYS[cycle],
  roster,
  periods: [
    { ...WEEK, periodEnded: true, isNext: true, generated: 1, paid: 0, state: "generated", parked: 0 },
    { ...PREVIOUS_WEEK, periodEnded: true, isNext: false, generated: 0, paid: 0, state: "not_generated", parked: 0 },
  ],
});

// ── issues and rules ──

export const periodInfo = (period = WEEK, cycle: PayCycle = "weekly"): PayrollPeriodInfo => ({
  label: formatPeriod(period),
  start: period.periodStart,
  end: period.periodEnd,
  month: Number(period.periodEnd.slice(5, 7)),
  year: Number(period.periodEnd.slice(0, 4)),
  days: DAYS[cycle],
  cycle,
  cycleLabel: LABEL[cycle],
});

/** One issue, with the severity, category and title its code has in the kit unless told otherwise. */
export function issue(
  payrollId: number,
  who: { employeeId: number; employeeCode: string; employeeName: string },
  code: PayrollIssue["code"],
  date: string | null,
  over: Partial<PayrollIssue> = {},
): PayrollIssue {
  const meta = ISSUE_META[code];
  return {
    id: `${payrollId}:${code}:${date ?? "period"}`,
    payrollId,
    ...who,
    department: "Weaving",
    designation: "Weaver",
    code,
    category: meta.category,
    severity: meta.severity,
    title: meta.label,
    detail: `Detail of ${meta.label.toLowerCase()}`,
    date,
    detectedAt: DETECTED_AT,
    impact: null,
    rule: null,
    ...over,
  };
}

const ASHA_WHO = { employeeId: 1, employeeCode: "PC-W1", employeeName: "Asha Worker" };

/** What payroll found for Asha's payslip: an absent day, a late day and a profile problem about the whole period. */
export const ASHA_ISSUES: PayrollIssue[] = [
  issue(11, ASHA_WHO, "absent", "2026-02-03", {
    detail: "No punches were recorded on this day, so no shift was earned",
    impact: { label: "No shift earned" },
  }),
  issue(11, ASHA_WHO, "late_in", "2026-02-05", {
    detail: "First punch 09:42 is after the production shift start + grace",
  }),
  issue(11, ASHA_WHO, "bank_missing", null, { detail: "No bank account number and IFSC code on the profile" }),
];

export function issuesResponse(
  issues: PayrollIssue[],
  employees: number,
  period = WEEK,
  cycle: PayCycle = "weekly",
): PayrollIssuesResponse {
  const bySeverity = { critical: 0, warning: 0, info: 0 };
  const byCode = new Map<string, PayrollIssuesResponse["summary"]["byCode"][number]>();
  for (const i of issues) {
    bySeverity[i.severity] += 1;
    const entry = byCode.get(i.code);
    if (entry) entry.count += 1;
    else byCode.set(i.code, { code: i.code, label: i.title, severity: i.severity, category: i.category, count: 1 });
  }
  return {
    scope: periodInfo(period, cycle),
    detectedAt: employees > 0 ? DETECTED_AT : null,
    summary: {
      employees,
      employeesWithIssues: new Set(issues.map((i) => i.employeeId)).size,
      total: issues.length,
      bySeverity,
      byCode: [...byCode.values()],
      byDepartment: issues.length > 0 ? [{ department: "Weaving", count: issues.length }] : [],
    },
    issues,
  };
}

export const rulesOf = (
  employeeId: number,
  code: string,
  name: string,
  payrollId: number | null,
  over: Partial<EmployeeRules> = {},
): EmployeeRules => ({
  employeeId,
  employeeCode: code,
  employeeName: name,
  department: "Weaving",
  designation: "Weaver",
  payrollId,
  chips: [
    { key: "rate", label: "₹500 per shift", tone: "info" },
    { key: "cycle", label: "Weekly cycle", tone: "accent" },
  ],
  groups: [],
  flags: [],
  ...over,
});

export const WEEKLY_RULES: EmployeeRules[] = [
  rulesOf(1, "PC-W1", "Asha Worker", 11),
  rulesOf(2, "PC-W2", "Bala Worker", null),
  rulesOf(3, "PC-N1", "Esha Worker", null, {
    chips: [{ key: "rate", label: "No rate", tone: "danger" }],
    flags: ["no_rate"],
  }),
];

export const rulesResponse = (
  employees: EmployeeRules[],
  period = WEEK,
  cycle: PayCycle = "weekly",
): PayrollRulesResponse => ({
  scope: periodInfo(period, cycle),
  settings: [
    {
      group: "Late detection",
      items: [
        {
          key: "late_free_allowance",
          label: "Free late days",
          value: "2 free, then slabs",
          source: "cycle",
          settingsPath: "/hr/settings?tab=production_payroll",
        },
      ],
    },
  ],
  employees,
});

// ── the Salary Statement, built from the same payrolls ──

export const PRODUCTION_COLUMNS: StatementColumn[] = [
  { key: "sno", label: "SNO", sub: null, align: "center", format: "int", weight: 0.6, total: false, group: "identity" },
  {
    key: "code",
    label: "ID NO",
    sub: null,
    align: "left",
    format: "text",
    weight: 1.1,
    total: false,
    group: "identity",
  },
  { key: "name", label: "Name", sub: null, align: "left", format: "text", weight: 3, total: false, group: "identity" },
  {
    key: "designation",
    label: "Designation",
    sub: null,
    align: "left",
    format: "text",
    weight: 2.2,
    total: false,
    group: "identity",
  },
  {
    key: "rate",
    label: "Rate / shift",
    sub: null,
    align: "right",
    format: "money",
    weight: 1.1,
    total: false,
    group: "earnings",
  },
  {
    key: "shifts",
    label: "Shifts",
    sub: null,
    align: "right",
    format: "days",
    weight: 1,
    total: true,
    group: "attendance",
  },
  {
    key: "eSalary",
    label: "E salary",
    sub: null,
    align: "right",
    format: "money",
    weight: 1.3,
    total: true,
    group: "earnings",
  },
  {
    key: "esi",
    label: "ESI / EF",
    sub: null,
    align: "right",
    format: "money",
    weight: 1,
    total: true,
    group: "deductions",
  },
  {
    key: "totalDeduction",
    label: "Total Deduction",
    sub: null,
    align: "right",
    format: "money",
    weight: 1.3,
    total: true,
    group: "deductions",
  },
  { key: "net", label: "NET", sub: null, align: "right", format: "money", weight: 1.3, total: true, group: "result" },
  {
    key: "remarks",
    label: "Remarks",
    sub: null,
    align: "left",
    format: "text",
    weight: 2,
    total: false,
    group: "result",
  },
];

const sumOf = (rows: StatementRow[], key: string): number =>
  rows.reduce((sum, r) => sum + (Number(r.values[key]) || 0), 0);

const totalsRow = (rows: StatementRow[]): StatementRow => ({
  payrollId: null,
  employeeId: null,
  sno: null,
  status: null,
  values: {
    shifts: sumOf(rows, "shifts"),
    eSalary: sumOf(rows, "eSalary"),
    esi: sumOf(rows, "esi"),
    totalDeduction: sumOf(rows, "totalDeduction"),
    net: sumOf(rows, "net"),
  },
});

/** The production statement of these payrolls, one department band (Weaving), as the server builds it. */
export function statementOf(payrolls: ProductionPayrollItem[], period = WEEK): SalaryStatement {
  const rows: StatementRow[] = payrolls.map((p, i) => ({
    payrollId: p.id,
    employeeId: p.employeeId,
    sno: i + 1,
    status: p.status,
    values: {
      code: p.employeeCode ?? "",
      name: p.employeeName ?? "",
      designation: "Weaver",
      rate: 500,
      shifts: p.presentDays,
      eSalary: p.grossSalary + p.bonus,
      esi: 0,
      totalDeduction: p.deductions,
      net: p.finalSalary,
      remarks: "",
    },
  }));
  const paid = payrolls.filter((p) => p.status === "paid").length;
  const from = period.periodStart.split("-").reverse().join("-");
  const to = period.periodEnd.split("-").reverse().join("-");
  return {
    kind: "production",
    company: { name: "UKTextiles", branchLabel: null },
    title: `Production Salary Statement From ${from} To ${to}`,
    period: { ...periodInfo(period), fromLabel: from, toLabel: to },
    generatedAt: "2026-02-09T18:05:00+05:30",
    columns: PRODUCTION_COLUMNS,
    groups: rows.length > 0 ? [{ key: "4", label: "WEAVING", rows, subtotal: totalsRow(rows) }] : [],
    total: totalsRow(rows),
    counts: { employees: rows.length, departments: rows.length > 0 ? 1 : 0, paid, pending: rows.length - paid },
    notes: ["Rate / shift is the worker's salary per shift; Shifts is the total shifts earned in the period."],
  };
}

// ── payslips ──

export const slip = (id: number, name: string, code: string, over: Partial<SalarySlipItem> = {}): SalarySlipItem =>
  ({
    id,
    employeeId: id * 10,
    employeeCode: code,
    employeeName: name,
    departmentName: "Weaving",
    designationTitle: "Weaver",
    employmentType: "production",
    payCycle: "weekly",
    periodStart: WEEK.periodStart,
    periodEnd: WEEK.periodEnd,
    month: 2,
    year: 2026,
    slipNumber: `SS/${code}/2026-02-02_2026-02-08`,
    grossSalary: 3500,
    totalDeductions: 500,
    netSalary: 3000,
    emailedAt: null,
    ...over,
  }) as SalarySlipItem;

export const WEEKLY_SLIPS: SalarySlipItem[] = [slip(1, "Asha Worker", "PC-W1")];

// ── the skip check (the engine's dry run) ──

export const skipCheckOf = (over: Partial<ProductionSkipCheck> = {}): ProductionSkipCheck => ({
  cycle: "weekly",
  ...WEEK,
  totalChecked: 3,
  skippedCount: 1,
  alreadyGenerated: 1,
  skipped: [{ employeeId: 3, employeeCode: "PC-N1", name: "Esha Worker", reason: NO_RATE }],
  ...over,
});

// ── Excess, payslips and Not included (2026-11-20) ──

const round2 = (n: number) => Math.round(n * 100) / 100;
const inPeriodOf = (period: { periodStart: string; periodEnd: string }) => (p: ProductionPayrollItem) =>
  p.periodStart === period.periodStart && p.periodEnd === period.periodEnd;

/** An Excess (or Detection) entry of WEEK on the Weekly cycle. */
export const excessEntry = (id: number, employeeId: number, over: Partial<ExcessEntry> = {}): ExcessEntry => ({
  id,
  employeeId,
  kind: "excess",
  amount: 200,
  remark: "Festival incentive approved by MD",
  source: "manual",
  createdBy: "HR",
  createdAt: "2026-02-09T11:00:00+05:30",
  updatedBy: "HR",
  updatedAt: "2026-02-09T11:00:00+05:30",
  cycle: "weekly",
  periodStart: WEEK.periodStart,
  periodEnd: WEEK.periodEnd,
  ...over,
});

/**
 * GET /api/production-payroll-excess/period, built like the server does: one department (Weaving) with every worker who has
 * an entry in the period, the earned salary before (the payroll's gross) and after, and the picker's options (a worker
 * without a rate cannot be picked).
 */
export function excessPeriodOf(
  people: PeriodEmployee[],
  entries: ExcessEntry[],
  period: { periodStart: string; periodEnd: string },
  opts: { cycle?: PayCycle; locked?: boolean; canEdit?: boolean } = {},
): PayrollExcessData {
  const cycle = opts.cycle ?? "weekly";
  const mine = entries.filter((e) => e.periodStart === period.periodStart && e.periodEnd === period.periodEnd);
  const payrolls = people
    .flatMap((p) => (p.payroll ? [p.payroll as ProductionPayrollItem] : []))
    .filter(inPeriodOf(period));
  const rows = people
    .filter((p) => mine.some((e) => e.employeeId === p.employeeId))
    .map((p) => {
      const own = mine.filter((e) => e.employeeId === p.employeeId).sort((a, b) => b.id - a.id);
      const excess = round2(own.filter((e) => e.kind === "excess").reduce((s, e) => s + e.amount, 0));
      const detection = round2(own.filter((e) => e.kind === "detection").reduce((s, e) => s + e.amount, 0));
      const net = round2(excess - detection);
      const payroll = payrolls.find((r) => r.employeeId === p.employeeId) ?? null;
      return {
        employeeId: p.employeeId,
        code: p.employeeCode,
        name: p.name,
        designation: "Weaver",
        department: p.departmentName,
        excess,
        detection,
        net,
        payrollId: payroll?.id ?? null,
        inPayroll: !!payroll,
        earnedSalary: payroll ? payroll.grossSalary : null,
        earnedWithExcess: payroll ? round2(payroll.grossSalary + net) : null,
        netPay: payroll ? payroll.finalSalary : null,
        entries: own,
      };
    });
  const sum = (key: "excess" | "detection" | "net") => round2(rows.reduce((s, r) => s + r[key], 0));
  const label = `${LABEL[cycle]} ${formatPeriod(period)}`;
  return {
    cycle,
    ...period,
    periodLabel: label,
    locked: !!opts.locked,
    lockedMessage: opts.locked
      ? `${label} is finalized (Payroll Done): no excess or detection can be added, changed or removed.`
      : null,
    payrollGenerated: payrolls.length > 0,
    canEdit: opts.canEdit ?? true,
    summary: {
      employees: rows.length,
      entries: mine.length,
      excessTotal: sum("excess"),
      detectionTotal: sum("detection"),
      net: sum("net"),
    },
    departments:
      rows.length > 0
        ? [
            {
              departmentId: 4,
              department: "Weaving",
              unit: "HO",
              employees: rows.length,
              excessTotal: sum("excess"),
              detectionTotal: sum("detection"),
              net: sum("net"),
              rows,
            },
          ]
        : [],
    employeeOptions: people.map((p) => ({
      id: p.employeeId,
      code: p.employeeCode,
      name: p.name,
      department: p.departmentName,
      designation: "Weaver",
      eligible: p.salaryPerShift !== null,
      reason: p.salaryPerShift === null ? "No salary per shift on the profile" : null,
    })),
  };
}

/** GET /api/payslips/production: one payslip per payroll of the period, with the lines its PDF prints. */
export function productionPayslipsOf(
  people: PeriodEmployee[],
  period: { periodStart: string; periodEnd: string },
  opts: { cycle?: PayCycle; locked?: boolean; slips?: SalarySlipItem[]; excess?: ExcessEntry[] } = {},
): ProductionPayslips {
  const cycle = opts.cycle ?? "weekly";
  const rows: ProductionPayslipRow[] = people.flatMap((p) => {
    const payroll = p.payroll as ProductionPayrollItem | null;
    if (!payroll || !inPeriodOf(period)(payroll)) return [];
    const own = (opts.excess ?? []).filter(
      (e) => e.employeeId === p.employeeId && e.periodStart === period.periodStart && e.periodEnd === period.periodEnd,
    );
    const excess = round2(own.filter((e) => e.kind === "excess").reduce((s, e) => s + e.amount, 0));
    const detection = round2(own.filter((e) => e.kind === "detection").reduce((s, e) => s + e.amount, 0));
    const slip = (opts.slips ?? []).find((s) => s.employeeCode === p.employeeCode) ?? null;
    const earnings = [{ label: "Shift wages", amount: payroll.grossSalary }];
    if (excess) earnings.push({ label: "Excess (added by HR)", amount: excess });
    if (detection) earnings.push({ label: "Detection (taken off by HR)", amount: -detection });
    return [
      {
        payrollId: payroll.id,
        slipId: slip?.id ?? null,
        hasSlip: !!slip,
        employeeId: p.employeeId,
        code: p.employeeCode,
        name: p.name,
        department: p.departmentName,
        designation: "Weaver",
        unit: "HO",
        joinDate: "2025-04-21",
        bankAccountMasked: null,
        pfNumber: null,
        esiNumber: null,
        status: payroll.status,
        paymentStatus: "unpaid",
        salaryPerShift: p.salaryPerShift,
        shifts: payroll.presentDays,
        daysWorked: payroll.presentDays,
        absent: payroll.absentDays,
        earned: payroll.grossSalary,
        ot: 0,
        excess,
        detection,
        eSalary: round2(payroll.grossSalary + excess - detection),
        pf: 0,
        esi: 0,
        tds: 0,
        advance: payroll.deductions,
        others: 0,
        totalDeduction: payroll.deductions,
        net: payroll.finalSalary,
        earnings,
        deductions: [{ label: "Advance", amount: payroll.deductions }],
      },
    ];
  });
  const sum = (key: "earned" | "excess" | "detection" | "totalDeduction" | "net") =>
    round2(rows.reduce((s, r) => s + r[key], 0));
  return {
    cycle,
    ...period,
    periodLabel: `${LABEL[cycle]} ${formatPeriod(period)}`,
    locked: !!opts.locked,
    summary: {
      employees: rows.length,
      earned: sum("earned"),
      excess: sum("excess"),
      detection: sum("detection"),
      deductions: sum("totalDeduction"),
      net: sum("net"),
    },
    rows,
  };
}

/** A staff employee and a BiWeekly worker: never in the Weekly payroll, whatever happens. */
export const NOT_INCLUDED_OTHERS: NotIncludedEmployee[] = [
  {
    id: 90,
    code: "S-1",
    name: "Siva Staff",
    category: "staff",
    status: "active",
    departmentId: 7,
    department: "Accounts",
    designationId: 8,
    designation: "Accountant",
    branchId: 1,
    unit: "HO",
    joinDate: "2024-06-01",
    reasonCode: "staff",
    reason: "Staff employee: paid on the Staff Payroll.",
    detail: null,
    payrollId: null,
  },
  {
    id: 91,
    code: "PC-B1",
    name: "Banu Biweekly",
    category: "production",
    status: "active",
    departmentId: 5,
    department: "Stitching",
    designationId: 9,
    designation: "Tailor",
    branchId: 1,
    unit: "HO",
    joinDate: "2025-01-10",
    reasonCode: "other_cycle",
    reason: "On the BiWeekly cycle: paid on that cycle's page.",
    detail: "BiWeekly",
    payrollId: null,
  },
];

/**
 * GET /api/payroll/production/not-included: the Weekly roster without a payroll in the period (no rate, or would be paid:
 * generate again / not generated yet) plus the people who are never on it (a staff employee, a BiWeekly worker).
 */
export function notIncludedOf(
  people: PeriodEmployee[],
  period: { periodStart: string; periodEnd: string },
  cycle: PayCycle = "weekly",
): ProductionNotIncluded {
  const payrolls = people
    .flatMap((p) => (p.payroll ? [p.payroll as ProductionPayrollItem] : []))
    .filter(inPeriodOf(period));
  const generated = payrolls.length > 0;
  const roster: NotIncludedEmployee[] = people
    .filter((p) => !payrolls.some((r) => r.employeeId === p.employeeId))
    .map((p) => {
      const noRate = p.salaryPerShift === null;
      return {
        id: p.employeeId,
        code: p.employeeCode,
        name: p.name,
        category: "production",
        status: "active",
        departmentId: 4,
        department: p.departmentName,
        designationId: 6,
        designation: "Weaver",
        branchId: 1,
        unit: "HO",
        joinDate: "2025-04-21",
        reasonCode: noRate ? "no_salary" : "not_generated",
        reason: noRate
          ? "No salary per shift on the profile: payroll cannot work out the wages."
          : "Would be paid: generate the payroll again to add the worker.",
        detail: null,
        payrollId: null,
      };
    });
  const employees = [...roster, ...NOT_INCLUDED_OTHERS];
  const byReason: Record<string, number> = {};
  for (const e of employees) byReason[e.reasonCode] = (byReason[e.reasonCode] ?? 0) + 1;
  return {
    cycle,
    ...period,
    generated,
    notGeneratedCount: generated ? 0 : roster.filter((e) => e.reasonCode === "not_generated").length,
    summary: {
      total: employees.length,
      staff: employees.filter((e) => e.category === "staff").length,
      production: employees.filter((e) => e.category === "production").length,
      byReason,
    },
    employees,
    departments: [
      { id: 4, name: "Weaving" },
      { id: 5, name: "Stitching" },
      { id: 7, name: "Accounts" },
    ],
    designations: [
      { id: 6, title: "Weaver" },
      { id: 8, title: "Accountant" },
      { id: 9, title: "Tailor" },
    ],
  };
}
