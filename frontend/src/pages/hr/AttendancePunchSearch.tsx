import { useEffect, useMemo, useState, type ReactNode } from "react";
import HrLayout from "@/components/HrLayout";
import { RefreshButton } from "@/components/PageRefreshBar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  useAttendanceSearch,
  useAttendanceSearchRange,
  type AttendanceSearchDay,
  type AttendanceSearchResult,
} from "@/lib/api-client/custom-hooks";
import {
  MAX_RANGE_DAYS,
  PRESETS,
  activePreset,
  dayFlags,
  dayNotes,
  formatDisplayDate,
  formatPeriodLabel,
  formatSpan,
  inclusiveDays,
  initialsOf,
  isIssueDay,
  monthRange,
  parseYMD,
  presetPeriod,
  punchSpanMinutes,
  summarize,
  todayStr,
  weekRange,
  type DayFlag,
  type FlagTone,
  type PresetKey,
  type Summary,
  type ViewMode,
} from "@/lib/attendance-search";
import { attendanceStatusClass, TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  CalendarDays,
  CalendarRange,
  Fingerprint,
  Loader2,
  LogIn,
  LogOut,
  Search,
  Sun,
  Timer,
  UserSearch,
  X,
} from "lucide-react";

// The server returns at most this many people for one search.
const MATCH_CAP = 25;

const STATUS_META: Record<string, { label: string; cell: string; bar: string }> = {
  present: { label: "Present", cell: "bg-green-500 text-white", bar: "bg-green-500" },
  half_shift: { label: "Half shift", cell: "bg-amber-400 text-amber-950", bar: "bg-amber-400" },
  absent: { label: "Absent", cell: "bg-red-500 text-white", bar: "bg-red-500" },
  on_leave: { label: "On leave", cell: "bg-blue-500 text-white", bar: "bg-blue-500" },
  holiday: { label: "Holiday", cell: "bg-slate-200 text-slate-500", bar: "bg-slate-300" },
};
const statusMeta = (status: string) =>
  STATUS_META[status] ?? { label: status, cell: "bg-slate-200 text-slate-500", bar: "bg-slate-300" };

const FLAG_STYLES: Record<FlagTone, string> = {
  late: TONE.caution,
  halfShift: TONE.warning,
  casual: "bg-indigo-100 text-indigo-800 border-indigo-200",
  leave: TONE.info,
  permission: TONE.accent,
  autoPermission: "bg-emerald-100 text-emerald-800 border-emerald-200",
  compensation: "bg-teal-100 text-teal-800 border-teal-200",
};

const SOURCE_STYLES: Record<string, string> = {
  Biometric: "bg-blue-50 text-blue-700",
  "Geo Punch": "bg-teal-50 text-teal-700",
  "On-Duty": "bg-amber-50 text-amber-700",
  "HR Entry": "bg-purple-50 text-purple-700",
};
const sourceStyle = (label: string) => SOURCE_STYLES[label] ?? "bg-gray-100 text-gray-600";

// ── small pieces ──

function Initials({ name, size = 44 }: { name: string; size?: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex shrink-0 select-none items-center justify-center rounded-full bg-teal-50 font-black text-teal-700"
      style={{ width: size, height: size, fontSize: size * 0.36 }}
    >
      {initialsOf(name)}
    </div>
  );
}

function Panel({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <Card className="border-0 shadow-sm">
      <CardContent className="flex flex-col items-center px-6 py-14 text-center">
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-gray-100 text-gray-400">
          {icon}
        </div>
        <p className="text-base font-bold text-gray-900">{title}</p>
        {children && <div className="mt-1 max-w-md text-sm text-gray-500">{children}</div>}
      </CardContent>
    </Card>
  );
}

