import { useState } from "react";
import { useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Input } from "@/components/ui/input";
import {
  useAttendanceReportSummary, useAttendanceReportDetail, useAttendanceLateSummary,
  usePayrollSettings,
  type ShiftLogEntry, type MonthlySummaryRow,
} from "@/lib/api-client/custom-hooks";
import { useListDepartments } from "@/lib/api-client";
import {
  ClipboardList, AlertTriangle, ChevronLeft, ChevronDown, ChevronUp, Search, Users, Building2, Loader2,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────

const currentMonth = () => new Date().getMonth() + 1;
const currentYear = () => new Date().getFullYear();

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_STYLES: Record<ShiftLogEntry["status"], string> = {
  present: "bg-green-100 text-green-700",
  half_shift: "bg-amber-100 text-amber-700",
  absent: "bg-red-100 text-red-700",
  on_leave: "bg-blue-100 text-blue-700",
  holiday: "bg-gray-100 text-gray-600",
};

const STATUS_LABELS: Record<ShiftLogEntry["status"], string> = {
  present: "Present",
  half_shift: "Half Shift",
  absent: "Absent",
  on_leave: "On Leave",
  holiday: "Holiday",
};

function StatusBadge({ status }: { status: ShiftLogEntry["status"] }) {
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

// The backend only ever sends approved CL/Permission/Leave rows here
// (pending and rejected requests aren't final, so they don't belong on an
// attendance report) — a present row is always "approved", hence the fixed
// green style on all three badges below.
function CasualLeaveBadge({ cl }: { cl: ShiftLogEntry["casualLeave"] }) {
  if (!cl) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap bg-green-50 text-green-700 border-green-200"
      title={cl.reason ?? ""}
    >
      CL · Approved
    </span>
  );
}

function PermissionBadge({ perm }: { perm: ShiftLogEntry["permission"] }) {
  if (!perm) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap bg-green-50 text-green-700 border-green-200"
      title={perm.reason ?? ""}
    >
      Perm {perm.time ? `· ${perm.time}` : ""} · Approved
    </span>
  );
}

function LeaveBadge({ leave }: { leave: ShiftLogEntry["leave"] }) {
  if (!leave) return <span className="text-gray-300 text-xs">—</span>;
  return (
    <span
      className="text-[10px] font-bold px-1.5 py-0.5 rounded-full border whitespace-nowrap bg-blue-50 text-blue-700 border-blue-200"
      title={leave.reason ?? ""}
    >
      {leave.type ?? "Leave"} · Approved
    </span>
  );
}

