// compensation-placement: compensation days on a date HR CHOOSES (owner brief 2026-11-28; backend compensation_placement.py
// and compensation_placement_views.py, api-database-reference.md "Compensation days on a chosen date").
//
// HR places Shift compensation (a Type 2 OT record still waiting), Sunday / Holiday work compensation (a day off worked, not
// claimed yet), an approved credit (Sunday / holiday work, OT shift credit, an older birthday credit) or the balance as a
// whole on a working day picked on a calendar, like Birthday Compensation's "Choose date for employee". Every date goes to the
// employee's Department Head first, then HR. A day up to 45 days back (only when it can still take part of a shift) or up to
// 90 days ahead; nothing lapses (what is not placed stays in the balance).
//
// Every query key starts with "/api/compensation", so invalidateCompensation re-reads them with the rest of Compensation.
import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { invalidateCompensation } from "./compensation";
import { normalizeClaim, type CompensationClaim } from "./compensation-claims";

/** What is placed: a Type 2 OT record, a day off worked, an approved credit claim, or the balance as a whole. */
export type PlacementSourceType = "overtime" | "holiday_work" | "claim" | "balance";

/** shift = a Type 2 OT record, overtime = an OT shift credit, sunday / holiday = a day off worked, birthday = an older
 *  birthday credit, balance = the balance as a whole. */
export type CompType = "shift" | "overtime" | "sunday" | "holiday" | "birthday" | "balance";

/** The source as the server reads it ({type, id?, date?}), or its string form ("overtime:12", "claim:40", "balance"). */
export type PlacementSourceKey = { type: PlacementSourceType; id?: number; date?: string };

/** The `source` block of the calendar: what it gives, what is already placed and what can still be placed now. */
export type PlacementSource = PlacementSourceKey & {
  compType: CompType;
  /** "Sunday compensation", "Shift compensation" ... */
  compTypeLabel: string;
  /** "Sunday worked on Sun 22 Nov 2026" */
  title: string;
  /** The day worked / the OT day (null for the balance). */
  workDate: string | null;
  claimId: number | null;
  overtimeRecordId: number | null;
  /** What the source gives (the balance: what is available). */
  total: number;
  /** Already placed from it (waiting or approved). */
  placed: number;
  /** What can be placed now (capped by the available balance for a claim / the balance). */
  left: number;
  /** false only for a day off worked: HR chooses the credit (creditShifts 0.25..1.00, 1.00 by default). */
  creditFixed: boolean;
  /** true for overtime / holiday_work: the credit and the day go in one request. */
  placesAtOnce: boolean;
  canPlace: boolean;
  /** Why nothing can be placed (shown; the calendar stays readable). */
  refusal: string | null;
  /** not_approved | nothing_left | already_claimed | not_eligible | switched_off | too_old ... */
  refusalCode: string | null;
};

export type PlacementDayStatus =
  | "future"
  | "today"
  | "absent"
  | "half_shift"
  | "present"
  | "on_leave"
  | "holiday"
  | "off_day"
  | "locked"
  | "out_of_window"
  | "not_joined"
  | "placed"
  | "casual_leave"
  | "birthday_comp"
  | "none";

/** stage "hod" = waiting for the Department Head, "hr" = the head approved, waiting for HR (null once decided). */
export type PlacementStage = "hod" | "hr" | null;

/** A placement already on a day of the calendar. */
export type PlacementOnDay = {
  id: number;
  shifts: number;
  status: string;
  stage: PlacementStage;
  hrStep: boolean;
  compType: CompType | string;
  compTypeLabel: string;
};

/** One day of the calendar month and what it can take now. */
export type PlacementDay = {
  date: string;
  /** "Wed" */
  weekday: string;
  status: PlacementDayStatus | string;
  /** "Still to come", "Sunday", the holiday's name, "Payroll Done", "Absent" ... */
  label: string;
  selectable: boolean;
  /** What the day can still take (before what is left to place). */
  room: number;
  /** What can be placed on it now (<= room and <= left); [] when it cannot be chosen. */
  amounts: number[];
  /** The amount to preselect (as much as fits). */
  suggested: number | null;
  /** Why it cannot be chosen, or a note ("This day already earns 0.50 shift: at most 0.50 can be added."). */
  reason: string | null;
  /** The shifts the day earns now / will earn (null when unknown). */
  earns: number | null;
  firstPunch: string | null;
  lastPunch: string | null;
  manual: boolean;
  placed: PlacementOnDay[];
};

/** One of the employee's OPEN placements in the window (any source, whoever placed them), soonest first. */
export type PlacementItem = {
  id: number;
  date: string;
  shifts: number;
  status: string;
  /** "Waiting for the Department Head", "Approved by the Department Head, waiting for HR", "Approved: given on ..." */
  statusLabel: string;
  stage: PlacementStage;
  hrStep: boolean;
  /** use_balance | holiday_work | ot_shift */
  kind: string;
  compType: CompType | string;
  compTypeLabel: string;
  sourceClaimId: number | null;
  workDate: string | null;
  raisedByRole: "hr" | "employee" | string;
  requestedBy: string | null;
  reason: string | null;
  canWithdraw: boolean;
};