function IntroPanel() {
  const hints = [
    { icon: <Sun size={16} />, title: "Shift", text: "The assigned shift, its timings and grace period" },
    {
      icon: <Fingerprint size={16} />,
      title: "Every punch",
      text: "Each check-in and check-out and where it came from",
    },
    {
      icon: <AlertTriangle size={16} />,
      title: "What happened",
      text: "Late marks, leave, permission and half shifts",
    },
  ];
  return (
    <Card className="border-0 shadow-sm" data-testid="attendance-search-intro">
      <CardContent className="px-6 py-12">
        <div className="mx-auto mb-8 flex max-w-md flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 text-teal-600">
            <UserSearch size={26} />
          </div>
          <p className="text-base font-bold text-gray-900">Who are you looking for?</p>
          <p className="mt-1 text-sm text-gray-500">Type an employee code or part of a name above.</p>
        </div>
        <div className="mx-auto grid max-w-3xl gap-3 sm:grid-cols-3">
          {hints.map((h) => (
            <div key={h.title} className="rounded-xl bg-gray-50 p-4">
              <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-lg bg-white text-gray-600 shadow-sm">
                {h.icon}
              </div>
              <p className="text-sm font-bold text-gray-900">{h.title}</p>
              <p className="mt-0.5 text-xs text-gray-500">{h.text}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function ResultsSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading attendance">
      <Card className="border-0 shadow-sm">
        <CardContent className="flex items-center gap-4 p-5">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
          </div>
        </CardContent>
      </Card>
      <div className="space-y-2">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[72px] w-full rounded-xl" />
        ))}
      </div>
    </div>
  );
}