function LateCell({ row }: { row: ShiftLogEntry }) {
  if (!row.isLate) return <span className="text-green-600 text-sm">✓</span>;
  const parts = [row.lateMorning && "AM", row.lateReturn && "Return"].filter(Boolean);
  return (
    <span className="flex items-center gap-1.5 text-red-600 font-semibold text-xs" title={row.lateReason ?? ""}>
      <AlertTriangle size={13} />
      {parts.length > 0 ? parts.join(" + ") : "Late"}
    </span>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export default function AttendanceReportLog() {
  const [, navigate] = useLocation();

  const [month, setMonth] = useState(currentMonth());
  const [year, setYear] = useState(currentYear());
  const [department, setDepartment] = useState("");
  const [search, setSearch] = useState("");
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);
  const [showLatePenalty, setShowLatePenalty] = useState(false);

  const { data: departments } = useListDepartments();
  const { data: settings } = usePayrollSettings();
  const simpleMode = settings?.attendanceMode === "simple";

  const isDetail = selectedEmployeeId != null;

  const { data: summaryData, isLoading: summaryLoading } = useAttendanceReportSummary(
    { month, year, department: department ? Number(department) : undefined, search: search || undefined },
    !isDetail,
  );

  const { data: detailData, isLoading: detailLoading } = useAttendanceReportDetail(
    { month, year, employeeId: selectedEmployeeId ?? 0 },
    isDetail,
  );

  const { data: lateData, isLoading: lateLoading } = useAttendanceLateSummary(month, year, showLatePenalty);

  function renderRow(row: ShiftLogEntry) {
    return (
      <tr
        key={row.date}
        className={`border-b hover:bg-gray-50 transition-colors ${
          row.status === "absent" ? "bg-red-50/30" : row.isHalfShift ? "bg-amber-50/30" : ""
        }`}
      >
        <td className="px-3 py-2.5 text-xs font-mono text-gray-700 whitespace-nowrap">{row.date}</td>
        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
          {row.assignedShift ? (
            <>
              <p className="font-medium text-gray-700">{row.assignedShift.name}</p>
              <p className="text-[10px] text-gray-400">
                {row.assignedShift.startTime}–{row.assignedShift.endTime} · Grace {row.assignedShift.gracePeriodMinutes}m
              </p>
            </>
          ) : (
            <span className="text-gray-300">No shift assigned</span>
          )}
        </td>
        <td className="px-4 py-3 font-mono text-sm whitespace-nowrap">
          {row.punch1
            ? <span className={row.lateMorning ? "text-red-600 font-bold" : "text-green-700"}>{row.punch1}</span>
            : <span className="text-gray-300">—</span>}
        </td>
        {!simpleMode && (
          <>
            <td className="px-4 py-3 font-mono text-sm text-gray-600 whitespace-nowrap">{row.punch2 ?? <span className="text-gray-300">—</span>}</td>
            <td className="px-4 py-3 font-mono text-sm whitespace-nowrap">
              {row.punch3
                ? <span className={row.lateReturn ? "text-orange-600 font-bold" : "text-gray-700"}>{row.punch3}</span>
                : <span className="text-gray-300">—</span>}
            </td>
          </>
        )}
        <td className="px-4 py-3 font-mono text-sm text-gray-600 whitespace-nowrap">{row.punch4 ?? <span className="text-gray-300">—</span>}</td>
        <td className="px-4 py-3"><StatusBadge status={row.status} /></td>
        <td className="px-4 py-3">
          <span className={`font-bold ${row.isHalfShift ? "text-amber-700" : "text-gray-800"}`}>{row.shiftsCompleted}</span>
        </td>
        <td className="px-4 py-3"><LateCell row={row} /></td>
        <td className="px-4 py-3"><CasualLeaveBadge cl={row.casualLeave} /></td>
        <td className="px-4 py-3"><PermissionBadge perm={row.permission} /></td>
        <td className="px-4 py-3"><LeaveBadge leave={row.leave} /></td>
      </tr>
    );
  }

  const columnHeaders = [
    "Date", "Assigned Shift", "P1 · Morning IN",
    ...(simpleMode ? [] : ["P2 · Lunch OUT", "P3 · Lunch IN"]),
    "P4 · Evening OUT", "Status", "Shifts", "Late", "CL", "Permission", "Leave",
  ];

  return (
    <HrLayout>
      <div className="max-w-[1400px] mx-auto px-6 py-6 space-y-5">

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
              Every punch, shift, status, and reason — CL, Permission, and Leave included — for every staff employee.
            </p>
          </div>
          <span
            className={`ml-auto text-[10px] font-bold px-2.5 py-1 rounded-full uppercase tracking-wide ${
              simpleMode ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"
            }`}
            title="Attendance calculation mode — change it in Settings → Attendance"
          >
            {simpleMode ? "Simple Mode" : "Strict Mode"}
          </span>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-2 flex-wrap">
          {isDetail ? (
            <button
              onClick={() => setSelectedEmployeeId(null)}
              className="h-8 px-3 text-xs border rounded-lg text-indigo-700 border-indigo-200 hover:bg-indigo-50 flex items-center gap-1.5 font-semibold"
            >
              <ChevronLeft size={13} /> All Employees
            </button>
          ) : (
            <>
              <div className="relative">
                <Building2 size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <select
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="h-8 rounded-md border pl-7 pr-2 text-xs bg-background"
                >
                  <option value="">All Departments</option>
                  {(departments ?? []).map(d => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="relative">
                <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search by employee code or name…"
                  className="h-8 text-xs pl-7 w-64"
                />
              </div>
            </>
          )}
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
          {!isDetail && (
            <button
              onClick={() => setShowLatePenalty(v => !v)}
              className="ml-auto h-8 px-3 text-xs border rounded-lg text-amber-700 border-amber-200 hover:bg-amber-50 flex items-center gap-1.5 font-semibold"
            >
              {showLatePenalty ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Late-Penalty Breakdown
            </button>
          )}
        </div>

        {/* ── Mode A: All Employees / Department Summary ── */}
        {!isDetail && (
          <>
            <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
              {summaryLoading ? (
                <div className="py-20 flex flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
                  <Loader2 size={22} className="animate-spin text-indigo-500" />
                  <span>Computing attendance for every employee this month…</span>
                </div>
              ) : !summaryData || summaryData.employees.length === 0 ? (
                <div className="py-20 text-center">
                  <Users size={36} className="text-gray-200 mx-auto mb-3" />
                  <p className="text-sm text-gray-500">No matching employees found.</p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        {["Employee", "Department", "Present", "Half Shift", "Absent", "On Leave", "CL", "Permission", "Holidays", "Late", "Total Shifts", "Effective Days"].map(h => (
                          <th key={h} className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {summaryData.employees.map((row: MonthlySummaryRow) => (
                        <tr
                          key={row.employeeId}
                          onClick={() => setSelectedEmployeeId(row.employeeId)}
                          className={`border-b hover:bg-indigo-50/50 cursor-pointer transition-colors ${row.absentDays > 0 ? "bg-red-50/20" : ""}`}
                        >
                          <td className="px-4 py-3">
                            <p className="font-semibold text-gray-900 text-sm whitespace-nowrap">{row.employeeName}</p>
                            <p className="text-[11px] text-gray-400 font-mono">{row.employeeCode}</p>
                          </td>
                          <td className="px-4 py-3 text-xs text-gray-600 whitespace-nowrap">{row.department ?? "—"}</td>
                          <td className="px-4 py-3 font-bold text-sm text-green-700">{row.presentDays}</td>
                          <td className="px-4 py-3 font-bold text-sm text-amber-700">{row.halfShiftDays}</td>
                          <td className="px-4 py-3 font-bold text-sm text-red-700">{row.absentDays}</td>
                          <td className="px-4 py-3 font-bold text-sm text-blue-700">{row.onLeaveDays}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{row.casualLeaveCount}</td>
                          <td className="px-4 py-3 text-sm text-gray-700">{row.permissionCount}</td>
                          <td className="px-4 py-3 text-sm text-gray-500">{row.holidays}</td>
                          <td className="px-4 py-3">
                            <span className={`font-bold text-sm ${row.lateCount > 0 ? "text-red-600" : "text-gray-400"}`}>{row.lateCount}</span>
                          </td>
                          <td className="px-4 py-3 font-bold text-sm text-indigo-700">{row.totalShifts}</td>
                          <td className="px-4 py-3 font-bold text-sm text-gray-800">{row.effectiveDays}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* ── Late-Penalty Breakdown (collapsible, payroll-adjacent) ── */}
            {showLatePenalty && (
              <div className="space-y-3">
                <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-xl text-xs text-amber-800">
                  <AlertTriangle size={14} className="text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    <strong>Deduction Rule:</strong> Each employee gets 3 free lates per month.
                    Every 3 billable lates beyond that = ¼ shift deducted from salary.
                    These deductions are applied automatically when payroll is generated.
                  </span>
                </div>
                <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
                  {lateLoading ? (
                    <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                      <Loader2 size={18} className="animate-spin text-amber-500" /> Loading…
                    </div>
                  ) : !lateData || lateData.employees.length === 0 ? (
                    <div className="py-20 text-center">
                      <p className="text-sm text-gray-500">No late summary for {MONTH_NAMES[month - 1]} {year}.</p>
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
          </>
        )}

        {/* ── Mode B: Single Employee Detail ── */}
        {isDetail && (
          <div className="rounded-xl border bg-white overflow-hidden shadow-sm">
            {detailLoading ? (
              <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <Loader2 size={18} className="animate-spin text-indigo-500" /> Loading…
              </div>
            ) : !detailData ? (
              <div className="py-20 text-center">
                <ClipboardList size={36} className="text-gray-200 mx-auto mb-3" />
                <p className="text-sm text-gray-500">No attendance for {MONTH_NAMES[month - 1]} {year}.</p>
              </div>
            ) : (
              <>
                <div className="px-4 py-3 border-b bg-gray-50 flex items-center gap-3">
                  <div>
                    <p className="font-bold text-sm text-gray-900">{detailData.employee.name}</p>
                    <p className="text-[11px] text-gray-400 font-mono">
                      {detailData.employee.code} · {detailData.employee.department ?? "—"}
                      {detailData.employee.designation ? ` · ${detailData.employee.designation}` : ""}
                    </p>
                  </div>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        {columnHeaders.map(h => (
                          <th key={h} className="text-left px-3 py-3 text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {detailData.days.map((row) => renderRow(row))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

      </div>
    </HrLayout>
  );
}
