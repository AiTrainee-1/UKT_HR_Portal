// production-cycles: Production Payroll by pay cycle (Weekly / BiWeekly / Monthly) and the Production Employees
// assignment. Backend: api/production_cycles.py, production_payroll_views.py, production_employee_views.py, and the period
// workflow (2026-11-16: Payroll Done / Mark as Paid per pay period, New Joiners, Moved out, moves between cycles):
// production_period_workflow.py, production_period_workflow_views.py, production_transfers.py.
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { PayrollRunItem, PayrollSkipCheckResult } from "./payroll";

// ── The three cycles ──────────────────────────────────────────────────────────

export type PayCycle = "weekly" | "biweekly" | "monthly";

export const PAY_CYCLES: readonly PayCycle[] = ["weekly", "biweekly", "monthly"];

export const PAY_CYCLE_INFO: Record<
  PayCycle,
  { label: string; weeks: number; days: number; calculation: string; path: string }
> = {
  weekly: {
    label: "Weekly",
    weeks: 1,
    days: 7,
    calculation: "One-week calculation",
    path: "/hr/production-payroll/weekly",
  },
  biweekly: {
    label: "BiWeekly",
    weeks: 2,
    days: 14,
    calculation: "Two-week calculation",
    path: "/hr/production-payroll/biweekly",
  },
  monthly: {
    label: "Monthly",
    weeks: 4,
    days: 28,
    calculation: "Four-week calculation",
    path: "/hr/production-payroll/monthly",
  },
};

export const isPayCycle = (value: unknown): value is PayCycle => PAY_CYCLES.includes(value as PayCycle);

/**
 * The weekday a cycle's weeks start on. A week is seven days and ends the day before its start weekday comes round
 * again: Monday weeks run Monday to Sunday, Wednesday weeks run Wednesday to Tuesday, Sunday weeks Sunday to Saturday.
 */
export type WeekStart = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

/** The settings of one cycle (Settings -> Production Payroll), as GET /api/payroll-settings returns them. */
export type CycleSettings = {
  /** The weekday every period of this cycle starts on (Monday until one is saved). */
  weekStart: WeekStart;
  /** The first period start the periods are counted from (moved back to the start weekday); null = not set. */
  anchorDate: string | null;
  /** Free late days a period (the shared production value while the cycle has none of its own). */
  lateFreeAllowance: number;
  lateSlabs: { fromLates: number; deductionShifts: number }[];
  /** True when the cycle has its own late rules; false when it uses the shared production ones. */
  ownLateRules: boolean;
};

export type ProdCyclesSettings = Record<PayCycle, CycleSettings>;

/** What a save may carry for one cycle. A null late value hands the cycle back to the shared late rules. */
export type CycleSettingsPatch = {
  weekStart?: CycleSettings["weekStart"];
  anchorDate?: string | null;
  lateFreeAllowance?: number | null;
  lateSlabs?: { fromLates: number; deductionShifts: number }[] | null;
};

export type ProdCyclesPatch = Partial<Record<PayCycle, CycleSettingsPatch>>;

// ── Overview of the cycles ────────────────────────────────────────────────────

export type CyclePeriod = { periodStart: string; periodEnd: string };

/**
 * Where a pay period stands (owner 2026-11-16): nothing generated yet, generated (open: HR can still generate again,
 * adjust and clear), Payroll Done (locked for good, payment pending) or Paid (Mark as Paid with the day it was paid).
 */
export type PeriodState = "not_generated" | "generated" | "finalized" | "paid";

export type CycleSummary = {
  cycle: PayCycle;
  label: string;
  days: number;
  /** Active employees assigned to the cycle. */
  assigned: number;
  /** False when the cycle's period rule is incomplete (BiWeekly / Monthly need a first period start). */
  configured: boolean;
  configError: string | null;
  weekStart: CycleSettings["weekStart"];
  anchorDate: string | null;
  next: (CyclePeriod & { periodEnded: boolean; state?: PeriodState }) | null;
  pending: { records: number; employees: number; amount: number };
  /** Workers waiting in New Joiners (any period of the cycle): in no payroll until HR adds them. */
  parked?: number;
};

export type ProductionCyclesSummary = {
  cycles: CycleSummary[];
  totalProduction: number;
  unassigned: number;
};

export const getProductionCyclesQueryKey = () => ["/api/payroll/production/cycles"] as const;

export const useProductionCycles = () =>
  useQuery<ProductionCyclesSummary>({
    queryKey: getProductionCyclesQueryKey(),
    queryFn: () => customFetch<ProductionCyclesSummary>("/api/payroll/production/cycles"),
  });

