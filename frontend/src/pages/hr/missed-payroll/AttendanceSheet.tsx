import { useState } from "react";
import { AlertTriangle, CalendarDays, Info } from "lucide-react";
import { Avatar, EmptyNote } from "@/components/payroll/kit/parts";
import { dateLong } from "@/components/payroll/kit/format";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useEmployeeMonthlyAttendance, type FinalAttendanceDay } from "@/lib/api-client/custom-hooks/attendance";
import type { MissedKind, MissedRow } from "@/lib/api-client/custom-hooks/missed-payroll";
import { cn } from "@/lib/utils";
import { ACCENT as KIND_ACCENT } from "../payroll-details/accent";
import { DayAttendanceEdit } from "../payroll-details/DayAttendanceEdit";
import { dayOfMonth, errorText, monthWeeks, regenerateNote } from "./logic";
import { RowBadges, StatusChip } from "./parts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The colour and name of each attendance status on the calendar. */
const DAY_META: Record<string, { label: string; cell: string; dot: string }> = {
  present: { label: "Present", cell: "bg-emerald-100 text-emerald-900", dot: "bg-emerald-500" },
  half_shift: { label: "Half shift", cell: "bg-amber-100 text-amber-900", dot: "bg-amber-500" },
  absent: { label: "Absent", cell: "bg-red-100 text-red-800", dot: "bg-red-500" },
  on_leave: { label: "Leave", cell: "bg-sky-100 text-sky-900", dot: "bg-sky-500" },
  holiday: { label: "Holiday", cell: "bg-violet-100 text-violet-900", dot: "bg-violet-500" },
};

const dayMeta = (status: string) =>
  DAY_META[status] ?? { label: status.replace(/_/g, " "), cell: "bg-gray-100 text-gray-600", dot: "bg-gray-400" };

function dayTitle(d: FinalAttendanceDay): string {
  const parts = [`${d.day} ${dayOfMonth(d.date)}`, dayMeta(d.status).label];
  const shifts = Number(d.shiftsEarned);
  if (Number.isFinite(shifts) && shifts > 0) parts.push(`${shifts} shift${shifts === 1 ? "" : "s"}`);
  if (d.firstPunch || d.lastPunch) parts.push(`${d.firstPunch ?? "?"}-${d.lastPunch ?? "?"}`);
  if (d.isLate) parts.push("Late");
  if (d.source === "manual") parts.push("Set by HR");
  return parts.join(" · ");
}

/**
 * One employee's attendance for the page's month, inside the page: a calendar of the days, and for a picked day the
 * HRMS's own attendance editor (the change goes to the Department Head, then HR; the day changes only after both
 * approve). Generate again takes an approved change in while the entry is only Generated.
 */
export function AttendanceSheet({
  row,
  kind,
  month,
  year,
  period,
  onClose,
}: {
  row: MissedRow | null;
  kind: MissedKind;
  month: number;
  year: number;
  period: string;
  onClose: () => void;
}) {
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="mp-attendance">
        {row && <AttendanceBody key={row.id} row={row} kind={kind} month={month} year={year} period={period} />}
      </SheetContent>
    </Sheet>
  );
}

