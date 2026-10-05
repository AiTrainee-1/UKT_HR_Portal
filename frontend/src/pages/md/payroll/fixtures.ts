// Test fixtures: the backend's hand-computed August / September 2026 scenario (api/tests_md_payroll.py), shaped as the
// endpoints answer. The page smoke test serves them without a network.

import type { MdEnvelope, Provenance } from "@/lib/md/types";
import type {
  AttentionItem,
  ExceptionRow,
  MonthStatus,
  PayrollAdvances,
  PayrollAttention,
  PayrollBridge,
  PayrollComponents,
  PayrollDepartments,
  PayrollDistribution,
  PayrollExceptions,
  PayrollStatus,
  PayrollSummary,
  PayrollTrend,
  Totals,
  TrendRow,
} from "./types";

const entry = (id: string, title: string): Provenance => ({
  id,
  title,
  dataset: "Salary slips",
  definition: `How ${title.toLowerCase()} is worked out.`,
  formula: null,
  rows: 8,
  filters: [],
  caveats: [],
});

const PROVENANCE: Provenance[] = [
  entry("payroll-source", "Where the payroll figures come from"),
  entry("gross-pay", "Gross pay"),
  entry("net-pay", "Net pay"),
  entry("deductions", "Deductions"),
  entry("employer-cost", "Employer cost"),
  entry("headcount", "People paid"),
  entry("cost-per-head", "Cost per head"),
  entry("overtime", "Overtime"),
  entry("loss-of-pay", "Loss-of-pay days"),
  entry("provisional", "Provisional slips"),
  entry("payroll-status", "Payroll status of a month"),
  entry("trend", "Twelve-month trend"),
  entry("bridge", "Cost bridge"),
  entry("bridge-split", "Pay rate and attendance"),
  entry("departments", "Cost by department"),
  entry("distribution", "Spread of pay"),
  entry("components", "Components"),
  entry("statutory-due", "Statutory dues"),
  entry("statutory-bonus", "Statutory bonus"),
  entry("advances-outstanding", "Advances outstanding"),
  entry("advances-month", "Advances in the month"),
  entry("advances-ageing", "Advance ageing"),
  entry("exceptions", "Payroll exceptions"),
];

const base = (notes: string[] = []): MdEnvelope => ({
  generatedAt: "2026-10-12T10:42:10",
  scope: {
    branchIds: [],
    departmentIds: [],
    employmentType: null,
    description: "All units · all departments · staff and production",
  },
  provenance: PROVENANCE,
  notes,
});

export const sepStatus: MonthStatus = {
  month: "2026-09",
  label: "Sep 2026",
  state: "part_paid",
  stateLabel: "Part paid",
  monthEnded: true,
  slips: 8,
  headcount: 7,
  paidSlips: 2,
  unpaidSlips: 6,
  unpaidNet: 63145,
  provisionalSlips: 1,
  final: false,
  productionPeriods: 2,
  generatedAt: "2026-10-01T09:00:00",
  paidAt: "2026-10-06T10:00:00",
};

const augStatus: MonthStatus = {
  ...sepStatus,
  month: "2026-08",
  label: "Aug 2026",
  state: "paid",
  stateLabel: "Paid",
  paidSlips: 8,
  unpaidSlips: 0,
  unpaidNet: 0,
  provisionalSlips: 0,
  final: true,
};

const quiet = (month: string, label: string, state: MonthStatus["state"]): MonthStatus => ({
  ...sepStatus,
  month,
  label,
  state,
  stateLabel: state,
  slips: 0,
  headcount: 0,
  paidSlips: 0,
  unpaidSlips: 0,
  unpaidNet: 0,
  provisionalSlips: 0,
  final: false,
  productionPeriods: 0,
  generatedAt: null,
  paidAt: null,
});

