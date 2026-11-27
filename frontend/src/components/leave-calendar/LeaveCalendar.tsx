import { useEffect, useState } from "react";
import { CalendarDays, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { calendarWeeks, type CalendarDay } from "@/pages/hr/casual-leave/carry-forward";
import { cn } from "@/lib/utils";

/**
 * The Leave calendar of a Salary Advance / Term Loan request (owner 2026-11-27): the month the request was raised in, Monday
 * first, with the leave days of the 1st-Nth in RED - the same grid, week helper and look as the Casual Leave Carry
 * Forward calendar (casual-leave/DetectPanel.tsx, carry-forward.ts calendarWeeks), read-only. Every day after the counted
 * days is greyed out. Shared by the HRMS Loan & Advance pages, the MD portal and the Auditor Review Portal: each passes
 * its own `load` (GET /api/advances/<id>/leave-calendar, /api/md/settlement/items/<id>/leave-calendar,
 * /api/auditor-review/<token>/leave/<item id>), all answering `LeaveCalendarData`.
 */

export type LeaveDayKind = "absent" | "on_leave" | "half_day_leave";

export interface LeaveCalendarData {
  employee: { code: string; name: string };
  month: number;
  year: number;
  throughDay: number;
  days: { date: string; kind: LeaveDayKind; label: string; weight: number }[];
  holidays: { date: string; name: string }[];
  total: number;
  flag: "ok" | "warning" | "critical" | null;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Cell = CalendarDay & { kind: LeaveDayKind | "holiday" | "sunday" | "counted" | "after" };

/** Every day of the month as a calendar cell: leave days, holidays, Sundays, the other counted days, then the days after
 *  the counted period. */
export function leaveCells(data: LeaveCalendarData): Cell[] {
  const last = new Date(data.year, data.month, 0).getDate();
  const leave = new Map(data.days.map((d) => [d.date, d]));
  const holidays = new Map(data.holidays.map((h) => [h.date, h.name]));
  const out: Cell[] = [];
  for (let n = 1; n <= last; n += 1) {
    const date = `${data.year}-${String(data.month).padStart(2, "0")}-${String(n).padStart(2, "0")}`;
    const weekday = WEEKDAYS[new Date(data.year, data.month - 1, n).getDay()];
    const l = leave.get(date);
    const holiday = holidays.get(date);
    let kind: Cell["kind"];
    let label: string;
    if (l) {
      kind = l.kind;
      label = l.label;
    } else if (holiday) {
      kind = "holiday";
      label = holiday;
    } else if (weekday === "Sunday") {
      kind = "sunday";
      label = "Sunday";
    } else if (n <= data.throughDay) {
      kind = "counted";
      label = "Not leave";
    } else {
      kind = "after";
      label = `After the ${data.throughDay}th: not counted`;
    }
    out.push({ date, weekday, status: "none", selectable: false, label, kind });
  }
  return out;
}

const CELL: Record<Cell["kind"], string> = {
  absent: "border-red-300 bg-red-500 text-white",
  on_leave: "border-red-300 bg-red-500 text-white",
  half_day_leave: "border-red-300 bg-[linear-gradient(90deg,#ef4444_50%,#fee2e2_50%)] text-red-950",
  holiday: "border-transparent bg-slate-100 text-slate-500",
  sunday: "border-transparent bg-slate-100 text-slate-400",
  counted: "border-gray-100 bg-white text-gray-600",
  after: "border-transparent bg-transparent text-slate-300",
};
const MARK: Partial<Record<Cell["kind"], string>> = {
  absent: "Absent",
  on_leave: "Leave",
  half_day_leave: "½ leave",
  holiday: "Holiday",
  sunday: "Off",
};

export function LeaveMonthCalendar({ data, testId = "leave-calendar" }: { data: LeaveCalendarData; testId?: string }) {
  const cells = leaveCells(data);
  return (
    <div className="rounded-2xl border border-gray-100 bg-white p-2.5 shadow-sm" data-testid={testId}>
      <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[10px] font-bold uppercase tracking-wider text-[#006496]/60">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="space-y-1">
        {calendarWeeks(cells).map((week, w) => (
          <div key={w} className="grid grid-cols-7 gap-1">
            {week.map((cell, i) => {
              if (!cell) return <span key={`blank-${w}-${i}`} />;
              const c = cell as Cell;
              const n = Number(c.date.slice(8, 10));
              return (
                <span
                  key={c.date}
                  title={`${c.weekday} ${n}: ${c.label}`}
                  aria-label={`${c.weekday} ${n}: ${c.label}`}
                  className={cn(
                    "flex aspect-[5/4] flex-col items-center justify-center rounded-lg border text-xs font-semibold tabular-nums",
                    CELL[c.kind],
                  )}
                  data-kind={c.kind}
                  data-testid={`${testId}-${c.date}`}
                >
                  {n}
                  {MARK[c.kind] && <span className="text-[9px] font-bold leading-none">{MARK[c.kind]}</span>}
                </span>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 border-t border-gray-50 pt-2 text-[10px] text-gray-500">
        {[
          ["bg-red-500", "Leave (absent or on leave)"],
          ["bg-[linear-gradient(90deg,#ef4444_50%,#fee2e2_50%)]", "Half-day leave"],
          ["bg-slate-300", "Sunday / holiday"],
          ["bg-white ring-1 ring-gray-200", `1st–${data.throughDay}th: counted`],
        ].map(([dot, text]) => (
          <span key={text} className="inline-flex items-center gap-1">
            <span className={cn("h-2 w-2 rounded-full", dot)} aria-hidden />
            {text}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The dialog the Leave column opens: loads the calendar with `load` and shows it. */
export function LeaveCalendarDialog({
  open,
  onClose,
  load,
  title,
}: {
  open: boolean;
  onClose: () => void;
  load: () => Promise<LeaveCalendarData>;
  title?: string;
}) {
  const [data, setData] = useState<LeaveCalendarData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setData(null);
    setError(null);
    load()
      .then((d) => live && setData(d))
      .catch(() => live && setError("The leave calendar could not be loaded. Try again."));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reloads each time the dialog opens
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md" data-testid="leave-calendar-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarDays size={18} aria-hidden /> {title ?? data?.employee.name ?? "Leave calendar"}
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${MONTHS[data.month - 1]} ${data.year} · leave in the 1st–${data.throughDay}th: ${data.total} ${
                  data.total === 1 ? "day" : "days"
                } (absent and approved leave; Casual Leave, Sundays and holidays never count)`
              : "Leave in the counted days of the month the request was raised in."}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-red-600" data-testid="leave-calendar-error">
            {error}
          </p>
        ) : !data ? (
          <div className="flex items-center justify-center py-10 text-gray-400">
            <Loader2 className="animate-spin" size={20} aria-label="Loading" />
          </div>
        ) : (
          <LeaveMonthCalendar data={data} />
        )}
      </DialogContent>
    </Dialog>
  );
}
