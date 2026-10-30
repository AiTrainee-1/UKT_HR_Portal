import { useMemo, useState, type ReactNode } from "react";
import { CalendarDays, CalendarRange, Check, ListFilter, Loader2, RefreshCw, Table2, X } from "lucide-react";
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
import { useLiveCalendar } from "./use-details";
import { cn } from "@/lib/utils";
import type { Accent } from "./accent";
import { DayAttendanceEdit } from "./DayAttendanceEdit";
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
  offDayAsDay,
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

  // Sync: the days read again from the attendance records as they stand now (an approval given after the payroll was
  // generated shows up). The payroll's own figures are never changed by it.
  const live = useLiveCalendar(payrollKind, details.payrollId, details.days.length > 0);
  const [pressed, setPressed] = useState(false);
  const synced = live.data?.calendarSync?.live ? live.data : null;
  const shown = synced ?? details;
  const { period } = details;
  const days = shown.days;
  const offDays = useMemo(() => shown.offDays ?? [], [shown.offDays]);
  // the listed days plus the Sundays / holidays: a worked Sunday is a day like any other, a holiday carries its name
  const allDays = useMemo(() => [...days, ...offDays.map(offDayAsDay)], [days, offDays]);
  // the table lists what happened: a Sunday nobody worked is only a calendar cell
  const tableDays = useMemo(() => allDays.filter((d) => dayKind(d) !== "weekoff"), [allDays]);
  const tableCounts = useMemo(() => kindCounts(tableDays), [tableDays]);
  const cellCounts = useMemo(() => fillKindCounts(allDays), [allDays]);
  const counts = view === "calendar" ? cellCounts : tableCounts;
  const markTotals = useMemo(() => markCounts(allDays), [allDays]);
  const flaggedCount = useMemo(() => allDays.filter((d) => (d.flags ?? []).length > 0).length, [allDays]);
  const weeks = useMemo(
    () => buildCalendar(days, period.start, period.end, offDays),
    [days, offDays, period.start, period.end],
  );
  // days of the period with no record at all (neither a payroll day, a Sunday nor a holiday)
  const noRecord = useMemo(
    () => weeks.flat().filter((cell) => cell.type === "day" && cell.day === null).length,
    [weeks],
  );
  // the table keeps its own filters (status and Flagged only); the category legend belongs to the calendar
  const activeMark = view === "calendar" ? markFilter : "all";
  const rows = useMemo(
    () =>
      filterDays(view === "calendar" ? allDays : tableDays, {
        kind: kindFilter,
        flaggedOnly,
        mark: activeMark,
        plainOnly: view === "calendar",
      }),
    [allDays, tableDays, kindFilter, flaggedOnly, activeMark, view],
  );
  const visible = useMemo(() => new Set(rows.map((d) => d.date)), [rows]);
  const filtering = kindFilter !== "all" || flaggedOnly || activeMark !== "all";
  const monthsShown = useMemo(() => new Set(allDays.map((d) => d.date.slice(0, 7))).size, [allDays]);

  const day = selectedDay ? (allDays.find((d) => d.date === selectedDay) ?? null) : null;
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
      description={`${period.label}: what each day was counted as, with the first and last punch, and every kind of day in a colour of its own.`}
      actions={
        days.length > 0 && (
          <>
            <SyncButton
              busy={live.isFetching}
              onSync={() => {
                setPressed(true);
                void live.refetch();
              }}
            />
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
          </>
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
            <SyncNote failed={live.isError} sync={synced?.calendarSync ?? null} always={pressed} />
            {view === "calendar" && (
              <div
                className="grid items-start gap-x-8 gap-y-1 rounded-xl border border-slate-100 bg-slate-50/50 px-3 py-2 2xl:grid-cols-2"
                data-testid="pd-legend"
              >
                {/* two columns, each a stack of groups; every group's chips sit on the same grid, so they line up */}
                {LEGEND_COLUMNS.map((column, i) => (
                  <div key={i} className="min-w-0 space-y-1">
                    {column.map((name) =>
                      name === "Also marked" ? (
                        <LegendRow key={name} title={name} testId="pd-mark-legend">
                          {MARK_KEYS.filter((k) => k !== "late").map((k) => (
                            <ToggleChip
                              key={k}
                              pressed={markFilter === k}
                              onClick={() => setMarkFilter(markFilter === k ? "all" : k)}
                              disabled={markTotals[k] === 0 && markFilter !== k}
                              title={MARK_META[k].hint}
                              testId={`pd-mark-legend-${k}`}
                              className={LEGEND_CHIP}
                            >
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span
                                  className={cn(
                                    "h-2.5 w-2.5 shrink-0 rounded-[3px] border border-l-[3px]",
                                    MARK_META[k].cell,
                                    MARK_META[k].bar,
                                  )}
                                />
                                <span className="whitespace-nowrap">{MARK_META[k].label}</span>
                              </span>
                              <span className="tabular-nums text-[10px] opacity-60">{markTotals[k]}</span>
                            </ToggleChip>
                          ))}
                        </LegendRow>
                      ) : (
                        (() => {
                          const group = KIND_GROUPS.find((g) => g.title === name)!;
                          return (
                            <LegendRow key={name} title={group.title} testId={group.testId}>
                              {group.kinds.map((k) => (
                                <ToggleChip
                                  key={k}
                                  pressed={kindFilter === k}
                                  onClick={() => setKindFilter(kindFilter === k ? "all" : k)}
                                  disabled={counts[k] === 0 && kindFilter !== k}
                                  title={DAY_KIND_META[k].hint}
                                  testId={`pd-legend-${k}`}
                                  className={LEGEND_CHIP}
                                >
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <span className={cn("h-2 w-2 shrink-0 rounded-full", DAY_KIND_META[k].swatch)} />
                                    <span className="whitespace-nowrap">{DAY_KIND_META[k].label}</span>
                                  </span>
                                  <span className="tabular-nums text-[10px] opacity-60">{counts[k]}</span>
                                </ToggleChip>
                              ))}
                              {group.title === "Days off" && noRecord > 0 && (
                                <span
                                  className={cn(
                                    "inline-flex items-center rounded-md font-semibold text-slate-500",
                                    LEGEND_CHIP,
                                  )}
                                  title="Days of the period payroll has no record for: a day it did not count"
                                  data-testid="pd-legend-norecord"
                                >
                                  <span className="flex min-w-0 items-center gap-1.5">
                                    <span className="h-2 w-2 shrink-0 rounded-full border border-dashed border-slate-400" />
                                    <span className="whitespace-nowrap">Not a working day</span>
                                  </span>
                                  <span className="tabular-nums text-[10px] opacity-60">{noRecord}</span>
                                </span>
                              )}
                            </LegendRow>
                          );
                        })()
                      ),
                    )}
                  </div>
                ))}
              </div>
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
                  <option value="all">All statuses ({tableDays.length})</option>
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
                {/* a tinted board: lines between the days, between the weeks, and a gutter that names each week */}
                <div
                  className="min-w-[19rem] overflow-hidden rounded-2xl border border-slate-200 bg-slate-50/70"
                  data-testid="pd-calendar-board"
                >
                  <div className={cn(WEEK_GRID, "border-b border-slate-200 bg-slate-100 text-center")}>
                    <div className="py-2 text-[10px] font-semibold text-slate-400">Wk</div>
                    {CALENDAR_HEADERS.map((h) => (
                      <div
                        key={h}
                        className={cn(
                          "border-l border-slate-200 py-2 text-[11px] font-semibold text-slate-600",
                          h === "Sun" && "bg-orange-100/80 text-orange-700",
                        )}
                      >
                        {h}
                      </div>
                    ))}
                  </div>
                  {weeks.map((week, i) => {
                    const dayNumbers = week.flatMap((c) => (c.type === "day" ? [c.dayNumber] : []));
                    return (
                      <div
                        key={i}
                        className={cn(WEEK_GRID, "border-b border-slate-200 last:border-b-0")}
                        data-week={i + 1}
                      >
                        <div
                          className="flex items-center justify-center bg-slate-100/80 text-[10px] font-bold text-slate-400"
                          title={`Week ${i + 1}: ${dayNumbers[0]}${dayNumbers.length > 1 ? ` to ${dayNumbers[dayNumbers.length - 1]}` : ""}`}
                        >
                          W{i + 1}
                        </div>
                        {week.map((cell, col) => (
                          <div
                            key={cell.key}
                            className={cn(
                              "min-w-0 border-l border-slate-200 p-1 sm:p-1.5",
                              col === 6 && "bg-orange-50/60",
                              cell.type === "blank" && "bg-slate-100/50",
                            )}
                          >
                            <CalendarDay
                              cell={cell}
                              accent={accent}
                              selected={cell.type === "day" && cell.date === selectedDay}
                              dimmed={filtering && cell.type === "day" && !visible.has(cell.date)}
                              showMonth={monthsShown > 1}
                              alwaysShifts={payrollKind === "production"}
                              onSelect={(date) => onSelectDay(date === selectedDay ? null : date)}
                            />
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </div>
              </div>
              {filtering && rows.length === 0 && (
                <p className="mt-3 text-xs text-muted-foreground">No day matches the legend choice and filters.</p>
              )}
              {selectedDay && day && (
                <DayPanel
                  day={day}
                  employeeId={details.employee.id}
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

/** The key of the calendar in the order a reader looks for things. */
const KIND_GROUPS: { title: string; testId: string; kinds: DayKind[] }[] = [
  {
    title: "Worked",
    testId: "pd-status-legend",
    kinds: ["present", "late", "early", "half", "onduty", "onduty_pending"],
  },
  { title: "Leave", testId: "pd-leave-legend", kinds: ["casual", "unpaid", "leave", "onleave", "absent"] },
  { title: "Paid extras", testId: "pd-comp-legend", kinds: ["comp", "sunday_comp", "ot_comp"] },
  {
    title: "Days off",
    testId: "pd-off-legend",
    kinds: ["holiday", "weekoff", "holiday_worked", "sunday_worked", "other"],
  },
];

const syncedClock = (iso: string | null | undefined): string => {
  const at = iso ? new Date(iso) : null;
  return at && !Number.isNaN(at.getTime())
    ? at.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })
    : "";
};

/** The board's columns: a narrow gutter that names the week, then the seven days. */
const WEEK_GRID = "grid grid-cols-[1.75rem_repeat(7,minmax(0,1fr))] sm:grid-cols-[2.25rem_repeat(7,minmax(0,1fr))]";

/** The compact look of a legend chip: two columns of them have to fit side by side. */
const LEGEND_CHIP =
  "w-auto min-w-0 justify-start gap-1 rounded-md border-transparent bg-transparent px-1.5 py-0.5 text-[11px] hover:bg-white";

/** Which groups of the key stand in which column (three rows of chips each, so the two sides come out level). */
const LEGEND_COLUMNS: string[][] = [
  ["Worked", "Paid extras", "Days off"],
  ["Leave", "Also marked"],
];

/** The Sync button, in the card's header: read the attendance again, so an approval given since shows here. */
function SyncButton({ busy, onSync }: { busy: boolean; onSync: () => void }) {
  return (
    <span data-testid="pd-sync-bar" data-view-safe className="print:hidden">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-9 gap-1.5 rounded-xl"
        onClick={onSync}
        disabled={busy}
        title="Shows each day as the payroll counted it. Sync to read the attendance records as they are now (HOD and HR approvals included)."
        data-testid="pd-sync"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        Sync attendance
      </Button>
    </span>
  );
}

/** What a Sync found: how many days differ from what the payroll counted. Nothing is shown until one has been done. */
function SyncNote({
  failed,
  sync,
  always,
}: {
  failed: boolean;
  sync: { syncedAt: string | null; changedDays: number } | null;
  /** The Sync button was pressed: say what it found even when nothing differs. */
  always: boolean;
}) {
  // the days are read from the attendance records as soon as the page opens: only a difference (or a Sync) is worth a line
  if (!failed && !(sync && (always || sync.changedDays > 0))) return null;
  return (
    <p className="text-xs text-slate-500" aria-live="polite" data-testid="pd-sync-status">
      {failed ? (
        <span className="text-red-700">Could not read the attendance. Try again.</span>
      ) : sync ? (
        <>
          <Check size={12} className="mr-1 inline text-emerald-600" />
          Synced at {syncedClock(sync.syncedAt)}:{" "}
          {sync.changedDays > 0
            ? `${sync.changedDays} ${sync.changedDays === 1 ? "day" : "days"} differ from what this payroll counted. `
            : "the days match what this payroll counted. "}
          The pay is unchanged until the payroll is generated again.
        </>
      ) : null}
    </p>
  );
}

/** One line of the calendar's key: its name, then the choices (each is also a filter). */
function LegendRow({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-start gap-x-2" data-testid={testId}>
      <span className="pt-0.5 text-[11px] font-semibold text-slate-500">{title}</span>
      <div
        className="flex flex-wrap items-center gap-x-1 gap-y-0.5"
        role="group"
        aria-label={`Legend: ${title.toLowerCase()}`}
      >
        {children}
      </div>
    </div>
  );
}

/** The words a cell carries under its date when the kind needs more than a code: the holiday's name, "Casual Leave" ... */
function captionOf(day: PayrollDay, kind: DayKind): string {
  if (kind === "holiday") return day.holidayName || "Holiday";
  if (kind === "weekoff") return "Sunday";
  if (day.workedOffDay) return day.holidayName ? `Worked: ${day.holidayName}` : "Worked on a day off";
  if (kind === "casual") return "Casual Leave";
  if (kind === "onduty" || kind === "onduty_pending") return day.onDuty?.label ?? DAY_KIND_META[kind].label;
  if (kind === "comp" || kind === "sunday_comp" || kind === "ot_comp") return DAY_KIND_META[kind].label;
  if (kind === "unpaid" || kind === "leave" || kind === "onleave") return DAY_KIND_META[kind].label;
  return "";
}

const EARLY_OUT_PILL = "bg-fuchsia-600 text-white";

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
  if (cell.type === "blank") return <div aria-hidden="true" className="min-h-[3.25rem] sm:min-h-[6rem]" />;
  const label = showMonth && cell.dayNumber === 1 ? dayMonth(cell.date) : String(cell.dayNumber);
  if (!cell.day || !cell.kind) {
    return (
      <div
        className="min-h-[3.25rem] rounded-xl border border-dashed border-slate-200 p-1 text-xs font-bold text-slate-300 sm:min-h-[6rem] sm:p-2"
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
  const found = marksOf(day);
  const lateIn = !!day.isLate || found.includes("late");
  const earlyOut = !!day.isEarlyOut || flags.includes("early_out");
  const marks = found.filter((m) => m !== "late");
  // a day with a permission, On-Duty or missed-punch category is filled in that category's colour (with a solid edge)
  const fill = fillMark(day);
  const punches = punchText(day);
  const compensation = compensationMark(day);
  const caption = captionOf(day, kind);
  const aria = [
    `${dateLong(cell.date)}: ${caption && kind !== "weekoff" && kind !== "holiday" ? caption : meta.label}`,
    kind === "holiday" ? (day.holidayName ?? "") : "",
    lateIn && kind !== "late" ? "Late In" : "",
    earlyOut && kind !== "early" ? "Early Out" : "",
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
        "group relative flex h-full w-full min-h-[3.25rem] flex-col overflow-hidden rounded-xl border p-1.5 text-left transition-shadow sm:min-h-[6rem] sm:p-2",
        fill ? cn(MARK_META[fill].cell, "border-l-4", MARK_META[fill].bar) : cn(meta.cell, "border-l-4", meta.bar),
        selected && cn("ring-2 ring-offset-1", accent.ring),
        dimmed && "opacity-30",
        "hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
      )}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="text-xs font-black leading-none sm:text-sm">{label}</span>
        <span
          className="rounded bg-white/70 px-1 py-px text-[9px] font-bold leading-none opacity-90 max-[339px]:hidden"
          aria-hidden="true"
        >
          {meta.short}
        </span>
      </span>
      {caption && (
        <span className="mt-1 hidden truncate text-[10px] font-semibold leading-tight sm:block">{caption}</span>
      )}
      {punches && (
        <span className="mt-0.5 hidden text-[10px] leading-tight tabular-nums opacity-80 sm:block">{punches}</span>
      )}
      {day.shifts !== null && day.shifts !== 0 && (alwaysShifts || day.shifts !== 1) && (
        <span className="hidden text-[10px] font-semibold leading-tight opacity-80 sm:block">
          {trimNumber(day.shifts)} {day.shifts === 1 ? "shift" : "shifts"}
        </span>
      )}
      <span className="mt-auto flex flex-wrap items-center gap-0.5 pt-1" data-testid={`pd-marks-${cell.date}`}>
        {compensation && <CompensationSymbol day={day} decorative className="mr-0.5" />}
        {lateIn && (
          <span data-mark="late" title="Late In">
            <span
              className={cn(
                "hidden whitespace-nowrap rounded px-1 text-[9px] font-bold leading-4 sm:inline-block",
                MARK_META.late.pill,
              )}
            >
              Late In
            </span>
            <span className={cn("inline-block h-2 w-2 rounded-full sm:hidden", MARK_META.late.swatch)} />
          </span>
        )}
        {earlyOut && (
          <span data-mark="early_out" title="Early Out">
            <span
              className={cn(
                "hidden whitespace-nowrap rounded px-1 text-[9px] font-bold leading-4 sm:inline-block",
                EARLY_OUT_PILL,
              )}
            >
              Early Out
            </span>
            <span className="inline-block h-2 w-2 rounded-full bg-fuchsia-600 sm:hidden" />
          </span>
        )}
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

/** What the day is, in plain sentences: the holiday's name, a Sunday, Casual Leave, where an On-Duty request stands. */
function dayFacts(day: PayrollDay, kind: DayKind): string[] {
  const facts: string[] = [];
  if (day.holidayName) facts.push(`Holiday: ${day.holidayName}.`);
  else if (kind === "weekoff") facts.push("Sunday is the weekly holiday: nobody is expected to work.");
  if (day.workedOffDay) {
    facts.push(
      day.holidayName
        ? "Worked on a holiday: the real attendance is shown, not the holiday."
        : "Worked on a day off: the real attendance is shown, not the holiday.",
    );
  }
  if (day.casualLeave) facts.push("Approved Casual Leave (a paid day).");
  if (day.compensationType) facts.push(`${DAY_KIND_META[dayKindOfCompensation(day.compensationType)].label} day.`);
  if (day.onDuty) {
    facts.push(
      day.onDuty.state === "verified"
        ? `${day.onDuty.label}${day.onDuty.destination ? ` (${day.onDuty.destination})` : ""}.`
        : `${day.onDuty.label}${day.onDuty.destination ? ` (${day.onDuty.destination})` : ""}. An On-Duty day counts as worked only when HR has approved the request and the punches are there.`,
    );
  }
  return facts;
}

const dayKindOfCompensation = (type: NonNullable<PayrollDay["compensationType"]>): DayKind =>
  type === "sunday_compensation" ? "sunday_comp" : type === "ot_compensation" ? "ot_comp" : "comp";

function DayPanel({
  day,
  employeeId,
  issues,
  accent,
  onClose,
  onShowIssues,
}: {
  day: PayrollDay;
  employeeId: number;
  issues: PayrollIssue[];
  accent: Accent;
  onClose: () => void;
  onShowIssues: () => void;
}) {
  const kind = dayKind(day);
  const meta = DAY_KIND_META[kind];
  const marks = marksOf(day).filter((m) => m !== "late" || !day.isLate);
  const facts = dayFacts(day, kind);
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
      {facts.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs text-slate-700" data-testid="pd-day-facts">
          {facts.map((f) => (
            <li key={f} className="leading-snug">
              {f}
            </li>
          ))}
        </ul>
      )}
      {(day.isLate || day.isEarlyOut) && (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" data-testid="pd-day-lateearly">
          {day.isLate && (
            <span className={cn("rounded px-1.5 text-[10px] font-bold leading-4", MARK_META.late.pill)}>Late In</span>
          )}
          {day.isEarlyOut && (
            <span className={cn("rounded px-1.5 text-[10px] font-bold leading-4", EARLY_OUT_PILL)}>Early Out</span>
          )}
        </p>
      )}
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
      <DayAttendanceEdit employeeId={employeeId} date={day.date} accent={accent} />
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
      <td className="max-w-[18rem] px-3 py-2 text-xs text-muted-foreground">
        {[day.holidayName, day.onDuty?.label, day.note].filter(Boolean).join(" · ")}
      </td>
    </tr>
  );
}
