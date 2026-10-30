import { useState } from "react";
import { useLocation } from "wouter";
import { TONE } from "@/lib/statusTones";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AttendanceLoader } from "@/components/ui/AttendanceLoader";
import { useToast } from "@/hooks/use-toast";
import {
  useEmployeeMonthlyAttendance, useSetPunchDayStatus, useAttendanceOverrideRequests,
  usePayrollSettings,
  type FinalAttendanceDay,
} from "@/lib/api-client/custom-hooks";
import { useListEmployees } from "@/lib/api-client";
import { waitingText } from "@/lib/approval-workflow";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { halfDayWorked, lateDetectionFlags } from "@/lib/late-detection";
import { DayFlagBadges } from "@/components/DayFlagBadges";
import {
  CompensationChip, CompensationLegend, countMarks, isPunchlessRelaxation,
} from "@/components/attendance-compensation";
import {
  Search, User, RotateCcw, PenLine, X, ShieldCheck, Hourglass, ShieldX, History,
} from "lucide-react";

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const STATUS_BADGE: Record<string, string> = {
  present:    TONE.success,
  half_shift: TONE.warning,
  absent:     TONE.danger,
  on_leave:   TONE.info,
  holiday:    TONE.neutral,
};
const STATUS_LABEL: Record<string, string> = {
  present: "Present", half_shift: "Half Shift", absent: "Absent",
  on_leave: "On Leave", holiday: "Holiday",
};

const SEARCH_URL_DEFAULTS = { code: "", em: "", ey: "" } as const;

/**
 * Employee attendance search: type an employee code → see the whole month
 * split into weeks. Clicking ✏ on a day opens an edit modal (same style as
 * Add Attendance) pre-filled with that employee + date; saving overwrites
 * the final attendance record used by payroll.
 */
