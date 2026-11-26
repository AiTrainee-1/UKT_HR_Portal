// requests: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { UseQueryOptions } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ApprovalProgress } from "../../approval-workflow";

export type EmployeeRequest = {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  requestType: string;
  subject: string;
  description: string;
  status: "pending" | "in_review" | "approved" | "rejected" | "more_info";
  hrNotes?: string | null;
  handledBy?: string | null;
  handledAt?: string | null;
  createdAt?: string | null;
};

export type AdvanceRepaymentItem = {
  id: number;
  advanceId: number;
  month: number;
  year: number;
  amount: number;
  paymentMethod: "cash" | "gpay" | "payroll";
  isProcessed: boolean;
  payrollRunId?: number | null;
  notes?: string | null;
  createdAt?: string | null;
};

export type Advance = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  employeeDepartment?: string | null;
  employeeDesignation?: string | null;
  employeePhone?: string | null;
  employeeEmail?: string | null;
  advanceType: "general" | "term";
  amount: number;
  purpose: string;
  status: "pending" | "approved" | "rejected" | "closed";
  approvedBy?: string | null;
  approvedAt?: string | null;
  disbursedAt?: string | null;
  repaymentStartMonth?: number | null;
  repaymentStartYear?: number | null;
  repaymentMonths?: number | null;
  emiAmount: number;
  totalRepaid: number;
  outstanding: number;
  notes?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  repayments?: AdvanceRepaymentItem[];
  /** HR's remark on the approval / rejection ("" when none; 2026-11-20). Required on a rejection, and on an approval of
   *  another amount than was asked for. Sent on the PUT that decides. */
  decisionRemark?: string;
  /** When the advance was last approved / rejected (older rows: null, approvedAt then says it). */
  decidedAt?: string | null;
  /** The months of its deduction schedule, "YYYY-MM" (the Settlement page's month filter). */
  scheduleMonths?: string[];
  /** Every approval / rejection / reopening, newest first (the detail endpoint only). */
  history?: AdvanceDecisionItem[];
  /** "Salary Advance" | "Term Loan" (2026-11-26). */
  typeLabel?: string;
  /** The salary earned from the 1st to the 20th of the month the advance was raised in, as kept on it (2026-11-26);
   *  null for a production employee or when it has not been worked out yet. */
  earnings?: AdvanceEarnings | null;
  /** Why HR recorded a Salary Advance above the 50 % earned limit ("" when it was not above it). */
  limitRemark?: string;
  /** The employee's bank details, for the Settlement page's bank file (HR's list only; 2026-11-26). */
  bankAccount?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
};

/** The salary earned from the 1st to the 20th of a month (advance_earnings.earnings_json / Earnings.to_json). */
export type AdvanceEarnings = {
  month: number;
  year: number;
  throughDay: number;
  /** "YYYY-MM-DD" of the last day counted (the preview only). */
  through?: string;
  /** The monthly fixed salary. */
  fixedSalary: number | null;
  dailyRate?: number;
  companyDays?: number;
  /** Working Days: the paid days of the 1st-20th = present shifts + company holidays (owner 2026-11-26). */
  workingDays: number;
  /** The split of workingDays (servers since 2026-11-26): days worked (a half day 0.5) and company holidays. */
  presentShifts?: number;
  holidayDays?: number;
  /** Present shifts + paid holidays (= workingDays). */
  paidDays: number;
  earnedAmount: number;
  /** = earnedAmount (the kept figures only). */
  workingSalary?: number;
  percent: number;
  /** 50 % of the earned amount, whole rupees down: the Salary Advance limit. */
  limit: number | null;
  workedOutOn?: string | null;
};

/** The Term Loan's 6-month service check (advance_earnings.term_loan_service). */
export type TermLoanService = {
  eligible: boolean;
  joinDate: string | null;
  serviceMonths: number | null;
  requiredMonths: number;
  eligibleFrom: string | null;
  reason: string | null;
};

/** GET /api/advances/earnings?employeeId= (2026-11-26): the New Salary Advance / Term Loan dialog's figures. */
export type AdvanceEarningsPreview = {
  employeeId: number;
  employeeType: string;
  month: number;
  year: number;
  throughDay: number;
  percent: number;
  earnings: AdvanceEarnings | null;
  /** Why there are no figures (a production employee, or no salary recorded). */
  noSalaryReason: string | null;
  termLoanService: TermLoanService;
};

/** One decision on an advance, as GET /api/advances/<id> lists them in `history` (settlement_views.decision_json). */
export type AdvanceDecisionItem = {
  id: number;
  action: "approved" | "rejected" | "reopened";
  requestedAmount: number | null;
  approvedAmount: number | null;
  startMonth: number | null;
  startYear: number | null;
  remark: string;
  by: string;
  at: string | null;
};
export const getListEmployeeRequestsQueryKey = (params?: Record<string, string>) =>
  ["/api/employee-requests", params] as const;
export const getListAdvancesQueryKey = (params?: Record<string, string>) => ["/api/advances", params] as const;

// ── Employee Requests ─────────────────────────────────────────────────────────

export const listEmployeeRequests = (params?: { requestType?: string; status?: string }) => {
  const qs = new URLSearchParams();
  if (params?.requestType) qs.set("requestType", params.requestType);
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString();
  return customFetch<EmployeeRequest[]>(`/api/employee-requests${q ? `?${q}` : ""}`);
};

export const useListEmployeeRequests = <TData = EmployeeRequest[]>(
  params?: { requestType?: string; status?: string },
  options?: UseQueryOptions<EmployeeRequest[], unknown, TData>,
) =>
  useQuery<EmployeeRequest[], unknown, TData>({
    queryKey: getListEmployeeRequestsQueryKey(params as Record<string, string>),
    queryFn: () => listEmployeeRequests(params),
    ...options,
  });

export const useEmployeeRequestAction = () =>
  useMutation({
    mutationFn: ({
      id,
      status,
      hrNotes,
      handledBy,
    }: {
      id: number;
      status: string;
      hrNotes?: string;
      handledBy?: string;
    }) =>
      customFetch<{ id: number; status: string }>(`/api/employee-requests/${id}/action`, {
        method: "PUT",
        body: JSON.stringify({ status, hrNotes, handledBy }),
      }),
  });

// ── Advances ──────────────────────────────────────────────────────────────────

export const listAdvances = (params?: { advanceType?: string; status?: string }) => {
  const qs = new URLSearchParams();
  if (params?.advanceType) qs.set("advanceType", params.advanceType);
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString();
  return customFetch<Advance[]>(`/api/advances${q ? `?${q}` : ""}`);
};

export const useListAdvances = <TData = Advance[]>(
  params?: { advanceType?: string; status?: string },
  options?: UseQueryOptions<Advance[], unknown, TData>,
) =>
  useQuery<Advance[], unknown, TData>({
    queryKey: getListAdvancesQueryKey(params as Record<string, string>),
    queryFn: () => listAdvances(params),
    ...options,
  });

export const useCreateAdvance = () =>
  useMutation({
    mutationFn: (data: {
      employeeId: number;
      advanceType: string;
      amount: number;
      purpose?: string;
      emiAmount?: number;
      repaymentMonths?: number;
      repaymentStartMonth?: number;
      repaymentStartYear?: number;
      notes?: string;
      /** Why HR records a Salary Advance above the 50 % earned limit (required then: 400 over_limit without it). */
      limitRemark?: string;
    }) =>
      customFetch<Advance>("/api/advances", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useDeleteAdvance = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/advances/${id}`, { method: "DELETE" }),
  });

export const useUpdateAdvance = () =>
  useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Advance> }) =>
      customFetch<Advance>(`/api/advances/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const getAdvanceDetailQueryKey = (id: number) => ["advance-detail", id];

export const useAdvanceDetail = (id: number | null) =>
  useQuery({
    queryKey: getAdvanceDetailQueryKey(id ?? 0),
    queryFn: () => customFetch<Advance>(`/api/advances/${id}`),
    enabled: id !== null && id > 0,
  });

export const getAdvanceEarningsQueryKey = (employeeId: number) => ["/api/advances/earnings", employeeId] as const;

/** The salary an employee earned this month from the 1st to the 20th, the Salary Advance limit and the Term Loan's service
 *  check, for the New Salary Advance / Term Loan dialog. */
export const useAdvanceEarnings = (employeeId: number | null) =>
  useQuery({
    queryKey: getAdvanceEarningsQueryKey(employeeId ?? 0),
    queryFn: () => customFetch<AdvanceEarningsPreview>(`/api/advances/earnings?employeeId=${employeeId}`),
    enabled: employeeId !== null && employeeId > 0,
    staleTime: 60_000,
  });

export const useCreateAdvanceRepayment = () =>
  useMutation({
    mutationFn: ({
      advanceId,
      data,
    }: {
      advanceId: number;
      data: {
        month: number;
        year: number;
        amount: number;
        paymentMethod?: string;
        notes?: string;
      };
    }) =>
      customFetch<{ repayment: AdvanceRepaymentItem; advance: Advance }>(`/api/advances/${advanceId}/repayments`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

// ── Employee Permissions ───────────────────────────────────────────────────────

// The 3 permission types the API knows, as the slugs it sends and accepts.
export type PermissionType = "morning_late_in" | "evening_early_out" | "middle_permission";
// The pre-rewrite spelling of the same 3 types. The rewritten backend accepts either spelling, an older backend
// accepts only this one (a slug is a 400), and the two roll out at different moments -so requests send this spelling.
export type PermissionWireType = "Late In" | "Early Out" | "Short Leave";
// within_cap: an Allowed one (moves that day's boundary); excess: approved but beyond the monthly cap, so it does not.
export type PermissionCapStatus = "within_cap" | "excess" | "not_applicable";

export type PermissionItem = {
  id: number;
  employeeId: number;
  employeeName: string;
  employeeCode: string;
  department?: string | null;
  designation?: string | null;
  date: string;
  permissionTime?: string | null;
  reason?: string | null;
  // DEPRECATED spelling ("Late In" / "Early Out" / "Short Leave", or null) kept for older clients -use typeKey/typeLabel.
  type?: string | null;
  // null = an untyped request (older web-app submissions) that HR has not classified yet.
  typeKey?: PermissionType | null;
  typeLabel?: string | null;
  // Always 60 for a new request; an older row can hold its original 30/45/90.
  durationMinutes?: number | null;
  status: string;
  capStatus?: PermissionCapStatus;
  // "Pending" | "Allowed" | "Not Allowed" | "Overdue / Excess"
  statusLabel?: string;
  hrComment?: string | null;
  approvedBy?: string | null;
  approverRole?: string | null;
  createdAt?: string | null;
  // Only on the response to creating one: pending + approved permissions that calendar month.
  monthlyUsed?: number | null;
  // The HR-editable monthly cap (Settings → Late Detection → Permission Policy).
  monthlyLimit: number;
  /** Where the request is in its approval pipeline and who can act on it (see lib/approval-workflow.ts). */
  approval?: ApprovalProgress | null;
};

export const getListPermissionsQueryKey = (params?: {
  employeeId?: number;
  status?: string;
  month?: number;
  year?: number;
}) => ["/api/permissions", params] as const;

export const useListPermissions = <TData = PermissionItem[]>(
  params?: { employeeId?: number; status?: string; month?: number; year?: number },
  options?: UseQueryOptions<PermissionItem[], unknown, TData>,
) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.status) qs.set("status", params.status);
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  const q = qs.toString();
  return useQuery<PermissionItem[], unknown, TData>({
    queryKey: getListPermissionsQueryKey(params),
    queryFn: () => customFetch<PermissionItem[]>(`/api/permissions${q ? `?${q}` : ""}`),
    ...options,
  });
};

export const useCreatePermission = () =>
  useMutation({
    // No duration: every permission is a fixed 60 minutes and the server ignores whatever is sent.
    // type: the legacy spelling -see PermissionWireType (permissionTypeWire converts from the slug).
    mutationFn: (data: {
      employeeId: number;
      date: string;
      type: PermissionWireType;
      permissionTime?: string;
      reason?: string;
      status?: string;
    }) =>
      customFetch<PermissionItem>("/api/permissions", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const useUpdatePermissionStatus = () =>
  useMutation({
    // approvedBy is never client-sendable -it's always server-derived from
    // the logged-in HR user (a client-supplied name could be spoofed).
    // type lets HR classify an untyped request (or fix a mis-picked one) --
    // it decides whether an approval can shift a shift boundary at all.
    mutationFn: ({
      id,
      data,
    }: {
      id: number;
      data: { status?: string; hrComment?: string; type?: PermissionWireType };
    }) =>
      customFetch<PermissionItem>(`/api/permissions/${id}`, {
        method: "PUT",
        body: JSON.stringify(data),
      }),
  });

export const useDeletePermission = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/permissions/${id}`, { method: "DELETE" }),
  });

export const useDeleteLeaveRequest = () =>
  useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/leave-requests/${id}`, { method: "DELETE" }),
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Casual Leave (CL)
// ═══════════════════════════════════════════════════════════════════════════

export type CasualLeaveItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  date: string;
  reason?: string | null;
  status: "pending" | "approved" | "rejected";
  reviewedBy?: string | null;
  reviewerRole?: string | null;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  createdAt?: string | null;
  /** Where the request is in its approval pipeline and who can act on it (see lib/approval-workflow.ts). */
  approval?: ApprovalProgress | null;
  /** Full day or one half of the shift (2026-10-31); absent / "full" on older rows. */
  portion?: "full" | "first_half" | "second_half";
  portionLabel?: string;
};

export type CasualLeaveEligibility = {
  month: number;
  year: number;
  eligibilityMonths: number;
  employees: {
    employeeId: number;
    employeeCode: string;
    employeeName: string;
    department?: string | null;
    designation?: string | null;
    joinDate?: string | null;
    serviceMonths: number | null;
    eligible: boolean;
    reason?: string | null;
    usedThisMonth: boolean;
    usedStatus?: string | null;
    usedDate?: string | null;
  }[];
};

/**
 * An employee's Casual Leave balance for a calendar year (2026-11-02): 12 days a year, a half day counts 0.5, waiting
 * requests hold their days, a rejected one gives them back; unused days lapse on 31 December. `tracked` is false (and
 * `since` null) for a year wholly before the cut-over day, when no balance was kept.
 */
export type CasualLeaveBalance = {
  /** What has been given so far: carried in + every month's days up to the month shown (the year's days at once with
   *  the yearly allocation). */
  total: number;
  used: number;
  pending: number;
  /** What may still be asked for now (this month's, with the monthly allocation). */
  remaining: number;
  year: number;
  since: string | null;
  endsOn: string;
  cutOver: string;
  tracked: boolean;
  // added 2026-11-21 (Settings -> Casual Leave); absent on an older server
  /** The month the figures are for (YYYY-MM). */
  asOf?: string;
  allocation?: "monthly" | "yearly";
  perMonth?: number | null;
  perYear?: number | null;
  carriedIn?: number;
  carryForward?: boolean;
  yearEnd?: "lapse" | "carry";
  leftAtYearEnd?: number;
};

/** One line of an employee's Casual Leave year, oldest first: "12 → 11 on 05 Nov: Casual Leave approved (Full day, 05 Nov 2026)". */
export type CasualLeaveHistoryEntry = {
  /** "allocated" = a month's days given, "month_lapsed" = a month's unused days ending with it (no carry forward),
   *  "carried_out" = unused days moved into the next year (all added 2026-11-21, Settings -> Casual Leave). */
  kind: "opening" | "allocated" | "approved" | "pending" | "rejected" | "month_lapsed" | "carried_out" | "lapsed";
  on: string;
  date: string | null;
  portion: "full" | "first_half" | "second_half" | null;
  portionLabel: string | null;
  days: number | null;
  change: number;
  balanceBefore: number | null;
  balanceAfter: number;
  requestId: number | null;
  requestKind: "casual_leave" | "attendance_correction" | null;
  /** "hr_assign" (2026-11-04): Casual Leave HR gave for an absent / leave day on the Carry Forward tab. */
  source: "employee" | "hr_edit" | "hr_assign" | null;
  status: string | null;
  text: string;
};

export type CasualLeaveHistory = {
  employeeId: number;
  year: number;
  total: number;
  balance: CasualLeaveBalance;
  entries: CasualLeaveHistoryEntry[];
};

/** GET /api/casual-leaves/history: an employee's Casual Leave year as a running balance (HR passes the employee). */
export const useCasualLeaveHistory = (employeeId: number | null, year: number, enabled = true) =>
  useQuery<CasualLeaveHistory>({
    queryKey: ["/api/casual-leaves/history", employeeId, year],
    queryFn: () => customFetch<CasualLeaveHistory>(`/api/casual-leaves/history?employeeId=${employeeId}&year=${year}`),
    enabled: enabled && employeeId !== null,
  });

export const getCasualLeavesQueryKey = () => ["/api/casual-leaves"] as const;

export const useListCasualLeaves = (params?: { status?: string; month?: number; year?: number }, enabled = true) => {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.month) qs.set("month", String(params.month));
  if (params?.year) qs.set("year", String(params.year));
  const q = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery<CasualLeaveItem[]>({
    queryKey: ["/api/casual-leaves", params?.status ?? null, params?.month ?? null, params?.year ?? null],
    queryFn: () => customFetch<CasualLeaveItem[]>(`/api/casual-leaves${q}`),
    enabled,
  });
};

export const useCasualLeaveEligibility = (month: number, year: number) =>
  useQuery<CasualLeaveEligibility>({
    queryKey: ["/api/casual-leaves/eligibility", month, year],
    queryFn: () => customFetch<CasualLeaveEligibility>(`/api/casual-leaves/eligibility?month=${month}&year=${year}`),
  });

export const useCreateCasualLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      employeeId: number;
      date: string;
      reason?: string;
      portion?: "full" | "first_half" | "second_half";
    }) =>
      customFetch<CasualLeaveItem>("/api/casual-leaves", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/history"] });
    },
  });
};

export const useDecideCasualLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<CasualLeaveItem>(`/api/casual-leaves/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/employee-monthly"] });
    },
  });
};

export const useDeleteCasualLeave = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<{ ok: boolean }>(`/api/casual-leaves/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getCasualLeavesQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/eligibility"] });
      queryClient.invalidateQueries({ queryKey: ["/api/casual-leaves/history"] });
    },
  });
};
