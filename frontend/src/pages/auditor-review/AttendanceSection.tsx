import { useState, type ReactNode } from "react";
import { CalendarDays, Clock, Eye, Info } from "lucide-react";
import { LeaveCalendarDialog } from "@/components/leave-calendar/LeaveCalendar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { LeaveChip } from "@/pages/hr/settlement/LeaveChip";
import { earnedPeriodLabel, workingDaysText } from "@/pages/hr/settlement/logic";
import { Chip } from "@/pages/hr/settlement/parts";
import { earnedRange, ordinal } from "@/pages/hr/settlement/rules";
import { MONTH_FULL, formatDate, formatMoney } from "@/pages/hr/settlement/shared";
import { fetchLeaveCalendar, useTimecard, type PortalData, type PortalItem, type TimeCardDay } from "./api";
import { dayMarks, dayStatusLabel, inCountedDays, portalProblem, settlementThroughDay, summaryTiles } from "./logic";
import { CARD, FOCUS, HEADING_FONT, Tile } from "./parts";

const HEAD =
  "sticky top-0 z-10 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-3 text-left text-xs font-medium text-slate-500";
const CELL = "border-b border-slate-100 px-3 py-3 align-top";

const STATUS_TONE: Record<string, "success" | "danger" | "warning" | "info" | "neutral"> = {
  present: "success",
  absent: "danger",
  half_shift: "warning",
  on_leave: "info",
  holiday: "neutral",
};

function DayRow({ day, throughDay }: { day: TimeCardDay; throughDay: number | null }) {
  const marks = dayMarks(day);
  const counted = inCountedDays(day, throughDay);
  return (
    <tr
      className={cn(
        day.isSunday && "bg-slate-50",
        !counted && "text-slate-500",
        day.status === "absent" && counted && "bg-rose-50/60",
      )}
      data-testid={`timecard-day-${day.date}`}
    >
      <td className={cn(CELL, "whitespace-nowrap font-medium")}>{formatDate(day.date)}</td>
      <td className={CELL}>{day.day}</td>
      <td className={CELL}>
        <Chip tone={day.inProgress ? "info" : (STATUS_TONE[day.status] ?? "neutral")}>{dayStatusLabel(day)}</Chip>
        {day.holidayName && <p className="mt-0.5 text-[11px] text-slate-600">{day.holidayName}</p>}
        {day.isSunday && !day.holidayName && <p className="mt-0.5 text-[11px] text-slate-500">Sunday</p>}
      </td>
      <td className={cn(CELL, "tabular-nums")}>{day.firstPunch ?? "-"}</td>
      <td className={cn(CELL, "tabular-nums")}>{day.lastPunch ?? "-"}</td>
      <td className={cn(CELL, "text-right tabular-nums")}>{day.shiftsEarned}</td>
      <td className={CELL}>
        {marks.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {marks.map((m) => (
              <Chip key={m} tone="warning">
                {m}
              </Chip>
            ))}
          </div>
        ) : (
          <span className="text-slate-300">-</span>
        )}
      </td>
    </tr>
  );
}

/** One employee's time card for the settlement's month: every day, the month's counts, the 1st-20th figures and the
 *  leave check. Read only when asked for. */
