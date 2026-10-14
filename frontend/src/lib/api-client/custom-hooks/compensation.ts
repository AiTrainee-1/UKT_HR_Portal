// compensation: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ApprovalProgress } from "../../approval-workflow";
import type { SplitKey } from "../../salary-split";

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation -read-only CTC breakdown (Compensation.tsx)
// ═══════════════════════════════════════════════════════════════════════════

// The salary is shown as the employee's 50% + 50% split (lib/salary-split.ts): Basic, DA, Retaining Allowance | Other,
// Petrol, HRA, Special Allowance, CA. All eight are null for an employee with no monthly salary. `splitRecorded` is false
// when the split shown is the automatic one because none has been saved yet. Employer PF is worked out on the first portion.
export type CompensationRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  branch: string | null;
  employmentType: string | null;
  firstPortion: number | null;
  secondPortion: number | null;
  splitRecorded: boolean;
  employerPf: number;
  employerEsi: number;
  grossMonthly: number;
  annualCtc: number;
} & Record<SplitKey, number | null>;

export type CompensationParams = {
  departmentId?: number;
  branchId?: number;
  employmentType?: string;
  status?: string;
  search?: string;
};

export const useCompensation = (params: CompensationParams) => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  return useQuery<{ results: CompensationRow[]; count: number }>({
    queryKey: ["/api/compensation", params],
    queryFn: () => customFetch<{ results: CompensationRow[]; count: number }>(`/api/compensation?${qs.toString()}`),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Shared by everything below
// ═══════════════════════════════════════════════════════════════════════════

/** Every Compensation query key starts with a string that begins with this ("/api/compensation/ot", ".../windows" ...). */
const COMPENSATION_KEY_HEAD = "/api/compensation";

/**
 * A change to one Compensation record can change several lists (a claim approved elsewhere moves the balance, an assigned
 * relaxation moves a report), so a successful change marks every Compensation query stale; the ones on screen re-read.
 * (TanStack matches keys element by element, so a prefix of the string alone would match nothing: hence the predicate.)
 */
export const invalidateCompensation = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    predicate: (q) => {
      const head = q.queryKey[0];
      return typeof head === "string" && head.startsWith(COMPENSATION_KEY_HEAD);
    },
  });

/** The four amounts of shift compensation HR can give: a quarter, a half, three quarters or one whole shift. */
export type ShiftsValue = 0.25 | 0.5 | 0.75 | 1;

const withParams = (path: string, params: Record<string, string | number | null | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `${path}?${text}` : path;
};

// ═══════════════════════════════════════════════════════════════════════════
//  OT Detection: Type 1 (automatic next-day late-in allowance) and Type 2 (shift-based, HR assigns)
// ═══════════════════════════════════════════════════════════════════════════

/** allowance = Type 1, shift = Type 2, legacy = a record made before the overhaul (one day's pay or one credit). */
export type OvertimeType = "allowance" | "shift" | "legacy";
/** auto = Type 1 (nothing to do), detected = a Type 2 candidate, announced = assigned by HR, rejected. */
export type OvertimeStatus = "detected" | "auto" | "announced" | "rejected";
/** Type 1: used on the next working day, not used (that day has come and the employee did not need it), or not decided yet. */
export type AllowanceStatus = "used" | "not_used" | "pending";
export type OvertimeMode = "relaxation" | "pay";

export type OvertimeRow = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  date: string;
  shiftEndTime: string | null;
  lastPunchOut: string | null;
  /** True when the last punch was after midnight (`lastPunchOut` is then its clock time, e.g. "01:00"). */
  lastPunchNextDay: boolean;
  otMinutes: number;
  otType: OvertimeType;
  /** Type 1: the minutes the next working morning may use. */
  allowanceMinutes: number;
  /** Type 2: what the rule table suggests, and what HR assigned. */
  suggestedShifts: number | null;
  shifts: number | null;
  /** Type 2: the date the compensation is granted (same month as `date`). */
  claimDate: string | null;
  status: OvertimeStatus;
  statusLabel: string;
  compensationType: OvertimeMode | null;
  announcedBy: string | null;
  announcedAt: string | null;
  /** Type 1 only (null for the others): was the allowance used on the next working day? */
  allowanceUsed: boolean | null;
  /**
   * Type 1 only (null for the others): where the allowance stands. `pending` = the employee's next working day is today or
   * later, so nothing can be said yet (it must never read "not used"). An older backend does not send it.
   */
  allowanceStatus?: AllowanceStatus | null;
  usedOn: string | null;
  usedMinutes: number | null;
  /** True only for a detected Type 2 row. */
  canAssign: boolean;
};

