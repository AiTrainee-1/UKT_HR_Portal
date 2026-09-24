// payroll: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ── Salary Slips ──────────────────────────────────────────────────────────────

export type SlipLeaveBalance = {
  leaveType: string;
  leaveCode: string;
  allocated: number;
  used: number;
  remaining: number;
};

export type SalarySlipItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  departmentName?: string | null;
  designationTitle?: string | null;
  fatherName?: string;
  motherName?: string;
  joinDate?: string;
  pfNumber?: string;
  esiNumber?: string;
  bankAccount?: string;
  bankIfsc?: string;
  bankName?: string;
  employmentType?: string;
  payrollRunId?: number | null;
  month: number;
  year: number;
  weekNumber?: number | null;
  slipNumber: string;
  basic: number;
  hra: number;
  allowances: number;
  incentives: number;
  bonuses: number;
  otAmount: number;
  grossSalary: number;
  pfDeduction: number;
  esiDeduction: number;
  advanceDeduction: number;
  otherDeductions: number;
  totalDeductions: number;
  netSalary: number;
  workingDays: number;
  presentDays: number;
  absentDays: number;
  paidLeaveDays: number;
  unpaidLeaveDays: number;
  lateDays: number;
  completedSessions: number;
  leaveBalances?: SlipLeaveBalance[];
  breakdownDetails?: PayrollBreakdown | null;
  // Company/slip settings (injected by backend)
  slipCompanyName?: string;
  slipCompanyAddress?: string;
  minWageRate?: number;
  signatureImage?: string;
  generatedAt?: string | null;
  emailedAt?: string | null;
};

// ── Payroll Breakdown (full traceability) ─────────────────────────────────────

export type PayrollBreakdownDay = {
  date: string;
  day: string;
  // staff-only fields
  status?: "present" | "absent" | "paid_leave" | "unpaid_leave";
  isLate?: boolean;
  // Set only when isLate/half-shift-late is true — the specific rule and
  // times that fired it, e.g. "Late morning (Without Permission): arrived
  // 09:40, deadline 09:15". See AttendanceDayRecord.late_reason.
  lateReason?: string | null;
  // True when the day's lateness is specifically a Without Permission
  // occurrence (see Settings → Late Detection) rather than ordinary Late
  // Attendance — lateReason explains which.
  withoutPermission?: boolean;
  isHalfShift?: boolean;
  shiftsCompleted?: number;
  firstIn?: string | null;
  lastOut?: string | null;
  leaveType?: string | null;
  // production-only fields (legacy session-based payroll)
  sessions?: { sessionId: number; sessionName: string; completed: boolean; rate: number }[];
  totalSessions?: number;
  sessionAmount?: number;
  present?: boolean;
  // production-only fields (current shift-based payroll)
  shiftsEarned?: number;
  firstPunch?: string | null;
  lastPunch?: string | null;
};

export type PayrollBreakdown = {
  type: "staff" | "production";
  // Which attendance calculation produced this payroll (strict | simple)
  attendanceMode?: "strict" | "simple" | null;
  simpleHalfShiftCutoff?: string | null;
  shiftPunctualityWindowMinutes?: number | null;
  // staff
  shift?: {
    id?: number | null;
    name: string;
    startTime: string;
    gracePeriodMinutes: number;
    saturdayOff: boolean;
  };
  // production
  weekNumber?: number;
  dateFrom?: string;
  dateTo?: string;
  // legacy session-based payroll only
  sessionConfigs?: {
    id: number;
    name: string;
    startTime: string;
    endTime: string;
    minCheckout: string;
    rate: number;
  }[];
  // current shift-based payroll only
  salaryPerShift?: number;
  days: PayrollBreakdownDay[];
  summary: {
    // staff
    totalWorkingDays?: number;
    presentDays?: number;
    paidLeaveDays?: number;
    unpaidLeaveDays?: number;
    absentDays?: number;
    lateDays?: number;
    withoutPermissionDays?: number;
    halfShiftDays?: number;
    fullShiftDays?: number;
    effectivePaidDays?: number;
    // production
    totalDays?: number;
    daysWorked?: number;
    daysAbsent?: number;
    totalSessions?: number;
    totalShifts?: number;
  };
  earnings: {
    monthlySalary?: number;
    dailyRate?: number;
    effectiveDays?: number;
    basic?: number;
    hra?: number;
    allowances?: number;
    grossSalary: number;
    totalSessions?: number;
    totalShifts?: number;
    salaryPerShift?: number;
  };
  deductions: {
    pf?: number;
    pfRate?: number;
    esi?: number;
    esiRate?: number;
    // Salary-range rule applied to production PF/EF (null/absent = flat rates)
    pfEfRule?: { label: string; pfRate: number; efRate: number } | null;
    advances: number;
    advanceDetails: { advanceId: number; repaymentId: number; amount: number; notes?: string | null }[];
    lateShiftPenalty?: number;
    lateSummary?: {
      totalLateCount: number;
      permissionsUsed: number;
      billableLateCount: number;
      shiftDeductions: number;
    } | null;
    withoutPermissionPenalty?: number;
    withoutPermissionSummary?: {
      totalCount: number;
      freeAllowanceUsed: number;
      billableCount: number;
      shiftDeductions: number;
    } | null;
    total: number;
  };
  netSalary: number;
};

