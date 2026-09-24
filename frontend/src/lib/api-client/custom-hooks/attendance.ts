// attendance: hooks/types split out of the former single custom-hooks.ts (see ./index.ts).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch, getApiOrigin } from "../custom-fetch";
import { SyncResult } from "./shared";

// ── Attendance (enhanced) ─────────────────────────────────────────────────────

export type AttendanceSummary = {
  date: string;
  totalEmployees: number;
  productionTotal: number;
  staffTotal: number;
  presentToday: number;
  biometricPresent: number;
  manualPresent: number;
  productionPresent: number;
  staffPresent: number;
  notPunched: number;
  productionNotPunched: number;
  staffNotPunched: number;
  yesterday: {
    date: string;
    present: number;
    absent: number;
    late: number;
    onLeave: number;
  };
};

export type AttendanceDailyRecord = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  employmentType: "production" | "staff";
  status: "present" | "manual" | "on_leave" | "absent";
  firstPunch?: string | null;
  lastPunch?: string | null;
  source?: string | null;
  sourceLabel?: string | null;
  totalPunches: number;
};

export type AttendanceMonthlyTrendItem = {
  date: string;
  day: number;
  label: string;
  present: number;
  absent: number;
};

export type AttendanceEmployeeHistory = {
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType: string;
  };
  month: number;
  year: number;
  summary: { present: number; halfShift: number; absent: number; onLeave: number; late: number };
  records: {
    date: string;
    day: string;
    status: string;
    isLate: boolean;
    isHalfShift: boolean;
    permissionMorning?: boolean;
    permissionMorningWithRequest?: boolean;
    permissionAfternoon?: boolean;
    permissionAfternoonWithRequest?: boolean;
    permissionDeparture?: boolean;
    permissionDepartureWithRequest?: boolean;
    isCompensationDay?: boolean;
    isHalfDayLeave?: boolean;
    present: boolean;
    firstPunch?: string | null;
    lastPunch?: string | null;
    totalPunches: number;
    punches: { time: string; type: string; source: string; sourceLabel: string }[];
    hoursWorked?: string | null;
    source?: string | null;
    sourceLabel?: string | null;
    notes?: string | null;
    leaveType?: string | null;
  }[];
  totalPresent: number;
  totalAbsent: number;
};

export const getAttendanceSummaryQueryKey = (date?: string) => ["/api/attendance/summary", date] as const;

export const useAttendanceSummary = (date?: string) =>
  useQuery<AttendanceSummary>({
    queryKey: getAttendanceSummaryQueryKey(date),
    queryFn: () => {
      const q = date ? `?date=${date}` : "";
      return customFetch<AttendanceSummary>(`/api/attendance/summary${q}`);
    },
    refetchInterval: 60_000,
  });

export interface AttendanceCompanySummary {
  date: string;
  totalEmployees: number;
  present: number;
  halfShift: number;
  absent: number;
  onLeave: number;
  late: number;
  permission: number;
  totalShiftsEarned: number;
}

export const getAttendanceCompanySummaryQueryKey = () => ["/api/attendance/company-summary"] as const;

export const useAttendanceCompanySummary = () =>
  useQuery<AttendanceCompanySummary>({
    queryKey: getAttendanceCompanySummaryQueryKey(),
    queryFn: () => customFetch<AttendanceCompanySummary>("/api/attendance/company-summary"),
    refetchInterval: 60_000,
  });

export const getAttendanceDailyQueryKey = (date?: string) => ["/api/attendance/daily", date] as const;

export const useAttendanceDaily = (date?: string) =>
  useQuery<AttendanceDailyRecord[]>({
    queryKey: getAttendanceDailyQueryKey(date),
    queryFn: () => {
      const q = date ? `?date=${date}` : "";
      return customFetch<AttendanceDailyRecord[]>(`/api/attendance/daily${q}`);
    },
    refetchInterval: 60_000,
  });