/** What the OT list says is switched on (the server's own reading of the master switch and the Settings -> Compensation tab). */
export type OvertimeConfig = {
  masterEnabled: boolean;
  allowanceEnabled: boolean;
  shiftEnabled: boolean;
  relaxationEnabled: boolean;
  payEnabled: boolean;
  shiftMinExtraMinutes: number;
};

export type OvertimeListResponse = {
  results: OvertimeRow[];
  count: number;
  /** Kept for the old screen. */
  settings: { otDetectionEnabled: boolean; otThresholdMinutes: number; otCompensationType: OvertimeMode };
  config: OvertimeConfig;
};

export const getOvertimeListQueryKey = (month: number, year: number, status?: string) =>
  ["/api/compensation/ot", month, year, status] as const;

/** One month of OT records of every type (the page splits and filters them). Reading runs detection on the server first. */
export const useOvertimeList = (month: number, year: number, status?: string) =>
  useQuery<OvertimeListResponse>({
    queryKey: getOvertimeListQueryKey(month, year, status),
    queryFn: () => {
      const qs = new URLSearchParams({ month: String(month), year: String(year) });
      if (status) qs.set("status", status);
      return customFetch<OvertimeListResponse>(`/api/compensation/ot?${qs.toString()}`);
    },
  });

export type OvertimeAssignRecord = {
  employeeId: number;
  /** The OT day. */
  date: string;
  shifts?: ShiftsValue;
  /** The date it is granted: the same month as `date`. Needed for Relaxation, optional for Pay. */
  claimDate?: string | null;
};

export type OvertimeAssignBody = {
  records: OvertimeAssignRecord[];
  mode: OvertimeMode;
  shifts?: ShiftsValue;
  claimDate?: string | null;
};

/** A record the server could not assign, with the reason in a plain sentence. */
export type OvertimeSkipped = { employeeId: number | null; date: string | null; reason: string };

export type OvertimeAssignResult = { assigned: number; results: OvertimeRow[]; skipped: OvertimeSkipped[] };

/**
 * HR assigns Type 2 compensation (Relaxation or Payment) to detected rows. A record that cannot be assigned comes back in
 * `skipped` and the others still go through; when NOTHING could be assigned the server answers 400 with the same
 * `skipped` list in the error body (`ApiError.data`).
 */
export const useAssignOvertime = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OvertimeAssignBody) =>
      customFetch<OvertimeAssignResult>("/api/compensation/ot/assign", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

/** The LEGACY announce endpoint (kept for old clients): the page no longer uses it. */
export const useAnnounceOvertime = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { records: { employeeId: number; date: string }[]; compensationType?: OvertimeMode }) =>
      customFetch<{ announced: number; results: OvertimeRow[] }>("/api/compensation/ot/announce", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

export const useRejectOvertime = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { records: { employeeId: number; date: string }[] }) =>
      customFetch<{ rejected: number }>("/api/compensation/ot/reject", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation balance (shifts): credits from approved Sunday / holiday work, redemptions by HR
// ═══════════════════════════════════════════════════════════════════════════

export type BalanceEntryType = "credit" | "debit";

export type BalanceEntry = {
  /** null for a legacy Alternative-Day credit that has not been used (it lives in its own table). */
  id: number | null;
  type: BalanceEntryType;
  shifts: number;
  date: string;
  /** holiday_work | legacy_credit | redemption | ot_shift */
  source: string;
  note: string | null;
  createdBy: string | null;
  createdAt: string | null;
  /** false for the debit that only mirrors a legacy credit being used (it is not taken off the balance twice). */
  counted: boolean;
  legacyCreditId?: number;
};

export type BalanceRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  balance: number;
};

export type BalanceDetail = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  balance: number;
  entries: BalanceEntry[];
};

export const getBalancesQueryKey = () => ["/api/compensation/balance", "all"] as const;

/** Every staff employee that has a balance or any entry on the ledger. */
export const useCompensationBalances = () =>
  useQuery<{ results: BalanceRow[]; count: number }>({
    queryKey: getBalancesQueryKey(),
    queryFn: () => customFetch<{ results: BalanceRow[]; count: number }>("/api/compensation/balance"),
  });

/** One employee's balance and every entry behind it. Idle until an employee is chosen. */
export const useCompensationBalance = (employeeId: number | null) =>
  useQuery<BalanceDetail>({
    queryKey: ["/api/compensation/balance", employeeId],
    queryFn: () => customFetch<BalanceDetail>(`/api/compensation/balance?employeeId=${employeeId}`),
    enabled: employeeId !== null,
  });

