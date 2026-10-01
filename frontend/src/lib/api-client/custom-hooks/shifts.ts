// shifts: Manage Shifts - the full shift template, the assignment planner (preview + apply) and taking people off a shift.
// The rules live in backend/api/shift_planner.py and shift_views.py; this file only types and calls them.
import { useMutation, useQuery, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";
import { getListShiftsQueryKey } from "./organization";

// Every cached assignment list, whatever its filters ([key, undefined] would match none of the ones with params).
const ALL_ASSIGNMENTS = ["/api/shift-assignments"] as const;

// ── Shift templates ──────────────────────────────────────────────────────────

export type ShiftType = "staff" | "production";
export type GenderRule = "all" | "male" | "female";

/** A shift template as /api/shifts sends it (the generated type predates the lunch fields and the head count). */
export type ShiftItem = {
  id: number;
  name: string;
  shiftType: ShiftType;
  startTime: string;
  endTime: string;
  genderRule: GenderRule;
  gracePeriodMinutes: number;
  firstHalfEnd: string | null;
  lunchDurationMinutes: number;
  lunchGraceMinutes: number;
  departmentId?: number | null;
  departmentName?: string | null;
  isDefault: boolean;
  isActive: boolean;
  branchId?: number | null;
  /** Active employees on it right now. */
  assignedCount: number | null;
  createdAt?: string | null;
};

/** What the server sends back when it refuses a shift: the first message and one message per field. */
export type ShiftFieldErrors = Partial<Record<string, string>>;

export type ShiftFormPayload = {
  name: string;
  shiftType: ShiftType;
  startTime: string;
  endTime: string;
  genderRule: GenderRule;
  gracePeriodMinutes: number;
  firstHalfEnd?: string | null;
  lunchDurationMinutes?: number;
  lunchGraceMinutes?: number;
  isActive?: boolean;
};

export const useShiftTemplates = () =>
  useQuery({
    queryKey: getListShiftsQueryKey(),
    queryFn: () => customFetch<ShiftItem[]>("/api/shifts"),
  });

export const useSaveShiftTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id?: number; data: Partial<ShiftFormPayload> }) =>
      customFetch<ShiftItem>(id ? `/api/shifts/${id}` : "/api/shifts", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() }),
  });
};

export const useRemoveShiftTemplate = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => customFetch<void>(`/api/shifts/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() }),
  });
};

// ── The assignment planner ───────────────────────────────────────────────────

export type SelectionRule = { include: number[]; exclude: number[] };

export type ShiftSelection = {
  /** Everyone of the shift's type (staff or production). */
  includeAll: boolean;
  employees: SelectionRule;
  departments: SelectionRule;
  designations: SelectionRule;
};

export type ConflictDecision = "keep" | "reassign";

export type AssignRequest = {
  shiftId: number | null;
  effectiveFrom: string;
  selection: ShiftSelection;
  customStartTime?: string | null;
  customEndTime?: string | null;
  saturdayOff?: boolean;
  notes?: string | null;
  /** What to do with people already on a shift, unless `decisions` says otherwise for them. */
  onConflict: ConflictDecision;
  decisions: Record<string, ConflictDecision>;
};

export type PlanStatus = "new" | "unchanged" | "conflict" | "skipped" | "blocked" | "excluded";

export type PlanCurrent = {
  assignmentId: number;
  shiftId: number;
  shiftName: string;
  startTime: string | null;
  endTime: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  customStartTime: string | null;
  customEndTime: string | null;
  saturdayOff: boolean;
};

export type PlanRow = {
  employeeId: number;
  employeeCode: string;
  name: string;
  employmentType: string;
  gender: string | null;
  department: string | null;
  designation: string | null;
  /** How they were selected: 'Selected directly', 'Department: Sewing', ... */
  via: string[];
  status: PlanStatus;
  action: "assign" | "reassign" | "keep" | "none";
  reason: string | null;
  decision: ConflictDecision | null;
  current: PlanCurrent | null;
  scheduled: { assignmentId: number; shiftName: string; effectiveFrom: string }[];
  /** After an apply: created | reassigned | updated | kept | unchanged | skipped | blocked | excluded. */
  outcome?: string;
};

export type PlanCounts = {
  /** Matched an inclusion, before the exclusions. */
  matched: number;
  /** Matched and not excluded. */
  selected: number;
  new: number;
  /** Already on this shift, or on another one. */
  alreadyAssigned: number;
  alreadyOnThisShift: number;
  conflicts: number;
  willReassign: number;
  kept: number;
  skipped: number;
  excluded: number;
  blocked: number;
  /** New assignments plus reassignments: what Apply would write. */
  willChange: number;
};

export type PlanResult = {
  ok: boolean;
  errors: string[];
  warnings: string[];
  shift: {
    id: number;
    name: string;
    shiftType: ShiftType;
    startTime: string;
    endTime: string;
    genderRule: GenderRule;
  } | null;
  effectiveFrom: string | null;
  counts: PlanCounts;
  rows: PlanRow[];
  applied?: {
    created: number;
    reassigned: number;
    updated: number;
    kept: number;
    unchanged: number;
    skipped: number;
    blocked: number;
    excluded: number;
    assigned: number;
  };
};

/** The preview: re-asked whenever the request changes, the last answer stays on screen meanwhile. */
export const usePlanShiftAssignment = (request: AssignRequest, enabled: boolean) =>
  useQuery({
    queryKey: ["shift-plan", request],
    queryFn: () =>
      customFetch<PlanResult>("/api/shift-assignments/plan", { method: "POST", body: JSON.stringify(request) }),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 0,
    gcTime: 30_000,
  });

export const useApplyShiftAssignment = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: AssignRequest) =>
      customFetch<PlanResult>("/api/shift-assignments/apply", { method: "POST", body: JSON.stringify(request) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ALL_ASSIGNMENTS });
      queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["shift-plan"] });
    },
  });
};

export const useEndShiftAssignments = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { assignmentIds: number[]; lastDay: string }) =>
      customFetch<{ ended: number; cancelled: number; unchanged: number; lastDay: string }>(
        "/api/shift-assignments/end",
        { method: "POST", body: JSON.stringify(data) },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ALL_ASSIGNMENTS });
      queryClient.invalidateQueries({ queryKey: getListShiftsQueryKey() });
    },
  });
};
