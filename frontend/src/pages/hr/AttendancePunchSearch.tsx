import { useEffect, useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { SpeederLoader } from "@/components/ui/SpeederLoader";
import {
  useAttendanceSearch, useAttendanceSearchRange,
  type AttendanceSearchPunch, type AttendanceSearchDay, type AttendanceSearchResult,
} from "@/lib/api-client/custom-hooks";
import {
  Search, UserSearch, Clock, Sun, ArrowRightLeft, CalendarDays, CalendarRange, Users,
  CheckCircle2, AlertCircle, CalendarOff, AlertTriangle, ShieldCheck,
} from "lucide-react";

const todayStr = () => new Date().toISOString().slice(0, 10);

type ViewMode = "day" | "week" | "month" | "range";

function parseYMD(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function formatYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function weekRange(dateStr: string): [string, string] {
  const d = parseYMD(dateStr);
  const dow = d.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(d);
  monday.setDate(d.getDate() + diffToMonday);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  return [formatYMD(monday), formatYMD(sunday)];
}
function monthRange(ym: string): [string, string] {
  const [y, m] = ym.split("-").map(Number);
  const start = new Date(y, (m || 1) - 1, 1);
  const end = new Date(y, m || 1, 0);
  return [formatYMD(start), formatYMD(end)];
}
function formatDisplayDate(dateStr: string): string {
  const d = parseYMD(dateStr);
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "2-digit", month: "short" });
}

const SOURCE_STYLES: Record<string, string> = {
  Biometric: "bg-blue-50 text-blue-700",
  "Geo Punch": "bg-teal-50 text-teal-700",
  "On-Duty": "bg-amber-50 text-amber-700",
  "HR Entry": "bg-purple-50 text-purple-700",
};

function sourceStyle(label: string) {
  return SOURCE_STYLES[label] ?? "bg-gray-100 text-gray-600";
}

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  present: { label: "Present", className: "bg-emerald-50 text-emerald-700" },
  half_shift: { label: "Half Shift", className: "bg-amber-50 text-amber-700" },
  absent: { label: "Absent", className: "bg-red-50 text-red-700" },
  on_leave: { label: "On Leave", className: "bg-blue-50 text-blue-700" },
  holiday: { label: "Holiday", className: "bg-gray-100 text-gray-500" },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded uppercase ${s.className}`}>{s.label}</span>;
}

function PunchSlot({ slot, index }: { slot: AttendanceSearchPunch; index: number }) {
  if (!slot) {
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-gray-50 border border-dashed border-gray-200 min-w-[110px]">
        <span className="text-[10px] font-bold text-gray-300">PUNCH {index + 1}</span>
        <span className="text-xs text-gray-300">—</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-white border min-w-[110px]">
      <span className="text-[10px] font-bold text-gray-400">PUNCH {index + 1} · {slot.type === "IN" ? "Check-In" : "Check-Out"}</span>
      <span className="text-sm font-bold text-gray-900 tabular-nums">{slot.time.slice(0, 5)}</span>
      <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${sourceStyle(slot.sourceLabel)}`}>{slot.sourceLabel}</span>
    </div>
  );
}

// Every status slot always renders -active (colored, carries data) or
// inactive (dashed/faded, mirrors PunchSlot's empty-punch look) -so every
// day row has the same fixed set of tiles and reads like a consistent
// table instead of ad-hoc text that only sometimes appears.
function StatusSlot({
  label, active, activeClassName, valueLine, reasonLine,
}: {
  label: string;
  active: boolean;
  activeClassName: string;
  valueLine?: string | null;
  reasonLine?: string | null;
}) {
  if (!active) {
    return (
      <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-lg bg-gray-50 border border-dashed border-gray-200 min-w-[100px] max-w-[130px]">
        <span className="text-[10px] font-bold text-gray-300 uppercase">{label}</span>
        <span className="text-xs text-gray-300">—</span>
      </div>
    );
  }
  return (
    <div className={`flex flex-col items-center gap-1 px-3 py-2 rounded-lg border min-w-[100px] max-w-[130px] ${activeClassName}`}>
      <span className="text-[10px] font-bold uppercase opacity-75">{label}</span>
      {valueLine ? (
        <span className="text-xs font-bold">{valueLine}</span>
      ) : !reasonLine ? (
        <span className="text-xs opacity-60">✓</span>
      ) : null}
      {reasonLine && <span className="text-[10px] text-center line-clamp-2 opacity-90">{reasonLine}</span>}
    </div>
  );
}