const monthsBefore: MonthStatus[] = [
  ["2025-11", "Nov 2025"],
  ["2025-12", "Dec 2025"],
  ["2026-01", "Jan 2026"],
  ["2026-02", "Feb 2026"],
  ["2026-03", "Mar 2026"],
  ["2026-04", "Apr 2026"],
  ["2026-05", "May 2026"],
  ["2026-06", "Jun 2026"],
  ["2026-07", "Jul 2026"],
].map(([m, l]) => quiet(m, l, "no_data"));

export const statusFixture: PayrollStatus = {
  ...base(),
  today: "2026-10-12",
  currentMonth: "2026-10",
  defaultMonth: "2026-09",
  latestClosedMonth: "2026-09",
  payDay: 5,
  hasData: true,
  months: [...monthsBefore, augStatus, sepStatus, quiet("2026-10", "Oct 2026", "not_started")],
  available: ["2026-09", "2026-08"],
};

export const emptyStatusFixture: PayrollStatus = {
  ...base(["No payroll has been processed yet."]),
  today: "2026-10-12",
  currentMonth: "2026-10",
  defaultMonth: null,
  latestClosedMonth: null,
  payDay: 5,
  hasData: false,
  months: monthsBefore.map((m) => ({ ...m })),
  available: [],
};

const sepTotals: Totals = {
  grossPay: 110587.69,
  salaryEarned: 109587.69,
  overtimePay: 1000,
  bonusAndOneOffs: 0,
  totalDeductions: 2195,
  netPay: 108392.69,
  employerStatutory: 2145,
  employerCost: 112732.69,
  headcount: 7,
  slips: 8,
  costPerHead: 15798.24,
  employerCostPerHead: 16104.67,
  overtimeSharePct: 0.9,
  lopDays: 16,
};

const augTotals: Totals = {
  grossPay: 134500,
  salaryEarned: 134500,
  overtimePay: 0,
  bonusAndOneOffs: 0,
  totalDeductions: 3695,
  netPay: 130805,
  employerStatutory: 2145,
  employerCost: 136645,
  headcount: 7,
  slips: 8,
  costPerHead: 19214.29,
  employerCostPerHead: 19520.71,
  overtimeSharePct: 0,
  lopDays: 0,
};

export const summaryFixture: PayrollSummary = {
  ...base([
    "1 staff slip(s) for Sep 2026 were generated before the month ended and not regenerated since, so they understate pay. Regenerate payroll to correct them.",
    "3 production pay period(s) ended in Sep 2026 against 2 in Aug 2026: production pay moves with the number of periods.",
  ]),
  month: "2026-09",
  monthLabel: "Sep 2026",
  hasData: true,
  monthEnded: true,
  requested: false,
  status: sepStatus,
  totals: sepTotals,
  byType: {
    staff: { ...sepTotals, grossPay: 89307.69, headcount: 5 },
    production: { ...sepTotals, grossPay: 21280, headcount: 2, overtimePay: 0, lopDays: null },
  },
  previous: { month: "2026-08", label: "Aug 2026", totals: augTotals },
  lastYear: null,
  change: {
    grossPay: { abs: -23912.31, pct: -17.8 },
    salaryEarned: { abs: -24912.31, pct: -18.5 },
    overtimePay: { abs: 1000, pct: null },
    totalDeductions: { abs: -1500, pct: -40.6 },
    netPay: { abs: -22412.31, pct: -17.1 },
    employerCost: { abs: -23912.31, pct: -17.5 },
    headcount: { abs: 0, pct: 0 },
    costPerHead: { abs: -3416.05, pct: -17.8 },
    employerCostPerHead: { abs: -3416.04, pct: -17.5 },
    overtimeSharePct: { abs: 0.9, pct: null },
  },
  changeLastYear: null,
  payable: { slips: 6, netPay: 63145 },
};

export const emptySummaryFixture: PayrollSummary = {
  ...base(["No payroll has been processed yet."]),
  month: null,
  monthLabel: null,
  hasData: false,
  monthEnded: false,
  totals: null,
  byType: {},
};