// ── Periods of one cycle ──────────────────────────────────────────────────────

export type ProductionNextPeriod = CyclePeriod & {
  cycle: PayCycle;
  label: string;
  days: number;
  periodEnded: boolean;
};

export const getProductionNextPeriodQueryKey = (cycle: PayCycle) =>
  ["/api/payroll/production/next-period", cycle] as const;

export const useProductionNextPeriod = (cycle: PayCycle) =>
  useQuery<ProductionNextPeriod>({
    queryKey: getProductionNextPeriodQueryKey(cycle),
    queryFn: () => customFetch<ProductionNextPeriod>(`/api/payroll/production/next-period?cycle=${cycle}`),
    retry: false,
  });

export type CyclePeriodRow = CyclePeriod & {
  /** The period's last day is behind us: it can be generated (from the day AFTER its last day). */
  periodEnded: boolean;
  /** The period due next: the latest generated one until it is finalized, then the one after it. */
  isNext: boolean;
  /** Payslips of this cycle that exist for the period (New Joiners included), and how many of them are Cleared. */
  generated: number;
  paid: number;
  /** Not generated / Generated / Payroll Done / Paid (absent from an older server). */
  state?: PeriodState;
  stateLabel?: string;
  /** Workers of the period waiting in New Joiners. */
  parked?: number;
};

export type ProductionPeriods = {
  cycle: PayCycle;
  label: string;
  days: number;
  /** Active employees on the cycle now. */
  roster: number;
  periods: CyclePeriodRow[];
};

export const getProductionPeriodsQueryKey = (cycle: PayCycle, around?: string | null) =>
  ["/api/payroll/production/periods", cycle, around ?? null] as const;

const fetchProductionPeriods = (cycle: PayCycle, around?: string | null) =>
  customFetch<ProductionPeriods>(`/api/payroll/production/periods?cycle=${cycle}${around ? `&around=${around}` : ""}`);

/** `around` is any date (YYYY-MM-DD): the period that holds it is added to the list, so an older period can be opened. */
export const useProductionPeriods = (cycle: PayCycle, around?: string | null) =>
  useQuery<ProductionPeriods>({
    queryKey: getProductionPeriodsQueryKey(cycle, around),
    queryFn: () => fetchProductionPeriods(cycle, around),
    retry: false,
  });

/** What several `around` lists add up to: every row they hold (the freshest answer wins) and whether any is on its way. */
export type ProductionPeriodsAround = {
  rows: CyclePeriodRow[];
  fetching: boolean;
  failed: boolean;
};

function combineAround(
  results: { data?: ProductionPeriods; dataUpdatedAt: number; isFetching: boolean; isError: boolean }[],
) {
  const answered = results.filter((r) => r.data).sort((a, b) => a.dataUpdatedAt - b.dataUpdatedAt);
  const byKey = new Map<string, CyclePeriodRow>();
  for (const r of answered) for (const row of r.data!.periods) byKey.set(`${row.periodStart}|${row.periodEnd}`, row);
  return {
    rows: [...byKey.values()],
    fetching: results.some((r) => r.isFetching),
    failed: results.some((r) => r.isError),
  } satisfies ProductionPeriodsAround;
}

/**
 * The period list asked "around" each of several dates at once (the pay-period calendar asks once for every period of
 * the months on screen that it has not seen yet). The same cache entries as `useProductionPeriods(cycle, date)`.
 */
export const useProductionPeriodsAround = (cycle: PayCycle, dates: readonly string[]): ProductionPeriodsAround =>
  useQueries({
    queries: dates.map((around) => ({
      queryKey: getProductionPeriodsQueryKey(cycle, around),
      queryFn: () => fetchProductionPeriods(cycle, around),
      retry: false,
    })),
    combine: combineAround,
  });

// ── Which days a payslip pays after a pay-cycle change (backend production_coverage.py) ──

/** A run of days, both ends included (YYYY-MM-DD). */
export type DayRange = { from: string; to: string };

/** Days of the period that another payroll of the employee already paid. */
export type AlreadyPaidPart = DayRange & {
  payrollId: number;
  /** The cycle that payroll was generated on; null for a staff month or a payroll from before the cycles. */
  cycle: PayCycle | null;
  kind: "staff" | "production";
  /** "Weekly", "Staff Payroll", or "Production Payroll" (from before the cycles). */
  label: string;
  /** "pending" | "paid" (Cleared). */
  status: string;
  periodStart: string;
  periodEnd: string;
};

