import { useState, useRef, useEffect, useMemo, memo, type ReactNode } from "react";
import { Redirect, useLocation } from "wouter";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { TONE } from "@/lib/statusTones";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import { Gate, ViewOnlyTabNote, pickVisible, useLevel, useViewOnlyLock, visibleItems } from "@/lib/tab-access";
import {
  useAttendanceDaily,
  useAttendanceEmployeeHistory, useCreateManualAttendance, useListEmployeesLite,
  getAttendanceSummaryQueryKey, getAttendanceDailyQueryKey,
  getAttendanceMonthlyTrendQueryKey,
} from "@/lib/api-client";
import {
  useAttendanceSummaryTyped, useAttendanceTrendTyped,
  useListBiometricDevices, type SyncBiometricMode, type SyncDeviceId,
  getAutoSyncRulesQueryKey, useCreateAutoSyncRule, useUpdateAutoSyncRule, useDeleteAutoSyncRule,
  type AutoSyncRuleItem, type AutoSyncRuleInput,
  type BiometricDeviceItem,
  usePayrollSettings, useListHolidays,
} from "@/lib/api-client/custom-hooks";
import type { Employee } from "@/lib/api-client";
import { lateDetectionFlags } from "@/lib/late-detection";
import { DayFlagBadges } from "@/components/DayFlagBadges";
import { CompensationChip, CompensationLegend, countMarks } from "@/components/attendance-compensation";
import { useBiometricSync } from "@/contexts/BiometricSyncContext";
import { TimePicker12h } from "@/components/ui/time-picker-12h";
import { MarbleSwitch } from "@/components/ui/marble-switch";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import BiometricSyncPipeline from "@/components/BiometricSyncPipeline";
import { SkippedPunchesButton } from "@/components/SkippedPunchesButton";
import { SyncStatusIndicator } from "@/components/SyncStatusIndicator";
import AttendanceSearchSection from "./AttendanceSearch";
import { RollCall } from "./attendance/RollCall";
import { ArrivalsChart } from "./attendance/ArrivalsChart";
import { DayList } from "./attendance/DayList";
import { MonthPanel } from "./attendance/MonthPanel";
import { PunchSources } from "./attendance/PunchSources";
import { PunchTimeline } from "./attendance/PunchTimeline";
import { arrivalCurve, arrivalStats, countBoard, parseStatusFilter, type StatusFilter } from "./attendance/logic";
import {
  Plus, Factory, Briefcase, Fingerprint, PenLine, Search, Radar, ChevronLeft, ChevronRight,
} from "lucide-react";

const HISTORY_STATUS_META: Record<string, { label: string; cls: string }> = {
  present:    { label: "Present",    cls: TONE.success },
  half_shift: { label: "Half Shift", cls: TONE.warning },
  absent:     { label: "Absent",     cls: TONE.danger },
  on_leave:   { label: "On Leave",   cls: TONE.info },
  holiday:    { label: "Holiday",    cls: TONE.neutral },
  future:     { label: "Upcoming",   cls: "bg-gray-50 text-gray-400 border-gray-200" },
};

// ── Helpers ────────────────────────────────────────────────────────────────

/** The local calendar date (YYYY-MM-DD): the factory's day, not the UTC one (which is still yesterday before 05:30 IST). */
const localIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = () => localIso(new Date());
const shiftDay = (iso: string, by: number) => {
  const [y, m, d] = iso.split("-").map(Number);
  return localIso(new Date(y, m - 1, d + by));
};
const nextIso = (iso: string) => shiftDay(iso, 1);

/** What the page keeps in its address (?date=&month=&year=&status=), so coming back from another page (the Attendance Edit
 *  page, a details page) or reloading lands on the same day, month and filter. A value at its default stays out of it. */
const ATTENDANCE_URL_DEFAULTS = { date: "", month: "", year: "", status: "all" } as const;
const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Main Page ──────────────────────────────────────────────────────────────
//
// Staff / Production Attendance (2026-11-06 redesign). Top to bottom: the title row (the MD portal slots its own pieces into
// it, so its shape stays: title block + one group of buttons), the day's roll call with the status cards that filter the
// list, when people arrived, the list itself with every punch, the month with its report, where the day's punches came from,
// and the employee search. Everything on it reads the same endpoints as before plus the additive daily keys (punches,
// leaveState ...); nothing here computes or changes an attendance verdict.

type AttendanceView = "staff" | "production";

/** The Staff / Production switch and the permission key of each (Account Management -> Roles & Permissions). */
const ATTENDANCE_VIEWS: { value: AttendanceView; label: string; icon: ReactNode }[] = [
  { value: "staff", label: "Staff", icon: <Briefcase size={12} /> },
  { value: "production", label: "Production", icon: <Factory size={12} /> },
];
const ATTENDANCE_VIEW_KEY: Record<AttendanceView, string> = {
  staff: "attendance.staff",
  production: "attendance.production",
};

/** Staff / Production are addresses of their own (the route guard blocks a hidden one); the bare /hr/attendance shows Staff,
 *  or Production when Staff is hidden for this role, or a short note when neither is open to it. */