/** A month the company has no payroll for (the answer for any month other than the two with slips). */
export const noPayrollSummary = (month: string, label: string): PayrollSummary => ({
  ...base([`No salary slips exist for ${label} in this selection: payroll has not been generated for it.`]),
  month,
  monthLabel: label,
  hasData: false,
  monthEnded: true,
  status: quiet(month, label, "not_generated"),
  totals: null,
  byType: {},
  previous: null,
  lastYear: null,
  change: null,
  changeLastYear: null,
  payable: null,
});

const point = (month: string, label: string, gross: number | null, extra: Partial<TrendRow> = {}): TrendRow => ({
  month,
  label,
  hasData: gross != null,
  state: gross != null ? "paid" : "no_data",
  provisionalSlips: 0,
  grossPay: gross,
  netPay: gross != null ? Math.round(gross * 0.97) : null,
  headcount: gross != null ? 7 : null,
  costPerHead: gross != null ? Math.round(gross / 7) : null,
  overtimePay: gross != null ? 0 : null,
  overtimeSharePct: gross != null ? 0 : null,
  ...extra,
});

export const trendFixture: PayrollTrend = {
  ...base(["Months marked provisional include staff slips generated before the month ended: they understate pay."]),
  hasData: true,
  month: "2026-09",
  months: [
    point("2025-10", "Oct 2025", null),
    ...monthsBefore.map((m) => point(m.month, m.label, null)),
    point("2026-08", "Aug 2026", 134500),
    point("2026-09", "Sep 2026", 110587.69, {
      state: "part_paid",
      provisionalSlips: 1,
      overtimePay: 1000,
      overtimeSharePct: 0.9,
    }),
  ],
  average: 122543.85,
  highest: { month: "2026-08", label: "Aug 2026", grossPay: 134500 },
  lowest: { month: "2026-09", label: "Sep 2026", grossPay: 110587.69 },
};

export const bridgeFixture: PayrollBridge = {
  ...base([
    "1 staff slip(s) for Sep 2026 have no saved calculation breakdown, so their change cannot be split into pay rate and attendance and sits under Other.",
  ]),
  available: true,
  month: "2026-09",
  monthLabel: "Sep 2026",
  previousMonth: "2026-08",
  previousLabel: "Aug 2026",
  start: { label: "Aug 2026 gross pay", amount: 134500 },
  end: { label: "Sep 2026 gross pay", amount: 110587.69 },
  change: { abs: -23912.31, pct: -17.8 },
  steps: [
    {
      id: "joined",
      label: "Joined payroll",
      amount: 15000,
      people: 1,
      detail: "People paid this month who were not paid last month.",
    },
    {
      id: "left",
      label: "Left payroll",
      amount: -40000,
      people: 1,
      detail: "People paid last month who are not on this month's payroll.",
    },
    {
      id: "rate",
      label: "Pay rate changes",
      amount: 2480,
      people: 2,
      detail: "Change in contract salary or rate per shift.",
    },
    { id: "overtime", label: "Overtime", amount: 1000, people: 1, detail: "Change in overtime pay." },
    {
      id: "attendance",
      label: "Loss of pay / attendance",
      amount: -1392.31,
      people: 3,
      detail: "Change in pay lost to absence or shifts worked.",
    },
    { id: "oneoffs", label: "Bonus and one-offs", amount: 0, people: 0, detail: "Change in incentives and bonuses." },
    { id: "other", label: "Other", amount: -1000, people: 1, detail: "What could not be assigned." },
  ],
  sumOfSteps: -23912.31,
  mainDriver: { id: "left", label: "Left payroll", amount: -40000 },
  productionPeriods: { previous: 2, current: 2 },
  provisionalSlips: 1,
};

export const noBridgeFixture: PayrollBridge = {
  ...base(),
  available: false,
  month: "2026-08",
  previousMonth: "2026-07",
  steps: [],
  reason: "There is no payroll for Jul 2026 in this selection, so there is nothing to compare.",
};

