// The shapes of the Payroll Analysis endpoints (backend: api/md_portal/analytics/payroll.py, mounted at /api/md/payroll/).
// Money is rupees as a number with two places; percentages are 0-100; "no data" is null (never 0).

import type { MdEnvelope } from "@/lib/md/types";

/** A change against a comparison figure: `pct` is null when the comparison was 0. */
export type Change = { abs: number; pct: number | null };

export type PayrollState =
  "paid" | "part_paid" | "generated" | "in_progress" | "not_generated" | "not_started" | "no_data";

/** The payment state of one month: slips, how many are marked paid, how many staff slips are provisional... */
export type MonthStatus = {
  month: string;
  label: string;
  state: PayrollState;
  stateLabel: string;
  monthEnded: boolean;
  slips: number;
  headcount: number;
  paidSlips: number;
  unpaidSlips: number;
  /** Net pay of the slips not yet marked paid. */
  unpaidNet: number;
  provisionalSlips: number;
  /** Paid, with no provisional slip, and the month is over. */
  final: boolean;
  productionPeriods: number;
  generatedAt: string | null;
  paidAt: string | null;
};

/** The headline figures of a group of slips. */
export type Totals = {
  grossPay: number;
  salaryEarned: number;
  overtimePay: number;
  bonusAndOneOffs: number;
  totalDeductions: number;
  netPay: number;
  employerStatutory: number;
  employerCost: number;
  headcount: number;
  slips: number;
  costPerHead: number | null;
  employerCostPerHead: number | null;
  overtimeSharePct: number | null;
  lopDays: number | null;
};

export type ChangeKey =
  | "grossPay"
  | "salaryEarned"
  | "overtimePay"
  | "totalDeductions"
  | "netPay"
  | "employerCost"
  | "headcount"
  | "costPerHead"
  | "employerCostPerHead"
  | "overtimeSharePct";

export type ChangeMap = Record<ChangeKey, Change | null>;

export type MonthBlock = { month: string; label: string; totals: Totals };

export type PayrollSummary = MdEnvelope & {
  month: string | null;
  monthLabel: string | null;
  hasData: boolean;
  monthEnded: boolean;
  requested?: boolean;
  status?: MonthStatus;
  totals: Totals | null;
  byType: Partial<Record<"staff" | "production", Totals>>;
  /** A kind of payroll paid last month with no slip yet this month: the cost is understated. */
  typeGaps?: { type: "staff" | "production"; headcount: number; grossPay: number }[];
  previous?: MonthBlock | null;
  lastYear?: MonthBlock | null;
  change?: ChangeMap | null;
  changeLastYear?: ChangeMap | null;
  payable?: { slips: number; netPay: number } | null;
};

export type TrendRow = {
  month: string;
  label: string;
  hasData: boolean;
  state: PayrollState;
  provisionalSlips: number;
  grossPay: number | null;
  netPay: number | null;
  headcount: number | null;
  costPerHead: number | null;
  overtimePay: number | null;
  overtimeSharePct: number | null;
};

export type PayrollTrend = MdEnvelope & {
  hasData: boolean;
  month?: string;
  months: TrendRow[];
  average: number | null;
  highest?: { month: string; label: string; grossPay: number } | null;
  lowest?: { month: string; label: string; grossPay: number } | null;
};

export type BridgeStepId = "joined" | "left" | "rate" | "overtime" | "attendance" | "oneoffs" | "other";

export type BridgeStep = { id: BridgeStepId; label: string; amount: number; people: number; detail: string };

export type PayrollBridge = MdEnvelope & {
  available: boolean;
  month: string | null;
  monthLabel?: string;
  previousMonth: string | null;
  previousLabel?: string;
  reason?: string;
  start?: { label: string; amount: number };
  end?: { label: string; amount: number };
  change?: Change | null;
  steps: BridgeStep[];
  sumOfSteps?: number;
  mainDriver?: { id: BridgeStepId; label: string; amount: number } | null;
  productionPeriods?: { previous: number; current: number };
  provisionalSlips?: number;
};

export type GroupLine = {
  headcount: number;
  grossPay: number;
  netPay: number;
  overtimePay: number;
  overtimeSharePct: number | null;
  costPerHead: number | null;
  lopDays: number | null;
  employerCost: number;
  sharePct: number | null;
  previous: { headcount: number; grossPay: number; costPerHead: number | null } | null;
  change: { grossPay: Change | null; costPerHead: Change | null; headcount: Change | null } | null;
};