export type RedeemBody = { employeeId: number; date: string; shifts: ShiftsValue };
export type RedeemResult = { entry: BalanceEntry; balance: number };

/** HR redeems part of an employee's balance on a date (the day is topped up by that much). Employees never redeem. */
export const useRedeemBalance = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RedeemBody) =>
      customFetch<RedeemResult>("/api/compensation/balance/redeem", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Legacy Alternative-Day credits (before the overhaul): each counts as one shift in the balance
// ═══════════════════════════════════════════════════════════════════════════

export type CompensationCreditRow = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  status: "available" | "used";
  usedDate: string | null;
  sourceDate: string | null;
  createdAt: string | null;
};

export const useCompensationCredits = (params: { employeeId?: number; status?: string } = {}) =>
  useQuery<{ results: CompensationCreditRow[]; count: number }>({
    queryKey: ["/api/compensation/credits", params],
    queryFn: () => customFetch(withParams("/api/compensation/credits", params)),
  });

/** The old one-credit redeem (a whole day on a date). The balance's redeem replaces it on the page. */
export const useRedeemCompensationCredit = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, date }: { id: number; date: string }) =>
      customFetch(`/api/compensation/credits/${id}/redeem`, { method: "POST", body: JSON.stringify({ date }) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation Leave A: company-announced late-in / early-out windows
// ═══════════════════════════════════════════════════════════════════════════

/** late_in / early_out are the new windows; day is an older "Compensation Day" exemption (it still acts, HR cannot add more). */
export type WindowKind = "late_in" | "early_out" | "day";

export type CompensationWindow = {
  id: number;
  date: string;
  kind: WindowKind;
  kindLabel: string;
  /** The announced time (HH:MM): the latest arrival for late-in, the earliest leaving time for early-out. */
  time: string | null;
  reason: string | null;
  branchId: number | null;
  branch: string | null;
  departmentId: number | null;
  department: string | null;
  employeeIds: number[];
  employeeCount: number;
  /** How many active staff it covers. */
  covers: number;
  allStaff: boolean;
  announcedBy: string | null;
  createdAt: string | null;
  /** A future date HR may remove. */
  canDelete: boolean;
};

export type CompensationWindowsResponse = {
  results: CompensationWindow[];
  count: number;
  truncated: boolean;
  /** The server's today (India), YYYY-MM-DD. */
  today: string;
  enabled: { master: boolean; windows: boolean; canAnnounce: boolean };
};

export type CompensationWindowsParams = {
  /** windows (default: late-in + early-out) | late_in | early_out | day | all */
  kind?: string;
  month?: number;
  year?: number;
  upcoming?: boolean;
};

export const useCompensationWindows = (params: CompensationWindowsParams = {}) =>
  useQuery<CompensationWindowsResponse>({
    queryKey: ["/api/compensation/windows", params],
    queryFn: () =>
      customFetch<CompensationWindowsResponse>(
        withParams("/api/compensation/windows", {
          kind: params.kind,
          month: params.month,
          year: params.year,
          upcoming: params.upcoming ? 1 : undefined,
        }),
      ),
  });

export type CreateWindowBody = {
  date: string;
  kind: "late_in" | "early_out";
  time: string;
  reason: string;
  branchId?: number | null;
  departmentId?: number | null;
  employeeIds?: number[];
};

export const useCreateCompensationWindow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateWindowBody) =>
      customFetch<CompensationWindow>("/api/compensation/windows", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

export const useDeleteCompensationWindow = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/compensation/windows/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation Leave B: work on Sundays and company holidays (HR raises, the Department Head approves)
// ═══════════════════════════════════════════════════════════════════════════

export type HolidayWorkStatus = "pending" | "approved" | "rejected";
export type HolidayDayKind = "sunday" | "holiday";

export type HolidayWorkEnabled = { master: boolean; holidayWork: boolean; workflow: boolean; canRaise: boolean };

export type HolidayWorkClaim = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  designation: string | null;
  branch: string | null;
  branchId: number | null;
  employmentType: string | null;
  workDate: string;
  dayKind: HolidayDayKind;
  holidayName: string | null;
  shifts: number;
  reason: string;
  status: HolidayWorkStatus;
  requestedBy: string | null;
  reviewedBy: string | null;
  reviewComment: string | null;
  reviewedAt: string | null;
  createdAt: string | null;
  /** The Department Head who decides it (null when the employee has none). */
  hodName: string | null;
  /** True once the shifts were added to the employee's balance. */
  credited: boolean;
  approval: ApprovalProgress | null;
};

export type HolidayWorkListResponse = {
  results: HolidayWorkClaim[];
  count: number;
  truncated: boolean;
  /** null (with `year`) when every month was asked for (`anyMonth`). */
  month: number | null;
  year: number | null;
  summary: { pending: number; approved: number; rejected: number; approvedShifts: number; pendingShifts: number };
  enabled: HolidayWorkEnabled;
};

export type HolidayWorkParams = {
  /** all | pending | approved | rejected */
  status?: string;
  month?: number;
  year?: number;
  /** Every month of every year (when no month or year is given): the list of what is still waiting, whenever it was worked. */
  anyMonth?: boolean;
  employeeId?: number;
  departmentId?: number;
  branchId?: number;
};

export const useHolidayWorkClaims = (params: HolidayWorkParams = {}) =>
  useQuery<HolidayWorkListResponse>({
    queryKey: ["/api/compensation/holiday-work", params],
    queryFn: () =>
      customFetch<HolidayWorkListResponse>(
        withParams("/api/compensation/holiday-work", { ...params, anyMonth: params.anyMonth ? 1 : undefined }),
      ),
  });

export type HolidayWorkEligibleEmployee = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  designation: string | null;
  branch: string | null;
  branchId: number | null;
  employmentType: string | null;
  punchCount: number;
  firstPunch: string | null;
  lastPunch: string | null;
  spanMinutes: number | null;
  attendanceStatus: string | null;
  eligible: boolean;
  /** Why this person cannot be claimed for (an open claim, no punches ...). */
  reason: string | null;
  claim: { id: number; status: HolidayWorkStatus; shifts: number } | null;
};