const line = (
  id: number | null,
  name: string,
  unit: string | null,
  heads: number,
  gross: number,
  prev: number,
  share: number,
  lop: number | null,
  ot = 0,
) => ({
  id,
  name,
  unit,
  headcount: heads,
  grossPay: gross,
  netPay: gross,
  overtimePay: ot,
  overtimeSharePct: gross ? Math.round((ot / gross) * 1000) / 10 : null,
  costPerHead: Math.round((gross / heads) * 100) / 100,
  lopDays: lop,
  employerCost: gross,
  sharePct: share,
  previous: { headcount: heads, grossPay: prev, costPerHead: Math.round((prev / heads) * 100) / 100 },
  change: {
    grossPay: { abs: Math.round((gross - prev) * 100) / 100, pct: Math.round(((gross - prev) / prev) * 1000) / 10 },
    costPerHead: null,
    headcount: { abs: 0, pct: 0 },
  },
});

export const departmentsFixture: PayrollDepartments = {
  ...base(),
  hasData: true,
  month: "2026-09",
  monthLabel: "Sep 2026",
  total: sepTotals,
  departments: [
    line(1, "Stitching", "Unit 1", 3, 59787.69, 58500, 54.1, 2, 1000),
    line(2, "Cutting", "Unit 1", 2, 26800, 26000, 24.2, 0),
    line(3, "Accounts", "Unit 2", 2, 24000, 50000, 21.7, 14),
  ],
  departmentsTotal: 3,
  units: [
    line(1, "Unit 1", null, 5, 86587.69, 84500, 78.3, 2, 1000),
    line(2, "Unit 2", null, 2, 24000, 50000, 21.7, 14),
  ],
  types: [
    { ...line(1, "Staff", null, 5, 89307.69, 114000, 80.8, 16, 1000), id: "staff" as const },
    { ...line(2, "Production", null, 2, 21280, 20500, 19.2, null), id: "production" as const },
  ],
};

export const componentsFixture: PayrollComponents = {
  ...base(),
  hasData: true,
  month: "2026-09",
  monthLabel: "Sep 2026",
  previousMonth: "2026-08",
  previousLabel: "Aug 2026",
  earnings: [
    {
      id: "basic",
      label: "Basic pay",
      amount: 69933.85,
      previous: 79500,
      change: { abs: -9566.15, pct: -12 },
      sharePct: 63.2,
    },
    {
      id: "hra",
      label: "HRA",
      amount: 15861.54,
      previous: 17000,
      change: { abs: -1138.46, pct: -6.7 },
      sharePct: 14.3,
    },
    {
      id: "allowances",
      label: "Allowances",
      amount: 23792.3,
      previous: 26000,
      change: { abs: -2207.7, pct: -8.5 },
      sharePct: 21.5,
    },
    { id: "overtime", label: "Overtime", amount: 1000, previous: 0, change: { abs: 1000, pct: null }, sharePct: 0.9 },
  ],
  grossPay: {
    id: "gross",
    label: "Gross pay",
    amount: 110587.69,
    previous: 134500,
    change: { abs: -23912.31, pct: -17.8 },
    sharePct: 100,
  },
  deductions: [
    {
      id: "pf",
      label: "Provident fund (PF)",
      amount: 1560,
      previous: 1560,
      change: { abs: 0, pct: 0 },
      sharePct: 71.1,
    },
    { id: "esi", label: "ESI", amount: 135, previous: 135, change: { abs: 0, pct: 0 }, sharePct: 6.2 },
    {
      id: "advance",
      label: "Advance recovery",
      amount: 0,
      previous: 2000,
      change: { abs: -2000, pct: -100 },
      sharePct: 0,
    },
    {
      id: "late",
      label: "Late-arrival deduction",
      amount: 500,
      previous: 0,
      change: { abs: 500, pct: null },
      sharePct: 22.8,
    },
  ],
  totalDeductions: {
    id: "deductions",
    label: "Total deductions",
    amount: 2195,
    previous: 3695,
    change: { abs: -1500, pct: -40.6 },
    sharePct: 2,
  },
  netPay: {
    id: "net",
    label: "Net pay",
    amount: 108392.69,
    previous: 130805,
    change: { abs: -22412.31, pct: -17.1 },
    sharePct: 98,
  },
  employer: [
    {
      id: "employer-pf",
      label: "Employer PF (estimate)",
      amount: 1560,
      previous: 1560,
      change: { abs: 0, pct: 0 },
      sharePct: 1.4,
    },
    {
      id: "employer-esi",
      label: "Employer ESI (estimate)",
      amount: 585,
      previous: 585,
      change: { abs: 0, pct: 0 },
      sharePct: 0.5,
    },
  ],
  employerCost: {
    id: "employer-cost",
    label: "Employer cost (estimate)",
    amount: 112732.69,
    previous: 136645,
    change: { abs: -23912.31, pct: -17.5 },
    sharePct: 101.9,
  },
  statutoryDue: 3840,
  payable: { slips: 6, netPay: 63145 },
  statutoryBonus: {
    financialYear: "2026-27",
    calculated: { amount: 5000, people: 1 },
    approved: { amount: 3000, people: 1 },
    paid: { amount: 2000, people: 1 },
    total: 10000,
    notPaid: 8000,
  },
  netGap: 0,
};