function DayRow({ day, alt }: { day: AttendanceSearchDay; alt: boolean }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 p-3 rounded-xl ${alt ? "bg-gray-50/70" : "bg-white"}`}>
      <div className="min-w-[92px] shrink-0">
        <p className="text-xs font-bold text-gray-900">{formatDisplayDate(day.date)}</p>
        <div className="mt-1">
          <StatusPill status={day.status} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {day.punches.map((p, i) => <PunchSlot key={i} slot={p} index={i} />)}
        <StatusSlot label="Late" active={day.isLate} activeClassName="bg-red-50 text-red-700 border-red-100" />
        <StatusSlot
          label="CL"
          active={!!day.casualLeave}
          activeClassName="bg-indigo-50 text-indigo-700 border-indigo-100"
          reasonLine={day.casualLeave?.reason}
        />
        <StatusSlot label="Half Shift" active={day.isHalfShift} activeClassName="bg-amber-50 text-amber-700 border-amber-100" />
        <StatusSlot
          label="Leave"
          active={!!day.leave}
          activeClassName="bg-blue-50 text-blue-700 border-blue-100"
          valueLine={day.leave?.type}
          reasonLine={day.leave?.reason}
        />
        <StatusSlot
          label="Permission"
          active={!!day.permission}
          activeClassName="bg-purple-50 text-purple-700 border-purple-100"
          valueLine={day.permission?.time}
          reasonLine={day.permission?.reason}
        />
      </div>
    </div>
  );
}

function EmployeeMatchChip({ emp, selected, onSelect }: { emp: AttendanceSearchResult; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`text-left px-3 py-2 rounded-lg border text-xs transition-colors ${
        selected ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-200 hover:border-gray-400"
      }`}
    >
      <span className="font-bold">{emp.employeeName}</span>
      <span className={`ml-1.5 font-mono ${selected ? "text-white/70" : "text-gray-400"}`}>({emp.employeeCode})</span>
    </button>
  );
}

export default function AttendancePunchSearch() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<ViewMode>("day");
  const [date, setDate] = useState(todayStr());
  const [weekAnchor, setWeekAnchor] = useState(todayStr());
  const [month, setMonth] = useState(todayStr().slice(0, 7));
  const [rangeStart, setRangeStart] = useState(todayStr());
  const [rangeEnd, setRangeEnd] = useState(todayStr());
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  useEffect(() => {
    setSelectedEmployeeId(null);
  }, [query, mode]);

  // The match list resolves which employee(s) the query points at -"today"
  // is just an arbitrary anchor date for the lookup, it has no bearing on
  // which date range gets shown once an employee is selected below.
  const { data: matchData, isLoading: matchLoading, isFetching: matchFetching } = useAttendanceSearch(query, todayStr());
  const matches = matchData?.results ?? [];

  useEffect(() => {
    if (matches.length === 1 && selectedEmployeeId == null) {
      setSelectedEmployeeId(matches[0].employeeId);
    }
    // selectedEmployeeId must stay a real dependency here: the sibling
    // effect above resets it to null on every mode change (including
    // switching directly between two modes where matches.length stays
    // unchanged) -without this in the deps array, that reset never
    // re-triggers this effect, leaving selectedEmployeeId stuck null and
    // the whole results section rendering nothing (see the
    // `!selectedEmployeeId ? null` branch below) until the query changes.
  }, [matches.length, selectedEmployeeId]);

  const [startDate, endDate] =
    mode === "week" ? weekRange(weekAnchor)
    : mode === "month" ? monthRange(month)
    : mode === "range" ? [rangeStart, rangeEnd]
    : [date, date];

  const { data: rangeData, isLoading: rangeLoading, isFetching: rangeFetching } = useAttendanceSearchRange(
    selectedEmployeeId, startDate, endDate, true,
  );

  // Per-employee KPI cards for the currently resolved employee + period —
  // replaces the old always-on company-wide summary; nothing renders here
  // until a search actually resolves to one employee's data.
  const kpi = rangeData ? {
    totalDays: rangeData.days.length,
    present: rangeData.days.filter(d => d.status === "present").length,
    halfShift: rangeData.days.filter(d => d.status === "half_shift").length,
    absent: rangeData.days.filter(d => d.status === "absent").length,
    onLeave: rangeData.days.filter(d => d.status === "on_leave").length,
    late: rangeData.days.filter(d => d.isLate).length,
    permission: rangeData.days.filter(d => !!d.permission).length,
  } : null;

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black text-gray-900">Attendance Search</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Look up any employee by Employee Code or Name to see their shift, punch timings, late marks, leave and permission records -for a day, week, month, or custom date range.
          </p>
        </div>

        {/* This employee's attendance for the searched period -only appears once a search resolves to one employee, never a company-wide figure */}
        {kpi && rangeData && (
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
            {[
              { label: "Total Days", value: kpi.totalDays, color: "text-gray-700", icon: Users, bg: "bg-gray-100" },
              { label: "Present", value: kpi.present, color: "text-emerald-700", icon: CheckCircle2, bg: "bg-emerald-50" },
              { label: "Half Shift", value: kpi.halfShift, color: "text-amber-700", icon: Clock, bg: "bg-amber-50" },
              { label: "Absent", value: kpi.absent, color: "text-red-600", icon: AlertCircle, bg: "bg-red-50" },
              { label: "Leave", value: kpi.onLeave, color: "text-blue-700", icon: CalendarOff, bg: "bg-blue-50" },
              { label: "Late", value: kpi.late, color: "text-orange-600", icon: AlertTriangle, bg: "bg-orange-50" },
              { label: "Permission", value: kpi.permission, color: "text-purple-700", icon: ShieldCheck, bg: "bg-purple-50" },
            ].map(s => (
              <Card key={s.label} className="border-0 shadow-sm">
                <CardContent className="p-3 flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg ${s.bg} flex items-center justify-center shrink-0`}>
                    <s.icon size={15} className={s.color} />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground truncate">{s.label}</p>
                    <p className={`text-sm font-black ${s.color}`}>{s.value}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
        {kpi && rangeData && (
          <p className="text-[11px] text-gray-400 -mt-2 flex items-center gap-1.5">
            <Users size={11} /> {rangeData.employeeName} ({rangeData.employeeCode}) · {formatDisplayDate(rangeData.startDate)} – {formatDisplayDate(rangeData.endDate)}
          </p>
        )}

        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 flex flex-col gap-3">
            <div className="flex flex-wrap gap-3 items-center">
              <div className="relative flex-1 min-w-[240px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <Input
                  className="pl-9 h-10 text-sm"
                  placeholder="Search by Employee Code or Name…"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  autoFocus
                />
              </div>
              <PillTabs
                size="sm"
                value={mode}
                onChange={(v) => setMode(v as ViewMode)}
                items={[
                  { value: "day", label: "Day", icon: <CalendarDays size={12} /> },
                  { value: "week", label: "Week", icon: <CalendarDays size={12} /> },
                  { value: "month", label: "Month", icon: <CalendarDays size={12} /> },
                  { value: "range", label: "Custom Range", icon: <CalendarRange size={12} /> },
                ]}
              />
            </div>

            {mode === "day" && (
              <Input type="date" className="h-9 text-sm w-auto" value={date} max={todayStr()} onChange={(e) => setDate(e.target.value)} />
            )}
            {mode === "week" && (
              <div className="flex items-center gap-2">
                <Input type="date" className="h-9 text-sm w-auto" value={weekAnchor} max={todayStr()} onChange={(e) => setWeekAnchor(e.target.value)} />
                <span className="text-xs text-gray-400">Week of {formatDisplayDate(startDate)} – {formatDisplayDate(endDate)}</span>
              </div>
            )}
            {mode === "month" && (
              <Input type="month" className="h-9 text-sm w-auto" value={month} max={todayStr().slice(0, 7)} onChange={(e) => setMonth(e.target.value)} />
            )}
            {mode === "range" && (
              <div className="flex flex-wrap items-center gap-2">
                <Input type="date" className="h-9 text-sm w-auto" value={rangeStart} max={rangeEnd} onChange={(e) => setRangeStart(e.target.value)} />
                <span className="text-xs text-gray-400">to</span>
                <Input type="date" className="h-9 text-sm w-auto" value={rangeEnd} min={rangeStart} max={todayStr()} onChange={(e) => setRangeEnd(e.target.value)} />
              </div>
            )}
          </CardContent>
        </Card>

        {!query.trim() ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <UserSearch size={36} className="text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-500">Start typing an Employee Code or Name to search.</p>
            </CardContent>
          </Card>
        ) : matchLoading || matchFetching ? (
          <SpeederLoader />
        ) : matches.length === 0 ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="py-16 text-center">
              <UserSearch size={36} className="text-gray-200 mx-auto mb-3" />
              <p className="text-sm text-gray-500">No employees match "{query}".</p>
            </CardContent>
          </Card>
        ) : matches.length > 1 && selectedEmployeeId == null ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4 flex flex-col gap-3">
              <p className="text-xs font-bold text-gray-500 flex items-center gap-1.5">
                <Users size={13} /> Multiple employees match "{query}" -pick one to view their {mode === "week" ? "week" : mode === "month" ? "month" : "range"}
              </p>
              <div className="flex flex-wrap gap-2">
                {matches.map((emp) => (
                  <EmployeeMatchChip key={emp.employeeId} emp={emp} selected={false} onSelect={() => setSelectedEmployeeId(emp.employeeId)} />
                ))}
              </div>
            </CardContent>
          </Card>
        ) : !selectedEmployeeId ? null : rangeLoading || rangeFetching ? (
          <SpeederLoader />
        ) : rangeData ? (
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3 pb-3 mb-1 border-b">
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-bold text-gray-900">{rangeData.employeeName}</p>
                    <span className="text-[11px] font-mono text-gray-400">({rangeData.employeeCode})</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{rangeData.department ?? "—"} · {rangeData.designation ?? "—"}</p>
                  {rangeData.shift && (
                    <p className="text-xs text-gray-500 mt-1.5 flex items-center gap-1.5">
                      <Sun size={11} className="text-amber-500" />
                      {rangeData.shift.name}
                      {rangeData.shift.startTime && rangeData.shift.endTime && (
                        <span className="text-gray-400 flex items-center gap-1">
                          <ArrowRightLeft size={10} /> {rangeData.shift.startTime}–{rangeData.shift.endTime}
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {matches.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setSelectedEmployeeId(null)}
                      className="text-[11px] font-semibold text-gray-400 hover:text-gray-700 underline"
                    >
                      Change employee
                    </button>
                  )}
                  <span className="text-[11px] text-gray-400">{formatDisplayDate(rangeData.startDate)} – {formatDisplayDate(rangeData.endDate)}</span>
                </div>
              </div>
              {rangeData.days.length === 0 ? (
                <p className="text-sm text-center text-gray-400 py-10">No attendance data in this range.</p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {rangeData.days.map((day, i) => <DayRow key={day.date} day={day} alt={i % 2 === 1} />)}
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>
    </HrLayout>
  );
}