/** Days before the period that no payroll paid because the employee changed cycle: added to this payslip. */
export type CatchUpPart = DayRange & {
  days: number;
  /** The cycle the employee was on before (null for Staff Payroll). */
  fromCycle: PayCycle | null;
  fromKind: "staff" | "production";
  fromLabel: string;
  afterPayrollId: number;
};

/**
 * What a payslip of one employee pays for one period. An ordinary payslip pays the whole period (`partial` false).
 * After a pay-cycle change it pays only the days no other payroll paid (`payRanges`, `alreadyPaid` names the rest),
 * plus any catch-up days (`catchUp`); `refused` = nothing is left to pay.
 */
export type PeriodCoverage = {
  periodStart: string;
  periodEnd: string;
  periodDays: number;
  /** Days of the period it pays. */
  payDays: number;
  catchUpDays: number;
  /** Every day it pays (period days + catch-up days). */
  paidDays: number;
  payRanges: DayRange[];
  alreadyPaid: AlreadyPaidPart[];
  catchUp: CatchUpPart[];
  /** Days after a payroll from before the cycles that no payroll paid: reported, never added. */
  legacyGap: CatchUpPart | null;
  partial: boolean;
  refused: boolean;
  /** The server's own sentence about it; null for an ordinary payslip. */
  note: string | null;
  /** DRAFT payslips of other periods sharing this period's days (replaced when generated with replaceDrafts). */
  drafts?: DraftPayslip[];
};

/**
 * A DRAFT payslip of another period (owner 2026-11-16): a production payslip that is only Generated -not paid, its period
 * not finalized- so it may be worked out again whenever HR likes. Generating a period that shares days with it, with
 * "replace the overlapping draft payslips", deletes it first and pays those days once, in the new period.
 */
export type DraftPayslip = {
  payrollId: number;
  cycle: PayCycle | null;
  label: string;
  periodStart: string;
  periodEnd: string;
  /** "12 Oct – 25 Oct 2026". */
  periodLabel: string;
  status: string;
  /** Marked Cleared (verified): that mark goes with the draft. */
  cleared: boolean;
  net: number | null;
};

/** One employee of a run who is paid for part of the period only, or gets catch-up days. */
export type PartialEmployee = { employeeId: number; employeeCode: string; name: string; coverage: PeriodCoverage };

/** A worker's move between pay cycles (backend production_period_workflow.move_json). */
export type CycleMove = {
  id: number;
  /** null = Unassigned. */
  fromCycle: PayCycle | null;
  fromLabel: string;
  /** The cycle the worker really came from when the move was from Unassigned (Weekly -> Unassigned -> BiWeekly). */
  cameFrom: PayCycle | null;
  cameFromLabel: string;
  toCycle: PayCycle | null;
  toLabel: string;
  changedAt: string | null;
  /** The day of the move (India). */
  changedOn: string;
  changedBy: string | null;
  reason: string;
  /** The last day any payroll had paid when the move was made, and the first day the new cycle pays. */
  lastPaidThrough: string | null;
  paysFrom: string | null;
  /** What the old cycle had paid: pay periods and net. */
  paidPeriods: number;
  paidNet: number;
};

export type PeriodEmployee = {
  employeeId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  salaryPerShift: number | null;
  /** The payslip the employee already has for the period, if any. */
  payroll: PayrollRunItem | null;
  /** Why a payslip cannot be generated for them (no rate, every day already paid elsewhere, a finalized period). */
  blockedReason: string | null;
  /** Which days their payslip pays (or would pay); absent from an older server. */
  coverage?: PeriodCoverage | null;
  /** Moved here from another cycle and this is (or will be) their first period here: parked in New Joiners. */
  movedIn?: CycleMove | null;
  /** Joined during the period (YYYY-MM-DD): parked in New Joiners. */
  joinedOn?: string | null;
  /** Draft payslips of other periods sharing this period's days: never a block, replaced on request. */
  drafts?: DraftPayslip[];
};

export type ProductionPeriodStatus = CyclePeriod & {
  cycle: PayCycle;
  label: string;
  periodEnded: boolean;
  /** Finalized with Payroll Done: nothing in it can change (absent from an older server). */
  locked?: boolean;
  state?: PeriodState;
  counts: {
    generated: number;
    paid: number;
    ready: number;
    blocked: number;
    parked?: number;
    movedIn?: number;
    newJoiners?: number;
    /** Workers with draft payslips of other periods in the way, and how many such drafts in all. */
    drafts?: number;
    draftRows?: number;
  };
  employees: PeriodEmployee[];
};