function AttendanceBody({
  row,
  kind,
  month,
  year,
  period,
}: {
  row: MissedRow;
  kind: MissedKind;
  month: number;
  year: number;
  period: string;
}) {
  const query = useEmployeeMonthlyAttendance(row.code, month, year);
  const [picked, setPicked] = useState<string | null>(null);
  const days = (query.data?.weeks ?? []).flatMap((w) => w.days);
  const weeks = monthWeeks(days);
  const summary = query.data?.summary;
  const pickedDay = days.find((d) => d.date === picked) ?? null;
  const status = row.entry?.status ?? null;

  return (
    <div className="flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-6">
      <SheetHeader className="space-y-3 pb-4 text-left">
        <div className="flex items-start gap-3 pr-8">
          <Avatar name={row.name} size={44} />
          <div className="min-w-0 flex-1">
            <SheetTitle className="flex flex-wrap items-center gap-1.5 text-base">
              <span className="truncate">{row.name}</span>
              <RowBadges row={row} />
            </SheetTitle>
            <SheetDescription className="text-xs">
              <span className="font-mono">{row.code}</span> · Attendance for {period}
              {row.department && <> · {row.department}</>}
            </SheetDescription>
            {row.entry && (
              <div className="mt-1.5">
                <StatusChip status={row.entry.status} />
              </div>
            )}
          </div>
        </div>
        <div
          className="space-y-1 rounded-xl border border-indigo-100 bg-indigo-50/70 px-3 py-2.5 text-xs leading-relaxed text-indigo-950"
          data-testid="mp-attendance-note"
        >
          <p className="flex items-start gap-1.5">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Pick a day to see its punches and send a change. A change is an attendance-change request: the
              employee&apos;s Department Head approves it first, then HR, as everywhere in the HRMS. The day changes
              only after both approve.
            </span>
          </p>
          <p className="pl-5 font-semibold" data-testid="mp-attendance-regenerate">
            {regenerateNote(status)}
          </p>
        </div>
      </SheetHeader>

      {query.isLoading ? (
        <div className="space-y-2" data-testid="mp-attendance-loading">
          <Skeleton className="h-8 w-full rounded-lg" />
          <Skeleton className="h-56 w-full rounded-xl" />
        </div>
      ) : query.isError ? (
        <EmptyNote
          icon={AlertTriangle}
          title="The attendance could not be loaded"
          hint={errorText(query.error)}
          testId="mp-attendance-error"
        />
      ) : days.length === 0 ? (
        <EmptyNote
          icon={CalendarDays}
          title={`No attendance days for ${period}`}
          hint="Nothing is recorded for this month yet."
          testId="mp-attendance-empty"
        />
      ) : (
        <div className="space-y-4">
          {summary && (
            <p className="text-xs text-gray-600" data-testid="mp-attendance-summary">
              Present {summary.present} · Half shift {summary.halfShift} · Absent {summary.absent} · Leave{" "}
              {summary.onLeave} · Holidays {summary.holidays} · Late {summary.late} · Shifts {summary.totalShifts}
            </p>
          )}
          <div
            role="group"
            aria-label={`Attendance calendar, ${period}`}
            className="space-y-1"
            data-testid="mp-calendar"
          >
            <div className="grid grid-cols-7 gap-1" aria-hidden>
              {WEEKDAYS.map((w) => (
                <div key={w} className="text-center text-[10px] font-semibold uppercase text-gray-400">
                  {w}
                </div>
              ))}
            </div>
            {weeks.map((week, i) => (
              <div key={i} className="grid grid-cols-7 gap-1">
                {week.map((d, j) =>
                  d ? (
                    <button
                      key={d.date}
                      type="button"
                      aria-pressed={picked === d.date}
                      aria-label={dayTitle(d)}
                      title={dayTitle(d)}
                      onClick={() => setPicked(picked === d.date ? null : d.date)}
                      className={cn(
                        "relative flex h-12 flex-col items-center justify-center rounded-lg text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 sm:h-14",
                        dayMeta(d.status).cell,
                        picked === d.date && "ring-2 ring-indigo-600 ring-offset-1",
                      )}
                      data-testid={`mp-day-${d.date}`}
                    >
                      <span>{dayOfMonth(d.date)}</span>
                      {Number(d.shiftsEarned) > 0 && (
                        <span className="text-[10px] font-medium opacity-70">{Number(d.shiftsEarned)}</span>
                      )}
                      {d.isLate && (
                        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-amber-600" aria-hidden />
                      )}
                      {d.source === "manual" && (
                        <span className="absolute left-1 top-1 h-1.5 w-1.5 rounded-full bg-indigo-600" aria-hidden />
                      )}
                    </button>
                  ) : (
                    <div key={`empty-${j}`} aria-hidden className="h-12 sm:h-14" />
                  ),
                )}
              </div>
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-500" aria-label="Legend">
            {Object.entries(DAY_META).map(([key, meta]) => (
              <li key={key} className="inline-flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-full", meta.dot)} aria-hidden /> {meta.label}
              </li>
            ))}
            <li className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-600" aria-hidden /> Late
            </li>
            <li className="inline-flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-indigo-600" aria-hidden /> Set by HR
            </li>
          </ul>

          {pickedDay ? (
            <section
              className="rounded-xl border bg-slate-50/60 p-3"
              aria-label={`Attendance of ${dateLong(pickedDay.date)}`}
              data-testid="mp-day-panel"
            >
              <p className="text-sm font-bold text-gray-900">{dateLong(pickedDay.date)}</p>
              <p className="text-xs text-gray-600">{dayTitle(pickedDay)}</p>
              <DayAttendanceEdit employeeId={row.id} date={pickedDay.date} accent={KIND_ACCENT[kind]} />
            </section>
          ) : (
            <p className="text-xs text-gray-500">Pick a day on the calendar to see its punches or change it.</p>
          )}
        </div>
      )}
    </div>
  );
}