export type PayrollBreakdownResponse = {
  payrollId: number;
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType: string;
    salary: number;
  };
  month: number;
  year: number;
  weekNumber?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  salaryMode: string;
  status: string;
  summary: {
    grossSalary: number;
    deductions: number;
    bonus: number;
    netSalary: number;
  };
  breakdown: PayrollBreakdown | null;
};

export const getListSalarySlipsQueryKey = (params?: {
  employeeId?: number;
  month?: number;
  year?: number;
  weekNumber?: number;
  employmentType?: string;
}) => ["/api/salary-slips", params] as const;

export const useListSalarySlips = <TData = SalarySlipItem[]>(
  params?: { employeeId?: number; month?: number; year?: number; weekNumber?: number; employmentType?: string },
  options?: UseQueryOptions<SalarySlipItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  if (params?.weekNumber) qs.set("weekNumber", String(params.weekNumber));
  if (params?.employmentType) qs.set("employmentType", params.employmentType);
  const q = qs.toString();
  return useQuery<SalarySlipItem[], unknown, TData>({
    queryKey: getListSalarySlipsQueryKey(params),
    queryFn: () => customFetch<SalarySlipItem[]>(`/api/salary-slips${q ? `?${q}` : ""}`),
    ...options,
  });
};

// ── Payroll Runs ──────────────────────────────────────────────────────────────

export type PayrollRunItem = {
  id: number;
  employeeId: number;
  employeeName?: string | null;
  employeeCode?: string | null;
  email?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
  departmentId?: number | null;
  departmentName?: string | null;
  salaryMode: string;
  month: number;
  year: number;
  weekNumber?: number | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
  completedSessions?: number | null;
  otHours: number;
  otAmount: number;
  baseSalary: number;
  grossSalary: number;
  deductions: number;
  bonus: number;
  finalSalary: number;
  status: string;
  notes?: string | null;
  createdAt?: string | null;
};

export const getListPayrollRunsQueryKey = (params?: {
  employeeId?: number;
  month?: number;
  year?: number;
  status?: string;
}) => ["/api/payroll", params] as const;

