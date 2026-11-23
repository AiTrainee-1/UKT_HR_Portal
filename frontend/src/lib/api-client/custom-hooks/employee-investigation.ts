// employee-investigation: Employees -> Investigation (/hr/employees/investigation, owner 2026-11-23). The active employees
// (staff and production) away from the company 15-29 days in a row (the 15 Days list) or 30+ (the 30 Days list), counted
// in CALENDAR days since the last attended day up to yesterday; a day the employee's unit recorded almost no punches is a
// "no data" day and is not counted. HR can Keep active (the Auto Trigger then leaves them alone until they attend again)
// or Mark inactive (the same as the Active / Inactive switch). The nightly Auto Trigger (01:00) marks inactive whoever is
// away MORE than 30 days, not on approved leave for the whole time, not kept active and with attendance on record.
//
//   GET  summary                              {d15, d30, tonight, autoEnabled} (the Employees page button)
//   GET  list?bucket=15|30&kind=all|staff|production
//   GET  auto?kind=                           the switch, last run, who the next run would inactivate, its history
//   GET  detail?employeeId=                   one employee's absence: the days, leave, punches, decisions
//   POST inactivate   {employeeIds, reason, bucket}   bucket "15" | "30" | "auto" (decided on the Auto Trigger tab)
//   POST keep-active  {employeeIds, reason, bucket}
//   POST reactivate   {employeeIds, reason}
//   PUT  settings     {autoEnabled}           403 for a unit (branch) login
//   POST run-now                              the Auto Trigger at once, by the nightly rules, even while switched off;
//                                             {summary, settings}; 403 for a unit (branch) login
//
// Backend: backend/api/investigation/views.py (permission key employees.investigation: GET = view, POST / PUT = edit).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "../custom-fetch";

// ── Types ─────────────────────────────────────────────────────────────────────

export type InvestigationKind = "all" | "staff" | "production";
export type InvestigationBucket = "15" | "30";
export type InvestigationDecisionAction = "inactivated" | "auto_inactivated" | "kept_active" | "reactivated";

/** One decision about an employee's absence (views.decision_json). */
export type InvestigationDecision = {
  id: number;
  action: InvestigationDecisionAction;
  /** "Marked inactive", "Inactivated by the Auto Trigger", "Kept active", "Made active again". */
  actionLabel: string;
  reason: string | null;
  by: string | null;
  /** ISO datetime. */
  at: string | null;
  /** "15" | "30" | "auto": where it was decided. */
  bucket: string | null;
  /** The first day away of the absence it is about (ISO date). */
  spellStart: string | null;
  lastAttended: string | null;
  absentDays: number;
};

/** One active employee away from the company (views._row). */
export type InvestigationRow = {
  id: number;
  code: string;
  name: string;
  kind: "staff" | "production";
  /** "active" / "inactive". */
  status: string;
  departmentId: number | null;
  department: string;
  designation: string;
  branchId: number | null;
  unit: string;
  phone: string | null;
  joinDate: string | null;
  /** The last attended day (a punch, an On-Duty day or a worked day HR set), or null when never. */
  lastAttended: string | null;
  /** The first day away (ISO date). */
  awayFrom: string | null;
  /** Every day since the last attended day, up to yesterday (Sundays and holidays included). */
  calendarDays: number;
  /** The days counted as away: calendar days minus the unit's no-data days. */
  absentDays: number;
  /** Working days the unit's punches did not arrive (device or connector down): not counted as away. */
  noDataDays: number;
  /** Not a Sunday, holiday or no-data day. */
  workingDays: number;
  /** Approved leave on those working days (a half day counts 0.5). */
  leaveDays: number;
  /** Every working day away is approved leave: listed, never inactivated automatically. */
  coveredByLeave: boolean;
  /** No attendance ever recorded: counted from the join date, never inactivated automatically. */
  neverAttended: boolean;
  bucket: InvestigationBucket | null;
  /** The latest decision about the employee (any absence). */
  decision: InvestigationDecision | null;
  /** A Keep active (or Make active again) holds for this absence. */
  keptActive: boolean;
  /** The next Auto Trigger run would mark them inactive (when it is switched on). */
  autoTonight: boolean;
  /** Why it would not, in one sentence. */
  autoWhyNot: string | null;
};

export type InvestigationLastRun = {
  ran: boolean;
  at?: string;
  day?: string;
  inactivated?: number;
  employeeIds?: number[];
  /** "nightly", or the HR user who pressed Run now. */
  runBy?: string | null;
  reason?: string;
};

