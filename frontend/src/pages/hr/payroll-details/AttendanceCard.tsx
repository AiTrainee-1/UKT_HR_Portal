import { useMemo, useState } from "react";
import { CalendarDays, CalendarRange, ListFilter, Table2, X } from "lucide-react";
import {
  CompensationChip,
  CompensationLegend,
  CompensationSymbol,
  compensationMark,
  countMarks,
} from "@/components/attendance-compensation";
import { Button } from "@/components/ui/button";
import { dateLong, dayMonth, dateShort, weekdayShort } from "@/components/payroll/kit/format";
import { ISSUE_META, SEVERITY_META, issueLabel } from "@/components/payroll/kit/issue-meta";
import { EmptyNote, IssueChip, SectionCard } from "@/components/payroll/kit/parts";
import type { PayrollDay, PayrollDetails, PayrollIssue, PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { FilterSelect, SegmentedToggle, ToggleChip } from "./parts";
import {
  CALENDAR_HEADERS,
  DAY_KINDS,
  DAY_KIND_META,
  buildCalendar,
  dayKind,
  filterDays,
  kindCounts,
  sectionDomId,
  statusLabel,
  trimNumber,
  type CalendarCell,
  type DayKind,
} from "./logic";

type View = "calendar" | "table";

const timeText = (t: string | null | undefined): string => (t ? t.slice(0, 5) : "—");

/** The punches of a day in a few characters: "09:02–18:07", "in 09:02" (no last out), "out 18:07", or nothing. */
function punchText(day: Pick<PayrollDay, "firstIn" | "lastOut">): string {
  if (day.firstIn && day.lastOut) return `${timeText(day.firstIn)}–${timeText(day.lastOut)}`;
  if (day.firstIn) return `in ${timeText(day.firstIn)}`;
  if (day.lastOut) return `out ${timeText(day.lastOut)}`;
  return "";
}

const flagDot = (code: string): string => {
  const severity = ISSUE_META[code as keyof typeof ISSUE_META]?.severity;
  return severity ? SEVERITY_META[severity].dot : "bg-slate-400";
};

/**
 * The days of the payroll's period: a calendar (a coloured cell per day, with the punches and a dot for every flag) or
 * a table. The legend doubles as a filter, "Flagged only" narrows to days something was flagged on, and choosing a day
 * shows what happened on it and narrows the Issues list to it.
 */
export function AttendanceCard({
  details,
  kind: payrollKind,
  accent,
  selectedDay,
  onSelectDay,
  onShowIssues,
}: {
  details: PayrollDetails;
  kind: PayrollKind;
  accent: Accent;
  selectedDay: string | null;
  onSelectDay: (date: string | null) => void;
  onShowIssues: () => void;
}) {
  const [view, setView] = useState<View>("calendar");
  const [kindFilter, setKindFilter] = useState<DayKind | "all">("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  const { days, period } = details;
  const counts = useMemo(() => kindCounts(days), [days]);
  const flaggedCount = useMemo(() => days.filter((d) => (d.flags ?? []).length > 0).length, [days]);
  const weeks = useMemo(() => buildCalendar(days, period.start, period.end), [days, period.start, period.end]);
  // days of the period with no record: staff payroll only lists the working days, so a weekly off or a holiday is one
  const noRecord = useMemo(
    () => weeks.flat().filter((cell) => cell.type === "day" && cell.day === null).length,
    [weeks],
  );
  const rows = useMemo(() => filterDays(days, { kind: kindFilter, flaggedOnly }), [days, kindFilter, flaggedOnly]);
  const visible = useMemo(() => new Set(rows.map((d) => d.date)), [rows]);
  const filtering = kindFilter !== "all" || flaggedOnly;
  const monthsShown = useMemo(() => new Set(days.map((d) => d.date.slice(0, 7))).size, [days]);

  const day = selectedDay ? (days.find((d) => d.date === selectedDay) ?? null) : null;
  const dayIssues = useMemo(
    () => (selectedDay ? details.issues.filter((i) => i.date === selectedDay) : []),
    [details.issues, selectedDay],
  );

  return (
    <SectionCard
      id={sectionDomId("attendance")}
      testId="pd-section-attendance"
      className="scroll-mt-16"
      icon={CalendarRange}
      title={payrollKind === "production" ? "Shifts in this period" : "Attendance this month"}
      description={`${period.label}: what each day was counted as, with the first and last punch and anything flagged on it.`}
      actions={
        days.length > 0 && (
          <SegmentedToggle<View>
            label="Show the days as"
            value={view}
            onChange={setView}
            activeClass={accent.solid}
            className="print:hidden"
            testId="pd-attendance-view"
            items={[
              {
                value: "calendar",
                label: (
                  <>
                    <CalendarDays size={13} /> Calendar
                  </>
                ),
                testId: "pd-view-calendar",
              },
              {
                value: "table",
                label: (
                  <>
                    <Table2 size={13} /> Table
                  </>
                ),
                testId: "pd-view-table",
              },
            ]}
          />
        )
      }
    >
      {days.length === 0 ? (
        <EmptyNote
          icon={CalendarDays}
          title="No day records were stored for this payroll"
          hint="Payroll draws this calendar from the day-by-day breakdown it stores; this one has none."
          testId="pd-attendance-empty"
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 print:hidden" data-testid="pd-attendance-toolbar">
            {view === "calendar" ? (
              <div
                className="flex flex-wrap items-center gap-1.5"
                role="group"
                aria-label="Legend: choose a kind of day to focus on"
              >
                {DAY_KINDS.filter((k) => counts[k] > 0).map((k) => (
                  <ToggleChip
                    key={k}
                    pressed={kindFilter === k}
                    onClick={() => setKindFilter(kindFilter === k ? "all" : k)}
                    testId={`pd-legend-${k}`}
                  >
                    <span className={cn("h-2.5 w-2.5 rounded-sm", DAY_KIND_META[k].swatch)} />
                    {DAY_KIND_META[k].label}
                    <span className="tabular-nums opacity-70">{counts[k]}</span>
                  </ToggleChip>
                ))}
                {noRecord > 0 && (
                  <span
                    className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-500"
                    title="Days of the period payroll has no record for: a weekly off, a holiday, or a day it did not count"
                    data-testid="pd-legend-norecord"
                  >
                    <span className="h-2.5 w-2.5 rounded-sm border border-dashed border-slate-400" />
                    Not a working day
                    <span className="tabular-nums opacity-70">{noRecord}</span>
                  </span>
                )}
              </div>
            ) : (
              <FilterSelect
                value={kindFilter}
                onChange={(v) => setKindFilter(v as DayKind | "all")}
                label="Filter the days by status"
                testId="pd-status-filter"
                className="w-full sm:w-56"
              >
                <option value="all">All statuses ({days.length})</option>
                {DAY_KINDS.filter((k) => counts[k] > 0).map((k) => (
                  <option key={k} value={k}>
                    {DAY_KIND_META[k].label} ({counts[k]})
                  </option>
                ))}
              </FilterSelect>
            )}
            <ToggleChip
              pressed={flaggedOnly}
              onClick={() => setFlaggedOnly((v) => !v)}
              testId="pd-flagged-only"
              disabled={flaggedCount === 0 && !flaggedOnly}
            >
              <ListFilter size={12} /> Flagged only <span className="tabular-nums opacity-70">{flaggedCount}</span>
            </ToggleChip>
            {filtering && (
              <button
                type="button"
                onClick={() => {
                  setKindFilter("all");
                  setFlaggedOnly(false);
                }}
                className="text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
                data-testid="pd-days-clear"
              >
                Clear
              </button>
            )}
          </div>

          {/* Days the employee used a compensation (only when the details endpoint sends the marker) */}
          <CompensationLegend counts={countMarks(days)} className="mb-3 print:hidden" />

          {view === "calendar" ? (
            <div data-testid="pd-calendar">
              <div className="overflow-x-auto">
                <div className="min-w-[16.5rem]">
                  <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold uppercase tracking-wide text-muted-foreground sm:gap-1.5">
                    {CALENDAR_HEADERS.map((h) => (
                      <div key={h}>{h}</div>
                    ))}
                  </div>
                  {weeks.map((week, i) => (
                    <div key={i} className="mt-1 grid grid-cols-7 gap-1 sm:mt-1.5 sm:gap-1.5">
                      {week.map((cell) => (
                        <CalendarDay
                          key={cell.key}
                          cell={cell}
                          accent={accent}
                          selected={cell.type === "day" && cell.date === selectedDay}
                          dimmed={filtering && cell.type === "day" && !visible.has(cell.date)}
                          showMonth={monthsShown > 1}
                          alwaysShifts={payrollKind === "production"}
                          onSelect={(date) => onSelectDay(date === selectedDay ? null : date)}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
              {filtering && rows.length === 0 && (
                <p className="mt-3 text-xs text-muted-foreground">No day matches the legend choice and filters.</p>
              )}
              {selectedDay && day && (
                <DayPanel
                  day={day}
                  issues={dayIssues}
                  accent={accent}
                  onClose={() => onSelectDay(null)}
                  onShowIssues={onShowIssues}
                />
              )}
            </div>
          ) : rows.length === 0 ? (
            <EmptyNote
              icon={ListFilter}
              title="No day matches these filters"
              hint="Clear the status or the Flagged only switch to see every day again."
              testId="pd-days-empty"
            />
          ) : (
            <div className="overflow-x-auto rounded-xl border border-slate-100" data-testid="pd-days-table">
              <table className="w-full min-w-[42rem] text-sm">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    {["Date", "Day", "Status", "First in", "Last out", "Shifts", "Flags", "Note"].map((h) => (
                      <th key={h} className="px-3 py-2 font-semibold">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((d) => (
                    <DayRow key={d.date} day={d} selected={d.date === selectedDay} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </SectionCard>
  );
}

function CalendarDay({
  cell,
  selected,
  dimmed,
  showMonth,
  alwaysShifts,
  accent,
  onSelect,
}: {
  cell: CalendarCell;
  selected: boolean;
  dimmed: boolean;
  showMonth: boolean;
  /** Production is paid per shift, so a worked day always says how many; a staff day only when it is not a full one. */
  alwaysShifts: boolean;
  accent: Accent;
  onSelect: (date: string) => void;
}) {
  if (cell.type === "blank") return <div aria-hidden="true" className="min-h-[3rem] sm:min-h-[5.25rem]" />;
  const label = showMonth && cell.dayNumber === 1 ? dayMonth(cell.date) : String(cell.dayNumber);
  if (!cell.day || !cell.kind) {
    return (
      <div
        className="min-h-[3rem] rounded-xl border border-dashed border-slate-200 p-1 text-xs font-bold text-slate-300 sm:min-h-[5.25rem] sm:p-2"
        title={`${dateLong(cell.date)}: not a working day, or no record`}
        data-testid={`pd-day-${cell.date}`}
        data-kind="none"
      >
        {label}
      </div>
    );
  }
  const { day, kind } = cell;
  const meta = DAY_KIND_META[kind];
  const flags = day.flags ?? [];
  const punches = punchText(day);
  const compensation = compensationMark(day);
  const aria = [
    `${dateLong(cell.date)}: ${meta.label}`,
    // the engine's note ends with a full stop and the parts are joined by one
    compensation ? compensation.title.replace(/\.$/, "") : "",
    [day.firstIn ? `first in ${timeText(day.firstIn)}` : "", day.lastOut ? `last out ${timeText(day.lastOut)}` : ""]
      .filter(Boolean)
      .join(", "),
    flags.length > 0 ? `flagged: ${flags.map(issueLabel).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(". ");
  return (
    <button
      type="button"
      onClick={() => onSelect(cell.date)}
      aria-pressed={selected}
      aria-label={aria}
      title={aria}
      data-testid={`pd-day-${cell.date}`}
      data-kind={kind}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex min-h-[3rem] flex-col rounded-xl border p-1 text-left transition sm:min-h-[5.25rem] sm:p-2",
        meta.cell,
        selected && cn("ring-2 ring-offset-1", accent.ring),
        dimmed && "opacity-30",
        "hover:brightness-95",
      )}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="text-xs font-black leading-none sm:text-sm">{label}</span>
        <span className="text-[9px] font-bold leading-none opacity-70 max-[339px]:hidden" aria-hidden="true">
          {meta.short}
        </span>
      </span>
      {punches && (
        <span className="mt-1 hidden text-[10px] leading-tight tabular-nums opacity-80 sm:block">{punches}</span>
      )}
      {day.shifts !== null && day.shifts !== 0 && (alwaysShifts || day.shifts !== 1) && (
        <span className="hidden text-[10px] font-semibold leading-tight opacity-80 sm:block">
          {trimNumber(day.shifts)} {day.shifts === 1 ? "shift" : "shifts"}
        </span>
      )}
      <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1">
        {compensation && <CompensationSymbol day={day} decorative className="mr-0.5" />}
        {flags.slice(0, 4).map((code, i) => (
          <span key={`${code}-${i}`} className={cn("h-1.5 w-1.5 rounded-full", flagDot(code))} />
        ))}
        {flags.length > 4 && <span className="text-[9px] font-bold leading-none">+{flags.length - 4}</span>}
      </span>
    </button>
  );
}

function DayPanel({
  day,
  issues,
  accent,
  onClose,
  onShowIssues,
}: {
  day: PayrollDay;
  issues: PayrollIssue[];
  accent: Accent;
  onClose: () => void;
  onShowIssues: () => void;
}) {
  const kind = dayKind(day);
  const meta = DAY_KIND_META[kind];
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4" data-testid="pd-day-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-black text-slate-900">{dateLong(day.date)}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
            <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-semibold", meta.cell)}>
              {meta.label}
            </span>
            <span>
              First in <strong className="tabular-nums text-slate-800">{timeText(day.firstIn)}</strong>
            </span>
            <span>
              Last out <strong className="tabular-nums text-slate-800">{timeText(day.lastOut)}</strong>
            </span>
            {day.shifts !== null && (
              <span>
                Shifts <strong className="tabular-nums text-slate-800">{trimNumber(day.shifts)}</strong>
              </span>
            )}
          </div>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Close the day" onClick={onClose}>
          <X size={14} />
        </Button>
      </div>
      {day.note && <p className="mt-2 text-xs text-slate-600">{day.note}</p>}
      {compensationMark(day) && (
        <div className="mt-2">
          <CompensationChip day={day} withNote />
        </div>
      )}
      <div className="mt-3 space-y-2">
        {issues.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing was flagged on this day.</p>
        ) : (
          issues.map((issue) => (
            <div
              key={issue.id}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2"
              data-testid="pd-day-issue"
            >
              <IssueChip code={issue.code} severity={issue.severity} />
              <p className="mt-1 text-xs leading-snug text-slate-700">{issue.detail}</p>
            </div>
          ))
        )}
      </div>
      {issues.length > 0 && (
        <button
          type="button"
          onClick={onShowIssues}
          className={cn("mt-3 text-xs font-semibold underline-offset-2 hover:underline", accent.text)}
          data-testid="pd-day-show-issues"
        >
          Show it in the Issues list
        </button>
      )}
    </div>
  );
}

function DayRow({ day, selected }: { day: PayrollDay; selected: boolean }) {
  const kind = dayKind(day);
  const meta = DAY_KIND_META[kind];
  const flags = day.flags ?? [];
  return (
    <tr className={cn(selected && "bg-slate-50")} data-testid={`pd-row-${day.date}`} data-kind={kind}>
      <td className="whitespace-nowrap px-3 py-2 font-medium text-slate-800">{dateShort(day.date)}</td>
      <td className="px-3 py-2 text-muted-foreground">{day.day || weekdayShort(day.date)}</td>
      <td className="px-3 py-2">
        <span className={cn("whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold", meta.cell)}>
          {kind === "other" ? statusLabel(day.status) : meta.label}
        </span>
      </td>
      <td className="px-3 py-2 font-mono text-xs tabular-nums">{timeText(day.firstIn)}</td>
      <td className="px-3 py-2 font-mono text-xs tabular-nums">{timeText(day.lastOut)}</td>
      <td className="px-3 py-2 tabular-nums">{day.shifts === null ? "—" : trimNumber(day.shifts)}</td>
      <td className="px-3 py-2">
        {flags.length === 0 && !compensationMark(day) ? (
          <span className="text-slate-300">—</span>
        ) : (
          <span className="flex flex-wrap gap-1">
            {flags.map((code, i) => (
              <IssueChip
                key={`${code}-${i}`}
                code={code}
                severity={ISSUE_META[code as keyof typeof ISSUE_META]?.severity ?? "info"}
              />
            ))}
            <CompensationChip day={day} size="sm" />
          </span>
        )}
      </td>
      <td className="max-w-[18rem] px-3 py-2 text-xs text-muted-foreground">{day.note ?? ""}</td>
    </tr>
  );
}
