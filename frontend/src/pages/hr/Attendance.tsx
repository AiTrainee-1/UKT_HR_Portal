import { useState } from "react";
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
  BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
  ResponsiveContainer, LineChart, Line, Legend,
} from "recharts";
import {
  useAttendanceSummary, useAttendanceDaily, useAttendanceMonthlyTrend,
  useAttendanceEmployeeHistory, useCreateManualAttendance,
  getAttendanceSummaryQueryKey, getAttendanceDailyQueryKey,
  getAttendanceMonthlyTrendQueryKey,
} from "@/lib/api-client";
import {
  Users, UserCheck, UserX, Clock, CalendarDays, Plus,
  Factory, Briefcase, Fingerprint, PenLine, ChevronRight,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_CFG: Record<string, { label: string; className: string }> = {
  present:  { label: "Present",  className: "bg-green-100 text-green-800 border-green-200" },
  manual:   { label: "Manual",   className: "bg-blue-100 text-blue-800 border-blue-200" },
  on_leave: { label: "On Leave", className: "bg-purple-100 text-purple-800 border-purple-200" },
  absent:   { label: "Absent",   className: "bg-red-100 text-red-800 border-red-200" },
};

// ── Sub-components ─────────────────────────────────────────────────────────

function SummaryCard({
  icon: Icon,
  label,
  value,
  color,
  detail1,
  detail2,
  isLoading,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number | string;
  color: string;
  detail1?: { label: string; value: number | string };
  detail2?: { label: string; value: number | string };
  isLoading?: boolean;
}) {
  if (isLoading) {
    return (
      <Card className="border">
        <CardContent className="p-5">
          <Skeleton className="h-4 w-24 mb-3" />
          <Skeleton className="h-8 w-16 mb-3" />
          <Skeleton className="h-3 w-32" />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="border">
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
          <div className={`p-1.5 rounded-lg ${color}`}>
            <Icon size={15} className="text-white" />
          </div>
        </div>
        <p className="text-3xl font-black text-gray-900 mb-3">{value}</p>
        {(detail1 || detail2) && (
          <div className="flex gap-4 text-xs text-gray-500">
            {detail1 && <span><span className="font-semibold text-gray-700">{detail1.value}</span> {detail1.label}</span>}
            {detail2 && <span><span className="font-semibold text-gray-700">{detail2.value}</span> {detail2.label}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function YesterdayCard({ data, isLoading }: { data?: { date: string; present: number; absent: number; late: number; onLeave: number }; isLoading?: boolean }) {
  return (
    <Card className="border bg-slate-50">
      <CardContent className="p-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-500 mb-3">
          Yesterday Overview
          {data?.date && <span className="ml-2 normal-case font-normal text-gray-400">({data.date})</span>}
        </p>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-4 w-full" />)}
          </div>
        ) : data ? (
          <div className="space-y-2">
            {[
              { label: "Present",  value: data.present,  color: "text-green-700" },
              { label: "Absent",   value: data.absent,   color: "text-red-600" },
              { label: "Late",     value: data.late,     color: "text-amber-600" },
              { label: "On Leave", value: data.onLeave,  color: "text-purple-600" },
            ].map(({ label, value, color }) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-xs text-gray-500">{label}</span>
                <span className={`text-sm font-bold ${color}`}>{value}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-gray-400">No data</p>
        )}
      </CardContent>
    </Card>
  );
}

function EmployeeTable({
  records,
  isLoading,
  onClickEmployee,
}: {
  records: ReturnType<typeof useAttendanceDaily>["data"];
  isLoading: boolean;
  onClickEmployee: (id: number) => void;
}) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3 p-3">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-20" />
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 w-16" />
          </div>
        ))}
      </div>
    );
  }

  if (!records || records.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No employee records for this date.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-50">
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider">Employee</th>
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider">Code</th>
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider hidden md:table-cell">Department</th>
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider">Status</th>
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider">First Punch</th>
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider hidden lg:table-cell">Last Punch</th>
            <th className="text-left px-4 py-2.5 font-semibold text-xs text-gray-500 uppercase tracking-wider hidden lg:table-cell">Source</th>
            <th className="px-4 py-2.5"></th>
          </tr>
        </thead>
        <tbody>
          {records.map((rec) => {
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
        </tbody>
      </table>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function AttendancePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedDate, setSelectedDate] = useState(today());
  const [selectedMonth, setSelectedMonth] = useState(currentMonth());
  const [selectedYear, setSelectedYear] = useState(currentYear());
  const [activeTab, setActiveTab] = useState<"all" | "production" | "staff">("all");

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

  // Queries
  const { data: summary, isLoading: summaryLoading } = useAttendanceSummary(selectedDate);
  const { data: dailyList, isLoading: dailyLoading } = useAttendanceDaily(selectedDate);
  const { data: monthlyTrend } = useAttendanceMonthlyTrend(selectedYear, selectedMonth);
  const { data: empDetail, isLoading: empDetailLoading } = useAttendanceEmployeeHistory(
    detailEmpId, selectedMonth, selectedYear,
  );
  const createManual = useCreateManualAttendance();

  // Derived lists
  const allRecords = dailyList ?? [];
  const productionRecords = allRecords.filter((r) => r.employmentType === "production");
  const staffRecords = allRecords.filter((r) => r.employmentType === "staff");

  const activeRecords =
    activeTab === "production" ? productionRecords
    : activeTab === "staff" ? staffRecords
    : allRecords;

  // Today vs Yesterday comparison data
  const comparisonData = summary
    ? [
        {
          label: "Yesterday",
          present: summary.yesterday.present,
          absent: summary.yesterday.absent,
          late: summary.yesterday.late,
          onLeave: summary.yesterday.onLeave,
        },
        {
          label: "Today",
          present: summary.presentToday,
          absent: summary.notPunched,
          late: 0,
          onLeave: 0,
        },
      ]
    : [];

  const addManualAttendance = async () => {
    if (!manualForm.employeeId || !manualForm.date) {
      toast({ title: "Employee ID and date are required", variant: "destructive" });
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
            <h2 className="text-2xl font-black text-gray-900">Attendance</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Real-time attendance tracking · AiFace-Mars biometric integration
            </p>
          </div>
          <div className="flex items-center gap-2">
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

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <SummaryCard
            icon={Users}
            label="Total Employees"
            value={summary?.totalEmployees ?? "—"}
            color="bg-gray-700"
            detail1={{ label: "Production", value: summary?.productionTotal ?? "—" }}
            detail2={{ label: "Staff", value: summary?.staffTotal ?? "—" }}
            isLoading={summaryLoading}
          />
          <SummaryCard
            icon={UserCheck}
            label="Present Today"
            value={summary?.presentToday ?? "—"}
            color="bg-green-600"
            detail1={{ label: "Biometric", value: summary?.biometricPresent ?? "—" }}
            detail2={{ label: "Manual", value: summary?.manualPresent ?? "—" }}
            isLoading={summaryLoading}
          />
          <SummaryCard
            icon={UserX}
            label="Not Punched"
            value={summary?.notPunched ?? "—"}
            color="bg-red-500"
            detail1={{ label: "Production", value: summary?.productionNotPunched ?? "—" }}
            detail2={{ label: "Staff", value: summary?.staffNotPunched ?? "—" }}
            isLoading={summaryLoading}
          />
          <YesterdayCard data={summary?.yesterday} isLoading={summaryLoading} />
        </div>

        {/* ── Charts ── */}
        <div className="grid lg:grid-cols-2 gap-4">

          {/* Today vs Yesterday */}
          <Card className="border">
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-semibold text-gray-700">Today vs Yesterday</CardTitle>
              <p className="text-xs text-muted-foreground">Present / Absent / Late comparison</p>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {comparisonData.length > 0 ? (
                <ChartContainer
                  config={{
                    present: { color: "#22c55e" },
                    absent:  { color: "#ef4444" },
                    late:    { color: "#f59e0b" },
                    onLeave: { color: "#a855f7" },
                  }}
                  className="h-56"
                >
                  <BarChart data={comparisonData} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
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
                <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
                  No data available
                </div>
              )}
            </CardContent>
          </Card>

          {/* Monthly Trend */}
          <Card className="border">
            <CardHeader className="pb-2 pt-4 px-4">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-sm font-semibold text-gray-700">Monthly Trend</CardTitle>
                  <p className="text-xs text-muted-foreground">Daily present vs absent</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <select
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(Number(e.target.value))}
                    className="h-7 rounded-md border px-1.5 text-xs bg-background"
                  >
                    {MONTH_NAMES.map((m, i) => (
                      <option key={i} value={i + 1}>{m}</option>
                    ))}
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
              {(monthlyTrend ?? []).length > 0 ? (
                <ChartContainer
                  config={{ present: { color: "#22c55e" }, absent: { color: "#ef4444" } }}
                  className="h-56"
                >
                  <BarChart
                    data={monthlyTrend}
                    margin={{ top: 4, right: 8, left: -20, bottom: 4 }}
                    barCategoryGap="20%"
                  >
                    <CartesianGrid strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="day"
                      tick={{ fontSize: 10 }}
                      interval={4}
                    />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                    <Tooltip
                      labelFormatter={(v) => {
                        const item = monthlyTrend?.find((d) => d.day === v);
                        return item?.date ?? String(v);
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="present" stackId="a" fill="#22c55e" name="Present" />
                    <Bar dataKey="absent"  stackId="a" fill="#ef4444" name="Absent"  radius={[3,3,0,0]} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
                  No data for this month
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Employee Table ── */}
        <Card className="border">
          <CardHeader className="pb-0 pt-4 px-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-sm font-semibold text-gray-700">
                  Employee Attendance — {selectedDate}
                </CardTitle>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Click any row to view full attendance history
                </p>
              </div>
              <div className="flex items-center gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-green-500" /> Present: {allRecords.filter(r => r.status === "present" || r.status === "manual").length}
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-red-500" /> Absent: {allRecords.filter(r => r.status === "absent").length}
                </span>
                <span className="flex items-center gap-1">
                  <div className="w-2 h-2 rounded-full bg-purple-500" /> On Leave: {allRecords.filter(r => r.status === "on_leave").length}
                </span>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0 mt-3">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
              <div className="px-4 border-b">
                <TabsList className="bg-transparent h-9 p-0 gap-1">
                  <TabsTrigger
                    value="all"
                    className="h-8 text-xs rounded-none border-b-2 border-transparent data-[state=active]:border-gray-900 data-[state=active]:bg-transparent"
                  >
                    <Users size={12} className="mr-1" /> All ({allRecords.length})
                  </TabsTrigger>
                  <TabsTrigger
                    value="production"
                    className="h-8 text-xs rounded-none border-b-2 border-transparent data-[state=active]:border-gray-900 data-[state=active]:bg-transparent"
                  >
                    <Factory size={12} className="mr-1" /> Production ({productionRecords.length})
                  </TabsTrigger>
                  <TabsTrigger
                    value="staff"
                    className="h-8 text-xs rounded-none border-b-2 border-transparent data-[state=active]:border-gray-900 data-[state=active]:bg-transparent"
                  >
                    <Briefcase size={12} className="mr-1" /> Staff ({staffRecords.length})
                  </TabsTrigger>
                </TabsList>
              </div>
              <TabsContent value={activeTab} className="mt-0">
                <EmployeeTable
                  records={activeRecords}
                  isLoading={dailyLoading}
                  onClickEmployee={(id) => setDetailEmpId(id)}
                />
              </TabsContent>
            </Tabs>
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
              <Label>Employee ID</Label>
              <Input
                type="number"
                placeholder="Enter Employee ID"
                value={manualForm.employeeId}
                onChange={(e) => setManualForm((f) => ({ ...f, employeeId: e.target.value }))}
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
                  type="number"
                  min="0" max="24" step="0.5"
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
              <Button variant="outline" className="flex-1" onClick={() => setShowManualDialog(false)}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={addManualAttendance} disabled={createManual.isPending}>
                {createManual.isPending ? "Saving…" : "Save Attendance"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Employee Detail Dialog ── */}
      <Dialog open={!!detailEmpId} onOpenChange={(open) => { if (!open) setDetailEmpId(null); }}>
        <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>
              {empDetail ? `${empDetail.employee.name} — Attendance History` : "Attendance History"}
            </DialogTitle>
          </DialogHeader>

          {empDetailLoading ? (
            <div className="space-y-3 py-4">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : empDetail ? (
            <div className="flex flex-col gap-4 overflow-hidden">
              {/* Employee info bar */}
              <div className="flex items-center gap-4 p-3 bg-gray-50 rounded-lg text-sm flex-wrap">
                <span className="text-gray-500">Code: <strong className="text-gray-800 font-mono">{empDetail.employee.code}</strong></span>
                {empDetail.employee.department && (
                  <span className="text-gray-500">Dept: <strong className="text-gray-800">{empDetail.employee.department}</strong></span>
                )}
                <span className="text-gray-500">Type: <strong className="text-gray-800 capitalize">{empDetail.employee.employmentType}</strong></span>
                <span className="flex gap-3 ml-auto">
                  <span className="text-green-700 font-semibold">{empDetail.totalPresent} Present</span>
                  <span className="text-red-600 font-semibold">{empDetail.totalAbsent} Absent</span>
                </span>
              </div>

              {/* Filter controls */}
              <div className="flex items-center gap-2 flex-wrap">
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

              {/* Records table */}
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
