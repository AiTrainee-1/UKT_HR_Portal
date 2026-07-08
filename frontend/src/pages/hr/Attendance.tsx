import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ChartContainer } from "@/components/ui/chart";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend,
} from "recharts";
import {
  useAttendanceSummary, useAttendanceDaily, useAttendanceMonthlyTrend,
  useAttendanceEmployeeHistory, useCreateManualAttendance, useListEmployees,
  getAttendanceSummaryQueryKey, getAttendanceDailyQueryKey,
  getAttendanceMonthlyTrendQueryKey,
} from "@/lib/api-client";
import {
  useAttendanceSummaryTyped, useAttendanceTrendTyped,
  useListBiometricDevices, type SyncBiometricMode, type SyncDeviceId,
} from "@/lib/api-client/custom-hooks";
import { useBiometricSync } from "@/contexts/BiometricSyncContext";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import BiometricSyncPipeline from "@/components/BiometricSyncPipeline";
import AttendanceSearchSection from "./AttendanceSearch";
import {
  Users, UserCheck, UserX, CalendarDays, Plus,
  Factory, Briefcase, Fingerprint, PenLine, ChevronRight, RefreshCw,
  Search, ChevronDown,
  TrendingUp, Calendar, ChevronLeft,
} from "lucide-react";

// ── Pagination ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 5;


function Pagination({
  page,
  totalPages,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const start = (page - 1) * PAGE_SIZE + 1;
  const end   = Math.min(page * PAGE_SIZE, total);

  const pages: (number | "…")[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i);
  } else {
    pages.push(1);
    if (page > 3) pages.push("…");
    for (let i = Math.max(2, page - 1); i <= Math.min(totalPages - 1, page + 1); i++) pages.push(i);
    if (page < totalPages - 2) pages.push("…");
    pages.push(totalPages);
  }

  return (
    <div className="flex items-center justify-between px-4 py-3 border-t bg-gray-50/60 text-xs text-gray-500">
      <span>
        Showing <strong className="text-gray-700">{start}–{end}</strong> of <strong className="text-gray-700">{total}</strong>
      </span>
      <div className="flex items-center gap-1">
        <button
          onClick={() => onPage(page - 1)}
          disabled={page === 1}
          className="h-7 w-7 flex items-center justify-center rounded-md border bg-white hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronLeft size={13} />
        </button>
        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`ellipsis-${i}`} className="px-1 text-gray-400">…</span>
          ) : (
            <button
              key={p}
              onClick={() => onPage(p as number)}
              className={`h-7 min-w-[28px] px-1.5 rounded-md border text-xs font-semibold transition-colors ${
                p === page
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white hover:bg-gray-100 text-gray-700"
              }`}
            >
              {p}
            </button>
          )
        )}
        <button
          onClick={() => onPage(page + 1)}
          disabled={page === totalPages}
          className="h-7 w-7 flex items-center justify-center rounded-md border bg-white hover:bg-gray-100 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTH_FULL  = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const STATUS_CFG: Record<string, { label: string; className: string }> = {
  present:  { label: "Present",  className: "bg-green-100 text-green-800 border-green-200" },
  manual:   { label: "Manual",   className: "bg-blue-100 text-blue-800 border-blue-200" },
  on_leave: { label: "On Leave", className: "bg-purple-100 text-purple-800 border-purple-200" },
  absent:   { label: "Absent",   className: "bg-red-100 text-red-800 border-red-200" },
};

// ── Summary Card ───────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  colorCls,
  isLoading,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number | string;
  sub?: React.ReactNode;
  colorCls: string;
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <Card className="border">
        <CardContent className="p-5">
          <Skeleton className="h-3 w-20 mb-3" />
          <Skeleton className="h-8 w-14 mb-2" />
          <Skeleton className="h-3 w-28" />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="border">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
          <div className={`p-1.5 rounded-lg ${colorCls}`}>
            <Icon size={14} className="text-white" />
          </div>
        </div>
        <p className="text-3xl font-black text-gray-900 leading-none mb-2">{value}</p>
        {sub && <div className="text-xs text-gray-500">{sub}</div>}
      </CardContent>
    </Card>
  );
}

// ── Employee Table ─────────────────────────────────────────────────────────