export type HolidayWorkEligibleResponse = {
  date: string;
  dayKind: HolidayDayKind | null;
  holidayName: string | null;
  /** False for a weekday, a future date or one older than `maxAgeDays`: `message` says why and `employees` is empty. */
  claimable: boolean;
  message: string | null;
  maxAgeDays: number;
  earliestDate: string;
  enabled: HolidayWorkEnabled;
  counts: { worked: number; eligible: number };
  employees: HolidayWorkEligibleEmployee[];
};

/** Who worked on a Sunday / holiday, with their punches, so HR can pick them. Idle until a date is chosen. */
export const useHolidayWorkEligible = (date: string) =>
  useQuery<HolidayWorkEligibleResponse>({
    queryKey: ["/api/compensation/holiday-work/eligible", date],
    queryFn: () =>
      customFetch<HolidayWorkEligibleResponse>(withParams("/api/compensation/holiday-work/eligible", { date })),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  });

export type RaiseHolidayWorkBody = {
  workDate: string;
  reason: string;
  items: { employeeId: number; shifts: ShiftsValue }[];
};

/** Why one employee of a request could not be claimed for (the request is all-or-nothing, so nothing was raised). */
export type HolidayWorkProblem = { employeeId: number; error: string };

export type RaiseHolidayWorkResult = { created: number; warnings: string[]; claims: HolidayWorkClaim[] };

export const useRaiseHolidayWork = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: RaiseHolidayWorkBody) =>
      customFetch<RaiseHolidayWorkResult>("/api/compensation/holiday-work", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

/** Withdraws a claim that is still waiting for the Department Head. */
export const useWithdrawHolidayWork = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/compensation/holiday-work/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Compensation Leave C: birthdays (paid leave for the whole day, automatic)
// ═══════════════════════════════════════════════════════════════════════════

export type ReportPeriod = "today" | "week" | "month";

export type BirthdayRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  designation: string | null;
  branch: string | null;
  branchId: number | null;
  employmentType: string | null;
  /** The day it is celebrated this period (the birth year is never sent). */
  birthday: string;
  weekday: string;
  /** Does the employee get the paid birthday leave on that day? `reason` says why not when they do not. */
  benefits: boolean;
  reason: string | null;
  attendanceStatus: string | null;
  /** The day's attendance carries the birthday marker. */
  applied: boolean;
  compensationKind: string | null;
  firstPunch: string | null;
  lastPunch: string | null;
  shiftsEarned: number | null;
};

export type BirthdaysResponse = {
  period: ReportPeriod;
  date: string;
  from: string;
  to: string;
  enabled: { master: boolean; birthday: boolean; effectiveFrom: string | null };
  count: number;
  benefitCount: number;
  results: BirthdayRow[];
};

export type BirthdaysParams = { period: ReportPeriod; date?: string; departmentId?: number; branchId?: number };

export const useCompensationBirthdays = (params: BirthdaysParams) =>
  useQuery<BirthdaysResponse>({
    queryKey: ["/api/compensation/birthdays", params],
    queryFn: () => customFetch<BirthdaysResponse>(withParams("/api/compensation/birthdays", { ...params })),
  });

