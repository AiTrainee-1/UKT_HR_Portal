import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
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
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, PieChart, Pie, Cell, Legend,
  LineChart, Line,
} from "recharts";
import {
  Users, UserCheck, Calendar, CreditCard, TrendingUp, AlertCircle,
  ChevronRight, Clock, Building2, Gift, Activity,
  CheckCircle2, ClipboardList, Wallet, ArrowUp, ArrowDown,
} from "lucide-react";

// ── Palette ───────────────────────────────────────────────────────────────────

const PROD_COLOR  = "#0d9488"; // teal-600
const STAFF_COLOR = "#4f46e5"; // indigo-600
const SALARY_COLOR = "#3b82f6";
const GENDER_COLORS = ["#4f46e5", "#ec4899", "#f59e0b"];
const DEPT_COLORS = ["#3b82f6","#0d9488","#8b5cf6","#f59e0b","#ef4444","#06b6d4","#10b981","#f97316"];

// ── Attendance Ring Gauge ──────────────────────────────────────────────────────

function RingGauge({
  rate, size = 88, stroke = 9, color, bg = "#e2e8f0",
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
      <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">{children}</h3>
      {action && (
        <button
          onClick={onAction}
          className="flex items-center gap-1 text-xs text-blue-500 hover:text-blue-700 font-medium"
        >
          {action} <ChevronRight size={12} />
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
      className="group w-full text-left bg-white rounded-2xl p-4 shadow-sm hover:shadow-md transition-all border border-gray-100 hover:border-gray-200"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div
          className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: accent + "18" }}
        >
          <span style={{ color: accent }}><Icon size={17} /></span>
        </div>
        {trend !== undefined && (
          <span className={`flex items-center gap-0.5 text-[10px] font-bold ${trendUp ? "text-emerald-600" : "text-red-500"}`}>
            {trendUp ? <ArrowUp size={10} /> : <ArrowDown size={10} />}{trend}
          </span>
        )}
      </div>
      <p className="text-2xl font-black text-gray-900 leading-none">{value}</p>
      <p className="text-[11px] font-semibold text-gray-500 mt-1 truncate">{label}</p>
      {sub && <p className="text-[10px] text-gray-400 mt-0.5 truncate">{sub}</p>}
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
      className="w-full text-left group flex items-center gap-3 py-1.5 hover:bg-gray-50 rounded-lg px-1 transition-colors"
    >
      <span className="text-xs text-gray-600 truncate w-28 shrink-0 font-medium">{label}</span>
      <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
        <div
          className="h-2 rounded-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      <span className="text-xs font-bold text-gray-700 w-8 text-right shrink-0">{value}</span>
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

  const now = new Date();
  const month = now.getMonth() + 1;
  const year  = now.getFullYear();

  const { data: summary, isLoading: sumLoading } = useGetHrDashboardSummary();
  const { data: trends  } = useGetSalaryTrends();
  const { data: depts   } = useListDepartments();
  const { data: attn    } = useAttendanceSummary();
  const { data: attnTrend } = useAttendanceMonthlyTrend(year, month);
  const { data: advances  } = useListAdvances({ status: "approved" });
  const { data: holidays  } = useListHolidays({ year });
  const { data: auditStats } = useAuditLogStats();
  const { data: pendingPerms } = useListPermissions({ status: "pending", month, year });

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

  const pendingLeaves = summary?.pendingLeaves ?? 0;
  const pendingPermCount = (pendingPerms ?? []).length;
  const monthlyPayroll = summary?.monthlySalaryTotal ?? 0;

  const headerDate = now.toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  // Yesterday comparison
  const yest = attn?.yesterday;
  const presentDelta = yest ? (attn?.presentToday ?? 0) - yest.present : null;

  // Attendance trend for chart (last 20 days of current month)
  const trendData = (attnTrend ?? []).slice(-20);

  return (
    <HrLayout>
      <div className="space-y-5">

        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black text-gray-900 tracking-tight">HR Dashboard</h2>
            <p className="text-xs text-gray-400 mt-0.5 font-medium">{headerDate}</p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full border border-emerald-200">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              Live
            </span>
            <button
              onClick={() => navigate("/hr/payroll")}
              className="text-[11px] font-semibold text-gray-500 hover:text-gray-800 bg-gray-100 hover:bg-gray-200 px-3 py-1 rounded-full transition-colors"
            >
              Run Payroll
            </button>
            <button
              onClick={() => navigate("/hr/employees/new")}
              className="text-[11px] font-semibold text-white bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded-full transition-colors"
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
              icon={Users} accent="#3b82f6"
              onClick={() => navigate("/hr/employees")}
            />
            <KpiCard
              label="Present Today" value={attn?.presentToday ?? 0}
              sub={attn ? `of ${attn.totalEmployees} workforce` : undefined}
              icon={UserCheck} accent="#0d9488"
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
              icon={CreditCard} accent="#3b82f6"
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
          className="rounded-2xl border border-gray-100 shadow-sm overflow-hidden cursor-pointer group"
          onClick={() => navigate("/hr/attendance")}
        >
          <div className="bg-gradient-to-r from-slate-800 to-slate-900 px-5 py-3 flex items-center justify-between">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Today's Attendance</p>
              <p className="text-white font-black text-sm mt-0.5">
                {attn?.presentToday ?? 0} Present &nbsp;·&nbsp; {notPunched} Not Punched &nbsp;·&nbsp; {(attn?.manualPresent ?? 0)} Manual
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-400/10 px-2.5 py-1 rounded-full">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Live
              </span>
              <ChevronRight size={16} className="text-slate-500 group-hover:text-white transition-colors" />
            </div>
          </div>

          <div className="bg-white grid grid-cols-2 divide-x divide-gray-100">
            {/* Production */}
            <div className="p-5 flex items-center gap-5">
              <div className="relative flex-shrink-0">
                <RingGauge rate={prodRate} size={88} stroke={9} color={PROD_COLOR} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-black text-gray-900 leading-none">{prodRate}%</span>
                  <span className="text-[10px] text-gray-400 font-medium mt-0.5">rate</span>
                </div>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-teal-600 mb-1">Production</p>
                <p className="text-3xl font-black text-gray-900 leading-none">{prodPresent}</p>
                <p className="text-xs text-gray-500 mt-1">of {prodTotal} employees</p>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px] text-gray-400">
                    Absent: <span className="font-bold text-red-500">{prodTotal - prodPresent}</span>
                  </span>
                  <span className="text-[11px] text-gray-400">
                    Not punched: <span className="font-bold text-orange-500">{attn?.productionNotPunched ?? 0}</span>
                  </span>
                </div>
              </div>
            </div>

            {/* Staff */}
            <div className="p-5 flex items-center gap-5">
              <div className="relative flex-shrink-0">
                <RingGauge rate={staffRate} size={88} stroke={9} color={STAFF_COLOR} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-xl font-black text-gray-900 leading-none">{staffRate}%</span>
                  <span className="text-[10px] text-gray-400 font-medium mt-0.5">rate</span>
                </div>
              </div>
              <div>
                <p className="text-[11px] font-bold uppercase tracking-widest text-indigo-600 mb-1">Staff</p>
                <p className="text-3xl font-black text-gray-900 leading-none">{staffPresent}</p>
                <p className="text-xs text-gray-500 mt-1">of {staffTotal} employees</p>
                <div className="flex items-center gap-3 mt-2">
                  <span className="text-[11px] text-gray-400">
                    Absent: <span className="font-bold text-red-500">{staffTotal - staffPresent}</span>
                  </span>
                  <span className="text-[11px] text-gray-400">
                    Not punched: <span className="font-bold text-orange-500">{attn?.staffNotPunched ?? 0}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Yesterday comparison bar */}
          {yest && (
            <div className="bg-gray-50 border-t border-gray-100 px-5 py-2.5 flex items-center gap-6 text-[11px] text-gray-500 font-medium">
              <span className="uppercase tracking-wide text-gray-400 font-bold">Yesterday:</span>
              <span>Present <strong className="text-gray-700">{yest.present}</strong></span>
              <span>Absent <strong className="text-gray-700">{yest.absent}</strong></span>
              <span>Late <strong className="text-gray-700">{yest.late}</strong></span>
              <span>On Leave <strong className="text-gray-700">{yest.onLeave}</strong></span>
            </div>
          )}
        </div>

        {/* ── Charts Row ──────────────────────────────────────────────────── */}
        <div className="grid lg:grid-cols-3 gap-4">

          {/* Salary Cost Trend */}
          <div
            className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5 cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => navigate("/hr/payroll")}
          >
            <SectionTitle action="View Payroll" onAction={() => navigate("/hr/payroll")}>
              <span className="flex items-center gap-1.5">
                <TrendingUp size={12} className="text-blue-500" />
                Salary Cost — Last 12 Months
              </span>
            </SectionTitle>
            {salaryTrend.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <AreaChart data={salaryTrend} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="salaryGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor={SALARY_COLOR} stopOpacity={0.15} />
                      <stop offset="95%" stopColor={SALARY_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <YAxis
                    tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false}
                    tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                    formatter={(v: number) => [`₹${v.toLocaleString("en-IN")}`, "Total"]}
                  />
                  <Area
                    type="monotone" dataKey="total"
                    stroke={SALARY_COLOR} strokeWidth={2}
                    fill="url(#salaryGrad)"
                    dot={false} activeDot={{ r: 4 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-44 flex items-center justify-center text-gray-300 text-sm">
                No payroll data yet
              </div>
            )}
          </div>

          {/* Attendance Trend This Month */}
          <div
            className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 cursor-pointer hover:shadow-md transition-shadow"
            onClick={() => navigate("/hr/attendance")}
          >
            <SectionTitle action="View Attendance" onAction={() => navigate("/hr/attendance")}>
              <span className="flex items-center gap-1.5">
                <Activity size={12} className="text-teal-500" />
                This Month — Daily Trend
              </span>
            </SectionTitle>
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height={180}>
                <LineChart data={trendData} margin={{ top: 5, right: 5, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="day" tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }}
                  />
                  <Line type="monotone" dataKey="present" stroke={PROD_COLOR} strokeWidth={2} dot={false} name="Present" />
                  <Line type="monotone" dataKey="absent"  stroke="#ef4444"  strokeWidth={1.5} dot={false} name="Absent" strokeDasharray="4 2" />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-44 flex items-center justify-center text-gray-300 text-sm">
                No attendance data yet
              </div>
            )}
          </div>
        </div>

        {/* ── Insights Row ─────────────────────────────────────────────────── */}
        <div className="grid lg:grid-cols-3 gap-4">

          {/* Department Headcount */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <SectionTitle action="Manage Departments" onAction={() => navigate("/hr/departments")}>
              <span className="flex items-center gap-1.5">
                <Building2 size={12} className="text-purple-500" />
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
              <div className="h-32 flex items-center justify-center text-gray-300 text-sm">
                No department data
              </div>
            )}
          </div>

          {/* Gender Distribution */}
          <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
            <SectionTitle action="View Employees" onAction={() => navigate("/hr/employees")}>
              <span className="flex items-center gap-1.5">
                <Users size={12} className="text-pink-500" />
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
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: "1px solid #e2e8f0" }}
                  />
                  <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-44 flex items-center justify-center text-gray-300 text-sm">
                No employee data
              </div>
            )}
            {/* Totals row */}
            <div className="flex items-center justify-center gap-4 mt-1">
              {genderData.map((g, i) => (
                <div key={g.name} className="text-center">
                  <p className="text-lg font-black" style={{ color: GENDER_COLORS[i] }}>{g.value}</p>
                  <p className="text-[10px] text-gray-400">{g.name}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Action Items + Holidays */}
          <div className="space-y-4">

            {/* Pending Actions */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <SectionTitle>
                <span className="flex items-center gap-1.5">
                  <AlertCircle size={12} className="text-orange-500" />
                  Pending Actions
                </span>
              </SectionTitle>
              <div className="space-y-2">
                {[
                  {
                    label: "Leave Approvals", value: pendingLeaves,
                    color: "#f59e0b", icon: Calendar, path: "/hr/leave",
                  },
                  {
                    label: "Permission Requests", value: pendingPermCount,
                    color: "#8b5cf6", icon: Clock, path: "/hr/requests",
                  },
                  {
                    label: "Open Advances", value: openAdvances,
                    color: "#ef4444", icon: CreditCard, path: "/hr/settlement",
                  },
                  {
                    label: "Notifications", value: (summary as any)?.unreadNotifications ?? 0,
                    color: "#06b6d4", icon: AlertCircle, path: "/hr/notifications",
                  },
                ].map(({ label, value, color, icon: Icon, path }) => (
                  <button
                    key={label}
                    onClick={() => navigate(path)}
                    className="w-full flex items-center justify-between p-2.5 rounded-xl hover:bg-gray-50 transition-colors group"
                  >
                    <div className="flex items-center gap-2.5">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
                        style={{ background: color + "18" }}
                      >
                        <Icon size={13} style={{ color }} />
                      </div>
                      <span className="text-xs font-semibold text-gray-700">{label}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span
                        className="text-xs font-black px-2 py-0.5 rounded-full"
                        style={{ background: color + "18", color }}
                      >
                        {value}
                      </span>
                      <ChevronRight size={12} className="text-gray-300 group-hover:text-gray-500" />
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Upcoming Holidays */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
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
                        <div className="w-7 h-7 rounded-lg bg-rose-50 flex items-center justify-center flex-shrink-0">
                          <Gift size={12} className="text-rose-500" />
                        </div>
                        <div>
                          <p className="text-xs font-semibold text-gray-700 leading-none">{h.name}</p>
                          <p className="text-[10px] text-gray-400 mt-0.5">{fmtDate(h.date)}</p>
                        </div>
                      </div>
                      <span className="text-[10px] font-bold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">
                        {daysUntil(h.date)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400 text-center py-3">No upcoming holidays</p>
              )}
            </div>
          </div>
        </div>

        {/* ── Bottom Row: Activity Summary ─────────────────────────────────── */}
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            {
              label: "Events Today",  value: auditStats?.today    ?? 0,
              icon: Activity,        color: "#3b82f6", path: "/hr/activity-logs",
              sub: "in audit log",
            },
            {
              label: "This Week",    value: auditStats?.thisWeek  ?? 0,
              icon: TrendingUp,      color: "#0d9488", path: "/hr/activity-logs",
              sub: "system events",
            },
            {
              label: "HR Users",    value: auditStats?.recentUsers?.length ?? 0,
              icon: CheckCircle2,    color: "#8b5cf6", path: "/hr/user-management",
              sub: "recently active",
            },
            {
              label: "Total Audit Events", value: (auditStats?.total ?? 0).toLocaleString(),
              icon: ClipboardList,  color: "#f59e0b", path: "/hr/activity-logs",
              sub: "all time",
            },
          ].map(({ label, value, icon: Icon, color, path, sub }) => (
            <button
              key={label}
              onClick={() => navigate(path)}
              className="group bg-white rounded-2xl border border-gray-100 shadow-sm p-4 text-left hover:shadow-md transition-all hover:border-gray-200"
            >
              <div className="flex items-center justify-between mb-2">
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: color + "18" }}>
                  <Icon size={15} style={{ color }} />
                </div>
                <ChevronRight size={13} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
              </div>
              <p className="text-xl font-black text-gray-900">{value}</p>
              <p className="text-[11px] font-semibold text-gray-500 mt-0.5">{label}</p>
              <p className="text-[10px] text-gray-400">{sub}</p>
            </button>
          ))}
        </div>

      </div>
    </HrLayout>
  );
}
