// production-cycles: Production Payroll by pay cycle (Weekly / BiWeekly / Monthly) and the Production Employees
// assignment. Backend: api/production_cycles.py, production_payroll_views.py, production_employee_views.py.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
  next: (CyclePeriod & { periodEnded: boolean }) | null;
  pending: { records: number; employees: number; amount: number };
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
  periodEnded: boolean;
  /** The period Generate would pay by default. */
  isNext: boolean;
  /** Payslips of this cycle that exist for the period, and how many of them are paid. */
  generated: number;
  paid: number;
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

/** `around` is any date (YYYY-MM-DD): the period that holds it is added to the list, so an older period can be opened. */
export const useProductionPeriods = (cycle: PayCycle, around?: string | null) =>
  useQuery<ProductionPeriods>({
    queryKey: getProductionPeriodsQueryKey(cycle, around),
    queryFn: () =>
      customFetch<ProductionPeriods>(
        `/api/payroll/production/periods?cycle=${cycle}${around ? `&around=${around}` : ""}`,
      ),
    retry: false,
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
};

/** One employee of a run who is paid for part of the period only, or gets catch-up days. */
export type PartialEmployee = { employeeId: number; employeeCode: string; name: string; coverage: PeriodCoverage };

export type PeriodEmployee = {
  employeeId: number;
  employeeCode: string;
  name: string;
  departmentName: string | null;
  salaryPerShift: number | null;
  /** The payslip the employee already has for the period, if any. */
  payroll: PayrollRunItem | null;
  /** Why a payslip cannot be generated for them (no rate, or every day of the period is already paid elsewhere). */
  blockedReason: string | null;
  /** Which days their payslip pays (or would pay); absent from an older server. */
  coverage?: PeriodCoverage | null;
};

export type ProductionPeriodStatus = CyclePeriod & {
  cycle: PayCycle;
  label: string;
  periodEnded: boolean;
  counts: { generated: number; paid: number; ready: number; blocked: number };
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

export type ProductionSkipCheck = PayrollSkipCheckResult &
  CyclePeriod & {
    cycle: PayCycle;
    alreadyGenerated: number;
    /** Who would be paid for part of the period only, or get catch-up days (absent from an older server). */
    partial?: PartialEmployee[];
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
};

export const useGenerateProductionPayroll = () =>
  useMutation({
    mutationFn: (args: GenerateProductionArgs) =>
      customFetch<GenerateProductionResult>("/api/payroll/production/generate", {
        method: "POST",
        body: JSON.stringify(args),
      }),
  });

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
};

export type ListProductionPayrollParams = {
  cycle?: PayCycle;
  employeeId?: number;
  status?: string;
  periodStart?: string;
  periodEnd?: string;
  limit?: number;
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
  lastPayroll: (CyclePeriod & { status: string; payCycle: PayCycle | null }) | null;
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
  /** True only when the employee really changes cycle AND has payroll history: nobody else is warned. */
  warn: boolean;
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

export const useAssignProductionCycle = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: { employeeIds: number[]; cycle: PayCycle | null }) =>
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