// ═══════════════════════════════════════════════════════════════════════════
//  History & Reports: who benefited from each type of compensation, Today / Week / Month
// ═══════════════════════════════════════════════════════════════════════════

export type ReportType =
  | "ot_allowance"
  | "ot_shift_relaxation"
  | "ot_shift_pay"
  | "window_late_in"
  | "window_early_out"
  | "holiday_work"
  | "birthday";

/** Every row of every type has exactly these keys (unused ones are null), so one export serves every section. */
export type ReportRow = {
  type: ReportType;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  designation: string | null;
  branch: string | null;
  branchId: number | null;
  employmentType: string | null;
  /** The date the row is filed under (what the period filters on). */
  date: string | null;
  /** The day of the extra work / holiday work. */
  workDate: string | null;
  /** The day the benefit was used. */
  usedOn: string | null;
  /** The announced window time. */
  time: string | null;
  firstPunch: string | null;
  lastPunch: string | null;
  minutes: number | null;
  minutesUsed: number | null;
  /** Minutes worked past the shift end (Type 1 and Type 2 rows; null elsewhere). An older backend does not send it. */
  extraMinutes?: number | null;
  /** The next-day allowance in minutes (Type 1 rows; null elsewhere). An older backend does not send it. */
  allowanceMinutes?: number | null;
  shifts: number | null;
  status: string | null;
  statusLabel: string | null;
  amount: number | null;
  amountEstimated: boolean;
  assignedBy: string | null;
  approvedBy: string | null;
  grantedOn: string | null;
  reason: string | null;
  detail: string;
};

/** The counts and totals of one section: the keys differ per type (see history/history-logic.ts for each). */
export type ReportSummary = Record<string, number>;

export type ReportSection = {
  type: ReportType;
  label: string;
  /** Is this type acting right now (the master switch and its own switch in Settings are both on)? */
  enabled: boolean;
  summary: ReportSummary;
  rows: ReportRow[];
  /** holiday_work only: the balance redeemed inside the period. */
  redemptions?: ReportRow[];
};

export type CompensationReport = {
  period: ReportPeriod;
  date: string;
  from: string;
  to: string;
  filters: { departmentId: number | null; branchId: number | null };
  types: ReportType[];
  rowKeys: string[];
  totals: { rows: number; employees: number };
  sections: ReportSection[];
};

export type ReportParams = {
  period: ReportPeriod;
  date?: string;
  /** One type, or undefined for all of them. */
  type?: ReportType;
  departmentId?: number;
  branchId?: number;
};

export const useCompensationReport = (params: ReportParams) =>
  useQuery<CompensationReport>({
    queryKey: ["/api/compensation/reports", params],
    queryFn: () => customFetch<CompensationReport>(withParams("/api/compensation/reports", { ...params })),
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Legacy: Compensation-Day exemptions and the cost summary of the old OT flow
// ═══════════════════════════════════════════════════════════════════════════

export type CompensationLeaveDayRow = {
  id: number;
  date: string;
  leaveUntilTime: string | null;
  branch: string | null;
  department: string | null;
  employeeIds: number[];
  employeeCount: number;
  reason: string | null;
  announcedBy: string | null;
  createdAt: string | null;
};

export const useCompensationLeaveDays = (params: { month?: number; year?: number } = {}) =>
  useQuery<{ results: CompensationLeaveDayRow[]; count: number }>({
    queryKey: ["/api/compensation/leave-days", params],
    queryFn: () => customFetch(withParams("/api/compensation/leave-days", params)),
  });

export const useCreateCompensationLeaveDay = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      date: string;
      leaveUntilTime?: string | null;
      branchId?: number | null;
      departmentId?: number | null;
      employeeIds?: number[];
      reason?: string;
    }) => customFetch("/api/compensation/leave-days", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

export const useDeleteCompensationLeaveDay = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/compensation/leave-days/${id}`, { method: "DELETE" }),
    onSuccess: () => invalidateCompensation(queryClient),
  });
};

export type CompensationBenefitRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  type: "pay" | "relaxation";
  date: string;
  detail: string;
};

export type CompensationSummaryResponse = {
  month: number;
  year: number;
  paidCost: number;
  pendingCostEstimate: number;
  benefiting: CompensationBenefitRow[];
  notBenefiting: CompensationBenefitRow[];
};

export const useCompensationSummary = (month: number, year: number) =>
  useQuery<CompensationSummaryResponse>({
    queryKey: ["/api/compensation/summary", month, year],
    queryFn: () => customFetch<CompensationSummaryResponse>(`/api/compensation/summary?month=${month}&year=${year}`),
  });
