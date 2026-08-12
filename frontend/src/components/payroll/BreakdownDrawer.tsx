import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { usePayrollBreakdown, type PayrollRunItem } from "@/lib/api-client";
import {
  IndianRupee, Lock, CheckCircle2, Clock, ChevronDown, ChevronUp,
  AlertCircle, Info, ArrowRight, AlertTriangle, CalendarDays, X,
} from "lucide-react";

// Shared across Payroll (Staff) and Production Payroll pages -a payroll
// record's breakdown/row rendering doesn't care which page it's shown on,
// only on the record's own salaryMode/type, which /api/payroll/:id/breakdown
// already branches on server-side (staff monthly vs shift-based production
// vs legacy session-based production).

export const MONTH_NAMES = [
  "January","February","March","April","May","June",
  "July","August","September","October","November","December",
];
export const MONTH_SHORT = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:  { label: "Pending",  cls: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  paid:     { label: "Paid",     cls: "bg-green-50 text-green-700 border-green-200" },
  draft:    { label: "Draft",    cls: "bg-gray-50 text-gray-700 border-gray-200" },
  approved: { label: "Approved", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  locked:   { label: "Locked",   cls: "bg-purple-50 text-purple-700 border-purple-200" },
};

export const STATUS_COLORS: Record<string, string> = {
  present:      "bg-green-100 text-green-700",
  absent:       "bg-red-100 text-red-700",
  paid_leave:   "bg-blue-100 text-blue-700",
  unpaid_leave: "bg-orange-100 text-orange-700",
  half_shift:   "bg-amber-100 text-amber-700",
  holiday:      "bg-gray-100 text-gray-600",
};

export function BreakdownDrawer({ payrollId, onClose }: { payrollId: number; onClose: () => void }) {
  const { data, isLoading } = usePayrollBreakdown(payrollId);
  const bd = data?.breakdown;
  const [showAllDays, setShowAllDays] = useState(false);

  const displayDays = bd && !showAllDays ? bd.days.slice(0, 15) : bd?.days ?? [];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <IndianRupee size={18} className="text-green-600" />
            Salary Breakdown -{data ? `${data.employee.name}` : "Loading…"}
          </DialogTitle>
          {data && (
            <p className="text-xs text-muted-foreground">
              {data.periodStart && data.periodEnd
                ? `${data.periodStart} – ${data.periodEnd}`
                : `${MONTH_NAMES[(data.month ?? 1) - 1]} ${data.year}${data.weekNumber ? ` · Week ${data.weekNumber}` : ""}`}
              {" · "}{data.employee.code} · {data.employee.department ?? ""}
            </p>
          )}
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-3 py-4">
            {[1,2,3,4].map(i => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        ) : !bd ? (
          <div className="py-8 text-center text-muted-foreground">
            <Info size={28} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm">No breakdown data available. Re-generate payroll to create it.</p>
          </div>
        ) : (
          <div className="space-y-5 pb-2">

            {/* Summary cards */}
            <div className="grid grid-cols-3 gap-3">
              <div className="rounded-lg bg-blue-50 p-3 text-center">
                <p className="text-xs text-blue-600 font-medium">Gross Salary</p>
                <p className="text-lg font-black text-blue-800">₹{data!.summary.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
              </div>
              <div className="rounded-lg bg-red-50 p-3 text-center">
                <p className="text-xs text-red-600 font-medium">Deductions</p>
                <p className="text-lg font-black text-red-800">₹{data!.summary.deductions.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
              </div>
              <div className="rounded-lg bg-green-50 p-3 text-center">
                <p className="text-xs text-green-600 font-medium">Net Salary</p>
                <p className="text-lg font-black text-green-800">₹{data!.summary.netSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
              </div>
            </div>

            {/* Staff breakdown */}
            {bd.type === "staff" && (
              <>
                {/* Attendance summary */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Attendance Summary</p>
                  <div className={`grid gap-2 ${(bd.summary.halfShiftDays ?? 0) > 0 ? "grid-cols-5" : "grid-cols-4"}`}>
                    {[
                      { label: "Working Days", value: bd.summary.totalWorkingDays, color: "text-gray-800" },
                      { label: "Present", value: bd.summary.presentDays, color: "text-green-700" },
                      { label: "Paid Leave", value: bd.summary.paidLeaveDays, color: "text-blue-700" },
                      { label: "Absent", value: (bd.summary.absentDays ?? 0) + (bd.summary.unpaidLeaveDays ?? 0), color: "text-red-700" },
                      ...((bd.summary.halfShiftDays ?? 0) > 0 ? [{ label: "Half Shifts", value: bd.summary.halfShiftDays, color: "text-amber-700" }] : []),
                    ].map(s => (
                      <div key={s.label} className="rounded-lg border p-2 text-center">
                        <p className={`text-xl font-black ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                  {/* Attendance mode used for this payroll */}
                  {bd.attendanceMode && (
                    <p className="mt-2 text-[11px] text-muted-foreground">
                      Attendance calculated in{" "}
                      <strong className="uppercase">{bd.attendanceMode} mode</strong>
                      {bd.attendanceMode === "simple"
                        ? " -morning + evening punch model (configured in Settings → Attendance)."
                        : " -4-punch engine (configured in Settings → Attendance)."}
                    </p>
                  )}
                  {(bd.summary.lateDays ?? 0) > 0 && (
                    <div className="mt-2 rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-800 space-y-0.5">
                      <p className="font-semibold flex items-center gap-1">
                        <Clock size={11} /> Late Arrival Detection
                      </p>
                      <p>Shift starts: <strong>{bd.shift?.startTime ?? "—"}</strong> &nbsp;+&nbsp; Grace: <strong>{bd.shift?.gracePeriodMinutes ?? 0} min</strong> &nbsp;→&nbsp; Deadline: <strong>
                        {bd.shift?.startTime && bd.shift?.gracePeriodMinutes != null
                          ? (() => {
                              const [h, m] = bd.shift.startTime.split(":").map(Number);
                              const total = h * 60 + m + bd.shift.gracePeriodMinutes;
                              return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
                            })()
                          : "—"}
                      </strong></p>
                      <p>Days arrived after deadline: <strong>{bd.summary.lateDays}</strong></p>
                      {bd.attendanceMode === "simple" && (
                        <p className="text-amber-700/80">Simple mode: only the morning punch is checked -lunch-return delays are ignored.</p>
                      )}
                    </div>
                  )}
                  {(bd.summary.withoutPermissionDays ?? 0) > 0 && (
                    <div className="mt-2 rounded-md bg-rose-50 border border-rose-100 px-3 py-2 text-xs text-rose-800 space-y-0.5">
                      <p className="font-semibold flex items-center gap-1">
                        <AlertTriangle size={11} /> Without Permission Detection
                      </p>
                      <p>
                        Arriving late or leaving early inside a 1-hour window around the shift's start/end
                        time with <strong>no approved Permission</strong> covering it. Each day's exact reason
                        is shown in the Day-by-Day table below.
                      </p>
                      <p>
                        <strong>{bd.summary.withoutPermissionDays}</strong> day{bd.summary.withoutPermissionDays !== 1 ? "s" : ""} flagged this month
                        {(bd.deductions.withoutPermissionPenalty ?? 0) === 0 && (
                          <span> — no deduction yet (Settings → Late Detection → Without Permission has no slabs configured).</span>
                        )}
                      </p>
                    </div>
                  )}
                  {(bd.summary.halfShiftDays ?? 0) > 0 && (
                    <div className="mt-2 rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-800 space-y-0.5">
                      <p className="font-semibold flex items-center gap-1">
                        <AlertCircle size={11} /> Half-Shift Detection
                      </p>
                      {bd.attendanceMode === "simple" ? (
                        <p>
                          A half-shift is recorded when the <strong>first punch is after{" "}
                          {bd.simpleHalfShiftCutoff ?? "13:30"}</strong>, when only a single punch
                          exists for the day, or when HR manually marks the day as half shift.
                        </p>
                      ) : (
                        <p>A half-shift is recorded when only <strong>2 punches</strong> are present (morning only: P1+P2, or afternoon only: P3+P4).</p>
                      )}
                      <p>
                        <strong>{bd.summary.halfShiftDays}</strong> half-shift day{bd.summary.halfShiftDays !== 1 ? "s" : ""} &nbsp;×&nbsp; 0.5 &nbsp;=&nbsp;
                        <strong> {((bd.summary.halfShiftDays ?? 0) * 0.5).toFixed(2)} effective days</strong>
                        &nbsp;(vs {bd.summary.halfShiftDays} if full shifts)
                      </p>
                      <p>Salary impact: <strong>−₹{(((bd.summary.halfShiftDays ?? 0) * 0.5) * (bd.earnings?.dailyRate ?? 0)).toLocaleString("en-IN", { minimumFractionDigits: 2 })}</strong> vs full attendance</p>
                    </div>
                  )}
                </div>

                {/* Earnings breakdown */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Earnings Calculation</p>
                  <div className="rounded-lg border divide-y text-sm">
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Monthly Salary</span>
                      <span className="font-semibold">₹{bd.earnings.monthlySalary?.toLocaleString("en-IN")}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Working Days in Month</span>
                      <span className="font-semibold">{bd.summary.totalWorkingDays} days</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Daily Rate</span>
                      <span className="font-semibold">₹{bd.earnings.dailyRate?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 bg-blue-50/40">
                      <span className="text-blue-800 font-medium">
                        Effective Days (Present + Paid Leave)
                        {(bd.summary.halfShiftDays ?? 0) > 0 && (
                          <span className="ml-1.5 text-xs font-normal text-blue-600">
                            incl. {bd.summary.halfShiftDays} half-shift{bd.summary.halfShiftDays !== 1 ? "s" : ""} × 0.5
                          </span>
                        )}
                      </span>
                      <span className="font-bold text-blue-800">{bd.summary.effectivePaidDays} days</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Basic (50%)</span>
                      <span className="font-semibold">₹{bd.earnings.basic?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">HRA (20%)</span>
                      <span className="font-semibold">₹{bd.earnings.hra?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Other Allowances</span>
                      <span className="font-semibold">₹{bd.earnings.allowances?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 bg-green-50/40 font-bold">
                      <span className="text-green-800">Gross Salary</span>
                      <span className="text-green-800">₹{bd.earnings.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {/* Deductions */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Deductions</p>
                  <div className="rounded-lg border divide-y text-sm">
                    {(bd.deductions.pf ?? 0) > 0 && (
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">PF (12% of Basic)</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.pf?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {(bd.deductions.esi ?? 0) > 0 && (
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">ESI (0.75% of Gross)</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.esi?.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {bd.deductions.advances > 0 && (
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">Advance Recovery ({bd.deductions.advanceDetails.length} advance{bd.deductions.advanceDetails.length !== 1 ? "s" : ""})</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.advances.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {(bd.deductions.lateShiftPenalty ?? 0) > 0 && (
                      <div className="flex justify-between px-3 py-2 bg-orange-50/40">
                        <span className="text-orange-800 font-medium">
                          Late Shift Penalty
                          {bd.deductions.lateSummary && (
                            <span className="ml-1.5 font-normal text-orange-600 text-xs">
                              ({bd.deductions.lateSummary.totalLateCount} late · {bd.deductions.lateSummary.billableLateCount} billable · {bd.deductions.lateSummary.shiftDeductions} shift{bd.deductions.lateSummary.shiftDeductions !== 1 ? "s" : ""} deducted)
                            </span>
                          )}
                        </span>
                        <span className="font-semibold text-orange-700">- ₹{(bd.deductions.lateShiftPenalty ?? 0).toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {(bd.deductions.withoutPermissionPenalty ?? 0) > 0 && (
                      <div className="flex justify-between px-3 py-2 bg-rose-50/40">
                        <span className="text-rose-800 font-medium">
                          Without Permission Penalty
                          {bd.deductions.withoutPermissionSummary && (
                            <span className="ml-1.5 font-normal text-rose-600 text-xs">
                              ({bd.deductions.withoutPermissionSummary.totalCount} occurrence{bd.deductions.withoutPermissionSummary.totalCount !== 1 ? "s" : ""} · {bd.deductions.withoutPermissionSummary.billableCount} billable · {bd.deductions.withoutPermissionSummary.shiftDeductions} shift{bd.deductions.withoutPermissionSummary.shiftDeductions !== 1 ? "s" : ""} deducted)
                            </span>
                          )}
                        </span>
                        <span className="font-semibold text-rose-700">- ₹{(bd.deductions.withoutPermissionPenalty ?? 0).toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    )}
                    {bd.deductions.total === 0 && (
                      <div className="px-3 py-2 text-muted-foreground text-xs">No deductions</div>
                    )}
                    <div className="flex justify-between px-3 py-2 bg-red-50/40 font-bold">
                      <span className="text-red-800">Total Deductions</span>
                      <span className="text-red-800">- ₹{bd.deductions.total.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {/* Day-by-day table */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Day-by-Day Attendance</p>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Day</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">First In</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Last Out</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Detection</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {displayDays.map((d) => (
                          <tr key={d.date} className="hover:bg-gray-50/50">
                            <td className="px-3 py-1.5 font-mono">{d.date}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{d.day}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[d.status ?? "absent"] ?? "bg-gray-100 text-gray-600"}`}>
                                {d.status === "paid_leave" ? (d.leaveType ?? "Paid Leave")
                                  : d.status === "unpaid_leave" ? "Unpaid Leave"
                                  : d.status ?? "—"}
                              </span>
                            </td>
                            <td className="px-3 py-1.5 font-mono text-green-700">{d.firstIn ?? "—"}</td>
                            <td className="px-3 py-1.5 font-mono text-blue-700">{d.lastOut ?? "—"}</td>
                            <td className="px-3 py-1.5">
                              {d.isLate ? (
                                d.withoutPermission ? (
                                  <span className="px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 font-semibold whitespace-nowrap">Without Permission</span>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-semibold whitespace-nowrap">Late</span>
                                )
                              ) : <span className="text-gray-300">—</span>}
                            </td>
                            <td className="px-3 py-1.5 text-gray-500 max-w-[280px]">
                              {d.isLate ? (d.lateReason ?? <span className="text-gray-300">—</span>) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bd.days.length > 15 && (
                      <div className="border-t bg-gray-50 px-3 py-2 text-center">
                        <button
                          className="text-xs text-blue-600 hover:underline flex items-center gap-1 mx-auto"
                          onClick={() => setShowAllDays(s => !s)}
                        >
                          {showAllDays ? <><ChevronUp size={12} /> Show fewer days</> : <><ChevronDown size={12} /> Show all {bd.days.length} days</>}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Production breakdown -current shift-based payroll */}
            {bd.type === "production" && bd.salaryPerShift != null && (
              <>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Period: {bd.dateFrom} to {bd.dateTo}
                  </p>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: "Days Worked", value: bd.summary.daysWorked, color: "text-green-700" },
                      { label: "Days Absent", value: bd.summary.daysAbsent, color: "text-red-700" },
                      { label: "Total Shifts", value: bd.summary.totalShifts, color: "text-blue-700" },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg border p-2 text-center">
                        <p className={`text-xl font-black ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                {bd.deductions.lateSummary && (
                  <div className="rounded-md bg-amber-50 border border-amber-100 px-3 py-2 text-xs text-amber-800 space-y-0.5">
                    <p className="font-semibold flex items-center gap-1">
                      <Clock size={11} /> Late Detection (Production)
                    </p>
                    <p>
                      Checked against the employee's assigned Production shift (Manage Shift) start/end
                      time + grace period, per the Attendance Mode configured in Settings → Payroll →
                      Production.
                    </p>
                    <p>
                      <strong>{bd.deductions.lateSummary.totalLateCount}</strong> late occurrence{bd.deductions.lateSummary.totalLateCount !== 1 ? "s" : ""} this period
                      {(bd.deductions.lateShiftPenalty ?? 0) === 0 && (
                        <span> — no deduction yet (within the Free Allowance, or no slabs configured).</span>
                      )}
                    </p>
                  </div>
                )}

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Earnings</p>
                  <div className="rounded-lg border divide-y text-sm">
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Total Shifts Earned</span>
                      <span className="font-semibold">{bd.earnings.totalShifts}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Salary Per Shift</span>
                      <span className="font-semibold">₹{bd.earnings.salaryPerShift}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 font-bold bg-green-50/40">
                      <span className="text-green-800">Gross Salary</span>
                      <span className="text-green-800">₹{bd.earnings.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {((bd.deductions.pf ?? 0) > 0 || (bd.deductions.esi ?? 0) > 0 || bd.deductions.advances > 0 || (bd.deductions.lateShiftPenalty ?? 0) > 0) && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                      Deductions
                      {bd.deductions.pfEfRule && (
                        <span className="ml-2 normal-case font-normal text-purple-600">
                          rule: {bd.deductions.pfEfRule.label}
                        </span>
                      )}
                    </p>
                    <div className="rounded-lg border divide-y text-sm">
                      {(bd.deductions.pf ?? 0) > 0 && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-gray-600">PF ({bd.deductions.pfRate}%)</span>
                          <span className="font-semibold text-red-700">- ₹{(bd.deductions.pf ?? 0).toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                        </div>
                      )}
                      {(bd.deductions.esi ?? 0) > 0 && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-gray-600">{bd.deductions.pfEfRule ? "EF" : "ESI"} ({bd.deductions.esiRate}%)</span>
                          <span className="font-semibold text-red-700">- ₹{(bd.deductions.esi ?? 0).toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                        </div>
                      )}
                      {bd.deductions.advances > 0 && (
                        <div className="flex justify-between px-3 py-2">
                          <span className="text-gray-600">Advance Recovery</span>
                          <span className="font-semibold text-red-700">- ₹{bd.deductions.advances.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                        </div>
                      )}
                      {(bd.deductions.lateShiftPenalty ?? 0) > 0 && (
                        <div className="flex justify-between px-3 py-2 bg-orange-50/40">
                          <span className="text-orange-800 font-medium">
                            Late Shift Penalty
                            {bd.deductions.lateSummary && (
                              <span className="ml-1.5 font-normal text-orange-600 text-xs">
                                ({bd.deductions.lateSummary.totalLateCount} late · {bd.deductions.lateSummary.billableLateCount} billable · {bd.deductions.lateSummary.shiftDeductions} shift{bd.deductions.lateSummary.shiftDeductions !== 1 ? "s" : ""} deducted)
                              </span>
                            )}
                          </span>
                          <span className="font-semibold text-orange-700">- ₹{(bd.deductions.lateShiftPenalty ?? 0).toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Day-by-day table */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Day-by-Day Shifts</p>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Day</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">First Punch</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Last Punch</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Status</th>
                          <th className="text-right px-3 py-2 font-semibold text-gray-600">Shifts</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Reason</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {displayDays.map((d) => (
                          <tr key={d.date} className={(d.shiftsEarned ?? 0) > 0 ? "" : "opacity-40"}>
                            <td className="px-3 py-1.5 font-mono">{d.date}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{d.day}</td>
                            <td className="px-3 py-1.5 font-mono text-green-700">{d.firstPunch ?? "—"}</td>
                            <td className="px-3 py-1.5 font-mono text-blue-700">{d.lastPunch ?? "—"}</td>
                            <td className="px-3 py-1.5">
                              <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_COLORS[d.status ?? "absent"] ?? "bg-gray-100 text-gray-600"}`}>
                                {d.status ?? "—"}
                              </span>
                              {d.isLate && <span className="ml-1 text-amber-600 font-semibold text-xs">Late</span>}
                            </td>
                            <td className="px-3 py-1.5 text-right">
                              {(d.shiftsEarned ?? 0) > 0
                                ? <Badge className="text-xs bg-green-100 text-green-700 border-green-200">{d.shiftsEarned}</Badge>
                                : <span className="text-gray-300">0</span>
                              }
                            </td>
                            <td className="px-3 py-1.5 text-gray-500 max-w-[240px]">
                              {d.isLate ? (d.lateReason ?? <span className="text-gray-300">—</span>) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bd.days.length > 15 && (
                      <div className="border-t bg-gray-50 px-3 py-2 text-center">
                        <button className="text-xs text-blue-600 hover:underline flex items-center gap-1 mx-auto" onClick={() => setShowAllDays(s => !s)}>
                          {showAllDays ? <><ChevronUp size={12} /> Show fewer</> : <><ChevronDown size={12} /> Show all {bd.days.length} days</>}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Production breakdown -legacy session-based payroll (historical records) */}
            {bd.type === "production" && bd.salaryPerShift == null && (
              <>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Session Configuration</p>
                  <div className="grid sm:grid-cols-2 gap-2">
                    {(bd.sessionConfigs ?? []).map(sc => (
                      <div key={sc.id} className="rounded-lg bg-amber-50 border border-amber-100 p-3">
                        <p className="font-semibold text-sm text-amber-900">{sc.name}</p>
                        <p className="text-xs text-amber-700 mt-0.5">{sc.startTime} – {sc.endTime}</p>
                        <p className="text-xs text-amber-600">Min checkout: <strong>{sc.minCheckout}</strong></p>
                        <p className="text-sm font-bold text-amber-800 mt-1">₹{sc.rate}/session</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Period: {bd.dateFrom} to {bd.dateTo}
                  </p>
                  <div className="grid grid-cols-3 gap-2 mb-3">
                    {[
                      { label: "Days Worked", value: bd.summary.daysWorked, color: "text-green-700" },
                      { label: "Days Absent", value: bd.summary.daysAbsent, color: "text-red-700" },
                      { label: "Total Sessions", value: bd.summary.totalSessions, color: "text-blue-700" },
                    ].map(s => (
                      <div key={s.label} className="rounded-lg border p-2 text-center">
                        <p className={`text-xl font-black ${s.color}`}>{s.value}</p>
                        <p className="text-xs text-muted-foreground">{s.label}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Earnings</p>
                  <div className="rounded-lg border divide-y text-sm">
                    <div className="flex justify-between px-3 py-2">
                      <span className="text-gray-600">Total Sessions Completed</span>
                      <span className="font-semibold">{bd.summary.totalSessions}</span>
                    </div>
                    <div className="flex justify-between px-3 py-2 font-bold bg-green-50/40">
                      <span className="text-green-800">Gross Salary</span>
                      <span className="text-green-800">₹{bd.earnings.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                    </div>
                  </div>
                </div>

                {bd.deductions.advances > 0 && (
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Deductions</p>
                    <div className="rounded-lg border divide-y text-sm">
                      <div className="flex justify-between px-3 py-2">
                        <span className="text-gray-600">Advance Recovery</span>
                        <span className="font-semibold text-red-700">- ₹{bd.deductions.advances.toLocaleString("en-IN", {maximumFractionDigits:2})}</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Day-by-day table */}
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Day-by-Day Sessions</p>
                  <div className="rounded-lg border overflow-hidden">
                    <table className="w-full text-xs">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Date</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Day</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">First In</th>
                          <th className="text-left px-3 py-2 font-semibold text-gray-600">Last Out</th>
                          <th className="text-right px-3 py-2 font-semibold text-gray-600">Sessions</th>
                          <th className="text-right px-3 py-2 font-semibold text-gray-600">Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {displayDays.map((d) => (
                          <tr key={d.date} className={d.present ? "" : "opacity-40"}>
                            <td className="px-3 py-1.5 font-mono">{d.date}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{d.day}</td>
                            <td className="px-3 py-1.5 font-mono text-green-700">{d.firstIn ?? "—"}</td>
                            <td className="px-3 py-1.5 font-mono text-blue-700">{d.lastOut ?? "—"}</td>
                            <td className="px-3 py-1.5 text-right">
                              {d.totalSessions != null && d.totalSessions > 0
                                ? <Badge className="text-xs bg-green-100 text-green-700 border-green-200">{d.totalSessions}</Badge>
                                : <span className="text-gray-300">0</span>
                              }
                            </td>
                            <td className="px-3 py-1.5 text-right font-semibold">
                              {(d.sessionAmount ?? 0) > 0 ? `₹${d.sessionAmount}` : "—"}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {bd.days.length > 15 && (
                      <div className="border-t bg-gray-50 px-3 py-2 text-center">
                        <button className="text-xs text-blue-600 hover:underline flex items-center gap-1 mx-auto" onClick={() => setShowAllDays(s => !s)}>
                          {showAllDays ? <><ChevronUp size={12} /> Show fewer</> : <><ChevronDown size={12} /> Show all {bd.days.length} days</>}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Net salary callout */}
            <div className="rounded-xl bg-gradient-to-r from-green-50 to-emerald-50 border border-green-200 p-4 flex items-center justify-between">
              <div>
                <p className="text-xs text-green-600 font-medium">Net Salary Payable</p>
                <p className="text-2xl font-black text-green-800">
                  ₹{data!.summary.netSalary.toLocaleString("en-IN", {maximumFractionDigits:2})}
                </p>
              </div>
              <Badge className={`text-sm ${STATUS_CONFIG[data!.status]?.cls ?? STATUS_CONFIG.pending.cls}`}>
                {STATUS_CONFIG[data!.status]?.label ?? data!.status}
              </Badge>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}><X size={14} className="mr-1" />Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PayrollRow({ run, onViewBreakdown, onMarkPaid }: {
  run: PayrollRunItem;
  onViewBreakdown: (id: number) => void;
  onMarkPaid: (run: PayrollRunItem) => void;
}) {
  const s = STATUS_CONFIG[run.status] ?? STATUS_CONFIG.pending;
  const isProduction = run.salaryMode === "session" || run.salaryMode === "shift";
  const isShiftMode = run.salaryMode === "shift";

  return (
    <div className="flex items-center gap-3 py-3 px-4 rounded-xl border bg-white hover:shadow-sm transition-shadow">
      {/* Employee info */}
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-white text-xs font-bold shrink-0 ${isProduction ? "bg-gradient-to-br from-amber-400 to-orange-500" : "bg-gradient-to-br from-blue-400 to-indigo-500"}`}>
        {(run.employeeName ?? "?").charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <p className="font-bold text-sm text-gray-900 truncate">{run.employeeName ?? run.employeeCode ?? `#${run.employeeId}`}</p>
          <Badge className={`text-xs border ${s.cls}`}>{s.label}</Badge>
          <Badge className={`text-xs ${isProduction ? "bg-amber-100 text-amber-700 border-amber-200" : "bg-green-100 text-green-700 border-green-200"}`}>
            {isProduction ? "Production" : "Staff"}
          </Badge>
          {run.weekNumber && <Badge variant="outline" className="text-xs">Week {run.weekNumber}</Badge>}
          {run.periodStart && run.periodEnd && (
            <Badge variant="outline" className="text-xs">{run.periodStart} – {run.periodEnd}</Badge>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
          {isShiftMode ? (
            <span className="flex items-center gap-1"><CalendarDays size={11} />{run.presentDays} shifts</span>
          ) : isProduction ? (
            <span className="flex items-center gap-1"><CalendarDays size={11} />{run.completedSessions} sessions</span>
          ) : (
            <span className="flex items-center gap-1"><CalendarDays size={11} />{run.presentDays} / {run.totalWorkingDays} days</span>
          )}
          <span className="flex items-center gap-1"><ArrowRight size={11} />Gross ₹{run.grossSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</span>
          {run.deductions > 0 && <span className="text-red-500">- ₹{run.deductions.toLocaleString("en-IN", {maximumFractionDigits:0})}</span>}
        </div>
      </div>

      {/* Net salary */}
      <div className="text-right shrink-0">
        <p className="text-sm font-black text-green-700">₹{run.finalSalary.toLocaleString("en-IN", {maximumFractionDigits:0})}</p>
        <p className="text-xs text-muted-foreground">net</p>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1.5 shrink-0">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onViewBreakdown(run.id)}>
          <Info size={11} /> Details
        </Button>
        {run.status === "pending" && (
          <Button size="sm" className="h-7 text-xs gap-1 bg-green-700 hover:bg-green-800" onClick={() => onMarkPaid(run)}>
            <CheckCircle2 size={11} /> Mark Paid
          </Button>
        )}
        {run.status === "paid" && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <Lock size={11} /> Paid
          </span>
        )}
      </div>
    </div>
  );
}
