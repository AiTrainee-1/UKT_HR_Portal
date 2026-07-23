import { useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { useAuth, canView } from "@/contexts/AuthContext";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useGetHrDashboardSummary,
  useGetSalaryTrends,
  useListDepartments,
} from "@/lib/api-client";
import {
  useAttendanceSummary,
  useAttendanceMonthlyTrend,
  useListAdvances,
  useListHolidays,
  useAuditLogStats,
  useListPermissions,
} from "@/lib/api-client/custom-hooks";
import { useBiometricSync } from "@/contexts/BiometricSyncContext";
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, Legend,
  LineChart, Line,
} from "recharts";
import {
  Users, UserCheck, Calendar, CreditCard, TrendingUp, AlertCircle,
  ChevronRight, Clock, Building2, Gift, Activity,
  CheckCircle2, ClipboardList, Wallet, ArrowUp, ArrowDown, RefreshCw,
  MapPinned, Navigation, Radar, ShieldCheck,
} from "lucide-react";

// ── Palette ───────────────────────────────────────────────────────────────────

const PROD_COLOR   = "#006496";
const STAFF_COLOR  = "#0096c7";
const SALARY_COLOR = "#4FB8F0";
const GENDER_COLORS = ["#006496", "#4FB8F0", "#0096c7"];
const DEPT_COLORS = ["#006496","#0080bf","#0096c7","#00b4d8","#48cae4","#90e0ef","#4FB8F0","#023e8a"];

// ── Attendance Ring Gauge ──────────────────────────────────────────────────────

function RingGauge({
  rate, size = 88, stroke = 9, color, bg = "rgba(0,100,150,0.08)",
}: { rate: number; size?: number; stroke?: number; color: string; bg?: string }) {
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const dash = Math.max(0, Math.min(1, rate / 100)) * circ;
  return (
    <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={bg} strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={stroke}
        strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
        style={{ transition: "stroke-dasharray 0.6s ease" }}
      />
    </svg>
  );
}

// ── Section Title ─────────────────────────────────────────────────────────────

function SectionTitle({ children, action, onAction }: {
  children: React.ReactNode;
  action?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h3 className="text-[10px] font-bold uppercase tracking-widest" style={{ color: "rgba(0,60,100,0.65)" }}>
        {children}
      </h3>
      {action && (
        <button
          onClick={onAction}
          className="flex items-center gap-1 text-[11px] font-semibold transition-all hover:gap-1.5"
          style={{ color: "#006496" }}
        >
          {action} <ChevronRight size={11} />
        </button>
      )}
    </div>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, icon: Icon, accent, onClick, trend, trendUp,
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accent: string; onClick?: () => void; trend?: string; trendUp?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="group w-full text-left rounded-2xl p-4 clay-card hover:scale-[1.02] transition-all duration-200"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{
            background: accent + "18",
            boxShadow: `4px 4px 10px ${accent}20, -2px -2px 6px rgba(255,255,255,0.8), inset 2px 2px 4px rgba(255,255,255,0.6)`,
          }}
        >
          <span style={{ color: accent }}><Icon size={17} /></span>
        </div>
        {trend !== undefined && (
          <span
            className={`flex items-center gap-0.5 text-[10px] font-bold ${trendUp ? "text-emerald-600" : "text-red-500"}`}
          >
            {trendUp ? <ArrowUp size={10} /> : <ArrowDown size={10} />}{trend}
          </span>
        )}
      </div>
      <p className="text-2xl font-black leading-none" style={{ color: "#1a3a4a" }}>{value}</p>
      <p className="text-[11px] font-semibold mt-1 truncate" style={{ color: "#1e5a7a" }}>{label}</p>
      {sub && <p className="text-[10px] mt-0.5 truncate" style={{ color: "rgba(0,60,100,0.55)" }}>{sub}</p>}
    </button>
  );
}

// ── Horizontal Bar Row ────────────────────────────────────────────────────────