export const useListPayrollRuns = <TData = PayrollRunItem[]>(
  params?: { employeeId?: number; month?: number; year?: number; status?: string },
  options?: UseQueryOptions<PayrollRunItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString();
  return useQuery<PayrollRunItem[], unknown, TData>({
    queryKey: getListPayrollRunsQueryKey(params),
    queryFn: () => customFetch<PayrollRunItem[]>(`/api/payroll${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useGeneratePayroll = () =>
  useMutation({
    mutationFn: (data: {
      month: number;
      year: number;
      runType?: "monthly" | "biweekly" | "all";
      weekNumber?: number;
    }) =>
      customFetch<{
        message: string;
        generated: number;
        skipped: number;
        skippedDetails: { employeeId: number; name: string; reason: string }[];
      }>("/api/payroll/generate", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

// ── Payroll Skip Check (read-only, on-demand -no generation required) ─────

export type PayrollSkipReason = {
  employeeId: number;
  employeeCode: string;
  name: string;
  reason: string;
};

export type PayrollSkipCheckResult = {
  totalChecked: number;
  skippedCount: number;
  skipped: PayrollSkipReason[];
};

export const getPayrollSkipCheckQueryKey = (params: {
  month: number;
  year: number;
  runType: "monthly" | "biweekly";
  weekNumber?: number;
}) => ["/api/payroll/skip-check", params] as const;

export const usePayrollSkipCheck = (
  params: { month: number; year: number; runType: "monthly" | "biweekly"; weekNumber?: number } | null,
) => {
  const qs = new URLSearchParams();
  if (params) {
    qs.set("month", String(params.month));
    qs.set("year", String(params.year));
    qs.set("runType", params.runType);
    if (params.weekNumber) qs.set("weekNumber", String(params.weekNumber));
  }
  return useQuery<PayrollSkipCheckResult>({
    queryKey: getPayrollSkipCheckQueryKey(params ?? { month: 0, year: 0, runType: "monthly" }),
    queryFn: () => customFetch<PayrollSkipCheckResult>(`/api/payroll/skip-check?${qs.toString()}`),
    enabled: !!params,
  });
};

// ── Payroll Generation Progress ─────────────────────────────────────────────

export type PayrollGenerateProgress = {
  stage: "idle" | "running" | "completed";
  total: number;
  completed: number;
  generated: number;
  skipped: number;
  currentEmployee: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const useGeneratePayrollProgress = (enabled: boolean) =>
  useQuery<PayrollGenerateProgress>({
    queryKey: ["/api/payroll/generate-progress"],
    queryFn: () => customFetch<PayrollGenerateProgress>("/api/payroll/generate-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    // The pipeline only cares about the freshest snapshot -never serve a stale one.
    staleTime: 0,
  });

// ── Salary Slip Bulk Download/Email Progress ──────────────────────────────────

export type SalarySlipBulkProgress = {
  stage: "idle" | "running" | "completed";
  kind: "pdf" | "email" | null;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentEmployee: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export const useSalarySlipBulkProgress = (enabled: boolean) =>
  useQuery<SalarySlipBulkProgress>({
    queryKey: ["/api/salary-slips/bulk-progress"],
    queryFn: () => customFetch<SalarySlipBulkProgress>("/api/salary-slips/bulk-progress"),
    enabled,
    refetchInterval: enabled ? 600 : false,
    staleTime: 0,
  });

export type SalarySlipBulkEmailResult = {
  ok: boolean;
  sent: number;
  failed: number;
  failures: { employeeName: string; employeeCode: string; error: string }[];
};

// ── Production Payroll (period-driven, fully separate from Staff Payroll) ─────
// Periods come entirely from Settings → Payroll → Production
// (PayrollSettingsItem.prodPeriod*); these endpoints never take a
// month/year/weekNumber input -only an optional explicit periodStart/
// periodEnd pair for backfilling a past period.

export type ProductionNextPeriod = {
  periodStart: string;
  periodEnd: string;
  periodEnded: boolean;
  frequency: PayrollSettingsItem["prodPeriodFrequency"];
  style: PayrollSettingsItem["prodPeriodStyle"];
};

export const getProductionNextPeriodQueryKey = () => ["/api/payroll/production/next-period"] as const;

export const useProductionNextPeriod = () =>
  useQuery<ProductionNextPeriod>({
    queryKey: getProductionNextPeriodQueryKey(),
    queryFn: () => customFetch<ProductionNextPeriod>("/api/payroll/production/next-period"),
  });

export const getProductionSkipCheckQueryKey = (params: { periodStart: string; periodEnd: string } | null) =>
  ["/api/payroll/production/skip-check", params] as const;

export const useProductionSkipCheck = (params: { periodStart: string; periodEnd: string } | null) => {
  const qs = new URLSearchParams();
  if (params) {
    qs.set("periodStart", params.periodStart);
    qs.set("periodEnd", params.periodEnd);
  }
  return useQuery<PayrollSkipCheckResult & { periodStart: string; periodEnd: string }>({
    queryKey: getProductionSkipCheckQueryKey(params),
    queryFn: () =>
      customFetch<PayrollSkipCheckResult & { periodStart: string; periodEnd: string }>(
        `/api/payroll/production/skip-check?${qs.toString()}`,
      ),
    enabled: !!params,
  });
};

export const useGenerateProductionPayroll = () =>
  useMutation({
    mutationFn: (data?: { periodStart: string; periodEnd: string }) =>
      customFetch<{
        message: string;
        periodStart: string;
        periodEnd: string;
        generated: number;
        skipped: number;
        skippedDetails: { employeeId: number; name: string; reason: string }[];
      }>("/api/payroll/production/generate", {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
  });

export type ProductionPayrollItem = PayrollRunItem & {
  employeeCode: string;
  bankAccount: string;
  bankIfsc: string;
  bankName: string;
  email: string;
  departmentId: number | null;
  departmentName: string | null;
};

export const getListProductionPayrollQueryKey = (params?: { employeeId?: number; status?: string; limit?: number }) =>
  ["/api/payroll/production", params] as const;

export const useListProductionPayroll = <TData = ProductionPayrollItem[]>(
  params?: { employeeId?: number; status?: string; limit?: number },
  options?: UseQueryOptions<ProductionPayrollItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.status) qs.set("status", params.status);
  if (params?.limit) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return useQuery<ProductionPayrollItem[], unknown, TData>({
    queryKey: getListProductionPayrollQueryKey(params),
    queryFn: () => customFetch<ProductionPayrollItem[]>(`/api/payroll/production${q ? `?${q}` : ""}`),
    ...options,
  });
};

// ── Session Configs ───────────────────────────────────────────────────────────

export type SessionConfigItem = {
  id: number;
  name: string;
  startTime: string;
  endTime: string;
  minimumCheckoutTime?: string | null;
  payAmount: number;
  isOvertime: boolean;
  order: number;
};

export const getSessionConfigsQueryKey = () => ["/api/session-configs"] as const;

export const useSessionConfigs = () =>
  useQuery<SessionConfigItem[]>({
    queryKey: getSessionConfigsQueryKey(),
    queryFn: () => customFetch<SessionConfigItem[]>("/api/session-configs"),
  });

export const useCreateSessionConfig = () =>
  useMutation({
    mutationFn: (data: {
      name: string;
      startTime: string;
      endTime: string;
      minimumCheckoutTime?: string | null;
      payAmount: number;
      isOvertime?: boolean;
      order?: number;
    }) =>
      customFetch<SessionConfigItem>("/api/session-configs", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdateSessionConfig = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<SessionConfigItem> }) =>
      customFetch<SessionConfigItem>(`/api/session-configs/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteSessionConfig = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/session-configs/${id}`, { method: "DELETE" }),
  });

// ── Payroll Settings (singleton -PF/ESI rates) ───────────────────────────────

export type PayrollSettingsItem = {
  // Company profile -drives branding across the whole portal
  companyName: string;
  companyTagline: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string;
  companyGstin: string;
  companyPan: string;
  companyAddress: string;
  companyRegistration: string;
  // Staff deductions
  pfRate: number;
  esiRate: number;
  esiApplicableBelow: number;
  // Production deductions
  prodPfRate: number;
  prodEsiRate: number;
  prodEsiApplicableBelow: number;
  // Compensation (CTC breakdown -does not affect payroll generation)
  basicPercent: number;
  hraPercent: number;
  // Statutory Bonus (Payment of Bonus Act)
  bonusPercent: number;
  bonusWageCeiling: number;
  bonusEligibilityCeiling: number;
  bonusFyStartMonth: number;
  // OT / Compensation (Compensation page's OT detection + announce)
  otDetectionEnabled?: boolean;
  otThresholdMinutes?: number;
  otCompensationType?: "pay" | "relaxation";
  // General
  payDay: number;
  productionPayType: string;
  defaultSalaryPerShift?: number;
  // Production Payroll period configuration (Settings → Payroll → Production)
  prodPeriodFrequency: "weekly" | "2weeks" | "3weeks" | "monthly";
  prodPeriodStyle: "calendar_month" | "weekday_anchored" | "custom_recurring";
  prodPeriodWeekdayAnchor?: "mon_sat" | "sun_sat" | null;
  prodPeriodAnchorDate?: string | null;
  prodPeriodCustomDays?: number | null;
  // Production attendance mode + Late Detection (Settings → Payroll → Production)
  prodAttendanceMode: "simple" | "strict";
  prodLateDetectionEnabled?: boolean;
  prodLateFreeAllowance?: number;
  prodLateDeductionSlabs?: { fromLates: number; deductionShifts: number }[];
  // Salary slip header & signature
  slipCompanyName: string;
  slipCompanyAddress: string;
  minWageRate: number;
  signatureImage: string | null;
  // Resignation letter assets
  companyLogo: string | null;
  authorizedSignature: string | null;
  // Attendance calculation mode
  attendanceMode: "strict" | "simple";
  simpleHalfShiftCutoff: string;
  simpleGraceMinutes: number;
  shiftPunctualityWindowMinutes: number;
  lastPunchPostShiftGraceHours: number;
  firstPunchPreShiftBufferHours: number;
  // Production attendance windows (1.5-shift day)
  prodFirstHalfStart: string;
  prodFirstHalfEnd: string;
  prodSecondHalfStart: string;
  prodSecondHalfEnd: string;
  prodExtraStart: string;
  prodExtraEnd: string;
  // Half Shift late reference (staff) -a Half Shift day is only additionally
  // flagged Late when the first punch is strictly after this time.
  halfShiftLateReferenceTime?: string;
  // Auto-Permission zone (arrival/departure) -extra minutes past
  // shiftPunctualityWindowMinutes during which a punch is auto-detected as
  // Permission instead of Half Shift.
  permissionWindowMinutes?: number;
  // Afternoon (Night Late) lunch-return zone -strict mode only.
  afternoonLateWindowMinutes?: number;
  afternoonPermissionWindowMinutes?: number;
  afternoonLateCanCauseHalfShift?: boolean;
  // Defaults pre-filled into a NEW shift; Manage Shift still owns the real
  // per-shift times (including start/end), so these never retro-change
  // existing shifts.
  defaultShiftGraceMinutes?: number;
  defaultShiftFirstHalfEnd?: string;
  defaultShiftLunchDurationMinutes?: number;
  defaultShiftLunchGraceMinutes?: number;
  // Late Detection policy -lates and approved permissions share one pool.
  lateFreeAllowance?: number;
  lateDeductionSlabs?: { fromLates: number; deductionShifts: number }[];
  // Permission policy -separate pool: Permission-zone edges (morning,
  // afternoon, departure) with no approved request covering them.
  withoutPermissionFreeAllowance?: number;
  withoutPermissionDeductionSlabs?: { fromLates: number; deductionShifts: number }[];
  // Daily/weekly caps on the auto-detected Permission zone.
  maxPermissionsPerDay?: number;
  maxPermissionsPerWeek?: number;
  prodPfEfEnabled?: boolean;
  prodPfEfRules: { label: string; minSalary: number; maxSalary: number; pfRate: number; efRate: number }[];
  // Feature toggles (Settings master switches)
  staffPayrollRulesEnabled?: boolean;
  prodPayrollRulesEnabled?: boolean;
  compensationFeatureEnabled?: boolean;
  // Backup
  backupDirectory?: string;
  // SMTP / Email
  smtpHost: string;
  smtpPort: number;
  smtpUsername: string;
  smtpPassword: string;
  smtpFromEmail: string;
  smtpFromName: string;
  updatedAt: string | null;
};

export const getPayrollSettingsQueryKey = () => ["/api/payroll-settings"] as const;

export const usePayrollSettings = () =>
  useQuery<PayrollSettingsItem>({
    queryKey: getPayrollSettingsQueryKey(),
    queryFn: () => customFetch<PayrollSettingsItem>("/api/payroll-settings"),
  });

export const useUpdatePayrollSettings = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<PayrollSettingsItem>) =>
      customFetch<PayrollSettingsItem>("/api/payroll-settings", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getPayrollSettingsQueryKey() });
    },
  });
};