export type InvestigationSettings = {
  autoEnabled: boolean;
  /** The Auto Trigger acts after MORE than this many days away (30). */
  autoDays: number;
  /** "01:00". */
  runAt: string;
  lastRunAt: string | null;
  lastRun: InvestigationLastRun | null;
  /** A login for all units: only it can switch the Auto Trigger. */
  canChange: boolean;
  rules: { list15: number; list30: number; gapShare: number };
};

export type InvestigationCounts = { d15: number; d30: number; tonight: number };

export type InvestigationSummary = InvestigationCounts & { autoEnabled: boolean };

export type InvestigationList = {
  bucket: InvestigationBucket;
  kind: InvestigationKind;
  /** Yesterday: the last day counted (ISO date). */
  asOf: string;
  counts: InvestigationCounts;
  settings: InvestigationSettings;
  employees: InvestigationRow[];
};

/** One employee the Auto Trigger marked inactive, and what happened since. */
export type InvestigationHistoryItem = InvestigationDecision & {
  employee: {
    id: number;
    code: string;
    name: string;
    kind: "staff" | "production";
    department: string;
    unit: string;
    status: string;
  };
  calendarDays: number;
  /** A later decision (made active again by HR ...), or null. */
  since: InvestigationDecision | null;
};

export type InvestigationAuto = {
  kind: InvestigationKind;
  settings: InvestigationSettings;
  tonight: InvestigationRow[];
  history: InvestigationHistoryItem[];
};

export type InvestigationDayKind =
  "leave" | "half_leave" | "holiday" | "sunday" | "no_data" | "leave_pending" | "absent";

export type InvestigationDay = { date: string; kind: InvestigationDayKind; holiday: string | null };

export type InvestigationLeave = {
  id: number;
  type: string;
  from: string;
  to: string;
  days: number | null;
  halfDay: boolean;
  status: string;
  reason: string | null;
  decidedBy: string | null;
};

export type InvestigationCasualLeave = {
  id: number;
  date: string;
  portion: string;
  status: string;
  reason: string | null;
};

export type InvestigationPunch = { date: string; time: string; source: string | null };

export type InvestigationDetail = {
  employee: InvestigationRow;
  /** Newest first. */
  decisions: InvestigationDecision[];
  /** The first day shown on the calendar (at most the last 120 days); absent when nothing is measured. */
  calendarFrom?: string;
  calendar: InvestigationDay[];
  leaves: InvestigationLeave[];
  casualLeaves: InvestigationCasualLeave[];
  /** The last 8, newest first. */
  punches: InvestigationPunch[];
};

export type InvestigationDone = { employeeId: number; employeeCode: string; name: string; absentDays: number };
export type InvestigationRefusal = { employeeId: number; employeeCode: string; name: string; reason: string };
export type InvestigationResult = { done: InvestigationDone[]; refused: InvestigationRefusal[] };

/** The three decisions, by their address. */
export type InvestigationActionPath = "inactivate" | "keep-active" | "reactivate";

/** Where a decision was made: the 15 Days or 30 Days list, or the Auto Trigger tab. */
export type InvestigationDecisionBucket = InvestigationBucket | "auto";

export type InvestigationActionBody = {
  employeeIds: number[];
  reason: string;
  /** Inactivate / Keep active: the list it was decided in. */
  bucket?: InvestigationDecisionBucket;
};

/** Run now: what the run did, and the settings after it (its last run). */
export type InvestigationRunNowResult = { summary: InvestigationLastRun; settings: InvestigationSettings };

// ── Query keys ────────────────────────────────────────────────────────────────

export const INVESTIGATION_PREFIX = "/api/employee-investigation";

export const getInvestigationSummaryQueryKey = () => [`${INVESTIGATION_PREFIX}/summary`] as const;
export const getInvestigationListQueryKey = (bucket: InvestigationBucket, kind: InvestigationKind) =>
  [`${INVESTIGATION_PREFIX}/list`, { bucket, kind }] as const;
export const getInvestigationAutoQueryKey = (kind: InvestigationKind) =>
  [`${INVESTIGATION_PREFIX}/auto`, { kind }] as const;
export const getInvestigationDetailQueryKey = (employeeId: number) =>
  [`${INVESTIGATION_PREFIX}/detail`, { employeeId }] as const;

/** This page's keys, and the employee lists / counts a status change moves people between. */
export const isInvestigationRefreshKey = (key: readonly unknown[]): boolean =>
  typeof key[0] === "string" && (key[0].startsWith(INVESTIGATION_PREFIX) || key[0].startsWith("/api/employees"));