function TimeCardDialog({ token, item, onClose }: { token: string; item: PortalItem | null; onClose: () => void }) {
  const card = useTimecard(token, item?.id ?? null);
  const data = card.data;
  const e = data?.earnings;
  return (
    <Dialog open={!!item} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto bg-white" data-testid="timecard-dialog">
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="text-[17px] font-bold text-slate-900" style={{ fontFamily: HEADING_FONT }}>
            Time card · {item?.advance.employeeName} ({item?.advance.employeeCode})
          </DialogTitle>
          <DialogDescription>
            {data
              ? `${MONTH_FULL[data.month - 1]} ${data.year}${data.employee.department ? ` · ${data.employee.department}` : ""}${
                  data.employee.designation ? ` · ${data.employee.designation}` : ""
                }`
              : "The month's attendance, day by day."}
          </DialogDescription>
        </DialogHeader>
        {card.isLoading ? (
          <div className="space-y-2" data-testid="timecard-loading">
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : card.isError || !data ? (
          <p
            className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800"
            role="alert"
            data-testid="timecard-error"
          >
            {portalProblem(card.error).kind === "unavailable"
              ? "The time card could not be loaded. Try again in a moment."
              : portalProblem(card.error).text}
          </p>
        ) : (
          <div className="space-y-4" data-testid="timecard">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-slate-600">
              {data.shift && (
                <span className="inline-flex items-center gap-1" data-testid="timecard-shift">
                  <Clock size={12} aria-hidden /> {data.shift.name}
                  {data.shift.startTime && data.shift.endTime ? ` (${data.shift.startTime}-${data.shift.endTime})` : ""}
                </span>
              )}
              {data.employee.joinDate && (
                <span className="inline-flex items-center gap-1">
                  <CalendarDays size={12} aria-hidden /> Joined {formatDate(data.employee.joinDate)}
                </span>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="timecard-summary">
              {summaryTiles(data).map((t) => (
                <Tile key={t.label} label={t.label} value={t.value} />
              ))}
            </div>
            <div className="grid gap-3 md:grid-cols-[1fr_auto]">
              <div
                className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-[12px]"
                data-testid="timecard-earned"
              >
                {e ? (
                  <>
                    <p className="mb-1 font-semibold text-slate-700">Earned in {earnedPeriodLabel(e)}</p>
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-4">
                      <div>
                        <dt className="text-slate-500">Fixed salary</dt>
                        <dd className="font-semibold tabular-nums">{formatMoney(e.fixedSalary)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Working days</dt>
                        <dd className="font-semibold tabular-nums">{workingDaysText(e)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Earned salary</dt>
                        <dd className="font-semibold tabular-nums">{formatMoney(e.earnedAmount)}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Limit ({e.percent}%)</dt>
                        <dd className="font-semibold tabular-nums">{e.limit != null ? formatMoney(e.limit) : "-"}</dd>
                      </div>
                    </dl>
                  </>
                ) : (
                  <p className="text-slate-500">No earned-salary figures for this request.</p>
                )}
              </div>
              <div className="flex items-center rounded-xl border border-slate-200 bg-white p-3">
                <LeaveChip check={data.leaveCheck} showOk testId="timecard-leave" />
                {!data.leaveCheck && <span className="text-[12px] text-slate-400">No leave check</span>}
              </div>
            </div>
            <div className="relative max-h-[50vh] overflow-auto rounded-xl border border-slate-200">
              <table
                className="w-full min-w-[40rem] border-separate border-spacing-0 text-[12.5px]"
                data-testid="timecard-days"
              >
                <thead>
                  <tr>
                    <th className={HEAD}>Date</th>
                    <th className={HEAD}>Day</th>
                    <th className={HEAD}>Status</th>
                    <th className={HEAD}>First punch</th>
                    <th className={HEAD}>Last punch</th>
                    <th className={cn(HEAD, "text-right")}>Shifts</th>
                    <th className={HEAD}>Marks</th>
                  </tr>
                </thead>
                <tbody>
                  {data.days.map((day) => (
                    <DayRow key={day.date} day={day} throughDay={data.earnings?.throughDay ?? null} />
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[11px] text-slate-500">
              {data.earnings?.throughDay
                ? `The ${earnedRange(data.earnings.throughDay)} count for the earned salary and the leave check; later days are shown in grey.`
                : "The days counted for the earned salary and the leave check are shown in full; later days in grey."}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Attendance & Time Card: the settlement's employees with their working days and earned salary of the 1st-20th and the
 * leave check (it opens the employee's leave calendar); View Details opens an employee's time card for the month.
 * Nothing to download here.
 */
export default function AttendanceSection({ data, token }: { data: PortalData; token: string }) {
  const [open, setOpen] = useState<PortalItem | null>(null);
  const [leaveFor, setLeaveFor] = useState<PortalItem | null>(null);
  const through = settlementThroughDay(data);

  const leave = (item: PortalItem, testId: string): ReactNode => (
    <button
      type="button"
      onClick={() => setLeaveFor(item)}
      className={cn(
        "group/leave inline-flex items-center gap-1.5 rounded-full py-0.5 pr-1.5 hover:bg-slate-100",
        FOCUS,
        "focus-visible:ring-offset-1",
      )}
      title="Open the leave calendar"
      data-testid={`${testId}-btn`}
    >
      {item.advance.leaveCheck ? (
        <LeaveChip check={item.advance.leaveCheck} showOk testId={testId} />
      ) : (
        <span className="pl-1.5 text-[12px] font-medium text-slate-500">View</span>
      )}
      <CalendarDays size={13} className="shrink-0 text-slate-400 group-hover/leave:text-[#006496]" aria-hidden />
      <span className="sr-only">, open {item.advance.employeeName}&apos;s leave calendar</span>
    </button>
  );
  const viewButton = (item: PortalItem, testId: string, className?: string) => (
    <Button
      size="sm"
      variant="outline"
      className={cn("h-8 gap-1.5 text-xs font-semibold text-[#006496] hover:bg-[#006496]/5", className)}
      onClick={() => setOpen(item)}
      aria-label={`View ${item.advance.employeeName}'s time card`}
      data-testid={testId}
    >
      <Eye size={13} aria-hidden /> View Details
    </Button>
  );

  return (
    <div className="space-y-4" data-testid="portal-attendance">
      <div className="flex items-start gap-2.5 rounded-2xl border border-[#006496]/15 bg-[#006496]/[0.04] px-4 py-3 text-[13px] text-slate-700">
        <Info size={16} className="mt-0.5 shrink-0 text-[#006496]" aria-hidden />
        <p>
          The attendance behind each request: the working days and the salary earned from the 1st
          {through ? ` to the ${ordinal(through)}` : ""} of {data.settlement.period}, and the leave check (orange for 3
          days of leave, red for more). View Details shows the employee&apos;s time card for the month.
        </p>
      </div>

      <section className={cn(CARD, "overflow-hidden")} aria-labelledby="portal-attendance-heading">
        <div className="border-b border-slate-100 px-4 py-3.5 sm:px-5">
          <h2
            id="portal-attendance-heading"
            className="text-[15px] font-bold text-slate-900"
            style={{ fontFamily: HEADING_FONT }}
          >
            Attendance &amp; Time Card
          </h2>
          <p className="text-[12.5px] text-slate-500">
            {data.items.length} {data.items.length === 1 ? "employee" : "employees"} · {data.settlement.period}
          </p>
        </div>

        {/* tablets and wide screens: the table */}
        <div className="relative hidden max-h-[min(72vh,52rem)] overflow-auto md:block">
          <table
            className="w-full min-w-[44rem] border-separate border-spacing-0 text-[13px] text-slate-800"
            data-testid="portal-attendance-table"
          >
            <thead>
              <tr>
                <th className={HEAD}>Employee Code</th>
                <th className={HEAD}>Employee</th>
                <th className={HEAD}>Department</th>
                <th className={cn(HEAD, "text-right")}>Working Days{through ? ` (${earnedRange(through)})` : ""}</th>
                <th className={cn(HEAD, "text-right")}>Earned Salary</th>
                <th className={HEAD}>Leave check</th>
                <th className={cn(HEAD, "text-right")}>Time card</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((item) => {
                const a = item.advance;
                const e = a.earnings;
                return (
                  <tr key={item.id} className="hover:bg-slate-50/70" data-testid={`portal-att-row-${item.id}`}>
                    <td className={cn(CELL, "font-mono text-[12px] text-slate-700")}>{a.employeeCode}</td>
                    <td className={cn(CELL, "font-semibold text-slate-900")}>{a.employeeName}</td>
                    <td className={cn(CELL, "text-slate-700")}>{a.employeeDepartment ?? "-"}</td>
                    <td className={cn(CELL, "text-right tabular-nums")}>{e ? workingDaysText(e) : "-"}</td>
                    <td className={cn(CELL, "text-right tabular-nums")}>{e ? formatMoney(e.earnedAmount) : "-"}</td>
                    <td className={CELL}>{leave(item, `portal-att-leave-${item.id}`)}</td>
                    <td className={cn(CELL, "text-right")}>{viewButton(item, `portal-timecard-${item.id}`)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* phones: a card per employee */}
        <div className="space-y-3 bg-slate-50/60 p-3 md:hidden" data-testid="portal-attendance-cards">
          {data.items.map((item) => {
            const a = item.advance;
            const e = a.earnings;
            return (
              <article
                key={item.id}
                className="space-y-3 rounded-2xl border border-slate-200 bg-white p-3.5"
                aria-label={`${a.employeeName}, ${a.employeeCode}`}
                data-testid={`portal-att-card-${item.id}`}
              >
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900">{a.employeeName}</p>
                  <p className="text-[12px] text-slate-500">
                    <span className="font-mono">{a.employeeCode}</span>
                    {a.employeeDepartment ? ` · ${a.employeeDepartment}` : ""}
                  </p>
                </div>
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl bg-slate-50 px-3 py-2.5 text-[12.5px]">
                  <div>
                    <dt className="text-[11px] font-medium text-slate-500">Working days</dt>
                    <dd className="font-medium tabular-nums">{e ? workingDaysText(e) : "-"}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium text-slate-500">Earned salary</dt>
                    <dd className="font-medium tabular-nums">{e ? formatMoney(e.earnedAmount) : "-"}</dd>
                  </div>
                </dl>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {leave(item, `portal-att-card-leave-${item.id}`)}
                  {viewButton(item, `portal-att-card-timecard-${item.id}`)}
                </div>
              </article>
            );
          })}
        </div>
      </section>
      <p className="text-[11.5px] text-slate-500">
        Working days are the paid days: present shifts and company holidays.
      </p>
      <TimeCardDialog token={token} item={open} onClose={() => setOpen(null)} />
      <LeaveCalendarDialog
        open={leaveFor !== null}
        onClose={() => setLeaveFor(null)}
        load={() => fetchLeaveCalendar(token, leaveFor?.id ?? 0)}
        title={leaveFor ? `${leaveFor.advance.employeeName} (${leaveFor.advance.employeeCode})` : undefined}
      />
    </div>
  );
}
