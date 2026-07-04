import { useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useAttendanceReportLog, useComputeShiftLogs, useAttendanceLateSummary,
  usePayrollSettings,
  type ShiftLogEntry,
} from "@/lib/api-client/custom-hooks";
import { useListEmployees } from "@/lib/api-client";
import {
  ClipboardList, RefreshCw, AlertTriangle, CheckCircle2, XCircle,
  ChevronLeft,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

// ── Component ──────────────────────────────────────────────────────────────

export default function AttendanceReportLog() {
  const [, navigate] = useLocation();
  const { toast } = useToast();

  const [tab, setTab] = useState<"day" | "month" | "late">("day");
  const [date, setDate] = useState(today());
  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const [empId, setEmpId] = useState<number | null>(null);

  const { data: employees } = useListEmployees({ status: "active" });
  const { data: settings } = usePayrollSettings();
  const simpleMode = settings?.attendanceMode === "simple";

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
    if (tab === "day") {
      await computeMutation.mutateAsync({ date });
      refetchDay();
    } else {
      await computeMutation.mutateAsync({ month, year, employeeId: empId ?? undefined });
      refetchMonth();
    }
    toast({ title: "Shift logs recomputed" });
  };

  return (
    <HrLayout>
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-5">

        {/* Header */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/hr/attendance")}
            className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
          >
            <ChevronLeft size={18} />
          </button>
          <div className="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center shrink-0">
            <ClipboardList size={18} className="text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Report Log</h1>
            <p className="text-xs text-muted-foreground">
              {simpleMode
                ? "Simple mode · morning + evening punch · half-shift cutoff · late detection"
                : "4-punch breakdown · shift completion · late detection · monthly penalties"}
            </p>
          </div>
          <span
            className={`ml-auto text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide ${
              simpleMode
                ? "bg-green-100 text-green-700"
                : "bg-amber-100 text-amber-700"
            }`}
            title="Attendance calculation mode — change it in Settings → Attendance"
          >
            {simpleMode ? "Simple Mode" : "Strict Mode"}
          </span>
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-2 flex-wrap">
          {/* Tabs */}
          <div className="flex items-center gap-1 bg-gray-100 rounded-lg p-1">
            {(["day", "month", "late"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold transition-colors ${
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
              className="h-8 rounded-md border px-2 text-xs bg-background flex-1 max-w-xs"
            >
              <option value="">— All staff employees —</option>
              {(employees ?? []).filter(e => e.employmentType === "staff").map(e => (
                <option key={e.id} value={e.id}>
                  {e.firstName} {e.lastName} ({e.employeeCode})
                </option>
              ))}
            </select>
          )}

          {/* Recompute — strict mode only; simple mode recomputes automatically on load */}
          {tab !== "late" && !simpleMode && (
            <button
              onClick={handleRecompute}
              disabled={computeMutation.isPending}
              className="ml-auto h-8 px-3 text-xs border rounded-lg text-indigo-700 border-indigo-200 hover:bg-indigo-50 flex items-center gap-1.5 font-semibold"
            >
              <RefreshCw size={12} className={computeMutation.isPending ? "animate-spin" : ""} />
              Recompute
            </button>
          )}
        </div>

        {/* ── Day View ── */}
        {tab === "day" && (
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
            {dayLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
            ) : !dayData || dayData.length === 0 ? (
              <div className="py-20 text-center">
                <ClipboardList size={36} className="text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No shift logs for {date}.</p>
                <p className="text-xs text-muted-foreground mt-1">Click "Recompute" to process this day's punches.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {(simpleMode
                        ? ["Employee", "Mode", "First IN", "Last OUT", "1st ½", "2nd ½", "Shifts", "Late"]
                        : ["Employee", "Shift", "P1 — Morning IN", "P2 — Lunch OUT", "P3 — Return IN", "P4 — Evening OUT", "1st ½", "2nd ½", "Shifts", "Late"]
                      ).map(h => (
                        <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dayData.map((row: ShiftLogEntry) => {
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
                        {!simpleMode && (
                          <>
                            <td className="px-4 py-3 font-mono text-sm text-gray-600">{row.punch2 ?? <span className="text-gray-300">—</span>}</td>
                            <td className="px-4 py-3 font-mono text-sm">
                              {row.punch3
                                ? <span className={row.lateReturn ? "text-orange-600 font-bold" : "text-gray-700"}>{row.punch3}</span>
                                : <span className="text-gray-300">—</span>}
                            </td>
                          </>
                        )}
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
                          {isHalf && <span className="ml-1.5 text-[10px] font-semibold bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-full">½ Shift</span>}
                        </td>
                        <td className="px-4 py-3">
                          {(row.lateMorning || row.lateReturn) ? (
                            <span className="flex items-center gap-1.5 text-red-600 font-semibold text-xs">
                              <AlertTriangle size={13} />
                              {[row.lateMorning && "AM", row.lateReturn && "Return"].filter(Boolean).join(" + ")}
                            </span>
                          ) : <span className="text-green-600 text-sm">✓</span>}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Month View ── */}
        {tab === "month" && (
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
            {monthLoading ? (
              <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
            ) : !monthData || monthData.length === 0 ? (
              <div className="py-20 text-center">
                <ClipboardList size={36} className="text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No shift logs for {MONTH_NAMES[month - 1]} {year}.</p>
                <p className="text-xs text-muted-foreground mt-1">Click "Recompute" to process the full month's punches.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      {(simpleMode
                        ? ["Date", "Employee", "Mode", "First IN", "Last OUT", "1st ½", "2nd ½", "Shifts", "Late"]
                        : ["Date", "Employee", "Shift", "P1 IN", "P2 Lunch", "P3 Return", "P4 OUT", "1st ½", "2nd ½", "Shifts", "Late"]
                      ).map(h => (
                        <th key={h} className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monthData.map((row: ShiftLogEntry, i: number) => {
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
                        {!simpleMode && (
                          <>
                            <td className="px-3 py-2.5 font-mono text-xs text-gray-600">{row.punch2 ?? "—"}</td>
                            <td className={`px-3 py-2.5 font-mono text-xs ${row.lateReturn ? "text-orange-600 font-bold" : "text-gray-700"}`}>{row.punch3 ?? "—"}</td>
                          </>
                        )}
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
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Late Summary ── */}
        {tab === "late" && (
          <div className="space-y-3">
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800">
              <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
              <span>
                <strong>Deduction Rule:</strong> Each employee gets 3 free lates per month.
                Every 3 billable lates beyond that = ¼ shift deducted from salary.
                These deductions are applied automatically when payroll is generated.
              </span>
            </div>
            {/* Shift Completion Summary */}
            {lateData && lateData.employees.length > 0 && (
              <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
                <div className="px-4 py-3 border-b bg-gray-50">
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
                    {lateData.employees.map((row) => {
                      const total = parseFloat(row.totalShifts);
                      const half = row.halfShiftDays ?? 0;
                      const full = total - half * 0.5; // approximate full shift days
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
                              ? <span className="inline-flex items-center gap-1 font-bold text-sm text-amber-700"><span className="text-xs bg-amber-100 px-1.5 py-0.5 rounded-full">½×{half}</span></span>
                              : <span className="text-gray-400 text-sm">0</span>}
                          </td>
                          <td className="px-4 py-2.5 font-bold text-sm text-gray-800">{total.toFixed(2)} days</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Late Penalty Summary */}
            <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
              {lateLoading ? (
                <div className="py-16 text-center text-sm text-muted-foreground">Loading…</div>
              ) : !lateData || lateData.employees.length === 0 ? (
                <div className="py-20 text-center">
                  <p className="text-sm text-gray-500">No late summary for {MONTH_NAMES[month - 1]} {year}.</p>
                  <p className="text-xs text-muted-foreground mt-1">Switch to Month View and run Recompute first, then regenerate payroll.</p>
                </div>
              ) : (
                <>
                  <div className="px-4 py-3 border-b bg-gray-50">
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
                      {lateData.employees.map((row) => (
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
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        )}

      </div>
    </HrLayout>
  );
}