export default function AttendancePage() {
  const [location] = useLocation();
  const level = useLevel();
  const views = visibleItems(ATTENDANCE_VIEWS, (v) => ATTENDANCE_VIEW_KEY[v.value], level);
  const asked: AttendanceView = location.includes("/attendance/production") ? "production" : "staff";
  const view = pickVisible(asked, views.map((v) => v.value));

  if (views.length === 0) {
    return (
      <HrLayout>
        <p
          className="rounded-2xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground"
          data-testid="nothing-open"
        >
          Nothing on this page is open to your role.
        </p>
      </HrLayout>
    );
  }
  if (view !== asked) return <Redirect to={`/hr/attendance/${view}`} replace />;
  return <AttendanceDay view={view} views={views} />;
}

function AttendanceDay({ view, views }: { view: AttendanceView; views: typeof ATTENDANCE_VIEWS }) {
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();
  const { user } = useAuth();
  const level = useLevel();
  // Staff / Production on the bare /hr/attendance (no address of its own there): HrLayout locks a View-only address, this
  // locks the view when only it is View-only
  const viewOnlyHere =
    !isRouteViewOnly(user, location, moduleForPath(location)) && level(ATTENDANCE_VIEW_KEY[view]) === "view";
  useViewOnlyLock(viewOnlyHere, view);

  const [urlState, setUrlState] = useUrlParams<Record<keyof typeof ATTENDANCE_URL_DEFAULTS, string>>(
    ATTENDANCE_URL_DEFAULTS,
  );
  const selectedDate = urlState.date || today();
  const selectedMonth = Number(urlState.month) || currentMonth();
  const selectedYear = Number(urlState.year) || currentYear();
  const setSelectedDate = (v: string) => setUrlState({ date: v });
  const setSelectedMonth = (v: number) => setUrlState({ month: String(v) });
  const setSelectedYear = (v: number) => setUrlState({ year: String(v) });
  // Staff / Production sub-section -derived from the route so the sidebar
  // stays in sync (/hr/attendance/staff | /hr/attendance/production); `view` is the one AttendancePage chose
  const setView = (v: "staff" | "production") => navigate(`/hr/attendance/${v}`);

  const [showManualDialog, setShowManualDialog] = useState(false);

  const statusFilter = parseStatusFilter(urlState.status);
  const setStatusFilter = (v: StatusFilter) => setUrlState({ status: v });
  const [detailEmpId, setDetailEmpId] = useState<number | null>(null);
  const [syncMode, setSyncMode] = useState<SyncBiometricMode>("day");
  // Multi-select checklist: which specific devices to sync. Empty selection
  // means "use the default" (every enabled device), same as before.
  const [selectedDeviceIds, setSelectedDeviceIds] = useState<(number | "env")[]>([]);
  // NOTE: showSyncMenu / syncMenuRef / handleSync, and the Auto Sync state
  // further down, are intentionally retained while their buttons are hidden
  // (see the header). They are the working implementations of Sync Biometric
  // and Auto Sync -kept so those features can be switched back on by
  // restoring the header block alone, rather than rewritten from scratch, if
  // inbound access to the devices is ever configured.
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const syncMenuRef = useRef<HTMLDivElement>(null);

  const { data: employees } = useListEmployeesLite({ status: "active" });
  const { data: devices } = useListBiometricDevices();
  const enabledDevices = useMemo(() => (devices ?? []).filter(d => d.isActive), [devices]);

  // Sync lives in a root-level context (BiometricSyncProvider) so it keeps
  // running -and stays visible -even if the user navigates away mid-sync.
  const { isSyncing, showPipeline, progress, lastSyncedAt, triggerSync, dismiss } = useBiometricSync();

  const syncModeLabel = SYNC_MODES.find(m => m.key === syncMode)?.label ?? "Last Day";
  const allDevicesSelected = enabledDevices.length > 0 && selectedDeviceIds.length === enabledDevices.length;

  const toggleDevice = (id: number | "env") => {
    setSelectedDeviceIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleSelectAllDevices = () => {
    setSelectedDeviceIds(prev => prev.length === enabledDevices.length ? [] : enabledDevices.map(d => d.id));
  };

  const handleSync = (modeOverride?: SyncBiometricMode) => {
    const mode = modeOverride ?? syncMode;
    setShowSyncMenu(false);
    // No specific devices checked -> same default as before (every enabled device).
    const deviceId: SyncDeviceId = selectedDeviceIds.length > 0 ? selectedDeviceIds : "all";
    void triggerSync(mode, deviceId);
  };

  // ── Auto Sync (configurable background biometric sync rules) ───────────────
  // The rule form itself (and its state) lives in AutoSyncRuleForm; the page only says which rule is being edited and
  // bumps `ruleDialogSeq` on every open so the form always starts afresh.
  const [showAutoSyncMenu, setShowAutoSyncMenu] = useState(false);
  const autoSyncMenuRef = useRef<HTMLDivElement>(null);
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<AutoSyncRuleItem | null>(null);
  const [ruleDialogSeq, setRuleDialogSeq] = useState(0);

  // The rules belong to "Sync from devices and Auto Sync rules" (attendance.sync): a role without it never asks for them.
  const { data: autoSyncRules } = useQuery<AutoSyncRuleItem[]>({
    queryKey: getAutoSyncRulesQueryKey(),
    queryFn: () => customFetch<AutoSyncRuleItem[]>("/api/auto-sync-rules"),
    refetchInterval: 60_000,
    enabled: level("attendance.sync") !== "hidden",
  });
  const createAutoSyncRule = useCreateAutoSyncRule();
  const updateAutoSyncRule = useUpdateAutoSyncRule();
  const deleteAutoSyncRule = useDeleteAutoSyncRule();

  const { lastAutoSyncLabel, activeRuleCount } = useMemo(() => {
    const lastAutoSyncAt = (autoSyncRules ?? [])
      .map(r => r.lastRunAt)
      .filter((v): v is string => !!v)
      .sort()
      .at(-1);
    return {
      lastAutoSyncLabel: lastAutoSyncAt
        ? new Date(lastAutoSyncAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
        : null,
      activeRuleCount: (autoSyncRules ?? []).filter(r => r.isEnabled).length,
    };
  }, [autoSyncRules]);

  const openAddRule = () => {
    setEditingRule(null);
    setRuleDialogSeq(n => n + 1);
    setShowAutoSyncMenu(false);
    setRuleDialogOpen(true);
  };
  const openEditRule = (rule: AutoSyncRuleItem) => {
    setEditingRule(rule);
    setRuleDialogSeq(n => n + 1);
    setShowAutoSyncMenu(false);
    setRuleDialogOpen(true);
  };
  const toggleRuleEnabled = (rule: AutoSyncRuleItem) => {
    updateAutoSyncRule.mutate({ id: rule.id, data: { isEnabled: !rule.isEnabled } });
  };
  const removeRule = (rule: AutoSyncRuleItem) => {
    if (!window.confirm(`Delete the ${rule.time} Auto Sync rule?`)) return;
    deleteAutoSyncRule.mutate(rule.id);
  };

  // The context invalidates "/api/attendance" queries broadly on completion;
  // this page just needs to also refresh the one-employee history dialog key
  // (not covered by that prefix) when a sync finishes while it's open.
  const prevIsSyncing = useRef(isSyncing);
  useEffect(() => {
    if (prevIsSyncing.current && !isSyncing && detailEmpId) {
      queryClient.invalidateQueries({ queryKey: ["attendance-employee", detailEmpId] });
    }
    prevIsSyncing.current = isSyncing;
  }, [isSyncing, detailEmpId, queryClient]);

  // Summary + trend are filtered server-side by the selected sub-section
  const { data: summary } = useAttendanceSummaryTyped(selectedDate, view);
  const { data: dailyList, isLoading: dailyLoading }  = useAttendanceDaily(selectedDate);
  const { data: monthlyTrend } = useAttendanceTrendTyped(selectedYear, selectedMonth, view);
  const { data: holidays } = useListHolidays({ year: Number(selectedDate.slice(0, 4)) });

  // Records for the active sub-section, the card counts and the arrival curve -worked out once per day's list / view, not
  // on every render of the page (a sync progress tick, a dialog opening).
  const { allRecords, counts, curve, stats } = useMemo(() => {
    const records = (dailyList ?? []).filter((r) => r.employmentType === view);
    return {
      allRecords: records,
      counts: countBoard(records),
      curve: arrivalCurve(records),
      stats: arrivalStats(records),
    };
  }, [dailyList, view]);

  const holiday = useMemo(() => {
    const h = (holidays ?? []).find((x) => x.date === selectedDate);
    return h ? `${h.name}${h.branchName ? ` (${h.branchName})` : ""}` : null;
  }, [holidays, selectedDate]);
  const isSunday = useMemo(() => {
    const [y, m, d] = selectedDate.split("-").map(Number);
    return new Date(y, m - 1, d).getDay() === 0;
  }, [selectedDate]);

  return (
    <HrLayout>
      <div className="space-y-5">

        {/* ── Header (the MD portal adopts this row: keep a title block + one group of buttons) ── */}
        <div className="flex flex-wrap lg:flex-nowrap items-start justify-between gap-3">
          {/* shrink-0 on wide screens only: on a phone the title block may not be wider than the screen */}
          <div className="min-w-0 max-w-full lg:shrink-0">
            <h2 className="text-2xl font-black tracking-tight text-gray-900">
              {view === "staff" ? "Staff Attendance" : "Production Attendance"}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              See who is in, check every punch, and export the day or the month.
            </p>
            {/* Staff / Production sub-section toggle */}
            <div className="mt-2">
              <PillTabs
                items={views}
                value={view}
                onChange={(v) => setView(v as "staff" | "production")}
              />
            </div>
          </div>
          <div className="flex min-w-0 items-center gap-2 flex-wrap justify-end">
            {/* Manual Import, Sync Biometric and Auto Sync are hidden, not
                deleted: all three worked by having the backend open a direct
                connection to a device on the factory LAN, which is impossible
                now that the backend runs in the cloud. Their code and routes
                are intact -re-enable this block if inbound access to the
                devices is ever set up (see biometric-integration.md). The
                buttons below replace them with equivalents that read the
                database instead, so they work regardless of where the backend
                runs. */}
            <Gate k="attendance.skipped_punches">
              <SkippedPunchesButton />
            </Gate>
            <Gate k="attendance.punch_view">
              <Button
                variant="outline"
                onClick={() => navigate("/hr/attendance/punch-view")}
                className="clay-btn gap-1.5 h-9 px-3 rounded-xl border-0 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-700 shrink-0"
              >
                <Fingerprint size={14} />
                <span className="text-[13px] font-semibold">Punch View</span>
              </Button>
            </Gate>
            <Gate k="biometric_connectors.device_status">
              <Button
                variant="outline"
                onClick={() => navigate("/hr/Biometric-Connectors/device-status")}
                className="clay-btn gap-1.5 h-9 px-3 rounded-xl border-0 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-700 shrink-0"
                data-testid="open-device-status"
              >
                <Radar size={14} />
                <span className="text-[13px] font-semibold">Device Status</span>
              </Button>
            </Gate>
            {/* the "Sync Live / Offline" pill stands where the Sync / Auto Sync buttons were */}
            <Gate k="attendance.sync">
              <SyncStatusIndicator />
            </Gate>
            <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Day">
              <button
                type="button"
                onClick={() => setSelectedDate(shiftDay(selectedDate, -1))}
                className="inline-flex h-9 w-8 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                aria-label="Previous day"
                data-testid="attendance-prev-day"
              >
                <ChevronLeft size={16} aria-hidden="true" />
              </button>
              <Input
                type="date"
                value={selectedDate}
                onChange={(e) => e.target.value && setSelectedDate(e.target.value)}
                aria-label="Attendance date"
                className="clay-input h-9 text-sm w-36 shrink-0 rounded-xl"
                data-testid="attendance-date"
              />
              <button
                type="button"
                onClick={() => setSelectedDate(shiftDay(selectedDate, 1))}
                disabled={selectedDate >= today()}
                className="inline-flex h-9 w-8 items-center justify-center rounded-xl text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 disabled:opacity-40 disabled:hover:bg-transparent"
                aria-label="Next day"
                data-testid="attendance-next-day"
              >
                <ChevronRight size={16} aria-hidden="true" />
              </button>
              {selectedDate !== today() && (
                <button
                  type="button"
                  onClick={() => setSelectedDate(today())}
                  className="h-9 rounded-xl px-2.5 text-xs font-semibold text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  data-testid="attendance-today"
                >
                  Today
                </button>
              )}
            </div>
            <Gate k="attendance.add_manual">
              <Button
                onClick={() => setShowManualDialog(true)}
                className="clay-btn gap-1.5 h-9 px-3.5 rounded-xl border-0 bg-gradient-to-br from-[#006496] to-[#0080bf] text-white hover:brightness-105 shrink-0"
              >
                <Plus size={14} />
                <span className="text-[13px] font-semibold">Add Attendance</span>
              </Button>
            </Gate>
          </div>
        </div>

        <ViewOnlyTabNote show={viewOnlyHere} />

        {/* ── Biometric Sync Pipeline (visible only while/just after syncing) ── */}
        <BiometricSyncPipeline active={showPipeline} data={progress} onDismiss={dismiss} />

        {/* ── The day at a glance: the roll call, whose cards filter the list right under it ── */}
        <RollCall
          counts={counts}
          loading={dailyLoading}
          filter={statusFilter}
          onFilter={setStatusFilter}
          date={selectedDate}
          isToday={selectedDate === today()}
          holidayName={holiday}
          isSunday={isSunday}
          view={view}
          summary={summary}
        />

        {/* ── Production shift structure info ── */}
        {view === "production" && (
          <div className="flex items-start gap-3 rounded-2xl border border-orange-100 bg-orange-50/50 px-4 py-3 text-xs text-orange-900">
            <Factory size={16} className="shrink-0 mt-0.5 text-orange-600" aria-hidden="true" />
            <p className="leading-relaxed">
              <strong className="font-bold">Production 1.5-shift day:</strong>{" "}
              <strong>08:30–12:30</strong> first half (0.5), <strong>13:30–17:30</strong> second half (0.5),{" "}
              <strong>17:50–20:00</strong> additional half (0.5), up to <strong>1.5 shifts a day</strong>. Windows are set in
              Manage Shifts (Production). A night punch after midnight is shown on the day the shift began, marked +1.
            </p>
          </div>
        )}

        {/* ── Everyone on the day ── */}
        <DayList
          rows={allRecords}
          loading={dailyLoading}
          date={selectedDate}
          view={view}
          filter={statusFilter}
          onFilter={setStatusFilter}
          onOpen={setDetailEmpId}
        />

        {/* ── When people arrived, and where the day's punches came from ── */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ArrivalsChart curve={curve} stats={stats} loading={dailyLoading} />
          <PunchSources rows={allRecords} loading={dailyLoading} date={selectedDate} />
        </div>

        {/* ── The month, with its report ── */}
        <MonthPanel
          trend={monthlyTrend ?? []}
          month={selectedMonth}
          year={selectedYear}
          onMonth={setSelectedMonth}
          onYear={setSelectedYear}
          view={view}
        />

        {/* ── Employee Search + Manual Overrides ── */}
        <Gate k="attendance.employee_search">
          <AttendanceSearchPanel employmentType={view} />
        </Gate>

      </div>

      {/* ── Manual Attendance Dialog ── */}
      <ManualAttendanceDialog
        open={showManualDialog}
        onOpenChange={setShowManualDialog}
        employees={employees}
        selectedDate={selectedDate}
        selectedYear={selectedYear}
        selectedMonth={selectedMonth}
      />

      {/* ── Auto Sync Rule Dialog ── */}
      <Dialog open={ruleDialogOpen} onOpenChange={setRuleDialogOpen}>
        <DialogContent className="max-w-md">
          <AutoSyncRuleForm
            key={ruleDialogSeq}
            editingRule={editingRule}
            enabledDevices={enabledDevices}
            createAutoSyncRule={createAutoSyncRule}
            updateAutoSyncRule={updateAutoSyncRule}
            onClose={() => setRuleDialogOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* ── Employee Detail Dialog ── */}
      <EmployeeHistoryDialog
        detailEmpId={detailEmpId}
        onSelectEmployee={setDetailEmpId}
        employees={employees}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
        onMonthChange={setSelectedMonth}
        onYearChange={setSelectedYear}
      />
    </HrLayout>
  );
}

/** The Employee Attendance Search card. memo: it takes one prop, so the page's own re-renders skip it. */
const AttendanceSearchPanel = memo(AttendanceSearchSection);

// ── Dialogs ────────────────────────────────────────────────────────────────
// Each dialog keeps its own form state, so typing in one re-renders only that dialog, not the page with its charts,
// table and the day's filtered list.

const SYNC_MODES: { key: SyncBiometricMode; label: string }[] = [
  { key: "day",   label: "Today" },
  { key: "week",  label: "Last One Week" },
  { key: "month", label: "Last One Month" },
  { key: "all",   label: "All Records" },
];

const DAYS_OF_WEEK: { key: string; label: string }[] = [
  { key: "mon", label: "Mon" }, { key: "tue", label: "Tue" }, { key: "wed", label: "Wed" },
  { key: "thu", label: "Thu" }, { key: "fri", label: "Fri" }, { key: "sat", label: "Sat" }, { key: "sun", label: "Sun" },
];

const EMPTY_RULE_FORM: AutoSyncRuleInput = { name: "", time: "07:30", daysOfWeek: "*", deviceSelection: [], mode: "day", isEnabled: true };

const EMPTY_MANUAL_FORM = { employeeId: "", punchTime: "", punchType: "IN", notes: "", hoursWorked: "" };

/** Add Attendance Manually. Always mounted (only the dialog's content comes and goes), so a half-filled form survives
 *  Cancel and reopening, as it did when this state lived on the page. */
function ManualAttendanceDialog({
  open,
  onOpenChange,
  employees,
  selectedDate,
  selectedYear,
  selectedMonth,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[] | undefined;
  selectedDate: string;
  selectedYear: number;
  selectedMonth: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const createManual = useCreateManualAttendance();
  const [manualForm, setManualForm] = useState(() => ({ ...EMPTY_MANUAL_FORM, date: today() }));

  const addManualAttendance = async () => {
    if (!manualForm.employeeId || !manualForm.date) {
      toast({ title: "Please select an employee and date", variant: "destructive" });
      return;
    }
    try {
      await createManual.mutateAsync({
        employeeId: Number(manualForm.employeeId),
        date: manualForm.date,
        punchTime: manualForm.punchTime || undefined,
        punchType: manualForm.punchType,
        notes: manualForm.notes || undefined,
        hoursWorked: manualForm.hoursWorked ? Number(manualForm.hoursWorked) : undefined,
      });
    } catch (err: any) {
      toast({ title: err?.message ?? "Failed to add attendance", variant: "destructive" });
      return;
    }
    toast({ title: "Attendance recorded successfully" });
    onOpenChange(false);
    setManualForm({ employeeId: "", date: today(), punchTime: "", punchType: "IN", notes: "", hoursWorked: "" });
    queryClient.invalidateQueries({ queryKey: getAttendanceSummaryQueryKey(selectedDate) });
    queryClient.invalidateQueries({ queryKey: getAttendanceDailyQueryKey(selectedDate) });
    queryClient.invalidateQueries({ queryKey: getAttendanceMonthlyTrendQueryKey(selectedYear, selectedMonth) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add Attendance Manually</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground -mt-2">
          Use this when the biometric device missed a punch. Verify with CCTV before adding.
        </p>
        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>Employee</Label>
            <EmployeeSearchSelect
              employees={employees}
              value={manualForm.employeeId}
              onChange={(v) => setManualForm((f) => ({ ...f, employeeId: v }))}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Date</Label>
              <Input
                type="date"
                value={manualForm.date}
                onChange={(e) => setManualForm((f) => ({ ...f, date: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Punch Time (optional)</Label>
              <Input
                type="time"
                value={manualForm.punchTime}
                onChange={(e) => setManualForm((f) => ({ ...f, punchTime: e.target.value }))}
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Punch Type</Label>
              <select
                value={manualForm.punchType}
                onChange={(e) => setManualForm((f) => ({ ...f, punchType: e.target.value }))}
                className="w-full h-9 rounded-md border px-3 text-sm bg-background"
              >
                <option value="IN">Check In</option>
                <option value="OUT">Check Out</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Hours Worked (optional)</Label>
              <Input
                type="number" min="0" max="24" step="0.5"
                placeholder="e.g. 8"
                value={manualForm.hoursWorked}
                onChange={(e) => setManualForm((f) => ({ ...f, hoursWorked: e.target.value }))}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Input
              placeholder="e.g. CCTV verified – entry gate 2"
              value={manualForm.notes}
              onChange={(e) => setManualForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </div>
          <div className="flex gap-3 pt-1">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="flex-1" onClick={addManualAttendance} disabled={createManual.isPending}>
              {createManual.isPending ? "Saving…" : "Save Attendance"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The Auto Sync rule form (inside the dialog's content). Every way of opening the dialog starts it afresh -empty for a new
 *  rule, the rule's values for an edit -which the page guarantees by giving it a new `key` each time it opens. */
function AutoSyncRuleForm({
  editingRule,
  enabledDevices,
  createAutoSyncRule,
  updateAutoSyncRule,
  onClose,
}: {
  editingRule: AutoSyncRuleItem | null;
  enabledDevices: BiometricDeviceItem[];
  createAutoSyncRule: ReturnType<typeof useCreateAutoSyncRule>;
  updateAutoSyncRule: ReturnType<typeof useUpdateAutoSyncRule>;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const editingRuleId = editingRule ? editingRule.id : null;
  const [ruleForm, setRuleForm] = useState<AutoSyncRuleInput>(() =>
    editingRule
      ? {
          name: editingRule.name, time: editingRule.time, daysOfWeek: editingRule.daysOfWeek,
          deviceSelection: editingRule.deviceSelection, mode: editingRule.mode, isEnabled: editingRule.isEnabled,
        }
      : EMPTY_RULE_FORM,
  );

  const selectedDays = ruleForm.daysOfWeek === "*" || !ruleForm.daysOfWeek
    ? DAYS_OF_WEEK.map(d => d.key)
    : ruleForm.daysOfWeek.split(",").filter(Boolean);
  const toggleRuleDay = (key: string) => {
    const next = selectedDays.includes(key) ? selectedDays.filter(d => d !== key) : [...selectedDays, key];
    const value = next.length === 0 || next.length === 7
      ? "*"
      : DAYS_OF_WEEK.filter(d => next.includes(d.key)).map(d => d.key).join(",");
    setRuleForm(f => ({ ...f, daysOfWeek: value }));
  };
  const toggleRuleDevice = (id: number | "env") => {
    setRuleForm(f => {
      const sel = f.deviceSelection ?? [];
      return { ...f, deviceSelection: sel.includes(id) ? sel.filter(x => x !== id) : [...sel, id] };
    });
  };

  const saveRule = () => {
    if (!ruleForm.time) {
      toast({ title: "Time is required", variant: "destructive" });
      return;
    }
    const onSuccess = () => {
      toast({ title: editingRuleId ? "Auto Sync rule updated" : "Auto Sync rule added" });
      onClose();
    };
    const onError = (err: any) => toast({ title: err?.message ?? "Failed to save Auto Sync rule", variant: "destructive" });
    if (editingRuleId) {
      updateAutoSyncRule.mutate({ id: editingRuleId, data: ruleForm }, { onSuccess, onError });
    } else {
      createAutoSyncRule.mutate(ruleForm, { onSuccess, onError });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{editingRuleId ? "Edit Auto Sync Rule" : "Add Auto Sync Rule"}</DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Label (optional)</Label>
          <Input
            placeholder="e.g. Morning sync"
            value={ruleForm.name ?? ""}
            onChange={(e) => setRuleForm(f => ({ ...f, name: e.target.value }))}
          />
        </div>

        <TimePicker12h
          label="Time"
          value={ruleForm.time ?? "07:30"}
          onChange={(v) => setRuleForm(f => ({ ...f, time: v }))}
        />

        <div className="space-y-1.5">
          <Label>Repeat on</Label>
          <div className="flex gap-1.5 flex-wrap">
            {DAYS_OF_WEEK.map(d => (
              <button
                key={d.key}
                type="button"
                onClick={() => toggleRuleDay(d.key)}
                className={`h-8 px-2.5 rounded-lg text-xs font-semibold border transition-colors ${
                  selectedDays.includes(d.key)
                    ? "bg-cyan-600 text-white border-cyan-600"
                    : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Sync range</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {SYNC_MODES.map(m => (
              <button
                key={m.key}
                type="button"
                onClick={() => setRuleForm(f => ({ ...f, mode: m.key }))}
                className={`h-8 px-2.5 rounded-lg text-xs font-semibold border transition-colors ${
                  ruleForm.mode === m.key
                    ? "bg-cyan-600 text-white border-cyan-600"
                    : "bg-white text-gray-500 border-gray-200 hover:bg-gray-50"
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Devices</Label>
          <div className="border rounded-lg max-h-32 overflow-y-auto">
            <label className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer border-b">
              <input
                type="checkbox"
                checked={(ruleForm.deviceSelection ?? []).length === 0}
                onChange={() => setRuleForm(f => ({ ...f, deviceSelection: [] }))}
                className="accent-cyan-600"
              />
              <span className={(ruleForm.deviceSelection ?? []).length === 0 ? "text-cyan-700 font-semibold" : "text-gray-700"}>
                All enabled devices
              </span>
            </label>
            {enabledDevices.map(d => (
              <label key={d.id} className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={(ruleForm.deviceSelection ?? []).includes(d.id)}
                  onChange={() => toggleRuleDevice(d.id)}
                  className="accent-cyan-600"
                />
                <span className={(ruleForm.deviceSelection ?? []).includes(d.id) ? "text-cyan-700 font-semibold" : "text-gray-700"}>
                  {d.name}
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 text-sm">
          <MarbleSwitch
            id="auto-sync-rule-form-enabled"
            checked={ruleForm.isEnabled ?? true}
            onChange={() => setRuleForm(f => ({ ...f, isEnabled: !(f.isEnabled ?? true) }))}
          />
          Enabled
        </div>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" className="flex-1" onClick={onClose}>Cancel</Button>
          <Button
            className="flex-1"
            onClick={saveRule}
            disabled={createAutoSyncRule.isPending || updateAutoSyncRule.isPending}
          >
            {createAutoSyncRule.isPending || updateAutoSyncRule.isPending ? "Saving…" : "Save Rule"}
          </Button>
        </div>
      </div>
    </>
  );
}

/** One employee's month, opened by clicking a row. Owns its search box, so typing a name re-renders only this dialog. */
function EmployeeHistoryDialog({
  detailEmpId,
  onSelectEmployee,
  employees,
  selectedMonth,
  selectedYear,
  onMonthChange,
  onYearChange,
}: {
  detailEmpId: number | null;
  onSelectEmployee: (id: number | null) => void;
  employees: Employee[] | undefined;
  selectedMonth: number;
  selectedYear: number;
  onMonthChange: (month: number) => void;
  onYearChange: (year: number) => void;
}) {
  const [historySearch, setHistorySearch] = useState("");
  const { data: empDetail, isLoading: empDetailLoading } = useAttendanceEmployeeHistory(
    detailEmpId, selectedMonth, selectedYear,
  );
  // Half-Day times from Settings → Attendance, to say which half a Half Shift day was worked in.
  const { data: attSettings } = usePayrollSettings();
  const halfDayCutoffs = {
    firstHalfEnd: attSettings?.halfDayFirstHalfEndTime,
    secondHalfStart: attSettings?.halfDaySecondHalfStartTime,
  };

  // Each employee's code and name lower-cased once per roster, not on every keystroke.
  const searchIndex = useMemo(
    () => (employees ?? []).map(emp => ({
      emp,
      code: emp.employeeCode.toLowerCase(),
      name: `${emp.firstName} ${emp.lastName}`.toLowerCase(),
    })),
    [employees],
  );
  const historyQuery = historySearch.trim().toLowerCase();
  const historyMatches = useMemo(
    () => historyQuery
      ? searchIndex.filter(x => x.code.includes(historyQuery) || x.name.includes(historyQuery)).slice(0, 5).map(x => x.emp)
      : [],
    [searchIndex, historyQuery],
  );

  return (
    <Dialog
      open={!!detailEmpId}
      onOpenChange={(open) => { if (!open) { onSelectEmployee(null); setHistorySearch(""); } }}
    >
      <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {empDetail ? `${empDetail.employee.name} -Attendance History` : "Attendance History"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2 relative">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              className="pl-8 h-8 text-xs"
              placeholder="Search by employee code or name…"
              value={historySearch}
              onChange={e => setHistorySearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === "Enter") {
                  const q = historySearch.trim().toLowerCase();
                  const found = searchIndex.find(x => x.code === q || x.name.includes(q))?.emp;
                  if (found) { onSelectEmployee(found.id); setHistorySearch(""); }
                }
              }}
            />
          </div>
          {historyMatches.length > 0 ? (
            <div className="absolute z-50 mt-8 left-0 right-0 bg-white border rounded-xl shadow-lg overflow-hidden">
              {historyMatches.map(emp => (
                <button
                  key={emp.id}
                  className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-sm"
                  onClick={() => { onSelectEmployee(emp.id); setHistorySearch(""); }}
                >
                  <span className="font-mono text-xs text-gray-400 w-16 shrink-0">{emp.employeeCode}</span>
                  <span className="font-medium">{emp.firstName} {emp.lastName}</span>
                  {emp.departmentName && <span className="text-xs text-gray-400 ml-auto">{emp.departmentName}</span>}
                </button>
              ))}
            </div>
          ) : null}
          <select
            value={selectedMonth}
            onChange={(e) => onMonthChange(Number(e.target.value))}
            className="h-8 rounded-md border px-2 text-xs bg-background"
          >
            {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <Input
            type="number"
            value={selectedYear}
            onChange={(e) => onYearChange(Number(e.target.value))}
            className="w-20 h-8 text-xs"
            min={2020} max={2030}
          />
        </div>

        {empDetailLoading ? (
          <div className="space-y-3 py-4">
            {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : empDetail ? (() => {
          const holidays = empDetail.records.filter(r => r.status === "holiday").length;
          const upcoming = empDetail.records.filter(r => r.status === "future").length;
          const elapsedWorkable = empDetail.records.length - holidays - upcoming;
          const attendanceRate = elapsedWorkable > 0
            ? Math.round((empDetail.totalPresent / elapsedWorkable) * 100)
            : 0;
          const earlyOutDays = empDetail.records.filter(r => r.isEarlyOut).length;
          // Penalty Early Out days (left more than the penalty minutes early: part of the day deducted, not a late-pool mark)
          const penaltyDays = empDetail.records.filter(r => r.isPenaltyEarlyOut).length;
          // Days on which the employee used a compensation (OT allowance, announced window, birthday, relaxation).
          const compensationCounts = countMarks(empDetail.records);
          return (
          <div className="flex flex-col gap-4 overflow-hidden">
            {/* ── Profile + month summary ── */}
            <div className="flex flex-col gap-3 p-4 bg-gray-50 rounded-xl text-sm">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-gray-500">Code <strong className="text-gray-800 font-mono">{empDetail.employee.code}</strong></span>
                {empDetail.employee.designation && (
                  <span className="text-gray-500">Designation <strong className="text-gray-800">{empDetail.employee.designation}</strong></span>
                )}
                {empDetail.employee.department && (
                  <span className="text-gray-500">Dept <strong className="text-gray-800">{empDetail.employee.department}</strong></span>
                )}
                <span className="text-gray-500">Type <strong className="text-gray-800 capitalize">{empDetail.employee.employmentType}</strong></span>
                <span className="ml-auto flex items-center gap-1.5">
                  <span className="text-xs text-gray-400">Attendance</span>
                  <span className={`text-base font-black ${attendanceRate >= 90 ? "text-green-600" : attendanceRate >= 75 ? "text-amber-600" : "text-red-600"}`}>
                    {attendanceRate}%
                  </span>
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
                <div className="bg-white rounded-lg px-3 py-2 border border-green-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Present</p>
                  <p className="text-lg font-black text-green-700">{empDetail.totalPresent}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 border border-amber-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Half Shift</p>
                  <p className="text-lg font-black text-amber-600">{empDetail.summary.halfShift}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 border border-amber-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Late</p>
                  <p className="text-lg font-black text-amber-600">{empDetail.summary.late}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 border border-orange-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Early Out</p>
                  <p className="text-lg font-black text-orange-600">{earlyOutDays}</p>
                </div>
                {penaltyDays > 0 && (
                  <div className="bg-white rounded-lg px-3 py-2 border border-red-100" data-testid="history-penalty-early-out">
                    <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Penalty Early Out</p>
                    <p className="text-lg font-black text-red-600">{penaltyDays}</p>
                  </div>
                )}
                <div className="bg-white rounded-lg px-3 py-2 border border-red-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Absent</p>
                  <p className="text-lg font-black text-red-600">{empDetail.totalAbsent}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 border border-purple-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">On Leave</p>
                  <p className="text-lg font-black text-purple-600">{empDetail.summary.onLeave}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 border border-slate-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Holidays</p>
                  <p className="text-lg font-black text-slate-500">{holidays}</p>
                </div>
                <div className="bg-white rounded-lg px-3 py-2 border border-gray-100">
                  <p className="text-[10px] uppercase tracking-wide text-gray-400 font-semibold">Upcoming</p>
                  <p className="text-lg font-black text-gray-400">{upcoming}</p>
                </div>
              </div>
              <CompensationLegend counts={compensationCounts} />
            </div>

            {/* ── Day-by-day breakdown ── */}
            <div className="overflow-y-auto flex-1">
              {empDetail.records.length === 0 ? (
                <p className="text-center py-8 text-muted-foreground text-sm">No attendance records found.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b">
                      <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Date</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Punches</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase hidden sm:table-cell">Source</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase hidden lg:table-cell">Hours</th>
                      <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase hidden lg:table-cell">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {empDetail.records.map((rec) => {
                      const meta = HISTORY_STATUS_META[rec.status] ?? HISTORY_STATUS_META.absent;
                      const isDim = rec.status === "future" || rec.status === "holiday";
                      return (
                      <tr key={rec.date} className={`border-b hover:bg-gray-50 ${isDim ? "opacity-70" : ""}`}>
                        <td className="py-2.5 px-3">
                          <span className="font-mono text-xs text-gray-700">{rec.date}</span>
                          <span className="ml-1.5 text-[10px] text-gray-400">{rec.day}</span>
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <Badge className={`text-xs border ${meta.cls}`}>
                              {rec.status === "on_leave" && rec.leaveType ? `${rec.leaveType} Leave` : meta.label}
                            </Badge>
                            <DayFlagBadges flags={lateDetectionFlags(rec, halfDayCutoffs)} />
                            {rec.isCompensationDay && (
                              <Badge className="text-xs border bg-purple-50 text-purple-700 border-purple-200">Comp Day</Badge>
                            )}
                            <CompensationChip day={rec} withNote className="max-w-[18rem]" />
                          </div>
                        </td>
                        <td className="py-2.5 px-3">
                          {rec.punches.length > 0 ? (
                            <PunchTimeline
                              size="sm"
                              dayDate={rec.date}
                              testId="history-punches"
                              punches={rec.punches.map((p) => ({
                                ...p,
                                // the API lists a night's closing punch on its shift day with nextDay: true
                                date: (p as { nextDay?: boolean }).nextDay ? nextIso(rec.date) : rec.date,
                                nextDay: (p as { nextDay?: boolean }).nextDay,
                              }))}
                            />
                          ) : (
                            <span className="text-xs text-gray-300">
                              {rec.status === "on_leave" ? "—" : rec.status === "holiday" ? "Weekly off" : rec.status === "future" ? "—" : "No punches"}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-xs text-gray-400 hidden sm:table-cell">
                          {rec.sourceLabel ? (
                            <span className="flex items-center gap-1">
                              {rec.sourceLabel === "Biometric" ? <Fingerprint size={11} /> : <PenLine size={11} />}
                              {rec.sourceLabel}
                            </span>
                          ) : "—"}
                        </td>
                        <td className="py-2.5 px-3 text-xs text-gray-600 hidden lg:table-cell">
                          {rec.hoursWorked ?? <span className="text-gray-300">—</span>}
                        </td>
                        <td className="py-2.5 px-3 text-xs text-gray-500 hidden lg:table-cell max-w-[160px] truncate" title={rec.notes ?? undefined}>
                          {rec.notes ?? <span className="text-gray-300">—</span>}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
          );
        })() : null}
      </DialogContent>
    </Dialog>
  );
}
