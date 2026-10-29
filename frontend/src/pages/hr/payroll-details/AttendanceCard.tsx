import { useMemo, useState, type ReactNode } from "react";
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
import { ISSUE_META, issueLabel } from "@/components/payroll/kit/issue-meta";
import { EmptyNote, IssueChip, SectionCard } from "@/components/payroll/kit/parts";
import type { DayMark, PayrollDay, PayrollDetails, PayrollIssue, PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { FilterSelect, SegmentedToggle, ToggleChip } from "./parts";
import {
  CALENDAR_HEADERS,
  DAY_KINDS,
  DAY_KIND_META,
  MARK_KEYS,
  MARK_META,
  buildCalendar,
  dayKind,
  fillKindCounts,
  fillMark,
  filterDays,
  kindCounts,
  markCounts,
  marksOf,
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

/**
 * The days of the payroll's period: a calendar (a cell per day, filled in the colour of what the day was counted as, with the
 * punches and a solid coloured tag for each of the six attendance categories: late, permission, excess permission, On-Duty,
 * On-Duty punch, missed punch) or a table. Both legends double as filters, "Flagged only" narrows to days something was flagged
 * on, and choosing a day shows what happened on it and narrows the Issues list to it.
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
  const [markFilter, setMarkFilter] = useState<DayMark | "all">("all");
  const [flaggedOnly, setFlaggedOnly] = useState(false);

  const { days, period } = details;
  // the table counts every day of a status; the calendar counts the days whose cell shows that status
  const tableCounts = useMemo(() => kindCounts(days), [days]);
  const cellCounts = useMemo(() => fillKindCounts(days), [days]);
  const counts = view === "calendar" ? cellCounts : tableCounts;
  const markTotals = useMemo(() => markCounts(days), [days]);
  const flaggedCount = useMemo(() => days.filter((d) => (d.flags ?? []).length > 0).length, [days]);
  const weeks = useMemo(() => buildCalendar(days, period.start, period.end), [days, period.start, period.end]);
  // days of the period with no record: staff payroll only lists the working days, so a weekly off or a holiday is one
  const noRecord = useMemo(
    () => weeks.flat().filter((cell) => cell.type === "day" && cell.day === null).length,
    [weeks],
  );
  // the table keeps its own filters (status and Flagged only); the category legend belongs to the calendar
  const activeMark = view === "calendar" ? markFilter : "all";
  const rows = useMemo(
    () => filterDays(days, { kind: kindFilter, flaggedOnly, mark: activeMark, plainOnly: view === "calendar" }),
    [days, kindFilter, flaggedOnly, activeMark, view],
  );
  const visible = useMemo(() => new Set(rows.map((d) => d.date)), [rows]);
  const filtering = kindFilter !== "all" || flaggedOnly || activeMark !== "all";
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
      description={`${period.label}: what each day was counted as, with the first and last punch and the late, permission, On-Duty and missed-punch days marked.`}
      actions={
        days.length > 0 && (
          <SegmentedToggle<View>
            label="Show the days as"
            value={view}
            onChange={(next) => {
              setView(next);
              // the two views count the days differently, so a choice made in one does not carry over
              setKindFilter("all");
              setMarkFilter("all");
            }}
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
          <div className="mb-4 space-y-3 print:hidden" data-testid="pd-attendance-toolbar">
            {view === "calendar" && (
              <>
                <LegendRow title="Day status" testId="pd-status-legend">
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
                </LegendRow>
                <LegendRow title="Attendance types" testId="pd-mark-legend">
                  {MARK_KEYS.map((k) => (
                    <ToggleChip
                      key={k}
                      pressed={markFilter === k}
                      onClick={() => setMarkFilter(markFilter === k ? "all" : k)}
                      disabled={markTotals[k] === 0 && markFilter !== k}
                      title={MARK_META[k].hint}
                      testId={`pd-mark-legend-${k}`}
                    >
                      <span
                        className={cn("h-3 w-3 rounded-sm border border-l-[3px]", MARK_META[k].cell, MARK_META[k].bar)}
                      />
                      {MARK_META[k].label}
                      <span className="tabular-nums opacity-70">{markTotals[k]}</span>
                    </ToggleChip>
                  ))}
                </LegendRow>
              </>
            )}
            <div className="flex flex-wrap items-center gap-2">
              {view === "table" && (
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
                    setMarkFilter("all");
                    setFlaggedOnly(false);
                  }}
                  className="text-xs font-semibold text-slate-500 underline-offset-2 hover:underline"
                  data-testid="pd-days-clear"
                >
                  Clear
                </button>
              )}
            </div>
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

/** One line of the calendar's key: its name, then the choices (each is also a filter). */
function LegendRow({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5" data-testid={testId}>
      <span className="w-28 shrink-0 text-[11px] font-bold uppercase tracking-wide text-slate-500">{title}</span>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={`Legend: ${title.toLowerCase()}`}>
        {children}
      </div>
    </div>
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
  const marks = marksOf(day);
  // a day with a late, permission, On-Duty or missed-punch category is filled in that category's colour (with a solid edge)
  const fill = fillMark(day);
  const punches = punchText(day);
  const compensation = compensationMark(day);
  const aria = [
    `${dateLong(cell.date)}: ${meta.label}`,
    // the engine's note ends with a full stop and the parts are joined by one
    compensation ? compensation.title.replace(/\.$/, "") : "",
    [day.firstIn ? `first in ${timeText(day.firstIn)}` : "", day.lastOut ? `last out ${timeText(day.lastOut)}` : ""]
      .filter(Boolean)
      .join(", "),
    marks.length > 0 ? marks.map((m) => MARK_META[m].label).join(", ") : "",
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
      data-fill={fill ?? undefined}
      data-selected={selected ? "true" : "false"}
      className={cn(
        "flex min-h-[3rem] flex-col rounded-xl border p-1 text-left transition sm:min-h-[5.25rem] sm:p-2",
        fill ? cn(MARK_META[fill].cell, "border-l-4", MARK_META[fill].bar) : meta.cell,
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
      <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1" data-testid={`pd-marks-${cell.date}`}>
        {compensation && <CompensationSymbol day={day} decorative className="mr-0.5" />}
        {marks.map((mark) => (
          <span key={mark} data-mark={mark} title={MARK_META[mark].label}>
            <span
              className={cn(
                "hidden whitespace-nowrap rounded px-1 text-[9px] font-bold leading-4 sm:inline-block",
                MARK_META[mark].pill,
              )}
            >
              {MARK_META[mark].short}
            </span>
            <span className={cn("inline-block h-2 w-2 rounded-full sm:hidden", MARK_META[mark].swatch)} />
          </span>
        ))}
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
  const marks = marksOf(day);
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
      {marks.length > 0 && (
        <ul className="mt-3 space-y-1.5" data-testid="pd-day-marks">
          {marks.map((mark) => (
            <li key={mark} className="flex items-start gap-2 text-xs text-slate-700" data-mark={mark}>
              <span
                className={cn("mt-0.5 shrink-0 rounded px-1.5 text-[10px] font-bold leading-4", MARK_META[mark].pill)}
              >
                {MARK_META[mark].label}
              </span>
              <span className="leading-snug">{MARK_META[mark].hint}</span>
            </li>
          ))}
        </ul>
      )}
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