/** GET /api/compensation/placements/calendar: one employee's month for placing from one source. */
export type PlacementCalendar = {
  employee: {
    employeeId: number;
    employeeCode: string;
    employeeName: string;
    department: string | null;
    departmentId: number | null;
    designation?: string | null;
    branch: string | null;
    branchId: number | null;
  };
  source: PlacementSource;
  balance: { earned: number; used: number; pending: number; available: number; balance: number };
  window: { from: string; to: string; backDays: number; aheadDays: number };
  today: string;
  /** prev / next: null outside the window. */
  month: { key: string; label: string; first: string; last: string; prev: string | null; next: string | null };
  amounts: number[];
  days: PlacementDay[];
  placements: PlacementItem[];
  /** "HR → HOD → HR" */
  approvalPath: string | null;
  workflowOn: boolean;
  /** A sentence when the employee has no Department Head who may approve compensation (POST answers 409 no_hod). */
  hodProblem: string | null;
  reasonMax: number;
};

export const PLACEMENTS_PATH = "/api/compensation/placements";
const CALENDAR_PATH = `${PLACEMENTS_PATH}/calendar`;

export type PlacementCalendarParams = {
  employeeId: number | null;
  /** YYYY-MM; null = the current month. */
  month: string | null;
  /** The string form: "balance", "claim:40", "overtime:12", "holiday_work:2026-11-22". */
  source: string;
};

export const getPlacementCalendarQueryKey = (params: PlacementCalendarParams) => [CALENDAR_PATH, params] as const;

/** One employee's calendar month for placing compensation from `source`. Idle until there is an employee. */
export const usePlacementCalendar = (params: PlacementCalendarParams, options: { enabled?: boolean } = {}) =>
  useQuery<PlacementCalendar>({
    queryKey: getPlacementCalendarQueryKey(params),
    enabled: (options.enabled ?? true) && params.employeeId !== null && params.source !== "",
    // a month switch keeps the month on screen until the next one is in (no flash of the loader inside the dialog)
    placeholderData: keepPreviousData,
    queryFn: () => {
      const qs = new URLSearchParams({ employeeId: String(params.employeeId), source: params.source });
      if (params.month) qs.set("month", params.month);
      return customFetch<PlacementCalendar>(`${CALENDAR_PATH}?${qs.toString()}`);
    },
  });

/** A placement or a decision changes Compensation (claims, balance, OT, the calendar), the Requests hub and, once a day
 *  is given, the attendance. */
function afterChange(queryClient: QueryClient, attendance = false) {
  void invalidateCompensation(queryClient);
  void queryClient.invalidateQueries({ queryKey: ["/api/hr-requests"] });
  if (attendance) {
    void queryClient.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/attendance"),
    });
  }
}

export type PlaceCompensationInput = {
  employeeId: number;
  source: PlacementSourceKey | string;
  useDate: string;
  shifts: number;
  /** A day off worked only (holiday_work): the credit, 0.25..1.00 (1.00 by default); `shifts` must not be more. */
  creditShifts?: number;
  /** Optional, at most `reasonMax` characters (the server writes a sentence when it is empty). */
  reason?: string;
};

export type PlaceCompensationResult = { claim: CompensationClaim; message: string | null };

/** HR places compensation on a chosen date: 201 {claim, message}. It goes to the Department Head, then HR. */
export const usePlaceCompensation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ reason, creditShifts, ...rest }: PlaceCompensationInput): Promise<PlaceCompensationResult> => {
      const body: Record<string, unknown> = { ...rest };
      if (creditShifts !== undefined) body.creditShifts = creditShifts;
      if (reason?.trim()) body.reason = reason.trim();
      const raw = await customFetch<{ claim?: unknown; message?: unknown }>(PLACEMENTS_PATH, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        claim: normalizeClaim(raw?.claim),
        message: typeof raw?.message === "string" ? raw.message : null,
      };
    },
    onSuccess: () => afterChange(queryClient),
  });
};

/** The address of HR's decision on a placement (after the Department Head's). */
export const placementDecisionPath = (id: number): string => `${PLACEMENTS_PATH}/${id}/decision`;

/** HR's decision, after the Department Head's: the approval gives the day; a rejection needs its reason (>= 3 chars). */
export const useDecidePlacement = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) => {
      const raw = await customFetch<{ claim?: unknown }>(placementDecisionPath(id), {
        method: "PATCH",
        body: JSON.stringify({ status, comment: comment?.trim() || undefined }),
      });
      return normalizeClaim(raw?.claim);
    },
    onSuccess: () => afterChange(queryClient, true),
  });
};