export const getProductionPeriodStatusQueryKey = (cycle: PayCycle, period: CyclePeriod | null) =>
  ["/api/payroll/production/period-status", cycle, period] as const;

export const useProductionPeriodStatus = (cycle: PayCycle, period: CyclePeriod | null) =>
  useQuery<ProductionPeriodStatus>({
    queryKey: getProductionPeriodStatusQueryKey(cycle, period),
    queryFn: () =>
      customFetch<ProductionPeriodStatus>(
        `/api/payroll/production/period-status?cycle=${cycle}&periodStart=${period!.periodStart}&periodEnd=${period!.periodEnd}`,
      ),
    enabled: !!period,
  });

// ── Skip check (dry run) and generation ───────────────────────────────────────

export type ProductionSkipCheckParams = CyclePeriod & {
  cycle: PayCycle;
  employeeIds?: number[];
  regenerate?: boolean;
};

/** A worker who moved here from another cycle, in a run: the move, and the days they are (or would be) paid for. */
export type MovedInEmployee = {
  employeeId: number;
  employeeCode: string;
  name: string;
  move: CycleMove;
  coverage: PeriodCoverage | null;
};

/** A worker who joined during the period, in a run. */
export type NewJoinerEmployee = { employeeId: number; employeeCode: string; name: string; joinedOn: string };

export type ProductionSkipCheck = PayrollSkipCheckResult &
  CyclePeriod & {
    cycle: PayCycle;
    alreadyGenerated: number;
    periodEnded?: boolean;
    /** Who would be paid for part of the period only, or get catch-up days (absent from an older server). */
    partial?: PartialEmployee[];
    /** Who moved here from another cycle / joined during the period: calculated, then parked in New Joiners. */
    movedIn?: MovedInEmployee[];
    newJoiners?: NewJoinerEmployee[];
    /** Whose draft payslips of other periods the run would replace (asked with replaceDrafts). */
    drafts?: { employeeId: number; employeeCode: string; name: string; drafts: DraftPayslip[] }[];
  };

export const getProductionSkipCheckQueryKey = (params: ProductionSkipCheckParams | null) =>
  ["/api/payroll/production/skip-check", params] as const;

export const useProductionSkipCheck = (params: ProductionSkipCheckParams | null) => {
  const qs = new URLSearchParams();
  if (params) {
    qs.set("cycle", params.cycle);
    qs.set("periodStart", params.periodStart);
    qs.set("periodEnd", params.periodEnd);
    if (params.employeeIds?.length) qs.set("employeeIds", params.employeeIds.join(","));
    if (params.regenerate) qs.set("regenerate", "1");
  }
  return useQuery<ProductionSkipCheck>({
    queryKey: getProductionSkipCheckQueryKey(params),
    queryFn: () => customFetch<ProductionSkipCheck>(`/api/payroll/production/skip-check?${qs.toString()}`),
    enabled: !!params,
  });
};

export type GenerateProductionArgs = {
  cycle: PayCycle;
  /** One of the cycle's own periods; leave both out for the next due one. */
  periodStart?: string;
  periodEnd?: string;
  /** Only these employees (they must be on the cycle's roster); leave out for the whole roster. */
  employeeIds?: number[];
  /** Recompute the payslip the employee already has ("Generate again"); one marked Cleared stays Cleared. */
  regenerate?: boolean;
  /** Replace (delete first) the draft payslips of other periods that share the period's days (2026-11-16). */
  replaceDrafts?: boolean;
};

/** A worker whose draft payslips a run replaced, and the days that now wait for their own period. */
export type ReplacedDrafts = {
  employeeId: number;
  employeeCode: string;
  name: string;
  drafts: (Omit<DraftPayslip, "label"> & { days: number })[];
  waiting: DayRange[];
  waitingText: string | null;
};

export type SkippedEmployee = { employeeId: number; employeeCode?: string; name: string; reason: string };

export type GenerateProductionResult = {
  message: string;
  cycle: PayCycle;
  periodStart: string;
  periodEnd: string;
  generated: number;
  alreadyGenerated: number;
  alreadyGeneratedDetails: { employeeId: number; employeeCode: string; name: string }[];
  skipped: number;
  skippedDetails: SkippedEmployee[];
  /** Who was paid for part of the period only, or got catch-up days (absent from an older server). */
  partialDetails?: PartialEmployee[];
  /** Parked in New Joiners: moved here from another cycle, or joined during the period. */
  movedInDetails?: MovedInEmployee[];
  newJoinerDetails?: NewJoinerEmployee[];
  /** How many of the generated payslips wait in New Joiners. */
  parked?: number;
  /** The draft payslips of other periods this run replaced (per worker), and how many in all. */
  replacedDetails?: ReplacedDrafts[];
  replaced?: number;
};

