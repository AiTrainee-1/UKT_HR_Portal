import { useState } from "react";
import { ArrowUpRight, CalendarCheck, UserCheck, UserX } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { Donut, StackedBars, StackedColumns } from "@/components/md/kit/LiteCharts";
import { clockText, num, pct } from "@/lib/md/format";
import {
  PEOPLE_VIEWS,
  averagePresentPct,
  countsFor,
  shortDate,
  trendRows,
  unitRows,
  type PeopleView,
  type TrendRow,
  type UnitRow,
} from "./home-logic";
import type { DayCounts, HomeAttendance } from "./home-types";
import { CountUp, Meter, Reveal } from "./motion";
import { CardState, HOME_COLORS, LegendDot, OverviewHeader, Pills } from "./parts";

const SERIES = [
  { key: "present", label: "Present", color: HOME_COLORS.present },
  { key: "cl", label: "CL", color: HOME_COLORS.cl },
  { key: "absent", label: "Absent", color: HOME_COLORS.absent },
] as const;

/** One of the three counts: the figure, what it is out of, and a bar for its share. */
function CountTile({
  label,
  shortLabel,
  value,
  share,
  due,
  dueWord,
  color,
  icon: Icon,
  note,
  testId,
}: {
  label: string;
  /** What a phone shows instead of a long label ("CL" for "CL (Casual Leave)"). */
  shortLabel?: string;
  value: number;
  share: number | null;
  due: number;
  /** What the "of N" counts ("due today", "person-days due"). */
  dueWord: string;
  color: string;
  icon: typeof UserCheck;
  note?: string;
  testId: string;
}) {
  return (
    <div className="md-panel relative h-full overflow-hidden rounded-2xl p-3 pl-3.5 @2xl:p-4" data-testid={testId}>
      <span aria-hidden className="absolute inset-y-0 left-0 w-1" style={{ backgroundColor: color }} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] text-md-ink-soft @2xl:tracking-[0.12em]">
            {shortLabel ? (
              <>
                <span className="@2xl:hidden">{shortLabel}</span>
                <span className="hidden @2xl:inline">{label}</span>
              </>
            ) : (
              label
            )}
          </p>
          <p className="md-dashboard-figure mt-1 text-3xl font-black leading-none text-md-ink @2xl:text-4xl">
            <CountUp value={value} testId={`${testId}-value`} />
          </p>
        </div>
        <span
          className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl @2xl:flex"
          style={{ backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`, color }}
        >
          <Icon size={18} aria-hidden />
        </span>
      </div>
      <p className="mt-2 text-[11px] font-medium leading-tight text-md-ink-soft @2xl:text-xs">
        {share != null ? `${pct(share)} of ${num(due)}` : `of ${num(due)}`}
        <span className="hidden @[28rem]:inline"> {dueWord}</span>
      </p>
      {note && <p className="mt-0.5 hidden text-xs font-semibold text-md-ink @2xl:block">{note}</p>}
      <div className="mt-3">
        <Meter
          value={share}
          color={color}
          label={`${label}: ${share != null ? pct(share) : "no figure"} of the people due`}
        />
      </div>
    </div>
  );
}

/** The share present as a bar coloured by how the day is going (sage from 90%, ochre from 75%, crimson below). */
function PresentShare({ value }: { value: number | null }) {
  const color =
    value == null
      ? HOME_COLORS.cl
      : value >= 90
        ? HOME_COLORS.present
        : value >= 75
          ? HOME_COLORS.watch
          : HOME_COLORS.absent;
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-[72px] flex-1">
        <Meter value={value} color={color} label={`${pct(value)} present`} />
      </div>
      <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-md-ink-soft">{pct(value)}</span>
    </div>
  );
}

/** The day-by-day chart's tooltip: the day, the three counts and the share present. */
function TrendTip({ row }: { row: TrendRow }) {
  return (
    <div>
      <p className="mb-1 font-extrabold">
        {row.day} {row.label}
        {row.today ? " (today, still running)" : ""}
      </p>
      {row.expected === 0 ? (
        <p className="font-medium">Nobody was due (a day off)</p>
      ) : (
        <>
          {SERIES.map((s) => (
            <p key={s.key} className="flex items-center gap-2 font-medium">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}: {num(row[s.key])}
            </p>
          ))}
          <p className="mt-1 font-bold">{pct(row.presentPct)} present</p>
        </>
      )}
    </div>
  );
}

/** A unit table's rows and its total row (the same columns for today and for a month). */
function UnitsTable({
  units,
  total,
  presentHeading,
  testId,
}: {
  units: UnitRow[];
  total: DayCounts;
  presentHeading: string;
  testId: string;
}) {
  const dot = (color: string) => (
    <span aria-hidden className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />
  );
  return (
    <table className="w-full text-sm" data-testid={testId}>
      <thead>
        <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-md-ink-soft">
          <th className="py-1.5 pr-3 font-bold">Unit</th>
          <th className="py-1.5 pr-3 text-right font-bold">Due</th>
          <th className="py-1.5 pr-3 text-right font-bold">
            <span className="inline-flex items-center gap-1.5">{dot(HOME_COLORS.present)}Present</span>
          </th>
          <th className="py-1.5 pr-3 text-right font-bold">
            <span className="inline-flex items-center gap-1.5">{dot(HOME_COLORS.cl)}CL</span>
          </th>
          <th className="py-1.5 pr-3 text-right font-bold">
            <span className="inline-flex items-center gap-1.5">{dot(HOME_COLORS.absent)}Absent</span>
          </th>
          <th className="hidden py-1.5 pr-3 text-right font-bold @xl:table-cell">On leave</th>
          <th className="hidden py-1.5 pl-2 text-left font-bold @lg:table-cell">{presentHeading}</th>
        </tr>
      </thead>
      <tbody>
        {units.map((u) => (
          <tr key={u.name} className="md-dashboard-row border-t border-md-ink/[0.06]">
            <td className="py-2 pr-3 font-semibold text-md-ink">{u.name}</td>
            <td className="py-2 pr-3 text-right tabular-nums text-md-ink-soft">{num(u.expected)}</td>
            <td className="py-2 pr-3 text-right font-bold tabular-nums text-md-ink">{num(u.present)}</td>
            <td className="py-2 pr-3 text-right tabular-nums text-md-ink">{num(u.cl)}</td>
            <td className="py-2 pr-3 text-right tabular-nums text-md-ink">{num(u.absent)}</td>
            <td className="hidden py-2 pr-3 text-right tabular-nums text-md-ink-soft @xl:table-cell">
              {num(u.onLeave)}
            </td>
            <td className="hidden py-2 pl-2 @lg:table-cell">
              <PresentShare value={u.presentPct} />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-md-ink/15" data-testid={`${testId.replace(/-list$/, "")}-total`}>
          <td className="py-2.5 pr-3 font-extrabold text-md-ink">All units</td>
          <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">{num(total.expected)}</td>
          <td className="py-2.5 pr-3 text-right font-black tabular-nums text-md-wine">{num(total.present)}</td>
          <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">{num(total.cl)}</td>
          <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">{num(total.absent)}</td>
          <td className="hidden py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink @xl:table-cell">
            {num(total.onLeave)}
          </td>
          <td className="hidden py-2.5 pl-2 @lg:table-cell">
            <PresentShare value={total.presentPct} />
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/**
 * Attendance Overview. For the running month: today's Present / Absent (the people on approved leave included) / CL for
 * everyone, staff or production (the pills), a ring for today, the month so far day by day, and today by unit. For an
 * earlier month (the Dashboard's month filter): the same three counts as person-days over the month, its days, and the
 * month by unit. Light charts (kit/LiteCharts), no chart library.
 */
export default function AttendanceOverview({
  data,
  loading,
  error,
  onRetry,
}: {
  data: HomeAttendance | undefined;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [view, setView] = useState<PeopleView>("all");
  const month = data?.month;
  // an earlier month shows the month's totals; the running month (or an older backend without them) shows today
  const past = !!month && !month.current;
  const counts = data ? countsFor(past && month ? month : data, view) : null;
  const trend = data ? trendRows(data.trend, view) : [];
  const units = data ? unitRows(past && month ? { ...data, units: month.units } : data, view) : [];
  const average = data ? averagePresentPct(data.trend, view) : null;
  const ring = counts
    ? SERIES.map((s) => ({ key: s.key, label: s.label, value: counts[s.key], color: s.color })).filter(
        (s) => s.value > 0,
      )
    : [];
  const dueWord = past ? "person-days due" : "due today";
  const monthName = month?.label ?? "This month";
  const dayLabel = (row: TrendRow) => (trend.length > 16 ? String(Number(row.date.slice(8))) : row.label);

  return (
    <Reveal
      index={2}
      className="md-card md-dashboard-card @container"
      testId="md-home-attendance"
      labelledBy="md-home-attendance-title"
    >
      <OverviewHeader
        id="md-home-attendance-title"
        title="Attendance Overview"
        subtitle={
          !data
            ? "Today's attendance"
            : past && month
              ? `${month.label} · ${num(month.completeDays)} days · each person due on a day counts once (person-days)`
              : `Today, ${shortDate(data.date)} · as of ${clockText(data.asOf)} · the day is still running, so Absent also means not in yet`
        }
      >
        <Pills
          label="Whose attendance"
          value={view}
          options={PEOPLE_VIEWS}
          onChange={setView}
          testId="md-home-att-view"
        />
        <AskAiButton
          question={
            past && month
              ? `How was attendance in ${month.label}, and which unit was weakest?`
              : "Who is absent today, and which unit is weakest?"
          }
        />
        <Link
          href={view === "production" ? "/md/attendance/production" : "/md/attendance/staff"}
          className="md-btn md-btn-soft md-btn-sm"
        >
          Attendance <ArrowUpRight size={12} aria-hidden />
        </Link>
      </OverviewHeader>

      {loading || error || !data || !counts ? (
        <CardState loading={loading || (!error && !data)} error={error} onRetry={onRetry} shape="attendance" />
      ) : (
        <div className="space-y-6">
          {!past && !data.isWorkingDay && (
            <p className="rounded-2xl bg-md-info-50 px-4 py-2.5 text-sm font-medium text-md-info-800">
              Nobody is due today: it is a holiday or a weekly off.
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 @[28rem]:gap-3">
            <CountTile
              label="Present"
              value={counts.present}
              share={counts.presentPct}
              due={counts.expected}
              dueWord={dueWord}
              color={HOME_COLORS.present}
              icon={UserCheck}
              testId="md-home-present"
            />
            <CountTile
              label="Absent"
              value={counts.absent}
              share={counts.absentPct}
              due={counts.expected}
              dueWord={dueWord}
              color={HOME_COLORS.absent}
              icon={UserX}
              note={
                counts.onLeave > 0
                  ? `Includes ${num(counts.onLeave)} on approved leave`
                  : `Includes anyone on approved leave (none ${past ? "that month" : "today"})`
              }
              testId="md-home-absent"
            />
            <CountTile
              label="CL (Casual Leave)"
              shortLabel="CL"
              value={counts.cl}
              share={counts.clPct}
              due={counts.expected}
              dueWord={dueWord}
              color={HOME_COLORS.cl}
              icon={CalendarCheck}
              testId="md-home-cl"
            />
          </div>
          {/* on a phone the tiles are too narrow for the absent note: it goes under them */}
          <p className="-mt-3 text-[11px] font-semibold text-md-ink-soft @2xl:hidden" data-testid="md-home-absent-note">
            Absent{" "}
            {counts.onLeave > 0
              ? `includes ${num(counts.onLeave)} on approved leave`
              : `includes anyone on approved leave (none ${past ? "that month" : "today"})`}
            .
          </p>

          <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div className="md-panel rounded-2xl p-3 @lg:p-4">
              <h3 className="mb-2 text-sm font-extrabold text-md-ink">{past ? monthName : "Today"}</h3>
              {ring.length === 0 ? (
                <p className="py-10 text-center text-sm text-md-ink-soft">
                  Nobody is due {past ? "in this month" : "today"}.
                </p>
              ) : (
                <Donut
                  segments={ring}
                  format={num}
                  className="mx-auto h-[150px] w-[150px] @lg:h-[190px] @lg:w-[190px]"
                  testId="md-home-att-ring"
                >
                  <span className="md-dashboard-figure text-2xl font-black text-md-ink">
                    {pct(counts.presentPct, 0)}
                  </span>
                  <span className="text-[11px] font-semibold uppercase tracking-wide text-md-ink-soft">present</span>
                </Donut>
              )}
              <div className="mt-3 flex flex-wrap justify-center gap-3">
                {SERIES.map((s) => (
                  <LegendDot key={s.key} color={s.color}>
                    {s.label} {num(counts[s.key])}
                  </LegendDot>
                ))}
              </div>
            </div>

            <div className="md-panel min-w-0 rounded-2xl p-3 @lg:p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-extrabold text-md-ink">{monthName}, day by day</h3>
                <p className="text-xs font-medium text-md-ink-soft">
                  {average != null ? `On average ${pct(average)} present (complete days)` : "No complete days yet"}
                </p>
              </div>
              <StackedColumns
                className="h-[200px] @lg:h-[240px]"
                testId="md-home-att-trend"
                ariaLabel={`${monthName}: present, CL and absent day by day`}
                rows={trend}
                series={SERIES}
                rowKey={(r) => r.date}
                label={dayLabel}
                value={(r, key) => r[key as "present" | "cl" | "absent"]}
                dim={(r) => r.today}
                tooltip={(r) => <TrendTip row={r} />}
              />
              <div className="mt-2 flex flex-wrap gap-3">
                {SERIES.map((s) => (
                  <LegendDot key={s.key} color={s.color}>
                    {s.label}
                  </LegendDot>
                ))}
                {!past && (
                  <span className="text-[11px] font-medium text-md-ink-soft">
                    Today's bar is lighter: the day is still running.
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="md-panel rounded-2xl p-3 @lg:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-md-ink">{past ? `${monthName} by unit` : "Today by unit"}</h3>
              {!past && data.workedDayOff > 0 && (
                <p className="text-xs font-medium text-md-ink-soft">
                  {num(data.workedDayOff)} more came in on their day off (not counted above)
                </p>
              )}
            </div>
            {units.length === 0 ? (
              <p className="py-6 text-center text-sm text-md-ink-soft">
                Nobody in this group is due {past ? "in this month" : "today"}.
              </p>
            ) : (
              <>
                <StackedBars
                  testId="md-home-att-units"
                  format={num}
                  rows={units.map((u) => ({
                    key: u.name,
                    name: u.name,
                    parts: SERIES.map((s) => ({ key: s.key, label: s.label, value: u[s.key], color: s.color })),
                  }))}
                />
                <div className="mt-3 overflow-x-auto">
                  <UnitsTable
                    units={units}
                    total={counts}
                    presentHeading={past ? "Present" : "Present today"}
                    testId="md-home-att-units-list"
                  />
                  <p className="mt-2 text-[11px] font-medium text-md-ink-soft">
                    Absent includes the people on approved leave (the On leave column says how many)
                    {past ? "; the figures are person-days." : "; while the day runs it also means not in yet."}
                  </p>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Reveal>
  );
}
