import { useState } from "react";
import { CalendarCheck, UserCheck, UserX } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
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
} from "./home-logic";
import type { HomeAttendance } from "./home-types";
import { CountUp, Meter, Reveal } from "./motion";
import { CardState, HOME_COLORS, LegendDot, OverviewHeader, Pills } from "./parts";

const SERIES = [
  { key: "present", label: "Present", color: HOME_COLORS.present },
  { key: "cl", label: "CL", color: HOME_COLORS.cl },
  { key: "absent", label: "Absent", color: HOME_COLORS.absent },
] as const;

/** One of the three counts of today: the figure, what it is out of, and a bar for its share. */
function CountTile({
  label,
  shortLabel,
  value,
  share,
  due,
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
          style={{ backgroundColor: `${color}1A`, color }}
        >
          <Icon size={18} aria-hidden />
        </span>
      </div>
      <p className="mt-2 text-[11px] font-medium leading-tight text-md-ink-soft @2xl:text-xs">
        {share != null ? `${pct(share)} of ${num(due)}` : `of ${num(due)}`}
        <span className="hidden @[28rem]:inline"> due today</span>
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

/** The 14-day chart's tooltip: the day, the three counts and the share present. */
function TrendTip({ active, payload }: { active?: boolean; payload?: { payload: TrendRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={tooltipStyle}>
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

/**
 * Attendance Overview: today's Present / Absent (the people on approved leave included) / CL for everyone, staff or
 * production (the pills), a ring for today, the last 14 days as stacked bars, and today by unit.
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
  const today = data ? countsFor(data, view) : null;
  const trend = data ? trendRows(data.trend, view) : [];
  const units = data ? unitRows(data, view) : [];
  const average = data ? averagePresentPct(data.trend, view) : null;
  const ring = today
    ? SERIES.map((s) => ({ name: s.label, value: today[s.key], color: s.color })).filter((s) => s.value > 0)
    : [];
  const unitHeight = Math.max(140, units.length * 44 + 30);

  return (
    <Reveal
      index={1}
      className="md-card md-dashboard-card @container"
      testId="md-home-attendance"
      labelledBy="md-home-attendance-title"
    >
      <OverviewHeader
        id="md-home-attendance-title"
        title="Attendance Overview"
        subtitle={
          data
            ? `Today, ${shortDate(data.date)} · as of ${clockText(data.asOf)} · the day is still running, so Absent also means not in yet`
            : "Today's attendance"
        }
      >
        <Pills
          label="Whose attendance"
          value={view}
          options={PEOPLE_VIEWS}
          onChange={setView}
          testId="md-home-att-view"
        />
        <AskAiButton question="Who is absent today, and which unit is weakest?" />
      </OverviewHeader>

      {loading || error || !data || !today ? (
        <CardState loading={loading || (!error && !data)} error={error} onRetry={onRetry} />
      ) : (
        <div className="space-y-6">
          {!data.isWorkingDay && (
            <p className="rounded-2xl bg-md-info-50 px-4 py-2.5 text-sm font-medium text-md-info-800">
              Nobody is due today: it is a holiday or a weekly off.
            </p>
          )}
          <div className="grid grid-cols-3 gap-2 @[28rem]:gap-3">
            <CountTile
              label="Present"
              value={today.present}
              share={today.presentPct}
              due={today.expected}
              color={HOME_COLORS.present}
              icon={UserCheck}
              testId="md-home-present"
            />
            <CountTile
              label="Absent"
              value={today.absent}
              share={today.absentPct}
              due={today.expected}
              color={HOME_COLORS.absent}
              icon={UserX}
              note={
                today.onLeave > 0
                  ? `Includes ${num(today.onLeave)} on approved leave`
                  : "Includes anyone on approved leave (none today)"
              }
              testId="md-home-absent"
            />
            <CountTile
              label="CL (Casual Leave)"
              shortLabel="CL"
              value={today.cl}
              share={today.clPct}
              due={today.expected}
              color={HOME_COLORS.cl}
              icon={CalendarCheck}
              testId="md-home-cl"
            />
          </div>
          {/* on a phone the tiles are too narrow for the absent note: it goes under them */}
          <p className="-mt-3 text-[11px] font-semibold text-md-ink-soft @2xl:hidden" data-testid="md-home-absent-note">
            Absent{" "}
            {today.onLeave > 0
              ? `includes ${num(today.onLeave)} on approved leave`
              : "includes anyone on approved leave (none today)"}
            .
          </p>

          <div className="grid grid-cols-1 items-start gap-6 @4xl:grid-cols-[minmax(0,4fr)_minmax(0,8fr)]">
            <div className="md-panel rounded-2xl p-3 @lg:p-4">
              <h3 className="mb-2 text-sm font-extrabold text-md-ink">Today</h3>
              {ring.length === 0 ? (
                <p className="py-10 text-center text-sm text-md-ink-soft">Nobody is due today.</p>
              ) : (
                <div
                  className="relative mx-auto h-[150px] w-[150px] @lg:h-[190px] @lg:w-[190px]"
                  data-testid="md-home-att-ring"
                >
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={ring}
                        dataKey="value"
                        nameKey="name"
                        innerRadius="68%"
                        outerRadius="96%"
                        paddingAngle={2.5}
                        cornerRadius={5}
                        stroke="none"
                      >
                        {ring.map((s) => (
                          <Cell key={s.name} fill={s.color} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [num(Number(v)), name]} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                    <span className="md-dashboard-figure text-2xl font-black text-md-ink">
                      {pct(today.presentPct, 0)}
                    </span>
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-md-ink-soft">present</span>
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap justify-center gap-3">
                {SERIES.map((s) => (
                  <LegendDot key={s.key} color={s.color}>
                    {s.label} {num(today[s.key])}
                  </LegendDot>
                ))}
              </div>
            </div>

            <div className="md-panel min-w-0 rounded-2xl p-3 @lg:p-4">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-sm font-extrabold text-md-ink">Last 14 days</h3>
                <p className="text-xs font-medium text-md-ink-soft">
                  {average != null ? `On average ${pct(average)} present (complete days)` : "No complete days yet"}
                </p>
              </div>
              <div className="h-[200px] @lg:h-[240px]" data-testid="md-home-att-trend">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={trend} margin={{ top: 8, right: 4, bottom: 0, left: -12 }} barCategoryGap="22%">
                    <CartesianGrid {...gridProps} />
                    <XAxis
                      dataKey="label"
                      tick={axisStyle}
                      axisLine={false}
                      tickLine={false}
                      interval="preserveStartEnd"
                      minTickGap={8}
                    />
                    <YAxis allowDecimals={false} tick={axisStyle} axisLine={false} tickLine={false} />
                    <Tooltip content={<TrendTip />} cursor={{ fill: "rgba(127, 1, 31, 0.05)" }} />
                    {SERIES.map((s, i) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        stackId="day"
                        fill={s.color}
                        radius={i === SERIES.length - 1 ? [5, 5, 0, 0] : [0, 0, 0, 0]}
                      >
                        {trend.map((row) => (
                          <Cell key={row.date} fillOpacity={row.today ? 0.55 : 1} />
                        ))}
                      </Bar>
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-2 flex flex-wrap gap-3">
                {SERIES.map((s) => (
                  <LegendDot key={s.key} color={s.color}>
                    {s.label}
                  </LegendDot>
                ))}
                <span className="text-[11px] font-medium text-md-ink-soft">
                  Today's bar is lighter: the day is still running.
                </span>
              </div>
            </div>
          </div>

          <div className="md-panel rounded-2xl p-3 @lg:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-md-ink">Today by unit</h3>
              {data.workedDayOff > 0 && (
                <p className="text-xs font-medium text-md-ink-soft">
                  {num(data.workedDayOff)} more came in on their day off (not counted above)
                </p>
              )}
            </div>
            {units.length === 0 ? (
              <p className="py-6 text-center text-sm text-md-ink-soft">Nobody in this group is due today.</p>
            ) : (
              <div style={{ height: unitHeight }} data-testid="md-home-att-units">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={units}
                    layout="vertical"
                    margin={{ top: 4, right: 16, bottom: 4, left: 4 }}
                    barSize={20}
                  >
                    <CartesianGrid {...gridProps} horizontal={false} vertical />
                    <XAxis type="number" allowDecimals={false} tick={axisStyle} axisLine={false} tickLine={false} />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={96}
                      tick={axisStyle}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={tooltipStyle}
                      cursor={{ fill: "rgba(127, 1, 31, 0.05)" }}
                      formatter={(v, key) => [num(Number(v)), SERIES.find((s) => s.key === key)?.label ?? String(key)]}
                    />
                    {SERIES.map((s, i) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        stackId="unit"
                        fill={s.color}
                        radius={i === 0 ? [6, 0, 0, 6] : i === SERIES.length - 1 ? [0, 6, 6, 0] : [0, 0, 0, 0]}
                      />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
            {units.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-sm" data-testid="md-home-att-units-list">
                  <thead>
                    <tr className="text-left text-[11px] font-bold uppercase tracking-wide text-md-ink-soft">
                      <th className="py-1.5 pr-3 font-bold">Unit</th>
                      <th className="py-1.5 pr-3 text-right font-bold">Due</th>
                      <th className="py-1.5 pr-3 text-right font-bold">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: HOME_COLORS.present }}
                          />
                          Present
                        </span>
                      </th>
                      <th className="py-1.5 pr-3 text-right font-bold">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: HOME_COLORS.cl }}
                          />
                          CL
                        </span>
                      </th>
                      <th className="py-1.5 pr-3 text-right font-bold">
                        <span className="inline-flex items-center gap-1.5">
                          <span
                            aria-hidden
                            className="h-2 w-2 rounded-full"
                            style={{ backgroundColor: HOME_COLORS.absent }}
                          />
                          Absent
                        </span>
                      </th>
                      <th className="hidden py-1.5 pr-3 text-right font-bold @xl:table-cell">On leave</th>
                      <th className="hidden py-1.5 pl-2 text-left font-bold @lg:table-cell">Present today</th>
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
                    <tr className="border-t-2 border-md-ink/15" data-testid="md-home-att-units-total">
                      <td className="py-2.5 pr-3 font-extrabold text-md-ink">All units</td>
                      <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">
                        {num(today.expected)}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-black tabular-nums text-md-wine">
                        {num(today.present)}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">
                        {num(today.cl)}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink">
                        {num(today.absent)}
                      </td>
                      <td className="hidden py-2.5 pr-3 text-right font-extrabold tabular-nums text-md-ink @xl:table-cell">
                        {num(today.onLeave)}
                      </td>
                      <td className="hidden py-2.5 pl-2 @lg:table-cell">
                        <PresentShare value={today.presentPct} />
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <p className="mt-2 text-[11px] font-medium text-md-ink-soft">
                  Absent includes the people on approved leave (the On leave column says how many); while the day runs
                  it also means not in yet.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </Reveal>
  );
}
