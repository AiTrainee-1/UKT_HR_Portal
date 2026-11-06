import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { TONE } from "@/lib/statusTones";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AttendanceLoader } from "@/components/ui/AttendanceLoader";
import { useToast } from "@/hooks/use-toast";
import {
  useEmployeeMonthlyAttendance, useSetPunchDayStatus, useAttendanceOverrideRequests,
  usePayrollSettings, useEmployeePunchMonth,
  type FinalAttendanceDay,
} from "@/lib/api-client/custom-hooks";
import { useListEmployeesLite } from "@/lib/api-client";
import { waitingText } from "@/lib/approval-workflow";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { halfDayWorked, lateDetectionFlags } from "@/lib/late-detection";
import { DayFlagBadges } from "@/components/DayFlagBadges";
import {
  CompensationChip, CompensationLegend, countMarks, isPunchlessRelaxation,
} from "@/components/attendance-compensation";
import { PunchLegend, PunchTimeline } from "./attendance/PunchTimeline";
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

const COLUMNS = [
  { key: "date", label: "Date" },
  { key: "status", label: "Status" },
  { key: "inout", label: "In / Out" },
  { key: "punches", label: "Every punch" },
  { key: "shifts", label: "Shifts" },
  { key: "flags", label: "Late / Permission" },
  { key: "half", label: "Half" },
  { key: "source", label: "Source" },
  { key: "actions", label: "" },
] as const;