export const distributionFixture: PayrollDistribution = {
  ...base(),
  hasData: true,
  month: "2026-09",
  monthLabel: "Sep 2026",
  bands: [
    { id: "b0", label: "Nil or negative", from: null, to: 0, count: 0, staff: 0, production: 0 },
    { id: "b1", label: "Under ₹10k", from: 0, to: 10000, count: 2, staff: 1, production: 1 },
    { id: "b2", label: "₹10k–15k", from: 10000, to: 15000, count: 1, staff: 0, production: 1 },
    { id: "b3", label: "₹15k–20k", from: 15000, to: 20000, count: 3, staff: 3, production: 0 },
    { id: "b4", label: "₹20k–25k", from: 20000, to: 25000, count: 0, staff: 0, production: 0 },
    { id: "b5", label: "₹25k–30k", from: 25000, to: 30000, count: 1, staff: 1, production: 0 },
  ],
  stats: { people: 7, average: 15484.67, median: 15000, lowest: 8800, highest: 25440, belowTenThousand: 2 },
  byDesignation: [
    { designation: "Operator", headcount: 5, grossPay: 74587.69, averageGrossPay: 14917.54 },
    { designation: "Supervisor", headcount: 1, grossPay: 27000, averageGrossPay: 27000 },
    { designation: "No designation", headcount: 1, grossPay: 9000, averageGrossPay: 9000 },
  ],
  designationsTotal: 3,
};

export const advancesFixture: PayrollAdvances = {
  ...base([
    "The slips of Sep 2026 deducted ₹0.00 for advances but the instalments marked recovered add up to ₹5,000.00: payroll was probably regenerated after an instalment was processed.",
  ]),
  asOf: "2026-10-12",
  month: "2026-09",
  monthLabel: "Sep 2026",
  hasData: true,
  outstanding: {
    amount: 30000,
    advances: 3,
    borrowers: 3,
    average: 10000,
    general: { amount: 20000, advances: 2 },
    term: { amount: 10000, advances: 1 },
  },
  newThisMonth: { amount: 12000, count: 1, people: 1 },
  recoveredThisMonth: { amount: 5000, count: 1, people: 1 },
  netMovement: 7000,
  deductedOnSlips: 0,
  recoveryGap: -5000,
  overdue: { amount: 18000, count: 3, people: 2 },
  exEmployees: { amount: 8000, borrowers: 1 },
  ageing: [
    { label: "Up to 30 days", amount: 0, advances: 0 },
    { label: "31 to 90 days", amount: 12000, advances: 1 },
    { label: "91 to 180 days", amount: 0, advances: 0 },
    { label: "181 days to a year", amount: 10000, advances: 1 },
    { label: "Over a year", amount: 8000, advances: 1 },
  ],
};

