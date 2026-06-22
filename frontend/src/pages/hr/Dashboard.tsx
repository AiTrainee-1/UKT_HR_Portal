import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import Loader from "@/components/Loader";
import {
  useGetHrDashboardSummary,
  useGetSalaryTrends,
  useListDepartments,
} from "@/lib/api-client";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import { Users, UserCheck, UserX, Calendar, Bell, Briefcase, IndianRupee, Building2 } from "lucide-react";

export default function HrDashboard() {
  const { data: summary, isLoading } = useGetHrDashboardSummary();
  const { data: trends } = useGetSalaryTrends();
  const { data: departments } = useListDepartments();

  const stats = [
    { label: "Total Employees", value: summary?.totalEmployees ?? 0, icon: Users, color: "text-primary" },
    { label: "Active", value: summary?.activeEmployees ?? 0, icon: UserCheck, color: "text-green-600" },
    { label: "Inactive", value: summary?.inactiveEmployees ?? 0, icon: UserX, color: "text-red-500" },
    { label: "Pending Leaves", value: summary?.pendingLeaves ?? 0, icon: Calendar, color: "text-amber-600" },
    { label: "Unread Messages", value: summary?.unreadNotifications ?? 0, icon: Bell, color: "text-blue-600" },
    { label: "Departments", value: summary?.totalDepartments ?? 0, icon: Building2, color: "text-purple-600" },
    { label: "Open Jobs", value: summary?.openJobs ?? 0, icon: Briefcase, color: "text-cyan-600" },
    { label: "Pending Applicants", value: summary?.pendingApplicants ?? 0, icon: Users, color: "text-orange-600" },
  ];

  if (isLoading) {
    return (
      <HrLayout>
        <div className="flex items-center justify-center min-h-[calc(100vh-140px)]">
          <Loader />
        </div>
      </HrLayout>
    );
  }

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-foreground">HR Dashboard</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Overview of your workforce</p>
          </div>
          <Badge variant="outline" className="text-xs">
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short", year: "numeric" })}
          </Badge>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {stats.map(({ label, value, icon: Icon, color }) => (
            <Card key={label} data-testid={`stat-${label.toLowerCase().replace(/\s+/g, "-")}`}>
              <CardContent className="p-4">
                {isLoading ? (
                  <Skeleton className="h-12 w-full" />
                ) : (
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">{label}</p>
                      <p className={`text-3xl font-black mt-1 ${color}`}>{value}</p>
                    </div>
                    <div className={`p-2 rounded-lg bg-muted ${color}`}>
                      <Icon size={16} />
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Salary breakdown */}
        <div className="grid md:grid-cols-2 gap-4">
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Monthly Salary Total</p>
              {isLoading ? <Skeleton className="h-8 w-32" /> : (
                <p className="text-2xl font-black text-foreground flex items-center gap-1">
                  <IndianRupee size={18} className="text-accent" />
                  {(summary?.monthlySalaryTotal ?? 0).toLocaleString("en-IN")}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider mb-1">Weekly Salary Total</p>
              {isLoading ? <Skeleton className="h-8 w-32" /> : (
                <p className="text-2xl font-black text-foreground flex items-center gap-1">
                  <IndianRupee size={18} className="text-green-500" />
                  {(summary?.weeklySalaryTotal ?? 0).toLocaleString("en-IN")}
                </p>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Salary Trend Chart */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Salary Trend (Last 12 Months)</CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            {trends && trends.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={trends} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="label" tick={{ fontSize: 11 }} className="text-muted-foreground" />
                  <YAxis tick={{ fontSize: 11 }} className="text-muted-foreground" tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => [`₹${v.toLocaleString("en-IN")}`, "Total"]} />
                  <Bar dataKey="total" fill="hsl(var(--accent))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="h-48 flex items-center justify-center text-muted-foreground text-sm">No salary data yet</div>
            )}
          </CardContent>
        </Card>

        {/* Departments */}
        {departments && departments.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Departments</CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                {departments.map((dept) => (
                  <div key={dept.id} className="p-3 rounded-lg border bg-muted/30">
                    <p className="font-semibold text-sm text-foreground">{dept.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">{dept.employeeCount ?? 0} employees</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </HrLayout>
  );
}