function StatTile({ label, value, dot }: { label: string; value: number; dot: string }) {
  return (
    <div className="rounded-xl border bg-white px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-gray-500">
        <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden="true" />
        {label}
      </p>
      <p
        className={cn(
          "mt-1.5 text-2xl font-black leading-none tabular-nums",
          value ? "text-gray-900" : "text-gray-300",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function StatusBar({ summary }: { summary: Summary }) {
  const parts = [
    ["present", summary.present],
    ["half_shift", summary.halfShift],
    ["absent", summary.absent],
    ["on_leave", summary.onLeave],
    ["holiday", summary.holiday],
  ] as const;
  return (
    <div
      role="img"
      aria-label={parts.map(([s, n]) => `${n} ${statusMeta(s).label}`).join(", ")}
      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-gray-200"
    >
      {parts
        .filter(([, n]) => n > 0)
        .map(([status, n]) => (
          <div key={status} className={statusMeta(status).bar} style={{ width: `${(n / summary.total) * 100}%` }} />
        ))}
    </div>
  );
}

function DayCell({ day, onPick }: { day: AttendanceSearchDay; onPick: (date: string) => void }) {
  const label = `${formatDisplayDate(day.date)} · ${statusMeta(day.status).label}${day.isLate ? " · late" : ""}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={() => onPick(day.date)}
          className={cn(
            "flex h-7 w-7 items-center justify-center rounded-md text-[10px] font-bold tabular-nums transition-transform hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900",
            statusMeta(day.status).cell,
            day.isLate && "ring-2 ring-orange-400 ring-offset-1",
          )}
        >
          {parseYMD(day.date).getDate()}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function FlagBadge({ flag }: { flag: DayFlag }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold",
        FLAG_STYLES[flag.tone],
      )}
    >
      {flag.label}
      {flag.detail && <span className="font-medium opacity-80">· {flag.detail}</span>}
    </span>
  );
}

function DayRow({ day, isToday, flashing }: { day: AttendanceSearchDay; isToday: boolean; flashing: boolean }) {
  const punches = day.punches.filter((p): p is NonNullable<typeof p> => p !== null);
  const span = punchSpanMinutes(day.punches);
  const flags = dayFlags(day);
  const notes = dayNotes(day);
  const d = parseYMD(day.date);
  const tone = attendanceStatusClass(day.status);

  return (
    <div
      id={`day-${day.date}`}
      data-testid="attendance-day-row"
      data-status={day.status}
      className={cn(
        "flex scroll-mt-24 gap-3 rounded-xl border bg-white p-3 transition-shadow sm:gap-4",
        flashing && "shadow-md ring-2 ring-gray-900/25",
      )}
    >
      <div
        className={cn(
          "flex w-14 shrink-0 flex-col items-center justify-center self-start rounded-xl border py-1.5",
          tone,
        )}
      >
        <span className="text-[10px] font-bold uppercase tracking-wide opacity-75">
          {d.toLocaleDateString("en-IN", { weekday: "short" })}
        </span>
        <span className="text-xl font-black leading-tight tabular-nums">{d.getDate()}</span>
        <span className="text-[10px] font-semibold uppercase opacity-75">
          {d.toLocaleDateString("en-IN", { month: "short" })}
        </span>
      </div>

      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={cn("rounded-md border px-2 py-0.5 text-[11px] font-bold", tone)}>
            {statusMeta(day.status).label}
          </span>
          {isToday && (
            <span className="rounded-md bg-gray-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
              Today
            </span>
          )}
          {flags.map((f) => (
            <FlagBadge key={f.key} flag={f} />
          ))}
        </div>

        {punches.length ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {punches.map((p, i) => (
              <div key={i} className="flex items-center gap-1.5 rounded-lg border bg-gray-50 px-2 py-1">
                {p.type === "IN" ? (
                  <LogIn size={12} className="text-green-600" aria-hidden="true" />
                ) : (
                  <LogOut size={12} className="text-rose-500" aria-hidden="true" />
                )}
                <span className="sr-only">{p.type === "IN" ? "Check-in" : "Check-out"}</span>
                <span className="text-sm font-bold tabular-nums text-gray-900" title={p.time}>
                  {p.time.slice(0, 5)}
                </span>
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-bold", sourceStyle(p.sourceLabel))}>
                  {p.sourceLabel}
                </span>
              </div>
            ))}
            {span !== null && (
              <span
                className="ml-1 inline-flex items-center gap-1 text-xs font-semibold text-gray-500"
                title="First punch to last punch"
              >
                <Timer size={12} aria-hidden="true" /> {formatSpan(span)}
              </span>
            )}
          </div>
        ) : (
          <p className="text-xs text-gray-400">No punches recorded</p>
        )}

        {notes.length > 0 && (
          <ul className="space-y-0.5">
            {notes.map((n) => (
              <li key={n.key} className="text-xs text-gray-500">
                <span className="font-semibold text-gray-600">{n.label}:</span> {n.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function EmployeeOption({ emp, onSelect }: { emp: AttendanceSearchResult; onSelect: () => void }) {
  return (
    <button
      type="button"
      data-testid="attendance-employee-option"
      onClick={onSelect}
      className="flex items-center gap-3 rounded-xl border bg-white p-3 text-left transition hover:border-gray-400 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-900"
    >
      <Initials name={emp.employeeName} size={40} />
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-gray-900">{emp.employeeName}</span>
        <span className="block truncate text-xs text-gray-500">
          <span className="font-mono">{emp.employeeCode}</span> · {emp.department ?? "No department"}
        </span>
      </span>
    </button>
  );
}

// ── page ──

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
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [flash, setFlash] = useState<{ date: string; at: number } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(input), 300);
    return () => clearTimeout(t);
  }, [input]);

  // A new search starts over; changing the period does not, so the person you picked stays picked.
  useEffect(() => {
    setSelectedEmployeeId(null);
  }, [query]);

  // The match list resolves which employee(s) the query points at. "Today" is just the anchor date for
  // that lookup; it has no bearing on the period shown once an employee is selected.
  const matchQuery = useAttendanceSearch(query, todayStr());
  const matches = matchQuery.data?.results ?? [];

  useEffect(() => {
    if (matches.length === 1 && selectedEmployeeId == null) {
      setSelectedEmployeeId(matches[0].employeeId);
    }
  }, [matches.length, selectedEmployeeId]);

  const [startDate, endDate] =
    mode === "week"
      ? weekRange(weekAnchor)
      : mode === "month"
        ? monthRange(month)
        : mode === "range"
          ? [rangeStart, rangeEnd]
          : [date, date];
  const periodDays = inclusiveDays(startDate, endDate);
  const rangeTooLong = periodDays > MAX_RANGE_DAYS;

  const rangeQuery = useAttendanceSearchRange(selectedEmployeeId, startDate, endDate, !rangeTooLong);
  const rangeData = rangeQuery.data;
  const days = rangeData?.days;
  const summary = useMemo(() => summarize(days ?? []), [days]);

  const today = todayStr();
  const chosenPreset = activePreset({ mode, date, weekAnchor, month, rangeStart, rangeEnd });
  const applyPreset = (key: PresetKey) => {
    const p = presetPeriod(key);
    setMode(p.mode);
    setDate(p.date);
    setWeekAnchor(p.weekAnchor);
    setMonth(p.month);
  };

  const searching = input.trim() !== query.trim() || (query.trim() !== "" && matchQuery.isLoading);
  const clearSearch = () => {
    setInput("");
    setQuery("");
  };

  // Jump to a day from the calendar strip: show it even if the issues filter had hidden it, then pulse it.
  const pickDay = (d: string) => {
    setIssuesOnly(false);
    setFlash({ date: d, at: Date.now() });
  };
  useEffect(() => {
    if (!flash) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    document
      .getElementById(`day-${flash.date}`)
      ?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    const t = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const renderResults = () => {
    if (!query.trim()) return <IntroPanel />;

    if (matchQuery.isError) {
      return (
        <Panel icon={<AlertTriangle size={24} />} title="Couldn't search right now">
          <p>Check your connection and try again.</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void matchQuery.refetch()}>
            Try again
          </Button>
        </Panel>
      );
    }
    if (matchQuery.isLoading) return <ResultsSkeleton />;
    if (matches.length === 0) {
      return (
        <Panel icon={<UserSearch size={24} />} title={`No employee matches “${query.trim()}”`}>
          Check the spelling or try the employee code. Only active employees in your branch are searched.
        </Panel>
      );
    }
    if (matches.length > 1 && selectedEmployeeId == null) {
      return (
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4 sm:p-5">
            <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-bold text-gray-900">
                {matches.length} employees match “{query.trim()}”
              </p>
              <p className="text-xs text-gray-500">
                {matches.length >= MATCH_CAP
                  ? `Showing the first ${MATCH_CAP} — type more to narrow it down`
                  : "Pick one to see their attendance"}
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {matches.map((emp) => (
                <EmployeeOption key={emp.employeeId} emp={emp} onSelect={() => setSelectedEmployeeId(emp.employeeId)} />
              ))}
            </div>
          </CardContent>
        </Card>
      );
    }
    if (selectedEmployeeId == null) return <ResultsSkeleton />;

    if (rangeTooLong) {
      return (
        <Panel icon={<CalendarRange size={24} />} title={`That's ${periodDays} days`}>
          Pick {MAX_RANGE_DAYS} days or fewer to look at one employee at a time.
        </Panel>
      );
    }
    if (!startDate || !endDate) {
      return (
        <Panel icon={<CalendarRange size={24} />} title="Choose the dates">
          Set both a start and an end date.
        </Panel>
      );
    }
    if (rangeQuery.isError) {
      return (
        <Panel icon={<AlertTriangle size={24} />} title="Couldn't load this period">
          <p>{rangeQuery.error instanceof Error ? rangeQuery.error.message : "Something went wrong."}</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void rangeQuery.refetch()}>
            Try again
          </Button>
        </Panel>
      );
    }
    if (rangeQuery.isLoading || !rangeData) return <ResultsSkeleton />;

    const filtering = issuesOnly && rangeData.days.length > 1;
    const shown = filtering ? rangeData.days.filter(isIssueDay) : rangeData.days;
    const shift = rangeData.shift;

    return (
      <div className="space-y-4">
        <Card className="overflow-hidden border-0 shadow-sm" data-testid="attendance-employee-card">
          <CardContent className="p-0">
            <div className="flex flex-wrap items-start justify-between gap-4 p-4 sm:p-5">
              <div className="flex min-w-[16rem] flex-1 items-start gap-4">
                <Initials name={rangeData.employeeName} size={56} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-lg font-black text-gray-900">{rangeData.employeeName}</h3>
                    <span className="rounded-md bg-gray-100 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-gray-600">
                      {rangeData.employeeCode}
                    </span>
                  </div>
                  <p className="mt-0.5 text-sm text-gray-500">
                    {rangeData.department ?? "No department"} · {rangeData.designation ?? "No designation"}
                  </p>
                  {shift && (
                    <p className="mt-2 inline-flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800">
                      <Sun size={12} aria-hidden="true" />
                      {shift.name}
                      {shift.startTime && shift.endTime && (
                        <span className="tabular-nums font-medium opacity-80">
                          {shift.startTime.slice(0, 5)}–{shift.endTime.slice(0, 5)}
                        </span>
                      )}
                      {shift.gracePeriodMinutes ? (
                        <span className="font-medium opacity-80">· {shift.gracePeriodMinutes} min grace</span>
                      ) : null}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex flex-col items-start gap-1.5 sm:items-end">
                <p className="text-sm font-bold text-gray-900" data-testid="attendance-period-label">
                  {formatPeriodLabel(rangeData.startDate, rangeData.endDate)}
                </p>
                <p className="text-xs text-gray-500">
                  {rangeData.days.length} {rangeData.days.length === 1 ? "day" : "days"}
                </p>
                {matches.length > 1 && (
                  <Button variant="outline" size="sm" className="mt-1 h-8" onClick={() => setSelectedEmployeeId(null)}>
                    Change employee
                  </Button>
                )}
              </div>
            </div>

            {rangeData.days.length > 1 && (
              <div className="space-y-4 border-t bg-gray-50/70 p-4 sm:p-5" data-testid="attendance-summary">
                <StatusBar summary={summary} />
                <div className="grid grid-cols-2 gap-2 max-sm:[&>:last-child]:col-span-2 sm:grid-cols-4 lg:grid-cols-7">
                  <StatTile label="Present" value={summary.present} dot="bg-green-500" />
                  <StatTile label="Half shift" value={summary.halfShift} dot="bg-amber-400" />
                  <StatTile label="Absent" value={summary.absent} dot="bg-red-500" />
                  <StatTile label="On leave" value={summary.onLeave} dot="bg-blue-500" />
                  <StatTile label="Holiday" value={summary.holiday} dot="bg-slate-300" />
                  <StatTile label="Late" value={summary.late} dot="bg-orange-400" />
                  <StatTile label="Permission" value={summary.permission} dot="bg-purple-500" />
                </div>
                <div>
                  <div className="flex flex-wrap gap-1.5">
                    {rangeData.days.map((d) => (
                      <DayCell key={d.date} day={d} onPick={pickDay} />
                    ))}
                  </div>
                  <p className="mt-2 text-[11px] text-gray-500">
                    Select a day to jump to it. An orange outline marks a late arrival.
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {rangeData.days.length === 0 ? (
          <Panel icon={<CalendarDays size={24} />} title="No attendance records in this period" />
        ) : (
          <div className="space-y-2">
            {rangeData.days.length > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <p className="text-sm font-bold text-gray-900">
                  Daily records
                  <span className="ml-2 text-xs font-medium text-gray-500">
                    {filtering ? `${shown.length} of ${rangeData.days.length} days` : `${rangeData.days.length} days`}
                  </span>
                </p>
                <button
                  type="button"
                  aria-pressed={issuesOnly}
                  disabled={summary.issues === 0}
                  onClick={() => setIssuesOnly((v) => !v)}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    issuesOnly ? "border-gray-900 bg-gray-900 text-white" : "bg-white text-gray-600 hover:bg-gray-50",
                  )}
                >
                  <AlertTriangle size={12} aria-hidden="true" />
                  {summary.issues === 0 ? "No issues" : `Issues only · ${summary.issues}`}
                </button>
              </div>
            )}
            {shown.length === 0 ? (
              <Panel icon={<CalendarDays size={24} />} title="No issues in this period" />
            ) : (
              shown.map((d) => (
                <DayRow key={d.date} day={d} isToday={d.date === today} flashing={flash?.date === d.date} />
              ))
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-2xl font-black text-gray-900">Attendance Search</h2>
            <RefreshButton />
          </div>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Find an employee by code or name to see their shift, every punch, and any late, leave or permission, for a
            day, a week, a month or any range.
          </p>
        </div>

        <Card className="border-0 shadow-sm">
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="relative">
              {searching ? (
                <Loader2
                  size={16}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 animate-spin text-gray-400"
                  aria-hidden="true"
                />
              ) : (
                <Search
                  size={16}
                  className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400"
                  aria-hidden="true"
                />
              )}
              <Input
                data-testid="attendance-search-input"
                aria-label="Search by employee code or name"
                className="h-11 rounded-xl pl-10 pr-10 text-sm"
                placeholder="Employee code or name"
                value={input}
                autoFocus
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setQuery(input);
                  if (e.key === "Escape") clearSearch();
                }}
              />
              {input && (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={clearSearch}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700"
                >
                  <X size={15} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <PillTabs
                  size="sm"
                  value={mode}
                  onChange={(v) => setMode(v as ViewMode)}
                  items={[
                    { value: "day", label: "Day", icon: <CalendarDays size={12} /> },
                    { value: "week", label: "Week", icon: <CalendarDays size={12} /> },
                    { value: "month", label: "Month", icon: <CalendarDays size={12} /> },
                    { value: "range", label: "Custom", icon: <CalendarRange size={12} /> },
                  ]}
                />
                {mode === "day" && (
                  <Input
                    aria-label="Date"
                    type="date"
                    className="h-9 w-auto text-sm"
                    value={date}
                    max={today}
                    onChange={(e) => setDate(e.target.value)}
                  />
                )}
                {mode === "week" && (
                  <>
                    <Input
                      aria-label="Any day in the week"
                      type="date"
                      className="h-9 w-auto text-sm"
                      value={weekAnchor}
                      max={today}
                      onChange={(e) => setWeekAnchor(e.target.value)}
                    />
                    <span className="text-xs text-gray-500">{formatPeriodLabel(startDate, endDate)}</span>
                  </>
                )}
                {mode === "month" && (
                  <>
                    <Input
                      aria-label="Month"
                      type="month"
                      className="h-9 w-auto text-sm"
                      value={month}
                      max={today.slice(0, 7)}
                      onChange={(e) => setMonth(e.target.value)}
                    />
                    <span className="text-xs text-gray-500">{formatPeriodLabel(startDate, endDate)}</span>
                  </>
                )}
                {mode === "range" && (
                  <>
                    <Input
                      aria-label="From"
                      type="date"
                      className="h-9 w-auto text-sm"
                      value={rangeStart}
                      max={rangeEnd}
                      onChange={(e) => setRangeStart(e.target.value)}
                    />
                    <span className="text-xs text-gray-500">to</span>
                    <Input
                      aria-label="To"
                      type="date"
                      className="h-9 w-auto text-sm"
                      value={rangeEnd}
                      min={rangeStart}
                      max={today}
                      onChange={(e) => setRangeEnd(e.target.value)}
                    />
                    {periodDays > 0 && (
                      <span className={cn("text-xs", rangeTooLong ? "font-semibold text-red-600" : "text-gray-500")}>
                        {periodDays} days{rangeTooLong ? ` (up to ${MAX_RANGE_DAYS})` : ""}
                      </span>
                    )}
                  </>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick ranges">
                {PRESETS.map((p) => (
                  <button
                    key={p.key}
                    type="button"
                    aria-pressed={chosenPreset === p.key}
                    onClick={() => applyPreset(p.key)}
                    className={cn(
                      "h-8 rounded-full border px-3 text-xs font-semibold transition-colors",
                      chosenPreset === p.key
                        ? "border-gray-900 bg-gray-900 text-white"
                        : "bg-white text-gray-600 hover:bg-gray-50",
                    )}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {renderResults()}
      </div>
    </HrLayout>
  );
}