export type DepartmentLine = GroupLine & { id: number | null; name: string; unit: string | null };
export type UnitLine = GroupLine & { id: number | null; name: string };
export type TypeLine = GroupLine & { id: "staff" | "production"; name: string };

export type PayrollDepartments = MdEnvelope & {
  hasData: boolean;
  month: string | null;
  monthLabel?: string;
  total?: Totals | null;
  departments: DepartmentLine[];
  departmentsTotal: number;
  units: UnitLine[];
  types: TypeLine[];
};

export type NetBand = {
  id: string;
  label: string;
  from: number | null;
  to: number | null;
  count: number;
  staff: number;
  production: number;
};

export type PayrollDistribution = MdEnvelope & {
  hasData: boolean;
  month: string | null;
  monthLabel?: string;
  bands: NetBand[];
  stats: {
    people: number;
    average: number;
    median: number;
    lowest: number;
    highest: number;
    belowTenThousand: number;
  } | null;
  byDesignation: { designation: string; headcount: number; grossPay: number; averageGrossPay: number | null }[];
  designationsTotal: number;
};

export type ComponentLine = {
  id: string;
  label: string;
  amount: number;
  previous: number | null;
  change: Change | null;
  sharePct: number | null;
};

export type BonusBlock = {
  financialYear: string;
  calculated: { amount: number; people: number };
  approved: { amount: number; people: number };
  paid: { amount: number; people: number };
  total: number;
  notPaid: number;
};

export type PayrollComponents = MdEnvelope & {
  hasData: boolean;
  month: string | null;
  monthLabel?: string;
  previousMonth?: string | null;
  previousLabel?: string | null;
  earnings: ComponentLine[];
  grossPay?: ComponentLine;
  deductions: ComponentLine[];
  totalDeductions?: ComponentLine;
  netPay?: ComponentLine;
  employer: ComponentLine[];
  employerCost?: ComponentLine;
  statutoryDue?: number;
  payable?: { slips: number; netPay: number };
  statutoryBonus?: BonusBlock | null;
  netGap?: number;
};

export type CountAmount = { amount: number; count: number; people: number };

export type PayrollAdvances = MdEnvelope & {
  asOf: string;
  month: string;
  monthLabel: string;
  hasData: boolean;
  outstanding: {
    amount: number;
    advances: number;
    borrowers: number;
    average: number | null;
    general: { amount: number; advances: number };
    term: { amount: number; advances: number };
  };
  newThisMonth: CountAmount;
  recoveredThisMonth: CountAmount;
  netMovement: number;
  deductedOnSlips: number;
  recoveryGap: number;
  overdue: CountAmount;
  exEmployees: { amount: number; borrowers: number };
  ageing: { label: string; amount: number; advances: number }[];
};

export type ExceptionKindId =
  "negative-net" | "duplicate-slip" | "zero-net" | "paid-zero-days" | "no-slip" | "pay-outlier" | "pay-swing";

export type ExceptionSeverity = "critical" | "warning" | "info";

export type ExceptionRow = {
  employeeId: number;
  name: string;
  code: string | null;
  department: string;
  type: "Staff" | "Production";
  kind: ExceptionKindId;
  kindLabel: string;
  severity: ExceptionSeverity;
  detail: string;
  grossPay: number | null;
  netPay: number | null;
  compare: { label: string; amount: number } | null;
  changePct: number | null;
};

export type PayrollExceptions = MdEnvelope & {
  hasData: boolean;
  month: string | null;
  monthLabel?: string;
  total: number;
  people?: number;
  shown?: number;
  matching?: number;
  counts: Partial<Record<ExceptionKindId, number>>;
  kinds: { id: ExceptionKindId; label: string; severity: ExceptionSeverity; count: number }[];
  rows: ExceptionRow[];
  thresholds: { variancePct: number; varianceMinRupees: number; outlierMultiple: number; outlierMinPeers: number };
};

export type PayrollStatus = MdEnvelope & {
  today: string;
  currentMonth: string;
  defaultMonth: string | null;
  latestClosedMonth: string | null;
  payDay: number;
  hasData: boolean;
  months: MonthStatus[];
  /** Months that have slips, newest first ("2026-09"). */
  available: string[];
};

export type AttentionItem = {
  id: string;
  severity: "critical" | "warning" | "info" | "good";
  title: string;
  detail: string;
  metric: string | null;
  page: string;
  ask: string;
};

export type PayrollAttention = MdEnvelope & { month: string | null; items: AttentionItem[] };
