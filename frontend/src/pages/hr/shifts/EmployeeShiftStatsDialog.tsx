import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { DayFlagBadges } from "@/components/DayFlagBadges";
import { lateDetectionFlags, latePoolView } from "@/lib/late-detection";
import { useEmployeeShiftMonthlyStats, usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { AlertCircle, BarChart2, TrendingDown } from "lucide-react";

// The attendance history of one employee on their shift (opened from the Assignments tab). Moved here unchanged from the
// old single-file Manage Shifts page.

const MONTH_NAMES_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export default function EmployeeShiftStatsDialog({
  employeeId,
  employeeName,
  onClose,
}: {
  employeeId: number;
  employeeName: string;
  onClose: () => void;
}) {
  const now = new Date();
  const usePrev = now.getDate() <= 10;
  const month = usePrev ? (now.getMonth() === 0 ? 12 : now.getMonth()) : now.getMonth() + 1;
  const year = usePrev && now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const monthLabel = MONTH_NAMES_SHORT[month - 1] + " " + year;

  const { data, isLoading, isError } = useEmployeeShiftMonthlyStats(employeeId, month, year, true);
  // Half-Day times from Settings → Attendance, to say which half a Half Shift day was worked in.
  const { data: settings } = usePayrollSettings();
  const halfDayCutoffs = {
    firstHalfEnd: settings?.halfDayFirstHalfEndTime,
    secondHalfStart: settings?.halfDaySecondHalfStartTime,
  };

  // Staff only: the late pool (Morning Late-In + Evening Early-Out + excess Permissions) exactly as payroll prices it.
  // Built only when the server actually sent the split (lateInCount): an older backend has just the totals, and
  // "Late-In 0 / Early-Out 0 / pool = excess only" beside its own billable figure would be a wrong picture, so it
  // keeps the legacy layout. Production has its own separate late policy and always keeps the legacy layout too.
  const summary = data?.summary;
  const pool =
    summary && summary.lateInCount != null && data?.employmentType === "staff"
      ? latePoolView({
          lateInCount: summary.lateInCount,
          earlyOutCount: summary.earlyOutCount,
          excessPermissionCount: summary.excessPermissionCount ?? summary.permissionOverageCount,
          freeAllowance: summary.freeAllowance,
          permissionMonthlyCap: summary.permissionMonthlyCap,
          billableLateCount: summary.billableLateCount,
          shiftDeductions: summary.shiftDeductions,
        })
      : null;
  // Days the day-by-day log flagged. Different from the pool's counted figures (which are de-duplicated and limited to
  // working days), so it is only ever labelled "flagged".
  const earlyOutFlaggedDays = data ? data.dailyLogs.filter((l) => l.isEarlyOut).length : 0;

  const statusBadge = (status: string) => {
    switch (status) {
      case "present":
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700">
            Present
          </span>
        );
      case "half_shift":
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700">
            Half Shift
          </span>
        );
      case "absent":
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700">Absent</span>
        );
      case "on_leave":
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700">Leave</span>
        );
      case "holiday":
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-100 text-gray-500">Holiday</span>
        );
      default:
        return <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-gray-50 text-gray-400">—</span>;
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart2 size={18} className="text-indigo-600" />
            {employeeName} -Attendance History
          </DialogTitle>
          {data && (
            <p className="text-xs text-muted-foreground">
              Code: <strong>{data.employeeCode}</strong> &nbsp;·&nbsp; Dept: <strong>{data.department ?? "—"}</strong>{" "}
              &nbsp;·&nbsp; Type: <strong className="capitalize">{data.employmentType ?? "—"}</strong>
              &nbsp;&nbsp;|&nbsp;&nbsp;{monthLabel}
            </p>
          )}
        </DialogHeader>

        {isLoading ? (
          <CircleLoader texts={["UK Textiles", "Shift", "Loading"]} />
        ) : isError ? (
          <div className="py-12 text-center text-sm text-red-500">
            Could not load data. Restart the Django server and try again.
          </div>
        ) : !data ? (
          <div className="py-12 text-center text-sm text-muted-foreground">No data available.</div>
        ) : (
          <div className="flex flex-col gap-4 overflow-y-auto pr-1">
            {/* ── Summary counts row (mirrors Attendance History header) ── */}
            <div className="flex items-center gap-6 text-sm font-medium flex-wrap">
              <span className="text-green-700">{data.presentDays} Present</span>
              <span className="text-red-600">{data.absentDays} Absent</span>
              {data.leaveDays > 0 && <span className="text-blue-600">{data.leaveDays} On Leave</span>}
              {data.totalLateCount > 0 && (
                <span className="text-orange-600">
                  {data.totalLateCount} {pool ? "late days flagged" : "Late"}
                </span>
              )}
              {earlyOutFlaggedDays > 0 && (
                <span className="text-orange-600">{earlyOutFlaggedDays} early-out days flagged</span>
              )}
              {data.halfShiftDays > 0 && <span className="text-amber-600">{data.halfShiftDays} Half Shift</span>}
            </div>

            {/* ── Shift calculation summary ── */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 text-xs">
              <div className="rounded-lg border px-3 py-2 flex justify-between items-center">
                <span className="text-muted-foreground">Full Shifts</span>
                <span className="font-bold text-indigo-700">{data.fullShiftDays}</span>
              </div>
              <div className="rounded-lg border px-3 py-2 flex justify-between items-center">
                <span className="text-muted-foreground">Half Shifts</span>
                <span className={`font-bold ${data.halfShiftDays > 0 ? "text-amber-700" : "text-gray-400"}`}>
                  {data.halfShiftDays}
                </span>
              </div>
              <div className="rounded-lg border px-3 py-2 flex justify-between items-center">
                <span className="text-muted-foreground">Effective Days</span>
                <span className="font-bold text-gray-800">{parseFloat(data.totalEffectiveShifts).toFixed(2)}</span>
              </div>
              {pool ? (
                <>
                  <div
                    className="rounded-lg border px-3 py-2 flex justify-between items-center"
                    title="Morning Late-In occurrences counted in the monthly late pool (a late day that also has an Excess permission counts once, as the permission)"
                  >
                    <span className="text-muted-foreground">Late-In counted</span>
                    <span className={`font-bold ${(pool.lateIn ?? 0) > 0 ? "text-orange-600" : "text-gray-400"}`}>
                      {pool.lateIn ?? 0}
                    </span>
                  </div>
                  <div
                    className="rounded-lg border px-3 py-2 flex justify-between items-center"
                    title="Evening Early-Out occurrences counted in the monthly late pool (only while Evening Early-Out is switched on)"
                  >
                    <span className="text-muted-foreground">Early-Out counted</span>
                    <span className={`font-bold ${(pool.earlyOut ?? 0) > 0 ? "text-orange-600" : "text-gray-400"}`}>
                      {pool.earlyOut ?? 0}
                    </span>
                  </div>
                  <div
                    className="rounded-lg border px-3 py-2 flex justify-between items-center"
                    title="Approved permissions beyond the monthly cap: they did not move any boundary and count as one late occurrence each"
                  >
                    <span className="text-muted-foreground">Excess Permissions</span>
                    <span className={`font-bold ${(pool.excess ?? 0) > 0 ? "text-red-700" : "text-gray-400"}`}>
                      {pool.excess ?? 0}
                    </span>
                  </div>
                  <div
                    className="rounded-lg border px-3 py-2 flex justify-between items-center"
                    title="Late-In + Early-Out + Excess Permissions: the shared monthly pool"
                  >
                    <span className="text-muted-foreground">Late Pool Total</span>
                    <span className={`font-bold ${pool.total > 0 ? "text-red-700" : "text-gray-400"}`}>
                      {pool.total}
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <div className="rounded-lg border px-3 py-2 flex justify-between items-center">
                    <span className="text-muted-foreground">Late Morning</span>
                    <span className={`font-bold ${data.lateMorningDays > 0 ? "text-orange-600" : "text-gray-400"}`}>
                      {data.lateMorningDays}
                    </span>
                  </div>
                  <div className="rounded-lg border px-3 py-2 flex justify-between items-center">
                    <span className="text-muted-foreground">Total Late</span>
                    <span className={`font-bold ${data.totalLateCount > 0 ? "text-red-700" : "text-gray-400"}`}>
                      {data.totalLateCount}
                    </span>
                  </div>
                </>
              )}
              <div
                className="rounded-lg border px-3 py-2 flex justify-between items-center"
                title="Strict mode only: informational, not part of the late pool"
              >
                <span className="text-muted-foreground">Late Return</span>
                <span className={`font-bold ${data.lateReturnDays > 0 ? "text-orange-600" : "text-gray-400"}`}>
                  {data.lateReturnDays}
                </span>
              </div>
            </div>

            {/* Half shift salary impact note */}
            {data.halfShiftDays > 0 && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-100 rounded-lg text-xs text-amber-800">
                <AlertCircle size={13} className="text-amber-600 shrink-0 mt-0.5" />
                <span>
                  <strong>
                    {data.halfShiftDays} half-shift day{data.halfShiftDays !== 1 ? "s" : ""}
                  </strong>{" "}
                  -each counts as 0.5 effective days. Salary impact:{" "}
                  <strong>−{(data.halfShiftDays * 0.5).toFixed(2)} days</strong> vs full attendance.
                </span>
              </div>
            )}

            {/* Payroll penalty -with the split, a live preview of the same pool and formula payroll uses */}
            {data.summary && (
              <div className="rounded-lg border bg-orange-50/40 divide-y text-xs">
                <div className="px-3 py-2 font-semibold text-gray-700 flex items-center gap-1.5">
                  <TrendingDown size={12} className="text-orange-600" />{" "}
                  {pool ? "Late Penalty (live preview -same pool payroll uses)" : "Payroll Penalty (last payroll run)"}
                </div>
                {pool ? (
                  <>
                    <div className="px-3 py-2 flex justify-between">
                      <span className="text-gray-600">Morning Late-In days</span>
                      <span className="font-semibold text-gray-800">{pool.lateIn ?? 0}</span>
                    </div>
                    <div className="px-3 py-2 flex justify-between">
                      <span className="text-gray-600">Evening Early-Out days</span>
                      <span className="font-semibold text-gray-800">{pool.earlyOut ?? 0}</span>
                    </div>
                    <div className="px-3 py-2 flex justify-between">
                      <span className="text-gray-600">
                        Excess permissions
                        {pool.permissionCap != null && (
                          <span className="text-gray-400"> (approved beyond {pool.permissionCap} per month)</span>
                        )}
                      </span>
                      <span className="font-semibold text-gray-800">{pool.excess ?? 0}</span>
                    </div>
                    <div className="px-3 py-2 flex justify-between bg-white/50">
                      <span className="text-gray-700 font-medium">Late pool total</span>
                      <span className="font-bold text-gray-900">{pool.total}</span>
                    </div>
                    {pool.freeAllowance != null && (
                      <div className="px-3 py-2 flex justify-between">
                        <span className="text-gray-600">Free allowance used</span>
                        <span className="font-semibold text-green-700">
                          {pool.freeUsed ?? 0} of {pool.freeAllowance}
                        </span>
                      </div>
                    )}
                  </>
                ) : null}
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-gray-600">Billable lates</span>
                  <span className="font-semibold text-red-700">{data.summary.billableLateCount}</span>
                </div>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-gray-600">Shift deductions</span>
                  <span className="font-semibold text-red-700">{data.summary.shiftDeductions}</span>
                </div>
                <div className="px-3 py-2 flex justify-between">
                  <span className="text-gray-600">Salary deduction</span>
                  <span className="font-bold text-red-700">
                    ₹
                    {parseFloat(data.summary.salaryDeductionAmount).toLocaleString("en-IN", {
                      minimumFractionDigits: 2,
                    })}
                  </span>
                </div>
              </div>
            )}

            {/* ── Daily attendance table (mirrors Attendance History) ── */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">Daily Log</p>
              <div className="rounded-lg border overflow-hidden">
                <div className="overflow-y-auto max-h-72">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 sticky top-0 z-10">
                      <tr>
                        <th className="text-left px-3 py-2 font-semibold text-gray-500 w-[90px]">Date</th>
                        <th className="text-left px-3 py-2 font-semibold text-gray-500">Status</th>
                        <th className="text-left px-3 py-2 font-semibold text-gray-500">First IN</th>
                        <th className="text-left px-3 py-2 font-semibold text-gray-500">Last OUT</th>
                        <th className="text-center px-3 py-2 font-semibold text-gray-500">Punches</th>
                        <th className="text-left px-3 py-2 font-semibold text-gray-500">Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.dailyLogs
                        .filter((log) => log.status !== "future")
                        .map((log) => {
                          const rowBg = log.isHalfShift
                            ? "bg-amber-50/50"
                            : log.status === "absent"
                              ? "bg-red-50/30"
                              : log.status === "on_leave"
                                ? "bg-blue-50/30"
                                : log.status === "holiday"
                                  ? "bg-gray-50"
                                  : "";
                          const flags = lateDetectionFlags(
                            { ...log, isLate: log.isLate ?? log.lateMorning },
                            halfDayCutoffs,
                          );
                          // Strict mode's lunch-return lateness, when the day record itself did not already flag it.
                          const lateReturnOnly = log.lateReturn && !log.lateAfternoon;
                          const notes: string[] = [];
                          if (log.isHalfShift && !flags.some((f) => f.kind === "halfDay")) notes.push("½ Shift");
                          if (lateReturnOnly) notes.push("Late Ret");
                          if (log.leaveType) notes.push(log.leaveType);
                          return (
                            <tr key={log.date} className={`border-t ${rowBg}`}>
                              <td className="px-3 py-1.5 font-mono text-gray-700 whitespace-nowrap">
                                {log.date} <span className="text-gray-400 text-[10px]">{log.day}</span>
                              </td>
                              <td className="px-3 py-1.5">{statusBadge(log.status)}</td>
                              <td className="px-3 py-1.5 font-mono text-gray-600">{log.firstPunch ?? "—"}</td>
                              <td className="px-3 py-1.5 font-mono text-gray-600">{log.lastPunch ?? "—"}</td>
                              <td className="px-3 py-1.5 text-center text-gray-700 font-medium">
                                {log.totalPunches || "—"}
                              </td>
                              <td className="px-3 py-1.5">
                                {flags.length > 0 || notes.length > 0 ? (
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <DayFlagBadges flags={flags} size="sm" />
                                    {notes.length > 0 && (
                                      <span
                                        className={`font-semibold ${log.isHalfShift ? "text-amber-700" : "text-orange-600"}`}
                                      >
                                        {notes.join(", ")}
                                      </span>
                                    )}
                                  </div>
                                ) : log.status === "present" ? (
                                  <span className="text-green-600">✓</span>
                                ) : null}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="pt-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
