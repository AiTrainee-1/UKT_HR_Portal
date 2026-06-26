import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  useGetHrDashboardSummary,
  useGetSalaryTrends,
  useListDepartments,
} from "@/lib/api-client";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import {
  Users, UserCheck, UserX, Calendar, Building2, Briefcase,
  AlertCircle, TrendingUp, CreditCard, Activity,
} from "lucide-react";

const COLORS = ["#3b82f6", "#06b6d4", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];

function KpiCard({ label, value, icon: Icon, color, sub }: {
  label: string; value: number | string; icon: React.ComponentType<any>;
  color: string; sub?: string;
}) {
  return (
    <Card className="border-0 shadow-sm hover:shadow-md transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide truncate">{label}</p>
            <p className={`text-2xl font-black mt-0.5 ${color}`}>{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
          </div>
          <div className={`p-2.5 rounded-xl ${color.replace("text-", "bg-").replace("-600", "-50").replace("-500", "-50")}`}>
            <Icon size={18} className={color} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function HrDashboard() {
  const { data: summary, isLoading } = useGetHrDashboardSummary();
  const { data: trends } = useGetSalaryTrends();
  const { data: departments } = useListDepartments();

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "numeric", month: "long", year: "numeric"
  });

  const kpis = [
    { label: "Total Employees", value: summary?.totalEmployees ?? 0, icon: Users, color: "text-blue-600" },
    { label: "Active Employees", value: summary?.activeEmployees ?? 0, icon: UserCheck, color: "text-green-600" },
    { label: "Inactive Employees", value: summary?.inactiveEmployees ?? 0, icon: UserX, color: "text-red-500" },
    { label: "On Leave (Pending)", value: summary?.pendingLeaves ?? 0, icon: Calendar, color: "text-amber-600" },
    { label: "Open Positions", value: summary?.openJobs ?? 0, icon: Briefcase, color: "text-purple-600" },
    { label: "Applicants", value: summary?.pendingApplicants ?? 0, icon: Users, color: "text-orange-600" },
    { label: "Departments", value: summary?.totalDepartments ?? 0, icon: Building2, color: "text-teal-600" },
    { label: "Unread Notifications", value: (summary as any)?.unreadNotifications ?? 0, icon: AlertCircle, color: "text-rose-600" },
    { label: "Monthly Salary", value: `₹${(((summary?.monthlySalaryTotal ?? 0)) / 1000).toFixed(0)}K`, icon: CreditCard, color: "text-blue-700" },
  ];

  const maleCount = (summary as any)?.maleEmployees ?? 0;
  const femaleCount = (summary as any)?.femaleEmployees ?? 0;
  const otherCount = (summary as any)?.otherEmployees ?? 0;
  const genderData = [
    ...(maleCount > 0 ? [{ name: "Male", value: maleCount }] : []),
    ...(femaleCount > 0 ? [{ name: "Female", value: femaleCount }] : []),
    ...(otherCount > 0 ? [{ name: "Other", value: otherCount }] : []),
  ];

  const deptData = (departments ?? []).map((d: any) => ({
    name: d.name?.length > 12 ? d.name.slice(0, 12) + "…" : d.name,
    count: d.employeeCount ?? 0,
  }));

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">HR Dashboard</h2>
            <p className="text-muted-foreground text-sm mt-0.5">{today}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs font-medium text-green-700 bg-green-50 px-3 py-1.5 rounded-full border border-green-200">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </div>
          </div>
        </div>

        {/* KPI Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3">
          {kpis.map(kpi => (
            <KpiCard key={kpi.label} {...kpi} />
          ))}
        </div>

        {/* Charts Row */}
        <div className="grid md:grid-cols-3 gap-4">
          {/* Salary Trend */}
          <Card className="border-0 shadow-sm md:col-span-2">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-bold text-gray-700 flex items-center gap-2">
                <TrendingUp size={15} className="text-blue-500" />
                Salary Cost — Last 12 Months
              </CardTitle>
            </CardHeader>
            <CardContent>
              {trends && trends.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={trends} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-gray-100" />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                    <Tooltip formatter={(v: number) => [`₹${v.toLocaleString("en-IN")}`, "Total"]} />
                    <Bar dataKey="total" fill="#3b82f6" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                  No salary data yet
                </div>
              )}
            </CardContent>
          </Card>

          {/* Gender Distribution */}
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-bold text-gray-700 flex items-center gap-2">
                <Activity size={15} className="text-purple-500" />
                Gender Distribution
              </CardTitle>
            </CardHeader>
            <CardContent>
              {genderData.length > 0 ? (
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={genderData} cx="50%" cy="50%" innerRadius={55} outerRadius={80}
                      paddingAngle={3} dataKey="value">
                      {genderData.map((_, i) => (
                        <Cell key={i} fill={COLORS[i]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend iconSize={10} iconType="circle" />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">
                  No employee data yet
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Department Attendance */}
        {deptData.length > 0 && (
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-bold text-gray-700 flex items-center gap-2">
                <Building2 size={15} className="text-teal-500" />
                Department-wise Employee Count
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={deptData} margin={{ top: 4, right: 8, left: 0, bottom: 24 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-gray-100" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} angle={-20} textAnchor="end" height={40} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                    {deptData.map((_: any, i: number) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        )}

        {/* HR Alerts */}
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-bold text-gray-700 flex items-center gap-2">
              <AlertCircle size={15} className="text-amber-500" />
              HR Alerts &amp; Reminders
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl border bg-blue-50 border-blue-100">
                <p className="text-2xl font-black text-blue-700">{summary?.pendingLeaves ?? 0}</p>
                <p className="text-xs font-medium text-gray-600 mt-0.5">Pending Leave Approvals</p>
              </div>
              <div className="p-3 rounded-xl border bg-rose-50 border-rose-100">
                <p className="text-2xl font-black text-rose-700">{(summary as any)?.unreadNotifications ?? 0}</p>
                <p className="text-xs font-medium text-gray-600 mt-0.5">Unread Notifications</p>
              </div>
              <div className="p-3 rounded-xl border bg-purple-50 border-purple-100">
                <p className="text-2xl font-black text-purple-700">{summary?.openJobs ?? 0}</p>
                <p className="text-xs font-medium text-gray-600 mt-0.5">Open Positions</p>
              </div>
              <div className="p-3 rounded-xl border bg-amber-50 border-amber-100">
                <p className="text-2xl font-black text-amber-700">{summary?.pendingApplicants ?? 0}</p>
                <p className="text-xs font-medium text-gray-600 mt-0.5">Pending Applicants</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </HrLayout>
  );
}