const exception = (
  employeeId: number,
  code: string,
  name: string,
  kind: ExceptionRow["kind"],
  kindLabel: string,
  severity: ExceptionRow["severity"],
  detail: string,
  gross: number | null,
  net: number | null,
): ExceptionRow => ({
  employeeId,
  name,
  code,
  department: "Packing",
  type: "Staff",
  kind,
  kindLabel,
  severity,
  detail,
  grossPay: gross,
  netPay: net,
  compare: null,
  changePct: null,
});

export const EXCEPTION_ROWS: ExceptionRow[] = [
  exception(
    8,
    "K8",
    "Kala Test",
    "negative-net",
    "Negative net pay",
    "critical",
    "Deductions of ₹15,000.00 exceed gross pay of ₹12,000.00.",
    12000,
    -3000,
  ),
  exception(
    10,
    "K10",
    "Kiran Test",
    "duplicate-slip",
    "Duplicate slips",
    "critical",
    "2 staff slips for the same month: this person's pay is counted 2 times in the totals.",
    36000,
    36000,
  ),
  exception(
    9,
    "K9",
    "Kavya Test",
    "zero-net",
    "Zero net pay",
    "warning",
    "Net pay is zero (gross pay ₹10,000.00, deductions ₹10,000.00).",
    10000,
    0,
  ),
  exception(
    11,
    "K11",
    "Kumar Test",
    "paid-zero-days",
    "Paid for zero days",
    "warning",
    "Gross pay of ₹8,000.00 on a slip that counts no days or shifts worked.",
    8000,
    8000,
  ),
  exception(
    12,
    "K12",
    "Kamal Test",
    "no-slip",
    "No salary slip",
    "warning",
    "Active employee with a salary on file and no salary slip for Sep 2026.",
    null,
    null,
  ),
  exception(
    7,
    "K7",
    "Kishan Test",
    "pay-outlier",
    "Far above department median",
    "warning",
    "Gross pay ₹70,000 is 3.5 times the staff median of ₹20,000 in Packing.",
    70000,
    70000,
  ),
  exception(
    15,
    "K15",
    "Kavin Test",
    "pay-swing",
    "Large change on last month",
    "info",
    "Gross pay down 30%: ₹30,000 last month, ₹21,000 this month.",
    21000,
    21000,
  ),
  exception(
    16,
    "K16",
    "Kani Test",
    "pay-swing",
    "Large change on last month",
    "info",
    "Gross pay down 50%: ₹3,000 last month, ₹1,500 this month.",
    1500,
    1500,
  ),
  exception(
    17,
    "K17",
    "Keerthi Test",
    "pay-swing",
    "Large change on last month",
    "info",
    "Gross pay up 40%: ₹5,000 last month, ₹7,000 this month.",
    7000,
    7000,
  ),
  exception(
    18,
    "K18",
    "Kasi Test",
    "pay-swing",
    "Large change on last month",
    "info",
    "Gross pay up 90%: ₹10,000 last month, ₹19,000 this month.",
    19000,
    19000,
  ),
];

const KINDS: PayrollExceptions["kinds"] = [
  { id: "negative-net", label: "Negative net pay", severity: "critical", count: 1 },
  { id: "duplicate-slip", label: "Duplicate slips", severity: "critical", count: 1 },
  { id: "zero-net", label: "Zero net pay", severity: "warning", count: 1 },
  { id: "paid-zero-days", label: "Paid for zero days", severity: "warning", count: 1 },
  { id: "no-slip", label: "No salary slip", severity: "warning", count: 1 },
  { id: "pay-outlier", label: "Far above department median", severity: "warning", count: 1 },
  { id: "pay-swing", label: "Large change on last month", severity: "info", count: 4 },
];

/** The exceptions endpoint for a `limit` and `kind`: the first `limit` matching rows, with the whole month's counts. */
export function exceptionsFixture(
  limit: number,
  kind: string | null,
  rows: ExceptionRow[] = EXCEPTION_ROWS,
): PayrollExceptions {
  const matching = rows.filter((r) => !kind || r.kind === kind);
  return {
    ...base(),
    hasData: true,
    month: "2026-09",
    monthLabel: "Sep 2026",
    total: rows.length,
    people: rows.length,
    shown: Math.min(limit, matching.length),
    matching: matching.length,
    counts: Object.fromEntries(KINDS.map((k) => [k.id, k.count])),
    kinds: KINDS,
    rows: matching.slice(0, limit),
    thresholds: { variancePct: 25, varianceMinRupees: 1000, outlierMultiple: 3, outlierMinPeers: 5 },
  };
}