// ── The payroll rows of a cycle ───────────────────────────────────────────────

export type ProductionPayrollItem = PayrollRunItem & {
  employeeCode: string;
  bankAccount: string;
  bankIfsc: string;
  bankName: string;
  email: string;
  departmentId: number | null;
  departmentName: string | null;
  /** The cycle the row was generated on; null for rows generated before the cycles existed. */
  payCycle?: PayCycle | null;
  /** The cycle the employee is assigned to now. */
  employeePayCycle?: PayCycle | null;
  /** Why the row waits in New Joiners: joined during the period, or moved here from another cycle. */
  parkedReason?: "new_joiner" | "transfer" | null;
};

export type ListProductionPayrollParams = {
  cycle?: PayCycle;
  employeeId?: number;
  status?: string;
  /** One period: every row of it comes back (the period's whole payroll, never a first page only). */
  periodStart?: string;
  periodEnd?: string;
  limit?: number;
  /** Also the rows parked in New Joiners (left out of the records, totals and bank file otherwise). */
  includeParked?: boolean;
};

export const getListProductionPayrollQueryKey = (params?: ListProductionPayrollParams) =>
  ["/api/payroll/production", params] as const;

export const useListProductionPayroll = <TData = ProductionPayrollItem[]>(
  params?: ListProductionPayrollParams,
  options?: Partial<UseQueryOptions<ProductionPayrollItem[], unknown, TData>>,
) => {
  const qs = new URLSearchParams();
  if (params?.cycle) qs.set("cycle", params.cycle);
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.status) qs.set("status", params.status);
  if (params?.periodStart && params?.periodEnd) {
    qs.set("periodStart", params.periodStart);
    qs.set("periodEnd", params.periodEnd);
  }
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.includeParked) qs.set("includeParked", "1");
  const q = qs.toString();
  return useQuery<ProductionPayrollItem[], unknown, TData>({
    queryKey: getListProductionPayrollQueryKey(params),
    queryFn: () => customFetch<ProductionPayrollItem[]>(`/api/payroll/production${q ? `?${q}` : ""}`),
    ...options,
  });
};

// ── Production Employees: who is on which cycle ───────────────────────────────

export type ProductionEmployeeRow = {
  id: number;
  employeeCode: string;
  name: string;
  status: string;
  departmentId: number | null;
  departmentName: string | null;
  designationTitle: string | null;
  branchId: number | null;
  branchName: string | null;
  joinDate: string | null;
  salaryPerShift: number | null;
  payCycle: PayCycle | null;
  lastPayroll:
    (CyclePeriod & { status: string; payCycle: PayCycle | null; paymentStatus?: "paid" | "not_paid" }) | null;
  /** The worker's latest move between cycles (assigning from Unassigned and taking off a cycle included). */
  lastMove?: CycleMove | null;
  /** How many moves the worker has (the transfer history). */
  moveCount?: number;
};

export type ProductionEmployeeCounts = Record<PayCycle, number> & { unassigned: number; total: number };

export type ProductionEmployeesResult = {
  counts: ProductionEmployeeCounts;
  employees: ProductionEmployeeRow[];
};

export type ProductionEmployeeFilters = {
  cycle?: PayCycle | "all" | "unassigned";
  status?: "active" | "inactive" | "all";
  search?: string;
  departmentId?: number;
  branchId?: number;
};

export const getProductionEmployeesQueryKey = (filters?: ProductionEmployeeFilters) =>
  ["/api/employees/production", filters] as const;

export const useProductionEmployees = (filters?: ProductionEmployeeFilters) => {
  const qs = new URLSearchParams();
  if (filters?.cycle) qs.set("cycle", filters.cycle);
  if (filters?.status) qs.set("status", filters.status);
  if (filters?.search) qs.set("search", filters.search);
  if (filters?.departmentId) qs.set("departmentId", String(filters.departmentId));
  if (filters?.branchId) qs.set("branchId", String(filters.branchId));
  const q = qs.toString();
  return useQuery<ProductionEmployeesResult>({
    queryKey: getProductionEmployeesQueryKey(filters),
    queryFn: () => customFetch<ProductionEmployeesResult>(`/api/employees/production${q ? `?${q}` : ""}`),
    placeholderData: (previous) => previous,
  });
};