export const getAttendanceMonthlyTrendQueryKey = (year?: number, month?: number) =>
  ["/api/attendance/monthly-trend", year, month] as const;

export const useAttendanceMonthlyTrend = (year?: number, month?: number) =>
  useQuery<AttendanceMonthlyTrendItem[]>({
    queryKey: getAttendanceMonthlyTrendQueryKey(year, month),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (year) qs.set("year", String(year));
      if (month) qs.set("month", String(month));
      const q = qs.toString();
      return customFetch<AttendanceMonthlyTrendItem[]>(`/api/attendance/monthly-trend${q ? `?${q}` : ""}`);
    },
  });

export const getAttendanceEmployeeHistoryQueryKey = (id: number, month?: number, year?: number) =>
  ["/api/attendance/employee", id, month, year] as const;

export const useAttendanceEmployeeHistory = (id: number | null, month?: number, year?: number) =>
  useQuery<AttendanceEmployeeHistory>({
    queryKey: getAttendanceEmployeeHistoryQueryKey(id ?? 0, month, year),
    queryFn: () => {
      const qs = new URLSearchParams();
      if (month) qs.set("month", String(month));
      if (year) qs.set("year", String(year));
      const q = qs.toString();
      return customFetch<AttendanceEmployeeHistory>(`/api/attendance/employee/${id}${q ? `?${q}` : ""}`);
    },
    enabled: !!id,
  });

export const useCreateManualAttendance = () =>
  useMutation({
    mutationFn: (data: {
      employeeId: number;
      date: string;
      punchTime?: string;
      punchType?: string;
      notes?: string;
      hoursWorked?: number;
    }) =>
      customFetch<{ ok: boolean; attendanceId: number; logId?: number }>("/api/attendance/manual", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

// ── Report Log types ──────────────────────────────────────────────────────────

export type ShiftLogEntry = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  date: string;
  assignedShift: { name: string; startTime: string | null; endTime: string | null; gracePeriodMinutes: number } | null;
  punch1?: string | null; // morning IN
  punch2?: string | null; // lunch OUT
  punch3?: string | null; // lunch IN
  punch4?: string | null; // evening OUT
  totalPunches: number;
  status: "present" | "half_shift" | "absent" | "on_leave" | "holiday";
  isLate: boolean;
  isHalfShift: boolean;
  earlyLeave: boolean;
  shiftsCompleted: string; // Decimal as string, e.g. "1.00"
  lateMorning: boolean;
  lateAfternoon?: boolean;
  lateReturn: boolean;
  lateReason?: string | null;
  // Auto-Permission zone (see shift_engine.py's ZONE_* / _classify_zone) -
  // detected purely from punch timing, independent of the submitted-request
  // `permission` field below. The *WithRequest flags label whether an
  // approved request also covered that edge.
  permissionMorning?: boolean;
  permissionMorningWithRequest?: boolean;
  permissionAfternoon?: boolean;
  permissionAfternoonWithRequest?: boolean;
  permissionDeparture?: boolean;
  permissionDepartureWithRequest?: boolean;
  permissionZoneCount?: number;
  permissionEscalatedToHalfShift?: boolean;
  isCompensationDay?: boolean;
  isHalfDayLeave?: boolean;
  casualLeave: { status: "pending" | "approved" | "rejected"; reason: string | null } | null;
  permission: { status: "pending" | "approved" | "rejected"; time: string | null; reason: string | null } | null;
  leave: { status: "pending" | "approved" | "rejected"; type: string | null; reason: string | null } | null;
  source: "auto" | "manual";
};

export type MonthlySummaryRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  totalDays: number;
  workingDays: number;
  effectiveDays: string; // Decimal as string
  presentDays: number;
  halfShiftDays: number;
  absentDays: number;
  onLeaveDays: number;
  casualLeaveCount: number;
  permissionCount: number;
  holidays: number;
  lateCount: number;
  totalShifts: string; // Decimal as string
};

export type ReportLogSummaryResponse = {
  month: number;
  year: number;
  employees: MonthlySummaryRow[];
};

export type ReportLogDetailResponse = {
  month: number;
  year: number;
  employee: {
    id: number;
    code: string;
    name: string;
    department: string | null;
    designation: string | null;
  };
  days: ShiftLogEntry[];
};

export type LateSummaryEmployee = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  totalShifts: string;
  halfShiftDays: number;
  totalLateCount: number;
  permissionsUsed: number;
  billableLateCount: number;
  shiftDeductions: string;
  salaryDeductionAmount: string;
};