// The lists are worked out from every active employee's attendance: a tab switched back and forth inside half a minute
// reuses what it has (an action or the Refresh button always reloads).
const STALE_MS = 30_000;

// ── Reads ─────────────────────────────────────────────────────────────────────

/** The Employees page badge: how many are away 15-29 / 30+ days, and how many the next run would inactivate. */
export const useInvestigationSummary = (options?: { enabled?: boolean }) =>
  useQuery<InvestigationSummary>({
    queryKey: getInvestigationSummaryQueryKey(),
    queryFn: () => customFetch<InvestigationSummary>(`${INVESTIGATION_PREFIX}/summary`),
    enabled: options?.enabled ?? true,
    staleTime: STALE_MS,
  });

/** The 15 Days or 30 Days list (with the counts of both and the Auto Trigger's settings). */
export const useInvestigationList = (
  bucket: InvestigationBucket,
  kind: InvestigationKind,
  options?: { enabled?: boolean },
) =>
  useQuery<InvestigationList>({
    queryKey: getInvestigationListQueryKey(bucket, kind),
    queryFn: () => customFetch<InvestigationList>(`${INVESTIGATION_PREFIX}/list?bucket=${bucket}&kind=${kind}`),
    enabled: options?.enabled ?? true,
    staleTime: STALE_MS,
  });

/** The Auto Trigger: its switch and last run, who the next run would inactivate, and everyone it inactivated. */
export const useInvestigationAuto = (kind: InvestigationKind, options?: { enabled?: boolean }) =>
  useQuery<InvestigationAuto>({
    queryKey: getInvestigationAutoQueryKey(kind),
    queryFn: () => customFetch<InvestigationAuto>(`${INVESTIGATION_PREFIX}/auto?kind=${kind}`),
    enabled: options?.enabled ?? true,
    staleTime: STALE_MS,
  });

/** One employee's absence: the days coloured by kind, their leave and casual leave, last punches and decisions. */
export const useInvestigationDetail = (employeeId: number | null) =>
  useQuery<InvestigationDetail>({
    queryKey: getInvestigationDetailQueryKey(employeeId ?? 0),
    queryFn: () => customFetch<InvestigationDetail>(`${INVESTIGATION_PREFIX}/detail?employeeId=${employeeId}`),
    enabled: employeeId !== null,
    retry: false,
  });

// ── Writes ────────────────────────────────────────────────────────────────────

/** Mark inactive, Keep active or Make active again: answers who was changed and who was refused (and why). */
export const runInvestigationAction = (path: InvestigationActionPath, body: InvestigationActionBody) =>
  customFetch<InvestigationResult>(`${INVESTIGATION_PREFIX}/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** The Auto Trigger switch (a login for all units). */
export const setInvestigationAuto = (autoEnabled: boolean) =>
  customFetch<InvestigationSettings>(`${INVESTIGATION_PREFIX}/settings`, {
    method: "PUT",
    body: JSON.stringify({ autoEnabled }),
  });

/** Runs the Auto Trigger at once, by exactly the nightly rules, even while it is switched off (a login for all units). */
export const runInvestigationNow = () =>
  customFetch<InvestigationRunNowResult>(`${INVESTIGATION_PREFIX}/run-now`, { method: "POST" });

/** Reloads this page's lists and the Employees page's lists and counts. */
export function useRefreshInvestigation() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ predicate: (q) => isInvestigationRefreshKey(q.queryKey) });
}

/** A decision (Mark inactive / Keep active / Make active again); refreshes everything it can change. */
export function useInvestigationAction() {
  const refresh = useRefreshInvestigation();
  return useMutation({
    mutationFn: ({ path, body }: { path: InvestigationActionPath; body: InvestigationActionBody }) =>
      runInvestigationAction(path, body),
    onSettled: () => refresh(),
  });
}

/** The Auto Trigger switch; refreshes the page (the Tonight list does not change, the switch and the chips do). */
export function useSetInvestigationAuto() {
  const refresh = useRefreshInvestigation();
  return useMutation({
    mutationFn: (autoEnabled: boolean) => setInvestigationAuto(autoEnabled),
    onSettled: () => refresh(),
  });
}

/** Run now; refreshes the page and the Employees page's lists and counts (people moved to Inactive). */
export function useRunInvestigationNow() {
  const refresh = useRefreshInvestigation();
  return useMutation({
    mutationFn: () => runInvestigationNow(),
    onSettled: () => refresh(),
  });
}