export type AssignProductionCycleResult = {
  updated: number;
  unchanged: number;
  skipped: { employeeId: number; reason: string }[];
  /** Employees who still have unpaid payroll on the cycle they just left (it stays on that cycle's page). */
  pendingOnOtherCycle: number;
  /** The moves written (one per worker who really changed cycle). */
  moves?: CycleMove[];
  counts: ProductionEmployeeCounts;
};

// ── What a move would mean for pay (the warning shown before it) ──────────────

export type CycleChangePreviewEmployee = {
  employeeId: number;
  employeeCode: string;
  name: string;
  fromCycle: PayCycle | null;
  toCycle: PayCycle | null;
  /** False when the employee is already on the target. */
  changes: boolean;
  /** True only when the employee really changes cycle AND has payroll history: nobody else is warned. Such a move needs
   *  confirm + a reason (the server answers 409 otherwise). */
  warn: boolean;
  needsConfirmation?: boolean;
  /** The last day any payroll of the worker pays, and the first day the new cycle pays. */
  paidThrough?: string | null;
  paysFrom?: string | null;
  /** What the old cycle (from Unassigned: every production payroll) paid: pay periods, net, how many marked Paid. */
  oldCycle?: {
    cycle: PayCycle | null;
    label: string;
    periods: number;
    net: number;
    paidPeriods: number;
    lastPeriodEnd: string | null;
  };
  staffMonths?: number;
  /** The new cycle's period the move is planned for, and how many days it pays there. */
  firstPeriod?: { start: string; end: string } | null;
  firstPeriodPayDays?: number;
  /** FINAL payroll only (paid, or its period finalized): up to which day, how many periods, how much. */
  finalThrough?: string | null;
  finalPeriods?: number;
  finalNet?: number;
  /** Draft payslips (only Generated) on the old cycle, and the ones the new cycle's first period would replace. */
  draftPeriods?: number;
  replacesDrafts?: DraftPayslip[];
  lastPayroll: {
    payrollId: number;
    cycle: PayCycle | null;
    kind: "staff" | "production";
    label: string;
    periodStart: string;
    periodEnd: string;
    status: string;
  } | null;
  /** The target cycle's next due period; null when taking them off a cycle or the cycle is not set up yet. */
  nextPeriod: { start: string; end: string } | null;
  payRanges: DayRange[];
  alreadyPaid: AlreadyPaidPart[];
  catchUp: CatchUpPart[];
  legacyGap: CatchUpPart | null;
  refused: boolean;
  /** The owner's sentence with the real cycles and dates; null when `warn` is false. */
  message: string | null;
};

export type CycleChangePreview = {
  cycle: PayCycle | null;
  label: string;
  nextPeriod: { start: string; end: string } | null;
  /** Why the target cycle cannot run yet (BiWeekly / Monthly need a first period start), or null. */
  configError: string | null;
  warnCount: number;
  /** Some of these workers already have payroll: the move needs confirm + a reason. */
  needsReason?: boolean;
  /** The longest reason the server keeps. */
  reasonMax?: number;
  employees: CycleChangePreviewEmployee[];
  skipped: { employeeId: number; reason: string }[];
};

export const getCycleChangePreviewQueryKey = (ids: readonly number[], cycle: PayCycle | null) =>
  ["/api/employees/production/cycle-change-preview", [...ids], cycle ?? "unassigned"] as const;

/** GET /api/employees/production/cycle-change-preview: read-only, asked while the move is being confirmed. */
export const useCycleChangePreview = (ids: readonly number[], cycle: PayCycle | null, enabled: boolean) =>
  useQuery<CycleChangePreview>({
    queryKey: getCycleChangePreviewQueryKey(ids, cycle),
    queryFn: () =>
      customFetch<CycleChangePreview>(
        `/api/employees/production/cycle-change-preview?ids=${ids.join(",")}&cycle=${cycle ?? "unassigned"}`,
      ),
    enabled: enabled && ids.length > 0,
    staleTime: 0,
    retry: false,
  });

export type AssignProductionCycleArgs = {
  employeeIds: number[];
  cycle: PayCycle | null;
  /** HR confirmed the warning (a worker who already has payroll moves only with confirm + reason). */
  confirm?: boolean;
  reason?: string;
};

export const useAssignProductionCycle = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: AssignProductionCycleArgs) =>
      customFetch<AssignProductionCycleResult>("/api/employees/production/assign", {
        method: "POST",
        body: JSON.stringify(args),
      }),
    onSuccess: () => {
      // The roster of every cycle page and the lists on this page all depend on who is assigned.
      void queryClient.invalidateQueries({
        predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0].startsWith("/api/employees") || q.queryKey[0].startsWith("/api/payroll/production")),
      });
    },
  });
};