function HBar({
  label, value, max, color, onClick,
}: { label: string; value: number; max: number; color: string; onClick?: () => void }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <button
      onClick={onClick}
      className="w-full text-left group flex items-center gap-3 py-1.5 rounded-xl px-2 transition-all"
      style={{ color: "rgba(0,80,120,0.75)" }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(0,100,150,0.04)"; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
    >
      <span className="text-xs truncate w-28 shrink-0 font-semibold">{label}</span>
      <div
        className="flex-1 rounded-full h-2 overflow-hidden"
        style={{ background: "rgba(0,100,150,0.08)" }}
      >
        <div
          className="h-2 rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-xs font-black w-8 text-right shrink-0" style={{ color }}>{value}</span>
    </button>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmt(n: number) {
  if (n >= 100_000) return `₹${(n / 100_000).toFixed(1)}L`;
  if (n >= 1_000) return `₹${(n / 1_000).toFixed(0)}K`;
  return `₹${n}`;
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-IN", {
    weekday: "short", day: "numeric", month: "short",
  });
}

function daysUntil(iso: string) {
  const ms = new Date(iso).getTime() - Date.now();
  const d = Math.ceil(ms / 86400000);
  if (d === 0) return "Today";
  if (d === 1) return "Tomorrow";
  return `In ${d}d`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export default function HrDashboard() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  // Sync lives in a root-level context so it survives navigating away from
  // the Dashboard, and is shared with the Attendance page's sync button.
  const { isSyncing, lastSyncedAt, triggerSync } = useBiometricSync();
  const handleSync = () => void triggerSync("day", "all");

  const now = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();

  // Holidays and audit stats are always-readable aggregate data (see backend
  // permission_middleware.py ALWAYS_READABLE_GET_PREFIXES) — but advances and
  // pending permissions are full sensitive records reused here just for a
  // Dashboard count, so those two are only fetched when the viewer actually
  // has access to Settlement / Requests respectively.
  const canSeeSettlement = canView(user, "settlement");
  const canSeeRequests = canView(user, "requests");

  const { data: summary, isLoading: sumLoading } = useGetHrDashboardSummary();
  const { data: trends  } = useGetSalaryTrends();
  const { data: depts   } = useListDepartments();
  const { data: attn    } = useAttendanceSummary();
  const { data: attnTrend } = useAttendanceMonthlyTrend(year, month);
  const { data: advances  } = useListAdvances({ status: "approved" }, { enabled: canSeeSettlement } as any);
  const { data: holidays  } = useListHolidays({ year });
  const { data: auditStats } = useAuditLogStats();
  const { data: pendingPerms } = useListPermissions({ status: "pending", month, year }, { enabled: canSeeRequests } as any);

  // ── Derived ────────────────────────────────────────────────────────────────

  const prodPresent  = attn?.productionPresent ?? 0;
  const prodTotal    = attn?.productionTotal   ?? 0;
  const staffPresent = attn?.staffPresent      ?? 0;
  const staffTotal   = attn?.staffTotal        ?? 0;
  const prodRate     = prodTotal  > 0 ? Math.round((prodPresent  / prodTotal)  * 100) : 0;
  const staffRate    = staffTotal > 0 ? Math.round((staffPresent / staffTotal) * 100) : 0;
  const notPunched   = attn?.notPunched ?? 0;

  const totalOutstanding = (advances ?? []).reduce((s, a) => s + (a.outstanding ?? 0), 0);
  const openAdvances     = (advances ?? []).filter(a => a.outstanding > 0).length;

  const todayStr = now.toISOString().slice(0, 10);
  const upcomingHolidays = (holidays ?? [])
    .filter(h => h.date >= todayStr)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 5);

  const deptData = (depts as any[] ?? [])
    .map((d: any) => ({ name: d.name as string, count: (d.employeeCount ?? 0) as number }))
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  const maxDept = deptData[0]?.count ?? 1;

  const genderData = [
    { name: "Male",   value: (summary as any)?.maleEmployees   ?? 0 },
    { name: "Female", value: (summary as any)?.femaleEmployees ?? 0 },
    { name: "Other",  value: (summary as any)?.otherEmployees  ?? 0 },
  ].filter(g => g.value > 0);

  const salaryTrend = (trends ?? []).slice(-12);

  const pendingLeaves    = summary?.pendingLeaves ?? 0;
  const pendingPermCount = (pendingPerms ?? []).length;
  const monthlyPayroll   = summary?.monthlySalaryTotal ?? 0;

  const geoPunchesToday      = (summary as any)?.geoPunchesToday ?? 0;
  const onDutyPending        = (summary as any)?.onDutyPendingApprovals ?? 0;
  const onDutyApprovedToday  = (summary as any)?.onDutyApprovedToday ?? 0;
  const employeesOnDutyToday = (summary as any)?.employeesOnDutyToday ?? 0;
  const liveTrackingEnabled  = (summary as any)?.liveTrackingEnabledCount ?? 0;

  const headerDate = now.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const yest = attn?.yesterday;
  const presentDelta = yest ? (attn?.presentToday ?? 0) - yest.present : null;
  const trendData = (attnTrend ?? []).slice(-20);

  const chartTooltipStyle = {
    fontSize: 11, borderRadius: 12,
    border: "1px solid rgba(0,100,150,0.1)",
    background: "#ffffff",
    boxShadow: "6px 6px 14px rgba(0,100,150,0.1), -3px -3px 8px rgba(255,255,255,0.8)",
    color: "#1a3a4a",
  };
  const axisStyle = { fontSize: 10, fill: "rgba(0,60,100,0.65)" };

  return (
    <HrLayout>
      <div
        className="space-y-5"
        style={{ fontFamily: "'Hanken Grotesk', 'Inter', sans-serif" }}
      >

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black tracking-tight" style={{ color: "#1a3a4a" }}>
              HR Dashboard
            </h2>
            <p className="text-xs mt-0.5 font-medium" style={{ color: "rgba(0,60,100,0.65)" }}>
              {headerDate}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className="flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-full"
              style={{
                color: "#059669",
                background: "rgba(5,150,105,0.08)",
                boxShadow: "3px 3px 8px rgba(5,150,105,0.1), -2px -2px 6px rgba(255,255,255,0.8)",
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1 rounded-full transition-all disabled:opacity-60"
              style={{
                color: "#006496",
                background: "rgba(0,100,150,0.07)",
                boxShadow: "3px 3px 8px rgba(0,100,150,0.1), -2px -2px 6px rgba(255,255,255,0.8)",
              }}
            >
              <RefreshCw size={11} className={isSyncing ? "animate-spin" : ""} />
              {isSyncing ? "Syncing…" : "Auto Sync"}
              {lastSyncedAt && !isSyncing && (
                <span style={{ color: "rgba(0,100,150,0.45)", fontWeight: 400 }}>· {lastSyncedAt}</span>
              )}
            </button>
            <button
              onClick={() => navigate("/hr/payroll")}
              className="text-[11px] font-semibold px-3 py-1 rounded-full transition-all"
              style={{
                color: "rgba(0,100,150,0.7)",
                background: "rgba(0,100,150,0.06)",
                boxShadow: "3px 3px 8px rgba(0,100,150,0.08), -2px -2px 6px rgba(255,255,255,0.8)",
              }}
            >
              Run Payroll
            </button>
            <button
              onClick={() => navigate("/hr/employees/new")}
              className="text-[11px] font-semibold px-3 py-1 rounded-full text-white transition-all clay-btn"
              style={{ background: "linear-gradient(135deg, #006496, #0096c7)" }}
            >
              + Add Employee
            </button>
          </div>
        </div>

        {/* ── KPI Row ─────────────────────────────────────────────────────── */}
        {sumLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-24 rounded-2xl" />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KpiCard
              label="Total Employees" value={summary?.totalEmployees ?? 0}
              sub={`${summary?.activeEmployees ?? 0} active`}
              icon={Users} accent="#006496"
              onClick={() => navigate("/hr/employees")}
            />
            <KpiCard
              label="Present Today" value={attn?.presentToday ?? 0}
              sub={attn ? `of ${attn.totalEmployees} workforce` : undefined}
              icon={UserCheck} accent="#0096c7"
              trend={presentDelta !== null ? `${Math.abs(presentDelta)} vs yesterday` : undefined}
              trendUp={presentDelta !== null ? presentDelta >= 0 : undefined}
              onClick={() => navigate("/hr/attendance")}
            />
            <KpiCard
              label="Pending Leaves" value={pendingLeaves}
              sub="awaiting approval"
              icon={Calendar} accent="#f59e0b"
              onClick={() => navigate("/hr/leave")}
            />
            <KpiCard
              label="Pending Permissions" value={pendingPermCount}
              sub="this month"
              icon={ClipboardList} accent="#8b5cf6"
              onClick={() => navigate("/hr/requests")}
            />
            <KpiCard
              label="Monthly Payroll" value={fmt(monthlyPayroll)}
              sub="current month estimate"
              icon={CreditCard} accent="#0080bf"
              onClick={() => navigate("/hr/payroll")}
            />
            <KpiCard
              label="Open Advances" value={openAdvances}
              sub={totalOutstanding > 0 ? `${fmt(totalOutstanding)} outstanding` : "No outstanding"}
              icon={Wallet} accent="#ef4444"
              onClick={() => navigate("/hr/settlement")}
            />
          </div>
        )}

        {/* ── Attendance Hero ──────────────────────────────────────────────── */}
        <div
          className="rounded-2xl overflow-hidden cursor-pointer group clay-card"
          onClick={() => navigate("/hr/attendance")}
        >
          {/* Header bar */}
          <div
            className="px-5 py-3 flex items-center justify-between"
            style={{
              background: "linear-gradient(135deg, #006496 0%, #0096c7 100%)",
            }}
          >
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-white/60">Today's Attendance</p>
              <p className="text-white font-black text-sm mt-0.5">
                {attn?.presentToday ?? 0} Present &nbsp;·&nbsp; {notPunched} Not Punched &nbsp;·&nbsp; {(attn?.manualPresent ?? 0)} Manual
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-white/80 bg-white/15 px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-white animate-pulse" />
                Live
              </span>
              <ChevronRight size={16} className="text-white/50 group-hover:text-white transition-colors" />
            </div>
          </div>

          {/* Production / Staff panels */}
          <div className="bg-white grid grid-cols-2 divide-x" style={{ borderColor: "rgba(0,100,150,0.08)" }}>
            {/* Production */}
            <div className="p-5 flex items-center gap-5">
              <div className="relative flex-shrink-0">
                <RingGauge rate={prodRate} size={88} stroke={9} color={PROD_COLOR} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-black leading-none" style={{ color: "#1a3a4a" }}>{prodRate}%</span>
                  <span className="text-[10px] font-medium mt-0.5" style={{ color: "rgba(0,60,100,0.6)" }}>rate</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: "#006496" }}>Production</p>
                <p className="text-3xl font-black leading-none" style={{ color: "#1a3a4a" }}>{prodPresent}</p>
                <p className="text-xs mt-1" style={{ color: "#1e5a7a" }}>of {prodTotal} employees</p>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px]" style={{ color: "#1e5a7a" }}>
                    Absent: <strong className="text-red-500">{prodTotal - prodPresent}</strong>
                  </span>
                  <span className="text-[11px]" style={{ color: "#1e5a7a" }}>
                    NP: <strong className="text-amber-500">{attn?.productionNotPunched ?? 0}</strong>
                  </span>
                </div>
              </div>
            </div>

            {/* Staff */}
            <div className="p-5 flex items-center gap-5">
              <div className="relative flex-shrink-0">
                <RingGauge rate={staffRate} size={88} stroke={9} color={STAFF_COLOR} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-black leading-none" style={{ color: "#1a3a4a" }}>{staffRate}%</span>
                  <span className="text-[10px] font-medium mt-0.5" style={{ color: "rgba(0,60,100,0.6)" }}>rate</span>
                </div>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest mb-1" style={{ color: "#0096c7" }}>Staff</p>
                <p className="text-3xl font-black leading-none" style={{ color: "#1a3a4a" }}>{staffPresent}</p>
                <p className="text-xs mt-1" style={{ color: "#1e5a7a" }}>of {staffTotal} employees</p>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px]" style={{ color: "#1e5a7a" }}>
                    Absent: <strong className="text-red-500">{staffTotal - staffPresent}</strong>
                  </span>
                  <span className="text-[11px]" style={{ color: "#1e5a7a" }}>
                    NP: <strong className="text-amber-500">{attn?.staffNotPunched ?? 0}</strong>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Yesterday comparison */}
          {yest && (
            <div
              className="px-5 py-2.5 flex items-center gap-6 text-[11px] font-medium"
              style={{ background: "rgba(0,100,150,0.03)", borderTop: "1px solid rgba(0,100,150,0.06)", color: "#1e5a7a" }}
            >
              <span className="uppercase tracking-wide font-bold" style={{ color: "rgba(0,60,100,0.65)" }}>Yesterday:</span>
              <span>Present <strong style={{ color: "#1a3a4a" }}>{yest.present}</strong></span>
              <span>Absent <strong style={{ color: "#1a3a4a" }}>{yest.absent}</strong></span>
              <span>Late <strong style={{ color: "#1a3a4a" }}>{yest.late}</strong></span>
              <span>On Leave <strong style={{ color: "#1a3a4a" }}>{yest.onLeave}</strong></span>
            </div>
          )}
        </div>

        {/* ── Charts Row ──────────────────────────────────────────────────── */}
        <div className="grid lg:grid-cols-3 gap-4">

          {/* Salary Cost Trend */}
          <div
            className="lg:col-span-2 rounded-2xl p-5 cursor-pointer clay-card"
            onClick={() => navigate("/hr/payroll")}
          >
            <SectionTitle action="View Payroll" onAction={() => navigate("/hr/payroll")}>
              <span className="flex items-center gap-1.5">
                <TrendingUp size={12} style={{ color: "#006496" }} />
                Salary Cost — Last 12 Months
              </span>
            </SectionTitle>
            {salaryTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={salaryTrend} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="salaryGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={SALARY_COLOR} stopOpacity={0.25} />
                      <stop offset="95%" stopColor={SALARY_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,100,150,0.05)" />
                  <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={axisStyle} tickLine={false} axisLine={false}
                    tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip contentStyle={chartTooltipStyle} formatter={(v: number) => [`₹${v.toLocaleString("en-IN")}`, "Total"]} />
                  <Area
                    type="monotone" dataKey="total"
                    stroke={PROD_COLOR} strokeWidth={2.5}
                    fill="url(#salaryGrad)"
                    dot={false} activeDot={{ r: 4, fill: PROD_COLOR }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-44 flex items-center justify-center text-sm" style={{ color: "rgba(0,100,150,0.25)" }}>
                No payroll data yet
              </div>
            )}
          </div>

          {/* Attendance Trend This Month */}
          <div
            className="rounded-2xl p-5 cursor-pointer clay-card"
            onClick={() => navigate("/hr/attendance")}
          >
            <SectionTitle action="View Attendance" onAction={() => navigate("/hr/attendance")}>
              <span className="flex items-center gap-1.5">
                <Activity size={12} style={{ color: "#006496" }} />
                This Month — Daily Trend
              </span>
            </SectionTitle>
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trendData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,100,150,0.05)" />
                  <XAxis dataKey="day" tick={{ fontSize: 9, fill: "rgba(0,60,100,0.65)" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "rgba(0,60,100,0.65)" }} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Line type="monotone" dataKey="present" stroke={PROD_COLOR} strokeWidth={2} dot={false} name="Present" />
                  <Line type="monotone" dataKey="absent"  stroke="#ef4444" strokeWidth={1.5} dot={false} name="Absent" strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-44 flex items-center justify-center text-sm" style={{ color: "rgba(0,100,150,0.25)" }}>
                No attendance data yet
              </div>
            )}
          </div>
        </div>

        {/* ── Insights Row ─────────────────────────────────────────────────── */}
        <div className="grid lg:grid-cols-3 gap-4">

          {/* Department Headcount */}
          <div className="rounded-2xl p-5 clay-card">
            <SectionTitle action="Manage Departments" onAction={() => navigate("/hr/departments")}>
              <span className="flex items-center gap-1.5">
                <Building2 size={12} style={{ color: "#006496" }} />
                Department Headcount
              </span>
            </SectionTitle>
            {deptData.length > 0 ? (
              <div className="space-y-0.5">
                {deptData.map((d, i) => (
                  <HBar
                    key={d.name} label={d.name} value={d.count} max={maxDept}
                    color={DEPT_COLORS[i % DEPT_COLORS.length]}
                    onClick={() => navigate("/hr/employees")}
                  />
                ))}
              </div>
            ) : (
              <div className="h-32 flex items-center justify-center text-sm" style={{ color: "rgba(0,100,150,0.25)" }}>
                No department data
              </div>
            )}
          </div>

          {/* Gender Distribution */}
          <div className="rounded-2xl p-5 clay-card">
            <SectionTitle action="View Employees" onAction={() => navigate("/hr/employees")}>
              <span className="flex items-center gap-1.5">
                <Users size={12} style={{ color: "#006496" }} />
                Workforce Composition
              </span>
            </SectionTitle>
            {genderData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <Pie
                    data={genderData} cx="50%" cy="48%"
                    innerRadius={52} outerRadius={72}
                    paddingAngle={3} dataKey="value"
                  >
                    {genderData.map((_, i) => (
                      <Cell key={i} fill={GENDER_COLORS[i]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={chartTooltipStyle} />
                  <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 11, color: "#1e5a7a" }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-44 flex items-center justify-center text-sm" style={{ color: "rgba(0,100,150,0.25)" }}>
                No employee data
              </div>
            )}
            <div className="flex items-center justify-center gap-4 mt-1">
              {genderData.map((g, i) => (
                <div key={g.name} className="text-center">
                  <p className="text-lg font-black" style={{ color: GENDER_COLORS[i] }}>{g.value}</p>
                  <p className="text-[10px]" style={{ color: "#1e5a7a" }}>{g.name}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Action Items + Holidays */}
          <div className="space-y-4">

            {/* Pending Actions */}
            <div className="rounded-2xl p-5 clay-card">
              <SectionTitle>
                <span className="flex items-center gap-1.5">
                  <AlertCircle size={12} style={{ color: "#f59e0b" }} />
                  Pending Actions
                </span>
              </SectionTitle>
              <div className="space-y-1.5">
                {[
                  { label: "Leave Approvals",      value: pendingLeaves,    color: "#f59e0b", icon: Calendar,      path: "/hr/leave" },
                  { label: "Permission Requests",  value: pendingPermCount, color: "#8b5cf6", icon: Clock,         path: "/hr/requests" },
                  { label: "On-Duty Approvals",    value: onDutyPending,    color: "#d97706", icon: MapPinned,     path: "/hr/geo-attendance" },
                  { label: "Open Advances",        value: openAdvances,     color: "#ef4444", icon: CreditCard,    path: "/hr/settlement" },
                  { label: "Notifications",        value: (summary as any)?.unreadNotifications ?? 0, color: "#006496", icon: AlertCircle, path: "/hr/notifications" },
                ].map(({ label, value, color, icon: Icon, path }) => (
                  <button
                    key={label}
                    onClick={() => navigate(path)}
                    className="w-full flex items-center justify-between p-2.5 rounded-xl transition-all group"
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(0,100,150,0.04)"; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{
                          background: color + "18",
                          boxShadow: `3px 3px 8px ${color}20, -2px -2px 5px rgba(255,255,255,0.8)`,
                        }}
                      >
                        <Icon size={13} style={{ color }} />
                      </div>
                      <span className="text-xs font-semibold" style={{ color: "#1a3a4a" }}>{label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-xs font-black px-2 py-0.5 rounded-full"
                        style={{ background: color + "18", color }}
                      >
                        {value}
                      </span>
                      <ChevronRight size={12} style={{ color: "rgba(0,100,150,0.25)" }} />
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Upcoming Holidays */}
            <div className="rounded-2xl p-5 clay-card">
              <SectionTitle action="Manage" onAction={() => navigate("/hr/leave")}>
                <span className="flex items-center gap-1.5">
                  <Gift size={12} className="text-rose-500" />
                  Upcoming Holidays
                </span>
              </SectionTitle>
              {upcomingHolidays.length > 0 ? (
                <div className="space-y-2">
                  {upcomingHolidays.map(h => (
                    <div key={h.id} className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                          style={{ background: "rgba(244,63,94,0.08)", boxShadow: "3px 3px 8px rgba(244,63,94,0.1), -2px -2px 5px rgba(255,255,255,0.8)" }}
                        >
                          <Gift size={12} className="text-rose-500" />
                        </div>
                        <div>
                          <p className="text-xs font-semibold leading-none" style={{ color: "#1a3a4a" }}>{h.name}</p>
                          <p className="text-[10px] mt-0.5" style={{ color: "#1e5a7a" }}>{fmtDate(h.date)}</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">
                        {daysUntil(h.date)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-center py-3" style={{ color: "rgba(0,60,100,0.55)" }}>No upcoming holidays</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Geo Attendance Snapshot ─────────────────────────────────────── */}
        <div className="rounded-2xl p-5 clay-card">
          <SectionTitle action="Open Geo Attendance" onAction={() => navigate("/hr/geo-attendance")}>
            <span className="flex items-center gap-1.5">
              <Navigation size={12} style={{ color: "#006496" }} />
              Geo Attendance — Today
            </span>
          </SectionTitle>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Office Geo Punches", value: geoPunchesToday, color: "#006496", icon: MapPinned },
              { label: "On-Duty Approved", value: onDutyApprovedToday, color: "#059669", icon: ShieldCheck },
              { label: "Employees On-Duty", value: employeesOnDutyToday, color: "#d97706", icon: Users },
              { label: "Live Tracking Enabled", value: liveTrackingEnabled, color: "#7c3aed", icon: Radar },
            ].map(({ label, value, color, icon: Icon }) => (
              <button
                key={label}
                onClick={() => navigate("/hr/geo-attendance")}
                className="text-left rounded-xl p-3 transition-all hover:scale-[1.02]"
                style={{ background: color + "0d" }}
              >
                <div
                  className="w-7 h-7 rounded-lg flex items-center justify-center mb-2"
                  style={{ background: color + "18", boxShadow: `3px 3px 8px ${color}20, -2px -2px 5px rgba(255,255,255,0.8)` }}
                >
                  <Icon size={13} style={{ color }} />
                </div>
                <p className="text-xl font-black" style={{ color: "#1a3a4a" }}>{value}</p>
                <p className="text-[11px] font-semibold mt-0.5" style={{ color: "#1e5a7a" }}>{label}</p>
              </button>
            ))}
          </div>
        </div>

        {/* ── Bottom Row: Activity Summary ─────────────────────────────────── */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: "Events Today",     value: auditStats?.today    ?? 0, icon: Activity,     color: "#006496", path: "/hr/activity-logs", sub: "in audit log" },
            { label: "This Week",        value: auditStats?.thisWeek ?? 0, icon: TrendingUp,   color: "#0096c7", path: "/hr/activity-logs", sub: "system events" },
            { label: "HR Users",         value: auditStats?.recentUsers?.length ?? 0, icon: CheckCircle2, color: "#8b5cf6", path: "/hr/user-management", sub: "recently active" },
            { label: "Total Audit Events", value: (auditStats?.total ?? 0).toLocaleString(), icon: ClipboardList, color: "#f59e0b", path: "/hr/activity-logs", sub: "all time" },
          ].map(({ label, value, icon: Icon, color, path, sub }) => (
            <button
              key={label}
              onClick={() => navigate(path)}
              className="group rounded-2xl p-4 text-left clay-card hover:scale-[1.02] transition-all duration-200"
            >
              <div className="flex items-center justify-between mb-2">
                <div
                  className="w-8 h-8 rounded-xl flex items-center justify-center"
                  style={{
                    background: color + "18",
                    boxShadow: `4px 4px 10px ${color}20, -2px -2px 6px rgba(255,255,255,0.8)`,
                  }}
                >
                  <Icon size={15} style={{ color }} />
                </div>
                <ChevronRight size={13} style={{ color: "rgba(0,100,150,0.25)" }} />
              </div>
              <p className="text-xl font-black" style={{ color: "#1a3a4a" }}>{value}</p>
              <p className="text-[11px] font-semibold mt-0.5" style={{ color: "#1e4d6b" }}>{label}</p>
              <p className="text-[10px]" style={{ color: "rgba(0,60,100,0.6)" }}>{sub}</p>
            </button>
          ))}
        </div>

      </div>
    </HrLayout>
  );
}