export type EmployeeShiftMonthlyStats = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  designation?: string | null;
  employmentType?: string | null;
  month: number;
  year: number;
  presentDays: number;
  absentDays: number;
  leaveDays: number;
  halfShiftDays: number;
  fullShiftDays: number;
  totalEffectiveShifts: string;
  lateMorningDays: number;
  lateReturnDays: number;
  totalLateCount: number;
  summary?: {
    totalShifts: string;
    totalLateCount: number;
    billableLateCount: number;
    shiftDeductions: string;
    salaryDeductionAmount: string;
  } | null;
  dailyLogs: {
    date: string;
    day: string;
    status: "present" | "absent" | "on_leave" | "holiday" | "future";
    firstPunch?: string | null;
    lastPunch?: string | null;
    totalPunches: number;
    source?: string | null;
    leaveType?: string | null;
    shiftsCompleted?: string | null;
    isHalfShift: boolean;
    lateMorning: boolean;
    lateReturn: boolean;
  }[];
};

export type LateSummaryResponse = {
  month: number;
  year: number;
  employees: LateSummaryEmployee[];
};

export type SyncBiometricMode = "day" | "week" | "month" | "all";
export type SyncDeviceId = number | "all" | "env" | (number | "env")[];

export const useSyncBiometric = () =>
  useMutation({
    mutationFn: (params: { mode?: SyncBiometricMode; deviceId?: SyncDeviceId } | SyncBiometricMode = "day") => {
      const { mode = "day", deviceId } = typeof params === "string" ? { mode: params } : params;
      return customFetch<SyncResult>("/api/attendance/sync-biometric", {
        method: "POST",
        body: JSON.stringify({ mode, deviceId }),
      });
    },
  });

// ── Attendance: Skipped / Punch View / Sync status ────────────────────────
// All database-only -none of these contact a biometric device, so unlike the
// old Sync Biometric / Manual Import they work from a cloud-hosted backend.

export type SkippedPunch = {
  id: number;
  deviceUserId: string;
  deviceLabel: string | null;
  deviceSerial: string | null;
  punchCount: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  lastPunchDate: string | null;
  lastPunchTime: string | null;
  resolved: boolean;
  resolvedNote: string | null;
};

export type SkippedPunchesResponse = {
  results: SkippedPunch[];
  unresolvedCount: number;
  /** Total punches being discarded -conveys the cost of leaving these unresolved. */
  discardedPunches: number;
};

export const useSkippedPunches = (includeResolved = false) =>
  useQuery<SkippedPunchesResponse>({
    queryKey: ["/api/attendance/skipped-punches", includeResolved],
    queryFn: () =>
      customFetch<SkippedPunchesResponse>(
        `/api/attendance/skipped-punches${includeResolved ? "?includeResolved=1" : ""}`,
      ),
  });

