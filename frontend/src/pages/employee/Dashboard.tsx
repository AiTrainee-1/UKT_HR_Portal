import { useMemo } from "react";
import EmployeeLayout from "@/components/EmployeeLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import Loader from "@/components/Loader";
import { useAuth } from "@/contexts/AuthContext";
import {
  useGetEmployeeDashboardSummary, useListAttendance, getGetEmployeeDashboardSummaryQueryKey
} from "@/lib/api-client";
import { Calendar, CheckSquare, Clock, FileText } from "lucide-react";

function ActivityGraph({ records }: { records: Array<{ date: string; present: boolean }> }) {
  const today = new Date();
  const weeksBack = 52;

  const attendanceMap = useMemo(() => {
    const map = new Map<string, boolean>();
    records.forEach((r) => map.set(r.date, r.present));
    return map;
  }, [records]);

  const weeks = useMemo(() => {
    const result: Array<Array<{ dateStr: string; state: "present" | "absent" | "future" | "empty" }>> = [];
    // Start from 52 weeks ago, from Sunday
    const start = new Date(today);
    start.setDate(start.getDate() - (weeksBack * 7) - start.getDay());
    start.setHours(0, 0, 0, 0);

    for (let w = 0; w < weeksBack; w++) {
      const week: (typeof result)[0] = [];
      for (let d = 0; d < 7; d++) {
        const day = new Date(start);
        day.setDate(start.getDate() + w * 7 + d);
        const dateStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
        const isFuture = day > today;
        if (isFuture) {
          week.push({ dateStr, state: "future" });
        } else {
          const present = attendanceMap.get(dateStr);
          if (present === undefined) week.push({ dateStr, state: "empty" });
          else week.push({ dateStr, state: present ? "present" : "absent" });
        }
      }
      result.push(week);
    }
    return result;
  }, [attendanceMap, today]);

  const months = useMemo(() => {
    const labels: Array<{ label: string; col: number }> = [];
    const start = new Date(today);
    start.setDate(start.getDate() - (weeksBack * 7) - start.getDay());
    let lastMonth = -1;
    for (let w = 0; w < weeksBack; w++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7);
      const m = day.getMonth();
      if (m !== lastMonth) {
        labels.push({ label: day.toLocaleDateString("en-US", { month: "short" }), col: w });
        lastMonth = m;
      }
    }
    return labels;
  }, [today]);

  const colorClass = (state: string) => {
    if (state === "present") return "bg-green-500";
    if (state === "absent") return "bg-red-200";
    if (state === "future") return "bg-muted/30";
    return "bg-muted/50";
  };

  return (
    <div className="overflow-x-auto">
      {/* Month labels */}
      <div className="flex gap-[3px] mb-1 ml-0" style={{ paddingLeft: "0px" }}>
        {Array.from({ length: weeksBack }).map((_, w) => {
          const monthLabel = months.find((m) => m.col === w);
          return (
            <div key={w} className="w-[11px] flex-shrink-0 text-[9px] text-muted-foreground">
              {monthLabel?.label ?? ""}
            </div>
          );
        })}
      </div>
      {/* Grid */}
      <div className="flex gap-[3px]">
        {weeks.map((week, w) => (
          <div key={w} className="flex flex-col gap-[3px]">
            {week.map((day, d) => (
              <div
                key={d}
                title={`${day.dateStr}: ${day.state}`}
                className={`w-[11px] h-[11px] rounded-sm flex-shrink-0 ${colorClass(day.state)}`}
              />
            ))}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-green-500" /> Present</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-red-200" /> Absent</div>
        <div className="flex items-center gap-1"><div className="w-3 h-3 rounded-sm bg-muted/50" /> No record</div>
      </div>
    </div>
  );
}

export default function EmployeeDashboard() {
  const { user } = useAuth();
  const empId = user?.employeeId;

  const { data: summary, isLoading } = useGetEmployeeDashboardSummary(
    empId ? { employeeId: empId } : undefined,
    {
      query: {
        enabled: !!empId,
      } as any,
    }
  );
  const { data: attendance } = useListAttendance(
    empId ? { employeeId: empId } : undefined,
    {
      query: {
        enabled: !!empId,
      } as any,
    }
  );

  const stats = [
    { label: "Working Days", value: summary?.totalWorkingDays ?? 0, icon: Calendar, color: "text-blue-600" },
    { label: "Present Days", value: summary?.presentDays ?? 0, icon: CheckSquare, color: "text-green-600" },
    { label: "Pending Leaves", value: summary?.pendingLeaves ?? 0, icon: Clock, color: "text-amber-600" },
    { label: "Approved Leaves", value: summary?.approvedLeaves ?? 0, icon: FileText, color: "text-purple-600" },
  ];

  if (isLoading) {
    return (
      <EmployeeLayout>
        <div className="flex items-center justify-center min-h-[calc(100vh-200px)]">
          <Loader />
        </div>
      </EmployeeLayout>
    );
  }

  return (
    <EmployeeLayout>
      <div className="space-y-6 max-w-4xl">
        <div>
          <h2 className="text-2xl font-black">Good day, {user?.name?.split(" ")[0] ?? "Employee"}</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            {new Date().toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
          </p>
        </div>

        {/* Stats */}
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

        {/* Attendance graph */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Attendance Activity</CardTitle>
          </CardHeader>
          <CardContent>
            {attendance ? (
              <ActivityGraph records={attendance.map((a) => ({ date: a.date, present: a.present ?? false }))} />
            ) : (
              <Skeleton className="h-24 w-full" />
            )}
          </CardContent>
        </Card>

        {/* Recent salaries */}
        {summary?.recentSalaries && summary.recentSalaries.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">Recent Salary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {summary.recentSalaries.map((rec) => (
                <div key={rec.id} className="flex items-center justify-between py-2 border-b last:border-0">
                  <div>
                    <p className="text-sm font-semibold">{rec.month}/{rec.year}</p>
                    <p className="text-xs text-muted-foreground capitalize">{rec.type}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-black">₹{Number(rec.amount ?? 0).toLocaleString("en-IN")}</p>
                    <Badge className={rec.status === "paid" ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"}>
                      {rec.status}
                    </Badge>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
      </div>
    </EmployeeLayout>
  );
}