// ── One worker's moves between cycles (Production Employees -> history) ───────

export type ProductionEmployeeTransfers = {
  employeeId: number;
  employeeCode: string;
  name: string;
  payCycle: PayCycle | null;
  /** Newest first. */
  moves: CycleMove[];
};

export const getProductionEmployeeTransfersQueryKey = (id: number) =>
  ["/api/employees/production", id, "transfers"] as const;

export const useProductionEmployeeTransfers = (id: number | null) =>
  useQuery<ProductionEmployeeTransfers>({
    queryKey: getProductionEmployeeTransfersQueryKey(id ?? 0),
    queryFn: () => customFetch<ProductionEmployeeTransfers>(`/api/employees/production/${id}/transfers`),
    enabled: !!id,
  });

// ── The period workflow: Payroll Done -> Payment pending -> Paid (owner 2026-11-16) ──

export type ProductionPeriodCounts = {
  /** Payslips of the period (New Joiners included). */
  generated: number;
  /** In the period's payroll: the records, totals, bank file and statement. */
  inPayroll: number;
  notCleared: number;
  /** Waiting in New Joiners (out of everything above until added). */
  parked: number;
  newJoiners: number;
  movedIn: number;
  addedToPayroll: number;
  /** Payment status Paid (Mark as Paid). */
  paid: number;
  notPaid: number;
  mainNet: number;
};

export type ProductionPeriodWorkflow = CyclePeriod & {
  cycle: PayCycle;
  label: string;
  periodLabel: string;
  state: PeriodState;
  stateLabel: string;
  /** Payroll Done was pressed: nothing in the period can change any more. */
  locked: boolean;
  periodEnded: boolean;
  finalizedAt: string | null;
  finalizedBy: string | null;
  paidAt: string | null;
  paidBy: string | null;
  /** The day HR said the money was paid (YYYY-MM-DD). */
  paidOn: string | null;
  daysToPay: number | null;
  firstGeneratedAt: string | null;
  lastComputedAt: string | null;
  /** In the caller's scope (a unit login sees its unit's numbers). */
  counts: ProductionPeriodCounts;
  snapshot: {
    inPayroll: number;
    notCleared: number;
    mainNet: number;
    addedToPayroll?: number;
    backfill?: boolean;
  } | null;
  /** Why Payroll Done cannot be pressed now (empty: it can), in plain words. */
  finalizeBlockers: string[];
  /** A finalized period that cannot be unlocked: why ("Paid: locked for good ..."); null otherwise. */
  unlockBlocked?: string | null;
  wholeCompany: boolean;
  can: {
    finalize: boolean;
    markPaid: boolean;
    addToPayroll: boolean;
    adjust: boolean;
    markCleared: boolean;
    generate: boolean;
    /** A finalized, unpaid period back to Generated (Payroll Done's rights; absent from an older server). */
    unlock?: boolean;
  };
  /** Mark as Paid only: how many workers it paid. */
  workersPaid?: number;
};

const periodQuery = (cycle: PayCycle, period: CyclePeriod) =>
  `cycle=${cycle}&periodStart=${period.periodStart}&periodEnd=${period.periodEnd}`;

export const getProductionPeriodWorkflowQueryKey = (cycle: PayCycle, period: CyclePeriod | null) =>
  ["/api/payroll/production/period-workflow", cycle, period] as const;

export const useProductionPeriodWorkflow = (cycle: PayCycle, period: CyclePeriod | null) =>
  useQuery<ProductionPeriodWorkflow>({
    queryKey: getProductionPeriodWorkflowQueryKey(cycle, period),
    queryFn: () =>
      customFetch<ProductionPeriodWorkflow>(`/api/payroll/production/period-workflow?${periodQuery(cycle, period!)}`),
    enabled: !!period,
    retry: false,
  });

/** A New Joiners row: the payroll (parked or already added) and why it is there. */
export type NewJoinerRow = ProductionPayrollItem & {
  parked: boolean;
  parkedReason: "new_joiner" | "transfer" | null;
  joinedOn: string | null;
  move: CycleMove | null;
  days: {
    periodDays: number;
    /** Days this payslip pays (catch-up days included). */
    eligibleDays: number;
    /** Days of the period left out because another payroll already paid them. */
    excludedDays: number;
    catchUpDays: number;
    alreadyPaid: AlreadyPaidPart[];
    catchUp: CatchUpPart[];
    shifts: number;
  };
};