/**
 * Employee attendance search: type an employee code → see the whole month split into weeks, with EVERY punch of each day
 * (GET /api/attendance/employee-punches: device, phone, On-Duty, Missing Punch, HR, and the On-Duty punches still waiting
 * for HR) beside the day's verdict. Clicking ✏ on a day opens the Attendance Edit page for that employee + date; saving
 * sends the change for approval before it overwrites the final attendance record used by payroll.
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

  const { data: employees } = useListEmployeesLite({ status: "active" });
  const { data, isLoading, isError } = useEmployeeMonthlyAttendance(searchCode, month, year);
  // Every punch of the month, fetched beside the verdicts (same code, so both requests go out together).
  const { data: punchMonth, isLoading: punchesLoading } = useEmployeePunchMonth(searchCode, month, year);
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
  // date -> every punch of that (shift) day
  const punchesByDate = useMemo(
    () => new Map((punchMonth?.days ?? []).map(d => [d.date, d.punches])),
    [punchMonth],
  );

  // Lower-cased once per roster instead of twice per employee on every keystroke.
  const suggestionIndex = useMemo(
    () => (employees ?? []).map(e => ({
      emp: e,
      code: e.employeeCode.toLowerCase(),
      name: `${e.firstName} ${e.lastName}`.toLowerCase(),
    })),
    [employees],
  );
  const suggestions = useMemo(() => {
    if (!input.trim() || searchCode) return [];
    const q = input.toLowerCase();
    return suggestionIndex
      .filter(({ emp, code, name }) =>
        (!employmentType || emp.employmentType === employmentType) &&
        (code.includes(q) || name.includes(q)))
      .slice(0, 6)
      .map(({ emp }) => emp);
  }, [suggestionIndex, input, searchCode, employmentType]);

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

  const earlyOut = data ? data.weeks.reduce((n, w) => n + w.days.filter(d => d.earlyLeave).length, 0) : 0;

  return (
    <section
      className="clay-card min-w-0 rounded-2xl border border-slate-100 bg-white"
      aria-labelledby="attendance-search-title"
      data-testid="attendance-search-panel"
    >
      <header className="px-4 pt-4 pb-3 sm:px-5">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 max-w-2xl">
            <h3 id="attendance-search-title" className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <span className="rounded-lg bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
                <Search size={14} aria-hidden="true" />
              </span>
              Employee Attendance Search
            </h3>
            <p className="text-xs text-muted-foreground mt-1.5 leading-relaxed">
              One person&apos;s month, week by week, with every punch of every day. Click the pencil on a day to change it:
              every edit needs the Department Head&apos;s approval first and then HR&apos;s before the attendance changes.{" "}
              <a href="/hr/requests?kind=attendance_correction" className="font-semibold text-indigo-700 hover:underline" data-testid="attendance-edit-requests-link">
                Edit requests
              </a>
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative w-full sm:w-64">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden="true" />
              <Input
                className="pl-8 h-9 text-sm rounded-xl"
                placeholder="Employee code or name"
                aria-label="Employee code or name"
                value={input}
                onChange={e => { setInput(e.target.value); setSearchCode(""); }}
                onKeyDown={e => { if (e.key === "Enter" && input.trim()) runSearch(input.trim()); }}
                data-testid="employee-search-input"
              />
              {searchCode && (
                <button
                  type="button"
                  onClick={() => { setInput(""); setSearchCode(""); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-400 hover:text-gray-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                  aria-label="Clear the employee"
                >
                  <X size={12} aria-hidden="true" />
                </button>
              )}
              {suggestions.length > 0 && (
                <div className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border rounded-xl shadow-lg overflow-hidden">
                  {suggestions.map(emp => (
                    <button
                      key={emp.id}
                      type="button"
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-50 text-left text-xs"
                      onMouseDown={e => { e.preventDefault(); runSearch(emp.employeeCode); }}
                    >
                      <span className="tabular-nums text-gray-500 w-14 shrink-0">{emp.employeeCode}</span>
                      <span className="font-semibold truncate">{emp.firstName} {emp.lastName}</span>
                      {emp.departmentName && (
                        <span className="text-gray-500 ml-auto shrink-0">{emp.departmentName}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              size="sm"
              className="h-9 gap-1.5 text-xs px-3 rounded-xl"
              disabled={!input.trim()}
              onClick={() => runSearch(input.trim())}
            >
              <Search size={12} aria-hidden="true" /> Search
            </Button>
            <div className="flex items-center gap-2">
              <select
                value={month}
                onChange={e => setMonth(Number(e.target.value))}
                aria-label="Search month"
                className="h-9 rounded-xl border border-slate-200 px-2 text-xs bg-white"
              >
                {MONTH_NAMES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
              </select>
              <Input
                type="number" min={2020} max={2035}
                value={year}
                onChange={e => setYear(Number(e.target.value))}
                aria-label="Search year"
                className="w-20 h-9 text-xs rounded-xl"
              />
            </div>
          </div>
        </div>
      </header>

      <div className="px-4 pb-4 sm:px-5">
        {!searchCode ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 px-6 py-10 text-center">
            <User size={22} className="text-slate-400" aria-hidden="true" />
            <p className="text-sm text-slate-600">
              Type an employee code or name above and press Enter to see their month and every punch.
            </p>
          </div>
        ) : isLoading ? (
          <div className="border-t">
            <AttendanceLoader />
          </div>
        ) : isError || !data ? (
          <div className="py-10 text-center text-sm text-red-600 border-t">
            No employee found with code &quot;{searchCode}&quot;.
          </div>
        ) : (
          <div className="space-y-4 border-t border-slate-100 pt-4">
            {/* Employee header + totals */}
            <div className="rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-100 space-y-3">
              <div className="flex items-center gap-4 flex-wrap">
                <div className="flex items-center gap-3">
                  <div className="w-11 h-11 rounded-xl bg-white ring-1 ring-slate-200 flex items-center justify-center shrink-0 overflow-hidden">
                    {data.employee.photoUrl
                      ? <img src={data.employee.photoUrl} className="w-11 h-11 object-cover" alt="" />
                      : <User size={16} className="text-gray-500" aria-hidden="true" />}
                  </div>
                  <div>
                    <p className="font-black text-base leading-tight text-slate-900">{data.employee.name}</p>
                    <p className="text-[11px] text-slate-500">
                      <span className="tabular-nums">{data.employee.code}</span>
                      {data.employee.department ? `, ${data.employee.department}` : ""}
                      {data.employee.employmentType ? `, ${data.employee.employmentType}` : ""}
                    </p>
                  </div>
                </div>
                <dl className="grid grid-cols-4 sm:grid-cols-8 gap-1.5 ml-auto" data-testid="search-month-totals">
                  {[
                    { label: "Working days", value: data.summary.workingDays, cls: "text-gray-800" },
                    { label: "Present", value: data.summary.present, cls: "text-green-700" },
                    { label: "Half Shift", value: data.summary.halfShift, cls: "text-amber-700" },
                    { label: "Absent", value: data.summary.absent, cls: "text-red-700" },
                    { label: "Late", value: data.summary.late, cls: "text-orange-700" },
                    { label: "Early Out", value: earlyOut, cls: "text-orange-700" },
                    { label: "Leave", value: data.summary.onLeave, cls: "text-purple-700" },
                    { label: "Effective", value: data.summary.effectiveDays, cls: "text-indigo-700" },
                  ].map(s => (
                    <div key={s.label} className="text-center bg-white ring-1 ring-slate-100 rounded-lg px-2 py-1.5 min-w-[64px]">
                      <dd className={`text-sm font-black tabular-nums ${s.cls}`}>{s.value}</dd>
                      <dt className="text-[10px] leading-tight text-slate-500">{s.label}</dt>
                    </div>
                  ))}
                </dl>
              </div>

              {/* Assigned shift + grace period -the sole source of late/half-shift detection */}
              {data.assignedShift ? (
                <div className="flex items-center gap-2 flex-wrap text-xs bg-white ring-1 ring-slate-100 rounded-lg px-3 py-2">
                  <ShieldCheck size={13} className="text-blue-600 shrink-0" aria-hidden="true" />
                  <span className="text-gray-500">Assigned shift</span>
                  <strong className="text-gray-800">{data.assignedShift.name}</strong>
                  {data.assignedShift.startTime && data.assignedShift.endTime && (
                    <span className="tabular-nums text-gray-600">
                      {data.assignedShift.startTime}–{data.assignedShift.endTime}
                    </span>
                  )}
                  <span className="text-gray-300" aria-hidden="true">|</span>
                  <span className="text-gray-500">Grace period</span>
                  <strong className="text-gray-800">{data.assignedShift.gracePeriodMinutes} min</strong>
                  <span className="text-gray-500">
                    Late and Early Out below are judged against this shift&apos;s start / end + grace; Half Day uses the
                    company-wide Half-Day times (Settings → Attendance).
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2 text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
                  <ShieldCheck size={13} className="shrink-0" aria-hidden="true" />
                  No shift assigned -late detection cannot run for this employee until a shift is assigned in Manage Shift.
                </div>
              )}
            </div>

            {/* Every punch of the month: how many and from where */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white px-3 py-2 ring-1 ring-slate-100" data-testid="search-punch-sources">
              <p className="text-xs text-slate-700">
                {punchesLoading ? (
                  "Reading every punch of the month"
                ) : punchMonth ? (
                  <>
                    <strong className="font-bold tabular-nums text-slate-900">{punchMonth.totalPunches}</strong> punches this
                    month
                    {punchMonth.sources.length > 0 && ": "}
                    {punchMonth.sources.map((s, i) => (
                      <span key={s.label}>
                        {i > 0 && ", "}
                        {s.label} <span className="tabular-nums font-semibold">{s.count}</span>
                      </span>
                    ))}
                  </>
                ) : (
                  "The punches of this month could not be read."
                )}
              </p>
              <PunchLegend kinds={["biometric", "geo", "on_duty", "missing_punch", "hr_entry", "held", "uncounted"]} />
            </div>

            {/* Days on which the employee used a compensation (OT allowance, announced window, birthday, relaxation) */}
            <CompensationLegend
              counts={countMarks(data.weeks.flatMap(w => w.days))}
              className="rounded-lg border bg-white px-3 py-2"
            />

            {/* Weekly tables */}
            {data.weeks.map(week => (
              <div key={week.week} className="rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-700">Week {week.week}</p>
                  <p className="text-[11px] text-slate-500 tabular-nums">
                    {week.days[0]?.date} to {week.days[week.days.length - 1]?.date}
                  </p>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100">
                        {COLUMNS.map(c => (
                          <th key={c.key} scope="col" className="text-left px-3 py-2 text-[11px] font-semibold text-slate-500 whitespace-nowrap">
                            {c.label || <span className="sr-only">Actions</span>}
                          </th>
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
                        const punches = punchesByDate.get(day.date);
                        return (
                        <tr
                          key={day.date}
                          data-testid="search-day-row"
                          className={`border-b border-slate-100 last:border-0 align-top hover:bg-slate-50/70 ${
                            pending ? "bg-yellow-50/50" :
                            day.source === "manual" ? "bg-blue-50/40" :
                            day.status === "absent" ? "bg-red-50/30" :
                            day.status === "half_shift" ? "bg-amber-50/30" : ""
                          }`}
                        >
                          <td data-col="date" className="px-3 py-2 whitespace-nowrap">
                            <span className="block tabular-nums text-xs font-semibold text-slate-800">{day.date}</span>
                            <span className="block text-[11px] text-slate-500">{day.day}</span>
                          </td>
                          <td data-col="status" className="px-3 py-2">
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
                          <td data-col="inout" className="px-3 py-2 tabular-nums text-xs text-gray-700 whitespace-nowrap">
                            {day.firstPunch || day.lastPunch ? `${day.firstPunch ?? "—"} → ${day.lastPunch ?? "—"}` : "—"}
                          </td>
                          <td data-col="punches" className="px-3 py-2 min-w-[11rem]">
                            {punchesLoading ? (
                              <span className="text-[11px] text-slate-500">Loading</span>
                            ) : (
                              <PunchTimeline
                                punches={punches}
                                dayDate={day.date}
                                size="sm"
                                testId={`search-punches-${day.date}`}
                                empty={day.status === "holiday" ? "Day off" : day.status === "on_leave" ? "On leave" : "No punches"}
                              />
                            )}
                          </td>
                          <td data-col="shifts" className="px-3 py-2 text-xs font-bold text-gray-800">{day.shiftsEarned}</td>
                          <td data-col="flags" className="px-3 py-2 text-xs">
                            {flags.length > 0 ? (
                              <div className="flex items-center gap-1 flex-wrap">
                                <DayFlagBadges flags={flags} size="sm" />
                              </div>
                            ) : (
                              <span className="text-gray-300">—</span>
                            )}
                          </td>
                          <td data-col="half" className="px-3 py-2 text-xs">
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
                          <td data-col="source" className="px-3 py-2 text-[11px]">
                            {pending ? (
                              <span className="inline-flex items-center gap-1 text-yellow-800 font-semibold">
                                <Hourglass size={10} aria-hidden="true" /> {waitingText(pending.approval) ?? "Under review"}
                              </span>
                            ) : day.source === "manual" ? (
                              <span className="inline-flex items-center gap-1 text-blue-700 font-semibold">
                                <ShieldCheck size={10} aria-hidden="true" /> By hand{day.overrideBy ? ` · ${day.overrideBy}` : ""}
                              </span>
                            ) : (
                              <span className="text-gray-500">Auto</span>
                            )}
                          </td>
                          <td data-col="actions" className="px-3 py-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  navigate(
                                    `/hr/attendance/edit/${data.employee.id}/${day.date}?back=${encodeURIComponent(window.location.pathname + window.location.search)}`,
                                  )
                                }
                                className="p-1.5 rounded-lg text-gray-500 hover:text-blue-700 hover:bg-blue-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
                                title={pending ? "A change is already waiting for approval: open it to see where it is, or send a new one" : "Edit this day"}
                                aria-label={`Edit ${day.date}`}
                                data-testid={`attendance-edit-open-${day.date}`}
                              >
                                <PenLine size={13} aria-hidden="true" />
                              </button>
                              {day.source === "manual" && (
                                <button
                                  type="button"
                                  onClick={() => revertDay(day)}
                                  className="p-1.5 rounded-lg text-gray-500 hover:text-amber-700 hover:bg-amber-50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
                                  title="Revert to automatic value"
                                  aria-label={`Revert ${day.date} to the automatic value`}
                                >
                                  <RotateCcw size={13} aria-hidden="true" />
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
              <div className="rounded-2xl border border-slate-200 overflow-hidden">
                <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 flex items-center gap-1.5">
                  <History size={12} className="text-gray-500" aria-hidden="true" />
                  <p className="text-xs font-bold text-slate-700">
                    Submitted attendance requests
                  </p>
                </div>
                <div className="divide-y max-h-56 overflow-y-auto">
                  {(myRequests ?? []).slice(0, 15).map(r => (
                    <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                      <span className="tabular-nums text-gray-600 w-24 shrink-0">{r.date}</span>
                      <span className="text-gray-600 flex-1 truncate">{r.reason || "—"}</span>
                      {r.status === "pending" && (
                        <span className="inline-flex items-center gap-1 text-yellow-800 font-semibold shrink-0">
                          <Hourglass size={11} aria-hidden="true" /> Pending
                        </span>
                      )}
                      {r.status === "approved" && (
                        <span className="inline-flex items-center gap-1 text-green-700 font-semibold shrink-0">
                          <ShieldCheck size={11} aria-hidden="true" /> Approved{r.reviewedBy ? ` · ${r.reviewedBy}` : ""}
                        </span>
                      )}
                      {r.status === "rejected" && (
                        <span className="inline-flex items-center gap-1 text-red-700 font-semibold shrink-0" title={r.reviewComment ?? ""}>
                          <ShieldX size={11} aria-hidden="true" /> Rejected{r.reviewedBy ? ` · ${r.reviewedBy}` : ""}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
