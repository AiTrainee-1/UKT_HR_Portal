import type { ReactNode } from "react";
import {
  AlertTriangle,
  CalendarDays,
  CalendarX2,
  Clock,
  FileText,
  History,
  Phone,
  ShieldCheck,
  UserX,
  type LucideIcon,
} from "lucide-react";
import { Avatar, Chip, EmptyNote } from "@/components/payroll/kit/parts";
import { dateShort, dateTime } from "@/components/payroll/kit/format";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useInvestigationDetail,
  type InvestigationDetail,
  type InvestigationRow,
  type InvestigationSettings,
} from "@/lib/api-client/custom-hooks/employee-investigation";
import { REQUEST_STATUS_TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import {
  DAY_KIND_META,
  DAY_KIND_ORDER,
  NO_DATA_HELP,
  autoChip,
  calendarMonths,
  dayCount,
  dayKindCounts,
  dayLabel,
  decisionText,
  errorText,
  lastAttendedText,
  leaveRange,
  leaveText,
  plural,
  requestStatusLabel,
} from "./logic";
import { EmployeeStatusChip, InfoTip, KindChip } from "./parts";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/**
 * Leave details: one employee's absence in a sheet. The figures, a calendar of the days away coloured by kind (approved
 * leave, holidays, Sundays, no-data days, leave asked but not approved, away) with a legend, their leave and casual leave
 * requests with status, the last punches and every decision about them. Keep active / Mark inactive from here too.
 */
export function DetailSheet({
  employeeId,
  settings,
  canEdit,
  onKeep,
  onInactivate,
  onClose,
}: {
  /** null = closed. */
  employeeId: number | null;
  settings: InvestigationSettings | undefined;
  canEdit: boolean;
  onKeep: (row: InvestigationRow) => void;
  onInactivate: (row: InvestigationRow) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={employeeId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl" data-testid="inv-detail">
        {employeeId !== null && (
          <DetailBody
            key={employeeId}
            employeeId={employeeId}
            settings={settings}
            canEdit={canEdit}
            onKeep={onKeep}
            onInactivate={onInactivate}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function Section({
  title,
  icon: Icon,
  children,
  testId,
}: {
  title: string;
  icon: LucideIcon;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="space-y-2" data-testid={testId} aria-label={title}>
      <h3 className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
        <Icon size={14} className="text-gray-500" /> {title}
      </h3>
      {children}
    </section>
  );
}

function Figure({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-[11px] font-medium text-gray-500">{label}</p>
      <p className="text-base font-black leading-tight tabular-nums text-gray-900">{value}</p>
      {sub && <div className="mt-0.5 text-[11px] leading-snug text-gray-500">{sub}</div>}
    </div>
  );
}

function DetailBody({
  employeeId,
  settings,
  canEdit,
  onKeep,
  onInactivate,
}: {
  employeeId: number;
  settings: InvestigationSettings | undefined;
  canEdit: boolean;
  onKeep: (row: InvestigationRow) => void;
  onInactivate: (row: InvestigationRow) => void;
}) {
  const query = useInvestigationDetail(employeeId);
  const data = query.data;

  if (query.isLoading) {
    return (
      <div className="space-y-3 px-5 pt-5 sm:px-6" data-testid="inv-detail-loading" aria-busy="true">
        <SheetTitle className="sr-only">Leave details</SheetTitle>
        <SheetDescription className="sr-only">Loading the employee&apos;s absence</SheetDescription>
        <Skeleton className="h-11 w-2/3 rounded-xl" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
    );
  }
  if (query.isError || !data) {
    return (
      <div className="px-5 pt-5 sm:px-6">
        <SheetTitle className="sr-only">Leave details</SheetTitle>
        <SheetDescription className="sr-only">The absence could not be loaded</SheetDescription>
        <EmptyNote
          icon={AlertTriangle}
          title="The leave details could not be loaded"
          hint={errorText(query.error)}
          testId="inv-detail-error"
        />
      </div>
    );
  }
  return (
    <DetailContent data={data} settings={settings} canEdit={canEdit} onKeep={onKeep} onInactivate={onInactivate} />
  );
}

function DetailContent({
  data,
  settings,
  canEdit,
  onKeep,
  onInactivate,
}: {
  data: InvestigationDetail;
  settings: InvestigationSettings | undefined;
  canEdit: boolean;
  onKeep: (row: InvestigationRow) => void;
  onInactivate: (row: InvestigationRow) => void;
}) {
  const emp = data.employee;
  const attended = lastAttendedText(emp);
  const chip = autoChip(emp, settings);
  const months = calendarMonths(data.calendar);
  const counts = dayKindCounts(data.calendar);
  const truncated = !!data.calendarFrom && !!emp.awayFrom && data.calendarFrom > emp.awayFrom;
  const actionable = emp.status === "active" && emp.bucket !== null;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 pb-6 pt-5 sm:px-6" data-testid="inv-detail-body">
        <SheetHeader className="space-y-3 pb-4 text-left">
          <div className="flex items-start gap-3 pr-8">
            <Avatar name={emp.name} size={44} />
            <div className="min-w-0 flex-1">
              <SheetTitle className="flex flex-wrap items-center gap-1.5 text-base">
                <span className="truncate">{emp.name}</span>
                <KindChip kind={emp.kind} />
                <EmployeeStatusChip status={emp.status} />
              </SheetTitle>
              <SheetDescription className="text-xs">
                <span className="font-mono">{emp.code}</span>
                {emp.department && <> · {emp.department}</>}
                {emp.designation && <> · {emp.designation}</>}
                {emp.unit && <> · {emp.unit}</>}
              </SheetDescription>
              {emp.phone && (
                <a
                  href={`tel:${emp.phone}`}
                  className="mt-1 inline-flex items-center gap-1 rounded text-xs text-indigo-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Phone size={12} aria-hidden /> {emp.phone}
                </a>
              )}
            </div>
          </div>
        </SheetHeader>

        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="inv-detail-figures">
            <Figure
              label="Away"
              value={dayCount(emp.absentDays)}
              sub={emp.awayFrom ? `since ${dateShort(emp.awayFrom)}` : "Not away"}
            />
            <Figure
              label="Calendar days"
              value={emp.calendarDays}
              sub={
                emp.noDataDays > 0 ? (
                  <InfoTip label={`${plural(emp.noDataDays, "no-data day")} left out`} text={NO_DATA_HELP} />
                ) : (
                  "No no-data days"
                )
              }
            />
            <Figure label="Last attended" value={attended.main} sub={attended.note} />
            <Figure
              label="Approved leave"
              value={leaveText(emp)}
              sub={emp.coveredByLeave ? "Covers every working day" : null}
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5" data-testid="inv-detail-auto">
            {emp.keptActive && (
              <Chip tone="success" icon={ShieldCheck}>
                Kept active for this absence
              </Chip>
            )}
            {chip && (
              <Chip tone={chip.tone} icon={AlertTriangle} title={chip.title}>
                {chip.label}
              </Chip>
            )}
            {!emp.autoTonight && emp.autoWhyNot && !emp.keptActive && (
              <p className="text-xs text-gray-500">{emp.autoWhyNot}</p>
            )}
          </div>

          <Section title="The absence, day by day" icon={CalendarDays} testId="inv-detail-calendar">
            {months.length === 0 ? (
              <p className="text-xs text-gray-500">Nothing to show: the employee is not away at the moment.</p>
            ) : (
              <>
                {truncated && (
                  <p className="text-xs text-gray-500" data-testid="inv-detail-truncated">
                    The last 120 days are shown, from {dateShort(data.calendarFrom)}.
                  </p>
                )}
                <div className="space-y-3">
                  {months.map((m) => (
                    <div key={m.key} role="group" aria-label={m.label} className="space-y-1">
                      <p className="text-xs font-semibold text-gray-700">{m.label}</p>
                      <div className="grid grid-cols-7 gap-1" aria-hidden>
                        {WEEKDAYS.map((w) => (
                          <div key={w} className="text-center text-[10px] font-semibold uppercase text-gray-400">
                            {w}
                          </div>
                        ))}
                      </div>
                      <ul className="grid grid-cols-7 gap-1">
                        {m.cells.map((d, i) =>
                          d ? (
                            <li
                              key={d.date}
                              title={dayLabel(d)}
                              aria-label={dayLabel(d)}
                              className={cn(
                                "flex h-9 items-center justify-center rounded-lg text-xs font-semibold sm:h-10",
                                DAY_KIND_META[d.kind]?.cell ?? "bg-gray-100 text-gray-600",
                              )}
                              data-testid={`inv-day-${d.date}`}
                              data-kind={d.kind}
                            >
                              {Number(d.date.slice(8, 10))}
                            </li>
                          ) : (
                            <li key={`blank-${i}`} aria-hidden className="h-9 sm:h-10" />
                          ),
                        )}
                      </ul>
                    </div>
                  ))}
                </div>
                <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600" aria-label="Legend">
                  {DAY_KIND_ORDER.map((k) => (
                    <li key={k} className="inline-flex items-center gap-1" data-testid={`inv-legend-${k}`}>
                      <span className={cn("h-2.5 w-2.5 rounded-sm", DAY_KIND_META[k].dot)} aria-hidden />
                      {DAY_KIND_META[k].label}
                      <span className="tabular-nums text-gray-400">({counts[k]})</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          <Section title="Leave requests" icon={FileText} testId="inv-detail-leaves">
            {data.leaves.length === 0 ? (
              <p className="text-xs text-gray-500">No leave asked for these days.</p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {data.leaves.map((l) => (
                  <li key={l.id} className="space-y-0.5 px-3 py-2 text-xs" data-testid="inv-detail-leave">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900">
                        {l.type} · {leaveRange(l.from, l.to)}
                        {l.days !== null && (
                          <span className="font-normal text-gray-500"> ({plural(l.days, "day")})</span>
                        )}
                        {l.halfDay && <span className="font-normal text-gray-500"> · half day</span>}
                      </p>
                      <Chip tone={REQUEST_STATUS_TONE[l.status] ?? "neutral"}>{requestStatusLabel(l.status)}</Chip>
                    </div>
                    {l.reason && <p className="text-gray-600">{l.reason}</p>}
                    {l.decidedBy && <p className="text-gray-400">Decided by {l.decidedBy}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Casual leave" icon={CalendarX2} testId="inv-detail-casual">
            {data.casualLeaves.length === 0 ? (
              <p className="text-xs text-gray-500">No casual leave asked for these days.</p>
            ) : (
              <ul className="divide-y rounded-xl border">
                {data.casualLeaves.map((c) => (
                  <li key={c.id} className="space-y-0.5 px-3 py-2 text-xs" data-testid="inv-detail-cl">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-semibold text-gray-900">
                        {dateShort(c.date)}
                        {c.portion && (
                          <span className="font-normal text-gray-500"> · {c.portion.replace(/_/g, " ")}</span>
                        )}
                      </p>
                      <Chip tone={REQUEST_STATUS_TONE[c.status] ?? "neutral"}>{requestStatusLabel(c.status)}</Chip>
                    </div>
                    {c.reason && <p className="text-gray-600">{c.reason}</p>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Last punches" icon={Clock} testId="inv-detail-punches">
            {data.punches.length === 0 ? (
              <p className="text-xs text-gray-500">No punch ever recorded for this employee.</p>
            ) : (
              <ul className="grid grid-cols-1 gap-1 text-xs min-[420px]:grid-cols-2">
                {data.punches.map((p, i) => (
                  <li
                    key={`${p.date}-${p.time}-${i}`}
                    className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-2.5 py-1.5"
                  >
                    <span className="font-semibold text-gray-800">
                      {dateShort(p.date)} <span className="tabular-nums">{p.time}</span>
                    </span>
                    {p.source && <span className="text-gray-400">{p.source}</span>}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section title="Decisions" icon={History} testId="inv-detail-decisions">
            {data.decisions.length === 0 ? (
              <p className="text-xs text-gray-500">No decision about this employee yet.</p>
            ) : (
              <ol className="space-y-1.5">
                {data.decisions.map((d) => (
                  <li key={d.id} className="rounded-lg border px-3 py-2 text-xs" data-testid="inv-detail-decision">
                    <p className="text-gray-800">{decisionText(d)}</p>
                    <p className="text-gray-400">
                      {dateTime(d.at)} · away {dayCount(d.absentDays)}
                      {d.lastAttended ? ` · last attended ${dateShort(d.lastAttended)}` : ""}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </div>
      {actionable && (
        <div className="flex flex-wrap justify-end gap-2 border-t bg-white px-5 py-3 sm:px-6">
          <Button
            variant="outline"
            className="gap-1.5 text-emerald-700"
            onClick={() => onKeep(emp)}
            disabled={!canEdit}
            title={canEdit ? undefined : "Needs edit rights on this page"}
            data-testid="inv-detail-keep"
          >
            <ShieldCheck size={14} /> Keep active
          </Button>
          <Button
            variant="outline"
            className="gap-1.5 text-red-700"
            onClick={() => onInactivate(emp)}
            disabled={!canEdit}
            title={canEdit ? undefined : "Needs edit rights on this page"}
            data-testid="inv-detail-inactivate"
          >
            <UserX size={14} /> Mark inactive
          </Button>
        </div>
      )}
    </>
  );
}