export default function AttendanceSearchSection({
  employmentType,
}: {
  employmentType?: "staff" | "production";
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const now = new Date();

  // The searched employee and the month live in the address (?code=188&em=10&ey=2026): coming back from the Attendance Edit
  // page, or reloading, shows the same employee and month without searching again.
  const [urlState, setUrlState] = useUrlParams<Record<keyof typeof SEARCH_URL_DEFAULTS, string>>(SEARCH_URL_DEFAULTS);
  const searchCode = urlState.code;
  const setSearchCode = (v: string) => setUrlState({ code: v });
  const month = Number(urlState.em) || now.getMonth() + 1;
  const year = Number(urlState.ey) || now.getFullYear();
  const setMonth = (v: number) => setUrlState({ em: String(v) });
  const setYear = (v: number) => setUrlState({ ey: String(v) });
  const [input, setInput] = useState(searchCode);

  const { data: employees } = useListEmployees({ status: "active" });
  const { data, isLoading, isError } = useEmployeeMonthlyAttendance(searchCode, month, year);
  // Half-Day times from Settings → Attendance, to say which half a Half Shift day was worked in.
  const { data: settings } = usePayrollSettings();
  const halfDayCutoffs = {
    firstHalfEnd: settings?.halfDayFirstHalfEndTime,
    secondHalfStart: settings?.halfDaySecondHalfStartTime,
  };
  const overrideMutation = useSetPunchDayStatus();
  const { data: myRequests } = useAttendanceOverrideRequests(
    data ? { employeeId: data.employee.id } : undefined,
  );

  // Map date -> latest pending request, so the table can flag "Under Review"
  const pendingByDate = new Map(
    (myRequests ?? []).filter(r => r.status === "pending").map(r => [r.date, r]),
  );

  const suggestions = input.trim() && !searchCode
    ? (employees ?? [])
        .filter(e =>
          (!employmentType || e.employmentType === employmentType) &&
          (e.employeeCode.toLowerCase().includes(input.toLowerCase()) ||
           `${e.firstName} ${e.lastName}`.toLowerCase().includes(input.toLowerCase())))
        .slice(0, 6)
    : [];

  const runSearch = (code: string) => {
    setInput(code);
    setSearchCode(code);
  };

  const revertDay = async (day: FinalAttendanceDay) => {
    if (!data) return;
    try {
      await overrideMutation.mutateAsync({
        employeeId: data.employee.id,
        date: day.date,
        status: "auto",
      });
      toast({ title: "Reverted to automatic value" });
    } catch {
      toast({ title: "Failed to revert", variant: "destructive" });
    }
  };

  return (
    <Card className="border">
      <CardHeader className="pb-3 pt-4 px-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <Search size={14} className="text-gray-400" />
              Employee Attendance Search
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Search by employee code -view weekly attendance and click the pencil on a day to edit it. Every edit needs
              the Department Head's approval first and then HR's before the attendance changes.{" "}
              <a href="/hr/attendance/edit-requests" className="font-semibold text-indigo-700 hover:underline" data-testid="attendance-edit-requests-link">
                Edit requests
              </a>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative w-64">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                className="pl-8 h-8 text-xs"
                placeholder="Employee code (e.g. 2580)…"
                value={input}
                onChange={e => { setInput(e.target.value); setSearchCode(""); }}
                onKeyDown={e => { if (e.key === "Enter" && input.trim()) runSearch(input.trim()); }}
              />
              {searchCode && (
                <button
                  onClick={() => { setInput(""); setSearchCode(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <X size={12} />
                </button>
              )}
              {suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg overflow-hidden">
                  {suggestions.map(emp => (
                    <button
                      key={emp.id}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-xs"
                      onMouseDown={e => { e.preventDefault(); runSearch(emp.employeeCode); }}
                    >
                      <span className="font-mono text-gray-400 w-14 shrink-0">{emp.employeeCode}</span>
                      <span className="font-semibold truncate">{emp.firstName} {emp.lastName}</span>
                      {emp.departmentName && (
                        <span className="text-gray-400 ml-auto shrink-0">{emp.departmentName}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              size="sm"
              className="h-8 gap-1.5 text-xs px-3"
              disabled={!input.trim()}
              onClick={() => runSearch(input.trim())}
            >
              <Search size={12} /> Search
            </Button>
            <select
              value={month}
              onChange={e => setMonth(Number(e.target.value))}
              className="h-8 rounded-md border px-2 text-xs bg-background"
            >
              {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <Input
              type="number" min={2020} max={2035}
              value={year}
              onChange={e => setYear(Number(e.target.value))}
              className="w-20 h-8 text-xs"
            />
          </div>
        </div>
      </CardHeader>

      <CardContent className="px-4 pb-4 pt-0">
        {!searchCode ? (
          <div className="py-10 text-center text-sm text-muted-foreground border-t">
            Enter an employee code above and click Search (or press Enter) to load their monthly attendance.
          </div>
        ) : isLoading ? (
          <div className="border-t">
            <AttendanceLoader />
          </div>
        ) : isError || !data ? (
          <div className="py-10 text-center text-sm text-red-500 border-t">
            No employee found with code "{searchCode}".
          </div>
        ) : (
          <div className="space-y-4 border-t pt-4">
            {/* Employee header + totals */}
            <div className="p-3 bg-gray-50 rounded-xl space-y-3">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                    {data.employee.photoUrl
                      ? <img src={data.employee.photoUrl} className="w-9 h-9 rounded-full object-cover" alt="" />
                      : <User size={15} className="text-gray-500" />}
                  </div>
                  <div>
                    <p className="font-black text-base leading-tight">{data.employee.name}</p>
                    <p className="text-[11px] text-gray-400 font-mono">
                      {data.employee.code}
                      {data.employee.department ? ` · ${data.employee.department}` : ""}
                      {data.employee.employmentType ? ` · ${data.employee.employmentType}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2 ml-auto flex-wrap">
                  {[
                    { label: "Working Days", value: data.summary.workingDays, cls: "text-gray-700" },
                    { label: "Present", value: data.summary.present, cls: "text-green-700" },
                    { label: "Half Shift", value: data.summary.halfShift, cls: "text-amber-700" },
                    { label: "Absent", value: data.summary.absent, cls: "text-red-600" },
                    { label: "Late", value: data.summary.late, cls: "text-orange-600" },
                    {
                      label: "Early Out",
                      value: data.weeks.reduce((n, w) => n + w.days.filter(d => d.earlyLeave).length, 0),
                      cls: "text-orange-600",
                    },
                    { label: "Leave", value: data.summary.onLeave, cls: "text-purple-600" },
                    { label: "Effective", value: data.summary.effectiveDays, cls: "text-indigo-700" },
                  ].map(s => (
                    <div key={s.label} className="text-center bg-white border rounded-lg px-3 py-1.5 min-w-[70px]">
                      <p className="text-[10px] text-gray-400 uppercase tracking-wide">{s.label}</p>
                      <p className={`text-sm font-black ${s.cls}`}>{s.value}</p>
                    </div>
                  ))}
                </div>
              </div>

              {/* Assigned shift + grace period -the sole source of late/half-shift detection */}
              {data.assignedShift ? (
                <div className="flex items-center gap-2 flex-wrap text-xs bg-white border rounded-lg px-3 py-2">
                  <ShieldCheck size={13} className="text-blue-500 shrink-0" />
                  <span className="text-gray-500">Assigned Shift:</span>
                  <strong className="text-gray-800">{data.assignedShift.name}</strong>
                  {data.assignedShift.startTime && data.assignedShift.endTime && (
                    <span className="font-mono text-gray-600">
                      {data.assignedShift.startTime}–{data.assignedShift.endTime}
                    </span>
                  )}
                  <span className="text-gray-300">|</span>
                  <span className="text-gray-500">Grace Period:</span>
                  <strong className="text-gray-800">{data.assignedShift.gracePeriodMinutes} min</strong>
                  <span className="text-gray-400">
                    -Late and Early Out below are judged against this shift's start/end + grace; Half Day uses the
                    company-wide Half-Day times (Settings → Attendance).
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-700 rounded-lg px-3 py-2">
                  <ShieldCheck size={13} className="shrink-0" />
                  No shift assigned -late detection cannot run for this employee until a shift is assigned in Manage Shift.
                </div>
              )}
            </div>

            {/* Days on which the employee used a compensation (OT allowance, announced window, birthday, relaxation) */}
            <CompensationLegend
              counts={countMarks(data.weeks.flatMap(w => w.days))}
              className="rounded-lg border bg-white px-3 py-2"
            />

            {/* Weekly tables */}
            {data.weeks.map(week => (
              <div key={week.week} className="rounded-xl border overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b flex items-center justify-between">
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Week {week.week}
                  </p>
                  <p className="text-[11px] text-gray-400">
                    {week.days[0]?.date} → {week.days[week.days.length - 1]?.date}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        {["Date", "Day", "Status", "First IN", "Last OUT", "Shifts", "Late / Permission", "Half", "Source", ""].map(h => (
                          <th key={h} className="text-left px-3 py-2 text-[10px] font-semibold text-gray-400 uppercase whitespace-nowrap">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {week.days.map(day => {
                        const pending = pendingByDate.get(day.date);
                        // The Half column already says "½ Morning/Evening", so that flag is not repeated beside Late.
                        const allFlags = lateDetectionFlags(day, halfDayCutoffs);
                        const flags = allFlags.filter(f => f.kind !== "halfDay");
                        const halfFlag = allFlags.find(f => f.kind === "halfDay");
                        // A day made up by a relaxation has no punches: its Relaxation chip and note say what it is, so
                        // the Half column does not claim a Morning / Evening half was worked.
                        const topUpOnly = isPunchlessRelaxation(day);
                        const worked = day.isHalfShift && !topUpOnly ? halfDayWorked(day.firstPunch, halfDayCutoffs.firstHalfEnd, day.arrivalZone) : null;
                        return (
                        <tr
                          key={day.date}
                          className={`border-b last:border-0 hover:bg-gray-50 ${
                            pending ? "bg-yellow-50/50" :
                            day.source === "manual" ? "bg-blue-50/40" :
                            day.status === "absent" ? "bg-red-50/30" :
                            day.status === "half_shift" ? "bg-amber-50/30" : ""
                          }`}
                        >
                          <td className="px-3 py-2 font-mono text-xs text-gray-700">{day.date}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{day.day}</td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 flex-wrap">
                              <Badge className={`text-[10px] border ${STATUS_BADGE[day.status]}`}>
                                {STATUS_LABEL[day.status]}
                              </Badge>
                              {day.isCompensationDay && (
                                <Badge className="text-[10px] border bg-purple-50 text-purple-700 border-purple-200">
                                  Comp Day
                                </Badge>
                              )}
                              <CompensationChip day={day} size="sm" withNote className="max-w-[16rem]" />
                            </div>
                          </td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-700">{day.firstPunch ?? "—"}</td>
                          <td className="px-3 py-2 font-mono text-xs text-gray-700">{day.lastPunch ?? "—"}</td>
                          <td className="px-3 py-2 text-xs font-bold text-gray-800">{day.shiftsEarned}</td>
                          <td className="px-3 py-2 text-xs">
                            {flags.length > 0 ? (
                              <div className="flex items-center gap-1 flex-wrap">
                                <DayFlagBadges flags={flags} size="sm" />
                              </div>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs">
                            {day.isHalfShift && !topUpOnly ? (
                              <span className="text-amber-700 font-semibold" title={halfFlag?.title}>
                                ½
                                {worked && (
                                  <span className="ml-1 text-[10px] font-medium">
                                    {worked === "morning" ? "Morning" : "Evening"}
                                  </span>
                                )}
                              </span>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-[10px]">
                            {pending ? (
                              <span className="inline-flex items-center gap-1 text-yellow-700 font-semibold">
                                <Hourglass size={10} /> {waitingText(pending.approval) ?? "Under review"}
                              </span>
                            ) : day.source === "manual" ? (
                              <span className="inline-flex items-center gap-1 text-blue-600 font-semibold">
                                <ShieldCheck size={10} /> By hand{day.overrideBy ? ` · ${day.overrideBy}` : ""}
                              </span>
                            ) : (
                              <span className="text-gray-400">Auto</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                onClick={() =>
                                  navigate(
                                    `/hr/attendance/edit/${data.employee.id}/${day.date}?back=${encodeURIComponent(window.location.pathname + window.location.search)}`,
                                  )
                                }
                                className="p-1.5 rounded-lg text-gray-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                                title={pending ? "A change is already waiting for approval: open it to see where it is, or send a new one" : "Edit this day"}
                                data-testid={`attendance-edit-open-${day.date}`}
                              >
                                <PenLine size={13} />
                              </button>
                              {day.source === "manual" && (
                                <button
                                  onClick={() => revertDay(day)}
                                  className="p-1.5 rounded-lg text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                                  title="Revert to automatic value"
                                >
                                  <RotateCcw size={13} />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}

            {/* Submitted request tracking */}
            {(myRequests ?? []).length > 0 && (
              <div className="rounded-xl border overflow-hidden">
                <div className="px-3 py-2 bg-gray-50 border-b flex items-center gap-1.5">
                  <History size={12} className="text-gray-400" />
                  <p className="text-xs font-bold uppercase tracking-wider text-gray-500">
                    Submitted Attendance Requests
                  </p>
                </div>
                <div className="divide-y max-h-56 overflow-y-auto">
                  {(myRequests ?? []).slice(0, 15).map(r => (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <span className="font-mono text-gray-500 w-24 shrink-0">{r.date}</span>
                      <span className="text-gray-600 flex-1 truncate">{r.reason || "—"}</span>
                      {r.status === "pending" && (
                        <span className="inline-flex items-center gap-1 text-yellow-700 font-semibold shrink-0">
                          <Hourglass size={11} /> Pending
                        </span>
                      )}
                      {r.status === "approved" && (
                        <span className="inline-flex items-center gap-1 text-green-700 font-semibold shrink-0">
                          <ShieldCheck size={11} /> Approved{r.reviewedBy ? ` · ${r.reviewedBy}` : ""}
                        </span>
                      )}
                      {r.status === "rejected" && (
                        <span className="inline-flex items-center gap-1 text-red-600 font-semibold shrink-0" title={r.reviewComment ?? ""}>
                          <ShieldX size={11} /> Rejected{r.reviewedBy ? ` · ${r.reviewedBy}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </CardContent>

    </Card>
  );
}