export type ProductionNewJoiners = CyclePeriod & {
  cycle: PayCycle;
  locked: boolean;
  canAdd: boolean;
  /** Parked: out of the records, totals, bank file and statement until added. */
  waiting: NewJoinerRow[];
  /** Already added by HR (they stay added through every regeneration). */
  added: NewJoinerRow[];
  waitingNet: number;
};

export const getProductionNewJoinersQueryKey = (cycle: PayCycle, period: CyclePeriod | null) =>
  ["/api/payroll/production/new-joiners", cycle, period] as const;

export const useProductionNewJoiners = (cycle: PayCycle, period: CyclePeriod | null, enabled = true) =>
  useQuery<ProductionNewJoiners>({
    queryKey: getProductionNewJoinersQueryKey(cycle, period),
    queryFn: () =>
      customFetch<ProductionNewJoiners>(`/api/payroll/production/new-joiners?${periodQuery(cycle, period!)}`),
    enabled: enabled && !!period,
  });

/** A worker who moved away from a cycle (its "Moved out" view). */
export type MovedOutRow = CycleMove & {
  employeeId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  employeeStatus: string;
  currentCycle: PayCycle | null;
  /** This cycle's payroll generations since the move: shown for the first two. */
  generationsSince: number;
  hidden: boolean;
  /** Their latest payroll on this cycle (the details link). */
  lastPayroll: (CyclePeriod & { payrollId: number; status: string; paymentStatus: string; net: number }) | null;
};

export type ProductionMovedOut = {
  cycle: PayCycle;
  label: string;
  visibleGenerations: number;
  includeOlder: boolean;
  /** Older moves not listed unless "Show older" is on. */
  olderCount: number;
  moves: MovedOutRow[];
};

export const getProductionMovedOutQueryKey = (cycle: PayCycle, older: boolean) =>
  ["/api/payroll/production/moved-out", cycle, older] as const;

export const useProductionMovedOut = (cycle: PayCycle, older: boolean, enabled = true) =>
  useQuery<ProductionMovedOut>({
    queryKey: getProductionMovedOutQueryKey(cycle, older),
    queryFn: () =>
      customFetch<ProductionMovedOut>(`/api/payroll/production/moved-out?cycle=${cycle}${older ? "&older=1" : ""}`),
    enabled,
  });

const isProductionPayrollKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === "string" && key[0].startsWith("/api/payroll") && !key[0].includes("skip-check");

const postJson = <T>(url: string, body: unknown) => customFetch<T>(url, { method: "POST", body: JSON.stringify(body) });

/** Payroll Done, Mark as Paid and Add to payroll (one, several or all of a period); each refreshes the payroll on screen. */
export function useProductionPeriodActions() {
  const queryClient = useQueryClient();
  const onSuccess = () => void queryClient.invalidateQueries({ predicate: (q) => isProductionPayrollKey(q.queryKey) });
  const finalize = useMutation({
    mutationFn: ({ cycle, period }: { cycle: PayCycle; period: CyclePeriod }) =>
      postJson<ProductionPeriodWorkflow>("/api/payroll/production/period-finalize", { cycle, ...period }),
    onSuccess,
  });
  const markPaid = useMutation({
    mutationFn: ({ cycle, period, paidOn }: { cycle: PayCycle; period: CyclePeriod; paidOn: string }) =>
      postJson<ProductionPeriodWorkflow>("/api/payroll/production/period-paid", { cycle, ...period, paidOn }),
    onSuccess,
  });
  const addToPayroll = useMutation({
    mutationFn: (args: { payrollIds: number[] } | { cycle: PayCycle; period: CyclePeriod; all: true }) =>
      postJson<{ added: number; payrollIds: number[] }>(
        "/api/payroll/production/new-joiners/add",
        "payrollIds" in args ? args : { cycle: args.cycle, ...args.period, all: true },
      ),
    onSuccess,
  });
  const unlock = useMutation({
    mutationFn: ({ cycle, period, reason }: { cycle: PayCycle; period: CyclePeriod; reason: string }) =>
      postJson<ProductionPeriodWorkflow>("/api/payroll/production/period-unlock", { cycle, ...period, reason }),
    onSuccess,
  });
  return { finalize, markPaid, addToPayroll, unlock };
}

// ── One production payroll: change it, its breakdown (the production routes, production_payroll rights) ──

export type ProductionPayrollPatch = Partial<{ status: string; bonus: number; deductions: number; notes: string }>;

/** PATCH /api/payroll/production/<id>: Mark as Cleared / back to pending, bonus, deductions, notes. */
export const useUpdateProductionPayroll = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: ProductionPayrollPatch }) =>
      customFetch<PayrollRunItem>(`/api/payroll/production/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });
