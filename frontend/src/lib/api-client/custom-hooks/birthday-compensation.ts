// birthday-compensation: Birthday Compensation on a chosen date, as HR sees it (owner 2026-11-25; backend
// birthday_compensation*.py, api-database-reference.md "Compensation — Birthday Compensation on a chosen date").
//
// A birthday that is NOT worked is still paid birthday leave on the day, automatically. A birthday that IS worked (present,
// or even a half day) gives the employee 1.00 day of Birthday Compensation to place on working days of the birthday month:
// a full day, or a first / second half (the two halves may go on two different dates). Each placement is a "use" decided by
// the Department Head, then HR; HR's approval pays that day like Casual Leave. What is not placed by the end of the month
// lapses. HR can place it for an employee too ("Choose date for employee" on the Birthdays page).
//
// Every query key starts with "/api/compensation", so invalidateCompensation re-reads them with the rest of Compensation.
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import type { ApprovalProgress } from "../../approval-workflow";
import { invalidateCompensation } from "./compensation";

export type BirthdayCompPortion = "full" | "first_half" | "second_half";

/** pending (waiting for the Department Head) | pending_hr (the head approved, waiting for HR) | approved | rejected |
 *  withdrawn. */
export type BirthdayCompStatusKey = "pending" | "pending_hr" | "approved" | "rejected" | "withdrawn";
export type BirthdayCompStatus = "pending" | "approved" | "rejected" | "withdrawn";

/** One placement as every endpoint returns it (HR, the employee, the Department Head; only `canWithdraw` differs). */
export type BirthdayCompUse = {
  id: number;
  kind: "birthday_compensation";
  workflow?: string;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  departmentId: number | null;
  designation?: string | null;
  branch: string | null;
  branchId: number | null;
  employmentType?: string | null;
  birthday: string;
  birthdayText?: string | null;
  useDate: string;
  useDateText?: string | null;
  date?: string;
  weekday?: string | null;
  portion: BirthdayCompPortion;
  portionLabel: string;
  days: number;
  status: BirthdayCompStatus;
  statusKey: BirthdayCompStatusKey;
  statusLabel: string;
  reason: string | null;
  raisedByRole: "employee" | "hr";
  requestedBy: string | null;
  createdAt: string | null;
  hodReviewedBy?: string | null;
  hodReviewedAt?: string | null;
  hodReviewComment?: string | null;
  hrReviewedBy?: string | null;
  hrReviewedAt?: string | null;
  hrReviewComment?: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  withdrawnBy?: string | null;
  withdrawnAt?: string | null;
  /** HR: a pending use HR placed (the employee's own is rejected instead). */
  canWithdraw: boolean;
  approval: ApprovalProgress | null;
};

/** A use in a few words (the Birthdays list's `birthdayCompensation.uses`). */
export type BirthdayCompUseBrief = Pick<
  BirthdayCompUse,
  "id" | "useDate" | "portion" | "portionLabel" | "days" | "status" | "statusKey" | "statusLabel"
>;

/** available (some of the 1.00 still to place, the month not over) | placed (all of it waiting / approved) | lapsed (the
 *  month is over and some was never placed) | credit_claim (an open birthday CREDIT claim of the 2026-11-19 flow). */
export type BirthdayCompBlockState = "available" | "placed" | "lapsed" | "credit_claim";

/** The `birthdayCompensation` block of a Birthdays row (state null: the birthday gives nothing to place). */
export type BirthdayCompBlock = {
  state: BirthdayCompBlockState | null;
  /** "0.50 day to place by 31 Mar", "Placed: 3 Mar (first half, approved), 16 Mar (second half, pending)" ... */
  label: string | null;
  total: number;
  held: number;
  used: number;
  available: number;
  lapsed: number;
  windowFrom: string;
  lapsesOn: string;
  windowOpen: boolean;
  uses: BirthdayCompUseBrief[];
};

/** What a day of the birthday month is (the calendar of the "Choose date" dialog). */
export type BirthdayCompDayStatus =
  | "future"
  | "today"
  | "absent"
  | "on_leave"
  | "half_shift"
  | "present"
  | "holiday"
  | "birthday"
  | "off_day"
  | "not_joined"
  | "locked"
  | "casual_leave"
  | "compensation"
  | "none";

/** One day of the birthday month with the portions it can take (`selectable` = `portions` not empty). */
export type BirthdayCompDay = {
  date: string;
  /** "Tue" */
  weekday: string;
  status: BirthdayCompDayStatus | string;
  label: string;
  selectable: boolean;
  portions: BirthdayCompPortion[];
  /** The portion to preselect (the missed half of a half day). */
  suggested: BirthdayCompPortion | null;
  /** Why the day cannot be chosen, or why only some portions. */
  reason: string | null;
  /** A half day: which half was worked. */
  worked: "morning" | "evening" | string | null;
  firstPunch: string | null;
  lastPunch: string | null;
  /** A day HR set by hand: a full day only. */
  manual: boolean;
  /** The clock times of each half on that day's shift. */
  halves: { first: string; second: string } | null;
  /** The uses already on this date (pending / approved take their half; a full day takes both). */
  placed: { id: number; portion: BirthdayCompPortion; status: string }[];
};

/** available | placed | lapsed | upcoming | paid_leave | credit_claim | off_day | old_rule | not_eligible. */
export type BirthdayCompState =
  | "available"
  | "placed"
  | "lapsed"
  | "upcoming"
  | "paid_leave"
  | "credit_claim"
  | "off_day"
  | "old_rule"
  | "not_eligible";

/** GET /api/compensation/birthday-compensation?employeeId=&year=: one employee's Birthday Compensation of that year. */
export type BirthdayCompEntitlement = {
  employeeId?: number;
  employeeCode?: string;
  employeeName?: string;
  department?: string | null;
  branch?: string | null;
  birthday?: string | null;
  birthdayText?: string | null;
  weekday?: string | null;
  month?: { year: number; month: number; label: string; from: string; to: string } | null;
  state: BirthdayCompState | string;
  stateLabel?: string | null;
  message: string | null;
  worked?: boolean | null;
  dayStatus?: string | null;
  days?: { total: number; held: number; used: number; available: number; lapsed: number };
  windowOpen?: boolean;
  lapsesOn?: string | null;
  canPlace: boolean;
  /** Why nothing can be placed now (switched off, no Department Head, nothing left ...). */
  placeMessage?: string | null;
  portions?: { key: BirthdayCompPortion; label: string; days: number }[];
  uses: BirthdayCompUse[];
  eligibleDates: BirthdayCompDay[];
  creditClaim?: { id: number; status: string; shifts: number; workDate: string } | null;
  /** "Employee or HR → HOD → HR" */
  approvalPath?: string | null;
  workflowEnabled?: boolean;
  isStaff: boolean;
  enabled?: { master: boolean; birthday: boolean; workflow: boolean; canPlace: boolean };
  today?: string;
};

export type BirthdayCompListStatus =
  "all" | "pending" | "waiting_hod" | "waiting_hr" | "approved" | "rejected" | "withdrawn";

export type BirthdayCompUsesParams = {
  status?: BirthdayCompListStatus;
  month?: number;
  year?: number;
  employeeId?: number;
  departmentId?: number;
  branchId?: number;
  q?: string;
  raisedBy?: "hr" | "employee";
  page?: number;
  pageSize?: number;
};

export type BirthdayCompUsesResponse = {
  items: BirthdayCompUse[];
  total: number;
  page: number;
  pageSize: number;
  summary: {
    byStatus: Partial<Record<Exclude<BirthdayCompListStatus, "all">, number>>;
    pendingDays: number;
    approvedDays: number;
  };
  enabled?: { master: boolean; birthday: boolean; workflow: boolean; canPlace: boolean };
};

export const BIRTHDAY_COMP_PATH = "/api/compensation/birthday-compensation";
const USES_PATH = `${BIRTHDAY_COMP_PATH}/uses`;

const withParams = (path: string, params: Record<string, string | number | null | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `${path}?${text}` : path;
};

/** One employee's Birthday Compensation of `year` (the year of the birthday): the month's days, the balance and the uses. */
export const useBirthdayCompensation = (employeeId: number | null, year: number | null, enabled = true) =>
  useQuery<BirthdayCompEntitlement>({
    queryKey: [BIRTHDAY_COMP_PATH, { employeeId, year }],
    enabled: enabled && employeeId !== null,
    queryFn: () =>
      customFetch<BirthdayCompEntitlement>(withParams(BIRTHDAY_COMP_PATH, { employeeId, year: year ?? undefined })),
  });

/** The uses (newest first), with a summary by status. */
export const useBirthdayCompensationUses = (params: BirthdayCompUsesParams, enabled = true) =>
  useQuery<BirthdayCompUsesResponse>({
    queryKey: [USES_PATH, params],
    enabled,
    queryFn: () => customFetch<BirthdayCompUsesResponse>(withParams(USES_PATH, { ...params })),
  });

/** A placement or a decision changes the Birthdays list, the Requests hub and (once approved) the attendance. */
function afterChange(queryClient: QueryClient, attendance = false) {
  void invalidateCompensation(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["/api/hr-requests"] });
  if (attendance) {
    void queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/attendance"),
    });
  }
}

export type PlaceBirthdayCompInput = {
  employeeId: number;
  useDate: string;
  portion: BirthdayCompPortion;
  /** Optional, at most 500 characters. */
  reason?: string;
};

/** HR places Birthday Compensation for an employee: it goes to the Department Head, then HR (201 = the use). */
export const usePlaceBirthdayCompensation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ reason, ...rest }: PlaceBirthdayCompInput) =>
      customFetch<BirthdayCompUse>(USES_PATH, {
        method: "POST",
        body: JSON.stringify(reason?.trim() ? { ...rest, reason: reason.trim() } : rest),
      }),
    onSuccess: () => afterChange(queryClient),
  });
};

/** Withdraws a pending use HR placed (the employee's own is rejected instead). */
export const useWithdrawBirthdayCompensation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<BirthdayCompUse>(`${USES_PATH}/${id}`, { method: "DELETE" }),
    onSuccess: () => afterChange(queryClient),
  });
};

/** The address of HR's decision on a use (the Requests hub's `extra.decisionPath`). */
export const birthdayCompDecisionPath = (id: number): string => `${USES_PATH}/${id}/decision`;

/** HR's decision, after the Department Head's: the final approval pays the day; a rejection needs its reason. */
export const useDecideBirthdayCompensation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<BirthdayCompUse>(birthdayCompDecisionPath(id), {
        method: "PATCH",
        body: JSON.stringify({ status, comment: comment?.trim() || undefined }),
      }),
    onSuccess: () => afterChange(queryClient, true),
  });
};