function EmployeeTable({
  records,
  isLoading,
  onClickEmployee,
}: {
  records: ReturnType<typeof useAttendanceDaily>["data"];
  isLoading: boolean;
  onClickEmployee: (id: number) => void;
}) {
  const [page, setPage] = useState(1);
  const all  = records ?? [];
  const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const rows       = all.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: PAGE_SIZE }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    );
  }
  if (all.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No employee records for this date.
      </div>
    );
  }
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50">
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Employee</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Code</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden md:table-cell">Department</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider">First IN</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Last OUT</th>
              <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase tracking-wider hidden lg:table-cell">Source</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((rec) => {
              const cfg = STATUS_CFG[rec.status] ?? STATUS_CFG.absent;
              return (
                <tr
                  key={rec.employeeId}
                  className="border-b hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => onClickEmployee(rec.employeeId)}
                >
                  <td className="px-4 py-3 font-medium text-gray-900">{rec.employeeName}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs font-mono">{rec.employeeCode}</td>
                  <td className="px-4 py-3 text-gray-500 hidden md:table-cell">{rec.department ?? "—"}</td>
                  <td className="px-4 py-3">
                    <Badge className={`text-xs border ${cfg.className}`}>{cfg.label}</Badge>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700">
                    {rec.firstPunch ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-700 hidden lg:table-cell">
                    {rec.lastPunch ?? <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    {rec.source ? (
                      <span className="flex items-center gap-1 text-xs text-gray-400">
                        {rec.source.startsWith("biometric") ? <Fingerprint size={11} /> : <PenLine size={11} />}
                        {rec.source.startsWith("biometric") ? "Biometric" : "Manual"}
                      </span>
                    ) : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="px-4 py-3">
                    <ChevronRight size={14} className="text-gray-300" />
                  </td>
                </tr>
              );
            })}
            {Array.from({ length: PAGE_SIZE - rows.length }).map((_, i) => (
              <tr key={`fill-${i}`} className="border-b">
                <td className="h-[53px]" colSpan={8} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        page={safePage}
        totalPages={totalPages}
        total={all.length}
        onPage={setPage}
      />
    </>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();

  const [selectedDate, setSelectedDate] = useState(today());
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [selectedYear, setSelectedYear] = useState(currentYear());
  // Staff / Production sub-section — derived from the route so the sidebar
  // stays in sync (/hr/attendance/staff | /hr/attendance/production)
  const view: "staff" | "production" =
    location.includes("/attendance/production") ? "production" : "staff";
  const setView = (v: "staff" | "production") => navigate(`/hr/attendance/${v}`);

  const [showManualDialog, setShowManualDialog] = useState(false);
  const [manualForm, setManualForm] = useState({
    employeeId: "",
    date: today(),
    punchTime: "",
    punchType: "IN",
    notes: "",
    hoursWorked: "",
  });

  const [detailEmpId, setDetailEmpId] = useState<number | null>(null);
  const [syncMode, setSyncMode] = useState<SyncBiometricMode>("day");
  const [syncDeviceId, setSyncDeviceId] = useState<SyncDeviceId>("all");
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const syncMenuRef = useRef<HTMLDivElement>(null);

  const { data: employees } = useListEmployees({ status: "active" });
  const { data: devices } = useListBiometricDevices();
  const enabledDevices = (devices ?? []).filter(d => d.isActive);

  // Sync lives in a root-level context (BiometricSyncProvider) so it keeps
  // running — and stays visible — even if the user navigates away mid-sync.
  const { isSyncing, showPipeline, progress, lastSyncedAt, triggerSync, dismiss } = useBiometricSync();

  const SYNC_MODES: { key: SyncBiometricMode; label: string }[] = [
    { key: "day",   label: "Last Day" },
    { key: "week",  label: "Last One Week" },
    { key: "month", label: "Last One Month" },
    { key: "all",   label: "All Records" },
  ];

  const syncModeLabel = SYNC_MODES.find(m => m.key === syncMode)?.label ?? "Last Day";

  const handleSync = (modeOverride?: SyncBiometricMode) => {
    const mode = modeOverride ?? syncMode;
    setShowSyncMenu(false);
    void triggerSync(mode, syncDeviceId);
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
  const { data: summary, isLoading: summaryLoading } = useAttendanceSummaryTyped(selectedDate, view);
  const { data: dailyList, isLoading: dailyLoading }  = useAttendanceDaily(selectedDate);
  const { data: monthlyTrend } = useAttendanceTrendTyped(selectedYear, selectedMonth, view);
  const { data: empDetail, isLoading: empDetailLoading } = useAttendanceEmployeeHistory(
    detailEmpId, selectedMonth, selectedYear,
  );
  const createManual = useCreateManualAttendance();

  // Records for the active sub-section only
  const allRecords    = (dailyList ?? []).filter((r) => r.employmentType === view);
  const activeRecords = allRecords;

  const presentCount  = allRecords.filter(r => r.status === "present" || r.status === "manual").length;
  const absentCount   = allRecords.filter(r => r.status === "absent").length;
  const onLeaveCount  = allRecords.filter(r => r.status === "on_leave").length;

  // Monthly trend data for chart
  const trendData = monthlyTrend ?? [];

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
    setShowManualDialog(false);
    setManualForm({ employeeId: "", date: today(), punchTime: "", punchType: "IN", notes: "", hoursWorked: "" });
    queryClient.invalidateQueries({ queryKey: getAttendanceSummaryQueryKey(selectedDate) });
    queryClient.invalidateQueries({ queryKey: getAttendanceDailyQueryKey(selectedDate) });
    queryClient.invalidateQueries({ queryKey: getAttendanceMonthlyTrendQueryKey(selectedYear, selectedMonth) });
  };

  return (
    <HrLayout>
      <div className="space-y-5">

        {/* ── Header ── */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-2xl font-black text-gray-900">
              {view === "staff" ? "Staff Attendance" : "Production Attendance"}
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Real-time tracking · AiFace-Mars biometric integration
            </p>
            {/* Staff / Production sub-section toggle */}
            <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1 mt-2 w-fit">
              {(["staff", "production"] as const).map(v => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-4 py-1.5 rounded-md text-xs font-bold transition-colors flex items-center gap-1.5 ${
                    view === v ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-800"
                  }`}
                >
                  {v === "staff" ? <Briefcase size={12} /> : <Factory size={12} />}
                  {v === "staff" ? "Staff" : "Production"}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Sync split-button */}
            <div ref={syncMenuRef} className="relative flex items-center">
              <Button
                variant="outline"
                onClick={() => handleSync()}
                disabled={isSyncing}
                className="gap-2 h-9 border-cyan-200 text-cyan-700 hover:bg-cyan-50 rounded-r-none border-r-0"
              >
                <RefreshCw size={14} className={isSyncing ? "animate-spin" : ""} />
                {isSyncing ? "Syncing…" : "Sync Biometric"}
                {lastSyncedAt && !isSyncing && (
                  <span className="text-[10px] text-cyan-500 font-normal">· {lastSyncedAt}</span>
                )}
              </Button>
              <button
                onClick={() => setShowSyncMenu(v => !v)}
                className="h-9 px-2 border border-l-0 border-cyan-200 rounded-r-md text-cyan-700 hover:bg-cyan-50 flex items-center"
                title={syncModeLabel}
              >
                <ChevronDown size={13} />
              </button>
              {showSyncMenu && (
                <div className="absolute top-full right-0 mt-1 z-50 bg-white border rounded-xl shadow-lg overflow-hidden min-w-[220px]">
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 px-3 pt-2.5 pb-1">Device</p>
                  <button
                    onClick={() => setSyncDeviceId("all")}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-cyan-50 transition-colors ${
                      syncDeviceId === "all" ? "text-cyan-700 font-semibold bg-cyan-50" : "text-gray-700"
                    }`}
                  >
                    Select All Devices
                  </button>
                  {enabledDevices.map(d => (
                    <button
                      key={d.id}
                      onClick={() => setSyncDeviceId(d.id)}
                      className={`w-full text-left px-3 py-1.5 text-sm hover:bg-cyan-50 transition-colors ${
                        syncDeviceId === d.id ? "text-cyan-700 font-semibold bg-cyan-50" : "text-gray-700"
                      }`}
                    >
                      {d.name}
                    </button>
                  ))}
                  {enabledDevices.length === 0 && (
                    <p className="px-3 py-1.5 text-xs text-amber-600">No enabled devices — add one in Settings.</p>
                  )}

                  <div className="border-t mt-1" />
                  <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400 px-3 pt-2.5 pb-1">Sync range</p>
                  {SYNC_MODES.map(m => (
                    <button
                      key={m.key}
                      onClick={() => { setSyncMode(m.key); handleSync(m.key); }}
                      className={`w-full text-left px-3 py-2 text-sm hover:bg-cyan-50 transition-colors ${
                        syncMode === m.key ? "text-cyan-700 font-semibold bg-cyan-50" : "text-gray-700"
                      }`}
                    >
                      {m.label}
                      {m.key === "all" && <span className="block text-[10px] text-amber-500">⚠ May take a long time</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Input
              type="date"
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="h-9 text-sm w-40"
            />
            <Button onClick={() => setShowManualDialog(true)} className="gap-2 h-9">
              <Plus size={14} /> Add Attendance
            </Button>
          </div>
        </div>

        {/* ── Biometric Sync Pipeline (visible only while/just after syncing) ── */}
        <BiometricSyncPipeline active={showPipeline} data={progress} onDismiss={dismiss} />

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            icon={Users}
            label={view === "staff" ? "Total Staff" : "Total Production"}
            value={summary?.totalEmployees ?? "—"}
            colorCls="bg-gray-700"
            sub={
              <span className="flex gap-3">
                <span><strong className="text-gray-700">{summary?.staffTotal ?? "—"}</strong> Staff</span>
                <span><strong className="text-gray-700">{summary?.productionTotal ?? "—"}</strong> Production</span>
              </span>
            }
            isLoading={summaryLoading}
          />
          <StatCard
            icon={UserCheck}
            label="Present Today"
            value={summary?.presentToday ?? "—"}
            colorCls="bg-green-600"
            sub={
              <span className="flex gap-3">
                <span><strong className="text-gray-700">{summary?.biometricPresent ?? "—"}</strong> Biometric</span>
                <span><strong className="text-gray-700">{summary?.manualPresent ?? "—"}</strong> Manual</span>
              </span>
            }
            isLoading={summaryLoading}
          />
          <StatCard
            icon={UserX}
            label="Not Punched"
            value={summary?.notPunched ?? "—"}
            colorCls="bg-red-500"
            sub={
              <span className="flex gap-3">
                <span><strong className="text-gray-700">{summary?.productionNotPunched ?? "—"}</strong> Production</span>
                <span><strong className="text-gray-700">{summary?.staffNotPunched ?? "—"}</strong> Staff</span>
              </span>
            }
            isLoading={summaryLoading}
          />
          <StatCard
            icon={CalendarDays}
            label="On Leave Today"
            value={onLeaveCount}
            colorCls="bg-purple-500"
            sub={<span>from today's records</span>}
            isLoading={dailyLoading}
          />
          {/* Yesterday snapshot */}
          {summaryLoading ? (
            <Card className="border lg:col-span-1">
              <CardContent className="p-5 space-y-2">
                <Skeleton className="h-3 w-24 mb-3" />
                {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}
              </CardContent>
            </Card>
          ) : (
            <Card className="border bg-slate-50 lg:col-span-1">
              <CardContent className="p-5">
                <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
                  Yesterday
                  {summary?.yesterday?.date && (
                    <span className="ml-1.5 normal-case font-normal text-gray-400">({summary.yesterday.date})</span>
                  )}
                </p>
                <div className="space-y-1.5">
                  {[
                    { label: "Present",  value: summary?.yesterday?.present  ?? 0, color: "text-green-700" },
                    { label: "Absent",   value: summary?.yesterday?.absent   ?? 0, color: "text-red-600" },
                    { label: "Late",     value: summary?.yesterday?.late     ?? 0, color: "text-amber-600" },
                    { label: "On Leave", value: summary?.yesterday?.onLeave  ?? 0, color: "text-purple-600" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex items-center justify-between">
                      <span className="text-xs text-gray-500">{label}</span>
                      <span className={`text-sm font-bold ${color}`}>{value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Charts ── */}
        <div className="grid lg:grid-cols-2 gap-4">
          {/* Monthly Trend */}
          <Card className="border">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp size={14} className="text-gray-400" />
                  <div>
                    <CardTitle className="text-sm font-semibold text-gray-700">Monthly Attendance Trend</CardTitle>
                    <p className="text-xs text-muted-foreground">Daily present vs absent</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(Number(e.target.value))}
                    className="h-7 rounded-md border px-1.5 text-xs bg-background"
                  >
                    {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                  </select>
                  <Input
                    type="number"
                    value={selectedYear}
                    onChange={(e) => setSelectedYear(Number(e.target.value))}
                    className="w-16 h-7 text-xs"
                    min={2020} max={2030}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {trendData.length > 0 ? (
                <ChartContainer
                  config={{ present: { color: "#22c55e" }, absent: { color: "#ef4444" } }}
                  className="h-52"
                >
                  <BarChart data={trendData} margin={{ top: 4, right: 8, left: -20, bottom: 4 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="day" tick={{ fontSize: 10 }} interval={4} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip
                      labelFormatter={(v) => {
                        const item = trendData.find((d) => d.day === v);
                        return item?.date ?? String(v);
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="present" stackId="a" fill="#22c55e" name="Present" />
                    <Bar dataKey="absent"  stackId="a" fill="#ef4444" name="Absent" radius={[3,3,0,0]} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
                  No data for {MONTH_NAMES[selectedMonth - 1]} {selectedYear}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Today snapshot bar */}
          <Card className="border">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center gap-2">
                <Calendar size={14} className="text-gray-400" />
                <div>
                  <CardTitle className="text-sm font-semibold text-gray-700">Today vs Yesterday</CardTitle>
                  <p className="text-xs text-muted-foreground">Present · Absent · Leave comparison</p>
                </div>
              </div>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {summary ? (
                <ChartContainer
                  config={{
                    present: { color: "#22c55e" },
                    absent:  { color: "#ef4444" },
                    late:    { color: "#f59e0b" },
                    onLeave: { color: "#a855f7" },
                  }}
                  className="h-52"
                >
                  <BarChart
                    data={[
                      {
                        label: "Yesterday",
                        present: summary.yesterday.present,
                        absent:  summary.yesterday.absent,
                        late:    summary.yesterday.late,
                        onLeave: summary.yesterday.onLeave,
                      },
                      {
                        label: "Today",
                        present: summary.presentToday,
                        absent:  summary.notPunched,
                        late:    0,
                        onLeave: onLeaveCount,
                      },
                    ]}
                    margin={{ top: 4, right: 8, left: -20, bottom: 4 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="present"  fill="#22c55e" name="Present"  radius={[3,3,0,0]} />
                    <Bar dataKey="absent"   fill="#ef4444" name="Absent"   radius={[3,3,0,0]} />
                    <Bar dataKey="late"     fill="#f59e0b" name="Late"     radius={[3,3,0,0]} />
                    <Bar dataKey="onLeave"  fill="#a855f7" name="On Leave" radius={[3,3,0,0]} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="h-52 flex items-center justify-center text-sm text-muted-foreground">
                  No data available
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Employee Search + Manual Overrides ── */}
        <AttendanceSearchSection employmentType={view} />

        {/* ── Production shift structure info ── */}
        {view === "production" && (
          <Card className="border border-orange-100 bg-orange-50/40">
            <CardContent className="p-4 flex items-start gap-3 text-xs text-orange-800">
              <Factory size={16} className="shrink-0 mt-0.5 text-orange-500" />
              <div className="space-y-1">
                <p className="font-bold text-sm">Production 1.5-Shift Day</p>
                <p>
                  <strong>08:30–12:30</strong> First Half (0.5) ·{" "}
                  <strong>13:30–17:30</strong> Second Half (0.5) ·{" "}
                  <strong>17:50–20:00</strong> Additional Half (0.5) — up to{" "}
                  <strong>1.5 shifts/day</strong>. Windows are configurable in Settings → Attendance.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* ── Employee Table ── */}
        <Card className="border">
          <CardHeader className="pb-0 pt-4 px-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-sm font-semibold text-gray-700">
                  Employee Attendance — {selectedDate}
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">Click any row to view full attendance history</p>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500" /> Present: {presentCount}
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-red-500" /> Absent: {absentCount}
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-purple-500" /> On Leave: {onLeaveCount}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 mt-3">
            <EmployeeTable
              records={activeRecords}
              isLoading={dailyLoading}
              onClickEmployee={(id) => setDetailEmpId(id)}
            />
          </CardContent>
        </Card>

      </div>

      {/* ── Manual Attendance Dialog ── */}
      <Dialog open={showManualDialog} onOpenChange={setShowManualDialog}>
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
              <Button variant="outline" className="flex-1" onClick={() => setShowManualDialog(false)}>Cancel</Button>
              <Button className="flex-1" onClick={addManualAttendance} disabled={createManual.isPending}>
                {createManual.isPending ? "Saving…" : "Save Attendance"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Employee Detail Dialog ── */}
      <Dialog
        open={!!detailEmpId}
        onOpenChange={(open) => { if (!open) { setDetailEmpId(null); setHistorySearch(""); } }}
      >
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {empDetail ? `${empDetail.employee.name} — Attendance History` : "Attendance History"}
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
                    const found = (employees ?? []).find(
                      emp => emp.employeeCode.toLowerCase() === q ||
                             `${emp.firstName} ${emp.lastName}`.toLowerCase().includes(q)
                    );
                    if (found) { setDetailEmpId(found.id); setHistorySearch(""); }
                  }
                }}
              />
            </div>
            {historySearch.trim() && (() => {
              const q = historySearch.trim().toLowerCase();
              const matches = (employees ?? []).filter(
                emp => emp.employeeCode.toLowerCase().includes(q) ||
                       `${emp.firstName} ${emp.lastName}`.toLowerCase().includes(q)
              ).slice(0, 5);
              return matches.length > 0 ? (
                <div className="absolute z-50 mt-8 left-0 right-0 bg-white border rounded-xl shadow-lg overflow-hidden">
                  {matches.map(emp => (
                    <button
                      key={emp.id}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-sm"
                      onClick={() => { setDetailEmpId(emp.id); setHistorySearch(""); }}
                    >
                      <span className="font-mono text-xs text-gray-400 w-16 shrink-0">{emp.employeeCode}</span>
                      <span className="font-medium">{emp.firstName} {emp.lastName}</span>
                      {emp.departmentName && <span className="text-xs text-gray-400 ml-auto">{emp.departmentName}</span>}
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
            <select
              value={selectedMonth}
              onChange={(e) => setSelectedMonth(Number(e.target.value))}
              className="h-8 rounded-md border px-2 text-xs bg-background"
            >
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <Input
              type="number"
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="w-20 h-8 text-xs"
              min={2020} max={2030}
            />
          </div>

          {empDetailLoading ? (
            <div className="space-y-3 py-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : empDetail ? (
            <div className="flex flex-col gap-4 overflow-hidden">
              <div className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg text-sm flex-wrap">
                <span className="text-gray-500">Code: <strong className="text-gray-800 font-mono">{empDetail.employee.code}</strong></span>
                {empDetail.employee.department && (
                  <span className="text-gray-500">Dept: <strong className="text-gray-800">{empDetail.employee.department}</strong></span>
                )}
                <span className="text-gray-500">Type: <strong className="text-gray-800 capitalize">{empDetail.employee.employmentType}</strong></span>
                <span className="flex gap-3 ml-auto">
                  <span className="text-green-700 font-semibold">{empDetail.totalPresent} Present</span>
                  <span className="text-red-600 font-semibold">{empDetail.totalAbsent} Absent</span>
                  {empDetail.summary.onLeave > 0 && (
                    <span className="text-purple-600 font-semibold">{empDetail.summary.onLeave} On Leave</span>
                  )}
                </span>
              </div>
              <div className="overflow-y-auto flex-1">
                {empDetail.records.length === 0 ? (
                  <p className="text-center py-8 text-muted-foreground text-sm">No attendance records found.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-white">
                      <tr className="border-b">
                        <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Date</th>
                        <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Status</th>
                        <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">First In</th>
                        <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Last Out</th>
                        <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase">Punches</th>
                        <th className="text-left py-2 px-3 text-xs font-semibold text-gray-500 uppercase hidden md:table-cell">Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {empDetail.records.map((rec) => (
                        <tr key={rec.date} className="border-b hover:bg-gray-50">
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-700">{rec.date}</td>
                          <td className="py-2.5 px-3">
                            <Badge className={`text-xs border ${rec.present ? "bg-green-100 text-green-800 border-green-200" : "bg-red-100 text-red-800 border-red-200"}`}>
                              {rec.present ? "Present" : "Absent"}
                            </Badge>
                          </td>
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-700">
                            {rec.firstPunch ?? <span className="text-gray-300">—</span>}
                          </td>
                          <td className="py-2.5 px-3 font-mono text-xs text-gray-700">
                            {rec.lastPunch ?? <span className="text-gray-300">—</span>}
                          </td>
                          <td className="py-2.5 px-3 text-center text-xs text-gray-500">
                            {rec.totalPunches > 0 ? rec.totalPunches : "—"}
                          </td>
                          <td className="py-2.5 px-3 text-xs text-gray-400 hidden md:table-cell">
                            {rec.source?.startsWith("biometric") ? (
                              <span className="flex items-center gap-1"><Fingerprint size={11} /> Biometric</span>
                            ) : rec.source === "manual" ? (
                              <span className="flex items-center gap-1"><PenLine size={11} /> Manual</span>
                            ) : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