export const useResolveSkippedPunch = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, note }: { id: number; note?: string }) =>
      customFetch<{ ok: boolean }>(`/api/attendance/skipped-punches/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ note }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/skipped-punches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/sync-status-live"] });
    },
  });
};

export type PunchRow = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  employmentType: string;
  date: string;
  punchTime: string;
  punchType: "IN" | "OUT";
  source: string;
};

export type PunchListResponse = {
  total: number;
  limit: number;
  offset: number;
  results: PunchRow[];
};

export type PunchFilters = {
  dateFrom?: string;
  dateTo?: string;
  employmentType?: "staff" | "production" | "";
  punchType?: "IN" | "OUT" | "";
  source?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

function punchQuery(f: PunchFilters): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  return qs.toString();
}

export const usePunchList = (filters: PunchFilters) =>
  useQuery<PunchListResponse>({
    queryKey: ["/api/attendance/punches", punchQuery(filters)],
    queryFn: () => customFetch<PunchListResponse>(`/api/attendance/punches?${punchQuery(filters)}`),
  });

/** Downloads the full filtered set as .xlsx -not just the visible page. */
export async function downloadPunchesExcel(filters: PunchFilters): Promise<void> {
  const { limit: _l, offset: _o, ...rest } = filters;
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
  const response = await fetch(`${getApiOrigin()}/api/attendance/punches/export?${punchQuery(rest)}`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);

  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = disposition.match(/filename="?([^"';]+)"?/i)?.[1] ?? "punches.xlsx";
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export type PunchImportResult = {
  ok: boolean;
  updated: number;
  created: number;
  unchanged: number;
  errors: string[];
  errorCount: number;
};

export const useImportPunches = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      const token = typeof localStorage !== "undefined" ? localStorage.getItem("uk_textile_token") : null;
      const response = await fetch(`${getApiOrigin()}/api/attendance/punches/import`, {
        method: "POST",
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: form,
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Import failed");
      return body as PunchImportResult;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/punches"] });
      queryClient.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("/api/attendance"),
      });
    },
  });
};

export type DeviceHealthRow = {
  id: number;
  name: string;
  host: string;
  serialNumber: string | null;
  isActive: boolean;
  status: "live" | "silent" | "never" | "disabled";
  lastPushAt: string | null;
  lastSyncedAt: string | null;
};

export type SyncStatusLive = {
  devices: DeviceHealthRow[];
  liveCount: number;
  problemCount: number;
  isLive: boolean;
  silentAfterHours: number;
  checkedAt: string;
  punchesToday: number;
  lastPunchAt: string | null;
  unresolvedSkipped: number;
};

/** Polled while the Attendance page is open so the live dot reflects reality
 *  without the user refreshing. 30s is plenty -device silence is measured in
 *  hours, so anything faster is just load for no extra signal. */
export const useSyncStatusLive = () =>
  useQuery<SyncStatusLive>({
    queryKey: ["/api/attendance/sync-status-live"],
    queryFn: () => customFetch<SyncStatusLive>("/api/attendance/sync-status-live"),
    refetchInterval: 30_000,
  });

export type ReportLogSummaryParams = {
  month: number;
  year: number;
  department?: number;
  search?: string;
};

export type ReportLogDetailParams = {
  month: number;
  year: number;
  employeeId: number;
};

const reportLogQueryString = (params: Record<string, string | number | undefined>): string => {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") qs.set(key, String(value));
  }
  return qs.toString();
};

export const getReportLogSummaryQueryKey = (params: ReportLogSummaryParams) =>
  ["/api/attendance/report-log", "summary", params] as const;

// Mode A -one row per employee for the month, optionally narrowed by
// department and/or an employee code/name search.
export const useAttendanceReportSummary = (params: ReportLogSummaryParams, enabled = true) =>
  useQuery<ReportLogSummaryResponse>({
    queryKey: getReportLogSummaryQueryKey(params),
    queryFn: () => customFetch<ReportLogSummaryResponse>(`/api/attendance/report-log?${reportLogQueryString(params)}`),
    enabled,
  });

export const getReportLogDetailQueryKey = (params: ReportLogDetailParams) =>
  ["/api/attendance/report-log", "detail", params] as const;

// Mode B -one employee's full day-by-day month.
export const useAttendanceReportDetail = (params: ReportLogDetailParams, enabled = true) =>
  useQuery<ReportLogDetailResponse>({
    queryKey: getReportLogDetailQueryKey(params),
    queryFn: () => customFetch<ReportLogDetailResponse>(`/api/attendance/report-log?${reportLogQueryString(params)}`),
    enabled,
  });

// ── Mode C -Daily Report: one row per employee for a single date ──────────
// (Report Log page only -Late/Permission/On-Leave filtering, Informed
// status, Excel/PDF/Image export.)

export type ReportLogDailyRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  status: "present" | "half_shift" | "absent" | "on_leave" | "holiday";
  isLate: boolean;
  lateAfternoon: boolean;
  permissionMorning: boolean;
  permissionAfternoon: boolean;
  permissionDeparture: boolean;
  isCompensationDay: boolean;
  isInformed: boolean | null;
};

export type ReportLogDailyResponse = {
  date: string;
  rows: ReportLogDailyRow[];
  count: number;
};

export type ReportLogDailyParams = {
  date: string;
  department?: number;
  search?: string;
};

export const getReportLogDailyQueryKey = (params: ReportLogDailyParams) =>
  ["/api/attendance/report-log", "daily", params] as const;

export const useAttendanceReportDaily = (params: ReportLogDailyParams, enabled = true) =>
  useQuery<ReportLogDailyResponse>({
    queryKey: getReportLogDailyQueryKey(params),
    queryFn: () => customFetch<ReportLogDailyResponse>(`/api/attendance/report-log?${reportLogQueryString(params)}`),
    enabled,
  });

export const useSetDayInformed = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ employeeId, date, isInformed }: { employeeId: number; date: string; isInformed: boolean | null }) =>
      customFetch<{ employeeId: number; date: string; isInformed: boolean | null }>("/api/attendance/day-informed", {
        method: "PATCH",
        body: JSON.stringify({ employeeId, date, isInformed }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/report-log", "daily"] });
    },
  });
};

// ── Mode D -Attendance Sheet: the classic paper register as a grid, every
// employee × every date in a range (see attendance_report_log_sheet in
// attendance_views.py). Powers AttendanceSheet.tsx's Day/Week/Month views,
// which are all just this one endpoint given a shorter or longer range.

export type AttendanceSheetDayStatus = "present" | "half_shift" | "absent" | "on_leave" | "holiday" | null;

export type AttendanceSheetDayCell = {
  date: string;
  status: AttendanceSheetDayStatus;
  isLate?: boolean;
  isHalfShift?: boolean;
  // Which half was actually worked, only meaningful when status is
  // "half_shift" -see attendance_report_log_sheet's half_day_period
  // derivation (first punch vs. PayrollSettings.half_shift_late_reference_time).
  halfDayPeriod?: "morning" | "afternoon" | null;
  firstPunch?: string | null;
  lastPunch?: string | null;
  // Decimal as string, e.g. "1.00" / "0.50" / "0.00" -the actual shift
  // credit for the day, independent of the raw punch-in/punch-out span.
  shiftsEarned?: string | null;
};

export type AttendanceSheetEmployeeSummary = {
  totalDays: number;
  workingDays: number;
  present: number;
  halfShift: number;
  absent: number;
  onLeave: number;
  holidays: number;
  late: number;
  totalShifts: string;
  effectiveDays: string;
};

export type AttendanceSheetEmployeeRow = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  days: AttendanceSheetDayCell[];
  summary: AttendanceSheetEmployeeSummary;
};

export type AttendanceSheetResponse = {
  dateFrom: string;
  dateTo: string;
  dates: string[];
  employees: AttendanceSheetEmployeeRow[];
  strength: number[];
};

export type AttendanceSheetParams = {
  dateFrom: string;
  dateTo: string;
  department?: number;
  search?: string;
};

export const getAttendanceSheetQueryKey = (params: AttendanceSheetParams) =>
  ["/api/attendance/report-log/sheet", params] as const;

export const useAttendanceReportSheet = (params: AttendanceSheetParams, enabled = true) =>
  useQuery<AttendanceSheetResponse>({
    queryKey: getAttendanceSheetQueryKey(params),
    queryFn: () =>
      customFetch<AttendanceSheetResponse>(`/api/attendance/report-log/sheet?${reportLogQueryString(params)}`),
    enabled,
  });

export type AttendanceSearchPunch = {
  time: string;
  type: "IN" | "OUT";
  source: string;
  sourceLabel: string;
} | null;

export type AttendanceSearchResult = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  shift: { name: string; startTime: string | null; endTime: string | null; gracePeriodMinutes: number | null } | null;
  punches: AttendanceSearchPunch[];
  totalPunches: number;
};

export const useAttendanceSearch = (query: string, date: string, enabled = true) =>
  useQuery<{ date: string; query: string; count: number; results: AttendanceSearchResult[] }>({
    queryKey: ["/api/attendance/search", query, date],
    queryFn: () => customFetch(`/api/attendance/search?query=${encodeURIComponent(query)}&date=${date}`),
    enabled: enabled && query.trim().length > 0,
  });

// One employee's full day-by-day attendance across an arbitrary range —
// same punch shape as attendance_search above, plus each day's computed
// status/late flag and any approved Leave or Permission covering that date.
export type AttendanceSearchDay = {
  date: string;
  status: "present" | "half_shift" | "absent" | "on_leave" | "holiday";
  isLate: boolean;
  isHalfShift: boolean;
  lateAfternoon?: boolean;
  permissionMorning?: boolean;
  permissionAfternoon?: boolean;
  permissionDeparture?: boolean;
  permissionZoneCount?: number;
  permissionEscalatedToHalfShift?: boolean;
  isCompensationDay?: boolean;
  isHalfDayLeave?: boolean;
  totalPunches: number;
  punches: AttendanceSearchPunch[];
  casualLeave: { status: string; reason: string | null } | null;
  leave: { status: string; type: string; reason: string | null } | null;
  permission: { status: string; time: string | null; reason: string | null } | null;
};

export type AttendanceSearchRangeResponse = {
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  shift: { name: string; startTime: string | null; endTime: string | null; gracePeriodMinutes: number | null } | null;
  startDate: string;
  endDate: string;
  days: AttendanceSearchDay[];
};

export const useAttendanceSearchRange = (
  employeeId: number | null,
  startDate: string,
  endDate: string,
  enabled = true,
) =>
  useQuery<AttendanceSearchRangeResponse>({
    queryKey: ["/api/attendance/search/range", employeeId, startDate, endDate],
    queryFn: () =>
      customFetch(`/api/attendance/search/range?employeeId=${employeeId}&startDate=${startDate}&endDate=${endDate}`),
    enabled: enabled && employeeId != null && !!startDate && !!endDate,
  });

export const useComputeShiftLogs = () =>
  useMutation({
    mutationFn: (data: { date?: string; month?: number; year?: number; employeeId?: number }) =>
      customFetch<{ ok: boolean; computed: number }>("/api/attendance/compute-shifts", {
        method: "POST",
        body: JSON.stringify(data),
      }),
  });

export const getLateSummaryQueryKey = (month: number, year: number) =>
  ["/api/attendance/late-summary", month, year] as const;

export const useAttendanceLateSummary = (month: number, year: number, enabled = true) =>
  useQuery<LateSummaryResponse>({
    queryKey: getLateSummaryQueryKey(month, year),
    queryFn: () => customFetch<LateSummaryResponse>(`/api/attendance/late-summary?month=${month}&year=${year}`),
    enabled,
  });

export const useEmployeeShiftMonthlyStats = (employeeId: number | null, month: number, year: number, enabled = true) =>
  useQuery<EmployeeShiftMonthlyStats>({
    queryKey: ["/api/attendance/employee-shift-stats", employeeId, month, year],
    queryFn: () =>
      customFetch<EmployeeShiftMonthlyStats>(
        `/api/attendance/employee-shift-stats?employee_id=${employeeId}&month=${month}&year=${year}`,
      ),
    enabled: !!employeeId && enabled,
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Typed attendance dashboard (staff / production filtered)
// ═══════════════════════════════════════════════════════════════════════════

export type TypedAttendanceSummary = {
  date: string;
  totalEmployees: number;
  productionTotal: number;
  staffTotal: number;
  presentToday: number;
  biometricPresent: number;
  manualPresent: number;
  notPunched: number;
  productionNotPunched: number;
  staffNotPunched: number;
  yesterday: { date: string; present: number; absent: number; late: number; onLeave: number };
};

export const useAttendanceSummaryTyped = (date: string, employmentType?: string) =>
  useQuery<TypedAttendanceSummary>({
    queryKey: ["/api/attendance/summary", date, employmentType ?? "all"],
    queryFn: () =>
      customFetch<TypedAttendanceSummary>(
        `/api/attendance/summary?date=${date}${employmentType ? `&employmentType=${employmentType}` : ""}`,
      ),
  });

export type TrendPoint = { date: string; day: number; label: string; present: number; absent: number };

export const useAttendanceTrendTyped = (year: number, month: number, employmentType?: string) =>
  useQuery<TrendPoint[]>({
    queryKey: ["/api/attendance/monthly-trend", year, month, employmentType ?? "all"],
    queryFn: () =>
      customFetch<TrendPoint[]>(
        `/api/attendance/monthly-trend?year=${year}&month=${month}${employmentType ? `&employmentType=${employmentType}` : ""}`,
      ),
  });

// ═══════════════════════════════════════════════════════════════════════════
//  Final Attendance (weekly search + manual overrides)
// ═══════════════════════════════════════════════════════════════════════════

export type FinalAttendanceDay = {
  date: string;
  day: string;
  status: "present" | "absent" | "half_shift" | "on_leave" | "holiday";
  isLate: boolean;
  isHalfShift: boolean;
  earlyLeave: boolean;
  lateAfternoon?: boolean;
  permissionMorning?: boolean;
  permissionMorningWithRequest?: boolean;
  permissionAfternoon?: boolean;
  permissionAfternoonWithRequest?: boolean;
  permissionDeparture?: boolean;
  permissionDepartureWithRequest?: boolean;
  permissionEscalatedToHalfShift?: boolean;
  isCompensationDay?: boolean;
  isHalfDayLeave?: boolean;
  shiftsEarned: string;
  firstPunch?: string | null;
  lastPunch?: string | null;
  totalPunches: number;
  source: "auto" | "manual";
  overrideBy?: string | null;
  overrideNote?: string | null;
  computedMode?: string | null;
};

export type EmployeeMonthlyAttendance = {
  employee: {
    id: number;
    code: string;
    name: string;
    department?: string | null;
    designation?: string | null;
    employmentType?: string | null;
    photoUrl?: string | null;
  };
  assignedShift?: {
    name: string;
    startTime: string | null;
    endTime: string | null;
    gracePeriodMinutes: number;
  } | null;
  month: number;
  year: number;
  attendanceMode: string;
  weeks: { week: number; days: FinalAttendanceDay[] }[];
  summary: {
    totalDays: number;
    workingDays: number;
    present: number;
    halfShift: number;
    absent: number;
    onLeave: number;
    holidays: number;
    late: number;
    totalShifts: string;
    effectiveDays: string;
  };
};

export const getEmployeeMonthlyAttendanceKey = (code: string, month: number, year: number) =>
  ["/api/attendance/employee-monthly", code, month, year] as const;

export const useEmployeeMonthlyAttendance = (code: string, month: number, year: number, enabled = true) =>
  useQuery<EmployeeMonthlyAttendance>({
    queryKey: getEmployeeMonthlyAttendanceKey(code, month, year),
    queryFn: () =>
      customFetch<EmployeeMonthlyAttendance>(
        `/api/attendance/employee-monthly?code=${encodeURIComponent(code)}&month=${month}&year=${year}`,
      ),
    enabled: enabled && !!code.trim(),
    retry: false,
  });

export type AttendanceOverrideRequest = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department?: string | null;
  date: string;
  previousValues: Record<string, unknown>;
  requestedValues: Record<string, unknown>;
  reason?: string | null;
  status: "pending" | "approved" | "rejected";
  requestedBy?: string | null;
  reviewedBy?: string | null;
  reviewComment?: string | null;
  reviewedAt?: string | null;
  createdAt?: string | null;
};

/**
 * Submitting an override does NOT apply it immediately -it creates a
 * pending AttendanceOverrideRequest that a Department Head must approve
 * (via the mobile app) before the attendance record is actually changed.
 * reset=true is the only path that applies instantly (reverts to auto).
 */
export const useAttendanceOverride = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      employeeId: number;
      date: string;
      status?: string;
      isLate?: boolean;
      isHalfShift?: boolean;
      firstPunch?: string | null;
      lastPunch?: string | null;
      note?: string;
      reset?: boolean;
    }) =>
      customFetch<{
        ok: boolean;
        record: FinalAttendanceDay;
        pendingApproval?: boolean;
        request?: AttendanceOverrideRequest;
        reset?: boolean;
      }>("/api/attendance/override", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/employee-monthly"] });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/override-requests"] });
    },
  });
};

export const useAttendanceOverrideRequests = (params?: { employeeId?: number; code?: string; status?: string }) => {
  const qs = new URLSearchParams();
  if (params?.employeeId) qs.set("employeeId", String(params.employeeId));
  if (params?.code) qs.set("code", params.code);
  if (params?.status) qs.set("status", params.status);
  const q = qs.toString() ? `?${qs.toString()}` : "";
  return useQuery<AttendanceOverrideRequest[]>({
    queryKey: [
      "/api/attendance/override-requests",
      params?.employeeId ?? null,
      params?.code ?? null,
      params?.status ?? null,
    ],
    queryFn: () => customFetch<AttendanceOverrideRequest[]>(`/api/attendance/override-requests${q}`),
  });
};

// ═══════════════════════════════════════════════════════════════════════════
//  Missing Punch (two-stage: Department Head, then HR -same status machine
//  as OnDutySession; HR approval writes a real AttendanceLog row)
// ═══════════════════════════════════════════════════════════════════════════

// Which of the day's 4 punches this request represents -purely descriptive
// (maps onto punchType: morning_in/lunch_in -> IN, lunch_out/evening_out ->
// OUT). Never the source of truth for real P1-P4 identity, which the
// attendance engine derives from punch time, not a stored label.
export type MissingPunchSlot = "morning_in" | "lunch_out" | "lunch_in" | "evening_out";

export type MissingPunchItem = {
  id: number;
  employeeId: number;
  employeeCode: string;
  employeeName: string;
  department: string | null;
  designation: string | null;
  date: string;
  punchTime: string;
  punchType: "IN" | "OUT";
  punchSlot: MissingPunchSlot | null;
  reason: string;
  status: "pending_hod" | "pending_hr" | "approved" | "rejected";
  hodReviewedBy: string | null;
  hodReviewComment: string | null;
  hodReviewedAt: string | null;
  hrReviewedBy: string | null;
  hrReviewComment: string | null;
  hrReviewedAt: string | null;
  createdAt: string | null;
};

export const getMissingPunchRequestsQueryKey = () => ["/api/missing-punch-requests"] as const;

export const useMissingPunchRequestsHR = (
  status: "pending" | "pending_hod" | "pending_hr" | "approved" | "rejected" | "all" = "pending",
  enabled = true,
) =>
  useQuery<MissingPunchItem[]>({
    queryKey: ["/api/missing-punch-requests", status],
    queryFn: () => customFetch<MissingPunchItem[]>(`/api/missing-punch-requests?status=${status}`),
    refetchInterval: 30_000,
    enabled,
  });

export const useUpdateMissingPunchHR = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status, comment }: { id: number; status: "approved" | "rejected"; comment?: string }) =>
      customFetch<MissingPunchItem>(`/api/missing-punch-requests/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status, comment }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: getMissingPunchRequestsQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["/api/attendance/employee-monthly"] });
    },
  });
};
