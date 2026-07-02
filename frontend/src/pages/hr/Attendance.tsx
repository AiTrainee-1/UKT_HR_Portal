import { useState, useRef } from "react";
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
  useSyncBiometric, useAttendanceReportLog, useComputeShiftLogs,
  useAttendanceLateSummary, type ShiftLogEntry,
} from "@/lib/api-client/custom-hooks";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import {
  Users, UserCheck, UserX, CalendarDays, Plus,
  Factory, Briefcase, Fingerprint, PenLine, ChevronRight, RefreshCw,
  Search, ChevronDown, ClipboardList, AlertTriangle, CheckCircle2, XCircle,
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

// ── Report Log Section (embedded) ─────────────────────────────────────────

function ReportLogSection() {
  const { toast } = useToast();
  const [tab, setTab] = useState<"day" | "month" | "late">("day");
  const [date, setDate] = useState(today());
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const [empId, setEmpId] = useState<number | null>(null);

  // Per-table pagination pages (reset to 1 on filter/tab changes)
  const [dayPage,    setDayPage]    = useState(1);
  const [monthPage,  setMonthPage]  = useState(1);
  const [shiftPage,  setShiftPage]  = useState(1);
  const [latePage,   setLatePage]   = useState(1);

  const { data: employees } = useListEmployees({ status: "active" });

  const { data: dayData, isLoading: dayLoading, refetch: refetchDay } =
    useAttendanceReportLog({ date }, tab === "day");

  const { data: monthData, isLoading: monthLoading, refetch: refetchMonth } =
    useAttendanceReportLog(
      { month, year, employeeId: empId ?? undefined },
      tab === "month"
    );

  const { data: lateData, isLoading: lateLoading } =
    useAttendanceLateSummary(month, year, tab === "late");

  const computeMutation = useComputeShiftLogs();

  const handleRecompute = async () => {
    try {
      if (tab === "day") {
        await computeMutation.mutateAsync({ date });
        refetchDay();
      } else {
        await computeMutation.mutateAsync({ month, year, employeeId: empId ?? undefined });
        refetchMonth();
      }
      toast({ title: "Shift logs recomputed" });
    } catch {
      toast({ title: "Recompute failed", variant: "destructive" });
    }
  };

  // Pagination helpers
  const paginate = <T,>(items: T[], page: number) => {
    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const safePage = Math.min(page, totalPages);
    return { slice: items.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE), total, totalPages, safePage };
  };

  return (
    <Card className="border">
      <CardHeader className="pb-0 pt-4 px-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center shrink-0">
              <ClipboardList size={15} className="text-white" />
            </div>
            <div>
              <CardTitle className="text-sm font-bold text-gray-900">Report Log</CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">4-punch breakdown · shift completion · late detection · monthly penalties</p>
            </div>
          </div>

          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            {/* Tab toggles */}
            <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
              {(["day", "month", "late"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                    tab === t ? "bg-indigo-600 text-white shadow-sm" : "text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {t === "day" ? "Day View" : t === "month" ? "Month View" : "Late Summary"}
                </button>
              ))}
            </div>

            {/* Filters */}
            {tab === "day" && (
              <Input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="h-8 text-xs w-36"
              />
            )}
            {(tab === "month" || tab === "late") && (
              <>
                <select
                  value={month}
                  onChange={(e) => setMonth(Number(e.target.value))}
                  className="h-8 rounded-md border px-2 text-xs bg-background"
                >
                  {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
                </select>
                <Input
                  type="number"
                  value={year}
                  onChange={(e) => setYear(Number(e.target.value))}
                  className="w-20 h-8 text-xs"
                  min={2020} max={2035}
                />
              </>
            )}
            {tab === "month" && (
              <select
                value={empId ?? ""}
                onChange={(e) => setEmpId(e.target.value ? Number(e.target.value) : null)}
                className="h-8 rounded-md border px-2 text-xs bg-background max-w-[200px]"
              >
                <option value="">— All staff employees —</option>
                {(employees ?? []).filter(e => e.employmentType === "staff").map(e => (
                  <option key={e.id} value={e.id}>
                    {e.firstName} {e.lastName} ({e.employeeCode})
                  </option>
                ))}
              </select>
            )}

            {/* Recompute */}
            {tab !== "late" && (
              <button
                onClick={handleRecompute}
                disabled={computeMutation.isPending}
                className="h-8 px-3 text-xs border rounded-lg text-indigo-700 border-indigo-200 hover:bg-indigo-50 flex items-center gap-1.5 font-semibold"
              >
                <RefreshCw size={12} className={computeMutation.isPending ? "animate-spin" : ""} />
                Recompute
              </button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0 mt-3">
        {/* ── Day View ── */}
        {tab === "day" && (() => {
          const { slice, total, totalPages, safePage } = paginate(dayData ?? [], dayPage);
          return dayLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !dayData || dayData.length === 0 ? (
            <div className="py-14 text-center border-t">
              <ClipboardList size={32} className="text-gray-200 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No shift logs for {date}.</p>
              <p className="text-xs text-muted-foreground mt-1">Click "Recompute" to process this day's punches.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto border-t">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {["Employee", "Shift", "P1 — Morning IN", "P2 — Lunch OUT", "P3 — Return IN", "P4 — Evening OUT", "1st ½", "2nd ½", "Shifts", "Late"].map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map((row: ShiftLogEntry) => {
                      const isHalf = row.shiftsCompleted === "0.50";
                      return (
                        <tr key={row.employeeId} className={`border-b hover:bg-gray-50 transition-colors ${isHalf ? "bg-amber-50/30" : ""}`}>
                          <td className="px-4 py-3">
                            <p className="font-semibold text-gray-900 text-sm">{row.employeeName}</p>
                            <p className="text-[11px] text-gray-400 font-mono">{row.employeeCode}</p>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-500">{row.shiftName ?? "—"}</td>
                          <td className="px-4 py-3 font-mono text-sm">
                            {row.punch1
                              ? <span className={row.lateMorning ? "text-red-600 font-bold" : "text-green-700"}>{row.punch1}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 font-mono text-sm text-gray-600">{row.punch2 ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-4 py-3 font-mono text-sm">
                            {row.punch3
                              ? <span className={row.lateReturn ? "text-orange-600 font-bold" : "text-gray-700"}>{row.punch3}</span>
                              : <span className="text-gray-300">—</span>}
                          </td>
                          <td className="px-4 py-3 font-mono text-sm text-gray-600">{row.punch4 ?? <span className="text-gray-300">—</span>}</td>
                          <td className="px-4 py-3">
                            {row.firstHalf
                              ? <CheckCircle2 size={16} className="text-green-600" />
                              : <XCircle size={16} className="text-gray-300" />}
                          </td>
                          <td className="px-4 py-3">
                            {row.secondHalf
                              ? <CheckCircle2 size={16} className="text-green-600" />
                              : <XCircle size={16} className="text-gray-300" />}
                          </td>
                          <td className="px-4 py-3">
                            <span className={`font-bold ${isHalf ? "text-amber-700" : "text-gray-800"}`}>{row.shiftsCompleted}</span>
                            {isHalf && <span className="ml-1.5 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">½</span>}
                          </td>
                          <td className="px-4 py-3">
                            {(row.lateMorning || row.lateReturn) ? (
                              <span className="flex items-center gap-1.5 text-red-600 font-semibold text-xs">
                                <AlertTriangle size={13} />
                                {[row.lateMorning && "AM", row.lateReturn && "PM"].filter(Boolean).join("+")}
                              </span>
                            ) : <span className="text-green-600 text-sm">✓</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: PAGE_SIZE - slice.length }).map((_, i) => (
                      <tr key={`fill-${i}`} className="border-b">
                        <td className="h-[61px]" colSpan={10} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={safePage} totalPages={totalPages} total={total} onPage={setDayPage} />
            </>
          );
        })()}

        {/* ── Month View ── */}
        {tab === "month" && (() => {
          const { slice, total, totalPages, safePage } = paginate(monthData ?? [], monthPage);
          return monthLoading ? (
            <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
          ) : !monthData || monthData.length === 0 ? (
            <div className="py-14 text-center border-t">
              <ClipboardList size={32} className="text-gray-200 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No shift logs for {MONTH_FULL[month - 1]} {year}.</p>
              <p className="text-xs text-muted-foreground mt-1">Click "Recompute" to process the full month.</p>
            </div>
          ) : (
            <>
              <div className="overflow-x-auto border-t">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {["Date", "Employee", "Shift", "P1 IN", "P2 Lunch", "P3 Return", "P4 OUT", "1st ½", "2nd ½", "Shifts", "Late"].map(h => (
                        <th key={h} className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map((row: ShiftLogEntry, i: number) => {
                      const isHalf = row.shiftsCompleted === "0.50";
                      return (
                        <tr key={i} className={`border-b hover:bg-gray-50 ${isHalf ? "bg-amber-50/30" : ""}`}>
                          <td className="px-3 py-2.5 text-xs font-mono text-gray-700">{row.date}</td>
                          <td className="px-3 py-2.5">
                            <p className="font-semibold text-xs text-gray-900">{row.employeeName}</p>
                            <p className="text-[10px] font-mono text-gray-400">{row.employeeCode}</p>
                          </td>
                          <td className="px-3 py-2.5 text-xs text-gray-500">{row.shiftName ?? "—"}</td>
                          <td className={`px-3 py-2.5 font-mono text-xs ${row.lateMorning ? "text-red-600 font-bold" : "text-gray-700"}`}>{row.punch1 ?? "—"}</td>
                          <td className="px-3 py-2.5 font-mono text-xs text-gray-600">{row.punch2 ?? "—"}</td>
                          <td className={`px-3 py-2.5 font-mono text-xs ${row.lateReturn ? "text-orange-600 font-bold" : "text-gray-700"}`}>{row.punch3 ?? "—"}</td>
                          <td className="px-3 py-2.5 font-mono text-xs text-gray-600">{row.punch4 ?? "—"}</td>
                          <td className="px-3 py-2.5">{row.firstHalf ? <CheckCircle2 size={13} className="text-green-600" /> : <XCircle size={13} className="text-gray-300" />}</td>
                          <td className="px-3 py-2.5">{row.secondHalf ? <CheckCircle2 size={13} className="text-green-600" /> : <XCircle size={13} className="text-gray-300" />}</td>
                          <td className="px-3 py-2.5">
                            <span className={`text-xs font-bold ${isHalf ? "text-amber-700" : "text-gray-800"}`}>{row.shiftsCompleted}</span>
                            {isHalf && <span className="ml-1 text-[9px] font-semibold bg-amber-100 text-amber-700 px-1 py-0.5 rounded-full">½</span>}
                          </td>
                          <td className="px-3 py-2.5 text-xs">
                            {(row.lateMorning || row.lateReturn)
                              ? <span title={row.lateReason ?? ""}><AlertTriangle size={13} className="text-red-500" /></span>
                              : <span className="text-green-500">✓</span>}
                          </td>
                        </tr>
                      );
                    })}
                    {Array.from({ length: PAGE_SIZE - slice.length }).map((_, i) => (
                      <tr key={`fill-${i}`} className="border-b">
                        <td className="h-[49px]" colSpan={11} />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={safePage} totalPages={totalPages} total={total} onPage={setMonthPage} />
            </>
          );
        })()}

        {/* ── Late Summary ── */}
        {tab === "late" && (
          <div className="border-t">
            <div className="flex items-start gap-2 p-3 m-4 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800">
              <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>Deduction Rule:</strong> Each employee gets 3 free lates per month.
                Every 3 billable lates beyond that = ¼ shift deducted from salary.
                Applied automatically when payroll is generated.
              </span>
            </div>

            {lateLoading ? (
              <div className="py-12 text-center text-sm text-muted-foreground">Loading…</div>
            ) : !lateData || lateData.employees.length === 0 ? (
              <div className="py-14 text-center">
                <p className="text-sm text-gray-500">No late summary for {MONTH_FULL[month - 1]} {year}.</p>
                <p className="text-xs text-muted-foreground mt-1">Switch to Month View, run Recompute first, then regenerate payroll.</p>
              </div>
            ) : (() => {
              const empList = lateData.employees;
              const sc = paginate(empList, shiftPage);
              const lp = paginate(empList, latePage);
              return (
                <div className="space-y-4 px-4 pb-4">
                  {/* Shift Completion */}
                  <div className="rounded-xl border bg-white overflow-hidden">
                    <div className="px-4 py-2.5 border-b bg-gray-50">
                      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Shift Completion Summary</p>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="border-b">
                        <tr>
                          {["Employee", "Dept", "Total Shifts", "Full Shifts", "Half Shifts", "Effective Days"].map(h => (
                            <th key={h} className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sc.slice.map((row) => {
                          const total = parseFloat(row.totalShifts);
                          const half  = row.halfShiftDays ?? 0;
                          const full  = total - half * 0.5;
                          return (
                            <tr key={row.employeeId} className={`border-b hover:bg-gray-50 ${half > 0 ? "bg-amber-50/20" : ""}`}>
                              <td className="px-4 py-2.5">
                                <p className="font-semibold text-sm text-gray-900">{row.employeeName}</p>
                                <p className="text-[11px] font-mono text-gray-400">{row.employeeCode}</p>
                              </td>
                              <td className="px-4 py-2.5 text-xs text-gray-600">{row.department ?? "—"}</td>
                              <td className="px-4 py-2.5 font-bold text-sm text-indigo-700">{total.toFixed(2)}</td>
                              <td className="px-4 py-2.5 font-bold text-sm text-green-700">{Math.floor(full)}</td>
                              <td className="px-4 py-2.5">
                                {half > 0
                                  ? <span className="font-bold text-sm text-amber-700"><span className="text-xs bg-amber-100 px-1.5 py-0.5 rounded-full">½×{half}</span></span>
                                  : <span className="text-gray-400 text-sm">0</span>}
                              </td>
                              <td className="px-4 py-2.5 font-bold text-sm text-gray-800">{total.toFixed(2)} days</td>
                            </tr>
                          );
                        })}
                        {Array.from({ length: PAGE_SIZE - sc.slice.length }).map((_, i) => (
                          <tr key={`fill-${i}`} className="border-b">
                            <td className="h-[49px]" colSpan={6} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <Pagination page={sc.safePage} totalPages={sc.totalPages} total={sc.total} onPage={setShiftPage} />
                  </div>

                  {/* Late Penalty */}
                  <div className="rounded-xl border bg-white overflow-hidden">
                    <div className="px-4 py-2.5 border-b bg-gray-50">
                      <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">Late Penalty Summary</p>
                    </div>
                    <table className="w-full text-sm">
                      <thead className="border-b">
                        <tr>
                          {["Employee", "Department", "Total Late", "Free (3)", "Billable", "Shift Deductions", "Salary Deduction"].map(h => (
                            <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {lp.slice.map((row) => (
                          <tr key={row.employeeId} className={`border-b hover:bg-gray-50 ${row.billableLateCount > 0 ? "bg-red-50/20" : ""}`}>
                            <td className="px-4 py-3">
                              <p className="font-semibold text-sm text-gray-900">{row.employeeName}</p>
                              <p className="text-[11px] font-mono text-gray-400">{row.employeeCode}</p>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">{row.department ?? "—"}</td>
                            <td className="px-4 py-3">
                              <span className={`font-bold text-sm ${row.totalLateCount > 0 ? "text-amber-700" : "text-gray-400"}`}>{row.totalLateCount}</span>
                            </td>
                            <td className="px-4 py-3 text-sm text-gray-600">{row.permissionsUsed}/3</td>
                            <td className="px-4 py-3">
                              <span className={`font-bold text-sm ${row.billableLateCount > 0 ? "text-red-700" : "text-green-600"}`}>{row.billableLateCount}</span>
                            </td>
                            <td className="px-4 py-3 font-bold text-sm text-gray-800">{row.shiftDeductions}</td>
                            <td className="px-4 py-3">
                              <span className={`font-bold text-sm ${parseFloat(row.salaryDeductionAmount) > 0 ? "text-red-700" : "text-green-600"}`}>
                                ₹{parseFloat(row.salaryDeductionAmount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                              </span>
                            </td>
                          </tr>
                        ))}
                        {Array.from({ length: PAGE_SIZE - lp.slice.length }).map((_, i) => (
                          <tr key={`fill-${i}`} className="border-b">
                            <td className="h-[53px]" colSpan={7} />
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <Pagination page={lp.safePage} totalPages={lp.totalPages} total={lp.total} onPage={setLatePage} />
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </CardContent>
    </Card>
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
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState<"today" | "days3" | "days7" | "month" | "prevmonth" | "all">("today");
  const [showSyncMenu, setShowSyncMenu] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const syncMenuRef = useRef<HTMLDivElement>(null);

  const { data: employees } = useListEmployees({ status: "active" });
  const syncMutation = useSyncBiometric();

  const SYNC_MODES = [
    { key: "today",     label: "Today only" },
    { key: "days3",     label: "Last 3 days" },
    { key: "days7",     label: "Last 7 days" },
    { key: "month",     label: "This month" },
    { key: "prevmonth", label: "Previous month" },
    { key: "all",       label: "All records (first-time import)" },
  ] as const;

  const syncModeLabel = SYNC_MODES.find(m => m.key === syncMode)?.label ?? "Today only";

  const handleSync = async (modeOverride?: string) => {
    const mode = modeOverride ?? syncMode;
    setShowSyncMenu(false);
    try {
      const result = await syncMutation.mutateAsync(mode as any);
      if (result.ok) {
        setLastSyncedAt(new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }));
        const unmatched: string[] = result.unmatchedDeviceIds ?? [];
        toast({
          title: `Sync complete — ${result.created ?? 0} new records`,
          description: unmatched.length > 0
            ? `⚠ ${unmatched.length} device ID(s) had no matching employee: ${unmatched.join(", ")}`
            : undefined,
          variant: unmatched.length > 0 ? "destructive" : "default",
        });
        queryClient.invalidateQueries({ queryKey: getAttendanceSummaryQueryKey(selectedDate) });
        queryClient.invalidateQueries({ queryKey: getAttendanceDailyQueryKey(selectedDate) });
        queryClient.invalidateQueries({ queryKey: getAttendanceMonthlyTrendQueryKey(selectedYear, selectedMonth) });
        if (detailEmpId) {
          queryClient.invalidateQueries({ queryKey: ["attendance-employee", detailEmpId] });
        }
      } else {
        toast({ title: "Sync failed", description: result.error ?? "Device unreachable", variant: "destructive" });
      }
    } catch {
      toast({ title: "Sync failed", description: "Could not reach device", variant: "destructive" });
    }
  };

  const { data: summary, isLoading: summaryLoading } = useAttendanceSummary(selectedDate);
  const { data: dailyList, isLoading: dailyLoading }  = useAttendanceDaily(selectedDate);
  const { data: monthlyTrend } = useAttendanceMonthlyTrend(selectedYear, selectedMonth);
  const { data: empDetail, isLoading: empDetailLoading } = useAttendanceEmployeeHistory(
    detailEmpId, selectedMonth, selectedYear,
  );
  const createManual = useCreateManualAttendance();

  const allRecords        = dailyList ?? [];
  const productionRecords = allRecords.filter((r) => r.employmentType === "production");
  const staffRecords      = allRecords.filter((r) => r.employmentType === "staff");
  const activeRecords     =
    activeTab === "production" ? productionRecords
    : activeTab === "staff"   ? staffRecords
    : allRecords;

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
            <h2 className="text-2xl font-black text-gray-900">Attendance</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Real-time tracking · AiFace-Mars biometric integration
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {/* Sync split-button */}
            <div ref={syncMenuRef} className="relative flex items-center">
              <Button
                variant="outline"
                onClick={() => handleSync()}
                disabled={syncMutation.isPending}
                className="gap-2 h-9 border-cyan-200 text-cyan-700 hover:bg-cyan-50 rounded-r-none border-r-0"
              >
                <RefreshCw size={14} className={syncMutation.isPending ? "animate-spin" : ""} />
                {syncMutation.isPending ? "Syncing…" : "Sync Biometric"}
                {lastSyncedAt && !syncMutation.isPending && (
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
                <div className="absolute top-full right-0 mt-1 z-50 bg-white border rounded-xl shadow-lg overflow-hidden min-w-[200px]">
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

        {/* ── Summary Cards ── */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <StatCard
            icon={Users}
            label="Total Employees"
            value={summary?.totalEmployees ?? "—"}
            colorCls="bg-gray-700"
            sub={
              <span className="flex gap-3">
                <span><strong className="text-gray-700">{summary?.productionTotal ?? "—"}</strong> Production</span>
                <span><strong className="text-gray-700">{summary?.staffTotal ?? "—"}</strong> Staff</span>
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

        {/* ── Report Log (embedded) ── */}
        <ReportLogSection />

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