export const noExceptionsFixture: PayrollExceptions = {
  ...base(),
  hasData: true,
  month: "2026-09",
  total: 0,
  counts: {},
  kinds: KINDS.map((k) => ({ ...k, count: 0 })),
  rows: [],
  thresholds: { variancePct: 25, varianceMinRupees: 1000, outlierMultiple: 3, outlierMinPeers: 5 },
};

const item = (
  id: string,
  severity: AttentionItem["severity"],
  title: string,
  detail: string,
  metric: string,
): AttentionItem => ({
  id: `payroll.${id}`,
  severity,
  title,
  detail,
  metric,
  page: "payroll",
  ask: `Explain: ${title}`,
});

export const attentionFixture: PayrollAttention = {
  ...base(),
  month: "2026-09",
  items: [
    item(
      "unpaid-2026-09",
      "warning",
      "6 of 8 slips for Sep 2026 are not marked paid",
      "Salary day was the 5th, 7 day(s) ago. ₹63,145 net pay is not yet marked paid.",
      "₹63,145",
    ),
    item(
      "cost-drop",
      "warning",
      "Payroll cost fell 17.8% to ₹1.1 L in Sep 2026",
      "Down ₹23,912 on Aug 2026. Mainly left payroll (-₹40,000). Check nobody was left off payroll.",
      "-17.8%",
    ),
    item(
      "cost-per-head",
      "good",
      "Cost per head fell 17.8% to ₹15,798",
      "Sep 2026 against Aug 2026, with 7 people paid.",
      "-17.8%",
    ),
  ],
};

export const noAttentionFixture: PayrollAttention = { ...base(), month: "2026-09", items: [] };

/** Every endpoint of the page, answering the September scenario. */
export const FIXTURES = {
  "/api/md/payroll/status": statusFixture,
  "/api/md/payroll/summary": summaryFixture,
  "/api/md/payroll/attention": attentionFixture,
  "/api/md/payroll/trend": trendFixture,
  "/api/md/payroll/bridge": bridgeFixture,
  "/api/md/payroll/departments": departmentsFixture,
  "/api/md/payroll/components": componentsFixture,
  "/api/md/payroll/distribution": distributionFixture,
  "/api/md/payroll/advances": advancesFixture,
  "/api/md/payroll/exceptions": (params: URLSearchParams) =>
    exceptionsFixture(Number(params.get("limit") ?? 10), params.get("kind")),
};

const nothing = (extra: object) => ({
  ...base(["No payroll has been processed yet."]),
  hasData: false,
  month: null,
  ...extra,
});

/** A company with no slips at all: every endpoint answers "nothing yet". */
export const EMPTY_FIXTURES = {
  "/api/md/payroll/status": emptyStatusFixture,
  "/api/md/payroll/summary": emptySummaryFixture,
  "/api/md/payroll/attention": { ...base(), month: null, items: [] },
  "/api/md/payroll/trend": nothing({ months: [], average: null }),
  "/api/md/payroll/bridge": nothing({ available: false, previousMonth: null, steps: [] }),
  "/api/md/payroll/departments": nothing({ departments: [], departmentsTotal: 0, units: [], types: [] }),
  "/api/md/payroll/components": nothing({ earnings: [], deductions: [], employer: [] }),
  "/api/md/payroll/distribution": nothing({ bands: [], stats: null, byDesignation: [], designationsTotal: 0 }),
  "/api/md/payroll/advances": nothing({}),
  "/api/md/payroll/exceptions": nothing({ total: 0, counts: {}, kinds: [], rows: [], thresholds: {} }),
};
