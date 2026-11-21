import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, dayShort, num, pct } from "@/lib/md/format";
import SegTabs from "../shared/SegTabs";
import { QueryError, refreshingClass } from "../outpass/parts";
import type { TeaDrill } from "./RecordsSheet";
import type { TeaGroupBy, TeaGroups, TeaOffenders, TeaTrend } from "./types";

const LOST: TrendSeries = { key: "minutesLost", label: "Minutes lost", kind: "bar", color: CHART.brand };
const RATE: TrendSeries = {
  key: "overrunPct",
  label: "Overrun rate",
  kind: "line",
  color: CHART.deep,
  rightAxis: true,
};

/** Minutes lost to overruns per day (or week), with the overrun rate on the right-hand scale, and the verdict. */
export function TeaTrendCard({ query, ask }: { query: UseQueryResult<TeaTrend>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(
    () =>
      (trend?.points ?? []).map((p) => ({ date: p.date, minutesLost: p.minutesLost ?? 0, overrunPct: p.overrunPct })),
    [trend],
  );
  const weekly = trend?.granularity === "week";
  const any = (trend?.points ?? []).some((p) => p.breaks > 0);
  return (
    <SectionCard
      title="Is break discipline getting better?"
      subtitle={`${weekly ? "Week by week" : "Day by day"}: minutes lost to overruns, and the overrun rate (right-hand scale)`}
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-tea-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && any ? (
        <>
          {trend.momentum?.text && (
            <p className="md-analytics-note mb-2" data-testid="md-tea-verdict">
              {trend.momentum.text}
            </p>
          )}
          <TrendChart
            data={rows}
            xKey="date"
            series={[LOST, RATE]}
            height={240}
            xFormat={dayShort}
            yFormat={(v) => num(v)}
            rightFormat={(v) => pct(v, 0)}
          />
          {trend.worstDay && (
            <p className="md-analytics-note" data-testid="md-tea-worst-day">
              Worst day: {dayLong(trend.worstDay.date)}, {pct(trend.worstDay.overrunPct)} of breaks over the allowance (
              {num(trend.worstDay.minutesLost)} minutes lost).
            </p>
          )}
        </>
      ) : trend ? (
        <EmptyBlock title="No tea breaks in this period" testId="md-tea-trend-empty">
          Nobody scanned a tea break for this selection, so there is nothing to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}

const GROUP_TABS: { value: TeaGroupBy; label: string }[] = [
  { value: "department", label: "Departments" },
  { value: "unit", label: "Units" },
  { value: "gate", label: "Gates" },
  { value: "type", label: "Staff / production" },
];

/** Where the minutes go: ranked by minutes lost, by department, unit, gate or staff / production. A row opens its breaks. */
export function TeaGroupsCard({
  query,
  by,
  onBy,
  ask,
  onDrill,
}: {
  query: UseQueryResult<TeaGroups>;
  by: TeaGroupBy;
  onBy: (by: TeaGroupBy) => void;
  ask: string;
  onDrill: (drill: TeaDrill) => void;
}) {
  const data = query.data;
  const rows = data?.rows ?? [];
  return (
    <SectionCard
      title="Where the minutes go"
      subtitle={
        data
          ? `Ranked by minutes lost to overruns (company average ${pct(data.average.overrunPct)} of breaks over). Click a row for its breaks.`
          : "Ranked by minutes lost to overruns. Click a row for its breaks."
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-tea-groups"
    >
      <div className="mb-3">
        <SegTabs
          label="Group by"
          items={GROUP_TABS}
          value={by}
          onChange={(v) => onBy(v as TeaGroupBy)}
          testId="md-tea-group-tabs"
        />
      </div>
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <BarList
          items={rows
            .filter((r) => r.breaks > 0 || (r.refused ?? 0) > 0)
            .map((r) => ({
              key: r.key,
              label: r.lowSample ? `${r.label} (small sample)` : r.label,
              value: r.minutesLost ?? 0,
              display: `${num(r.minutesLost ?? 0)} min`,
              sub: `${num(r.breaks)} breaks · ${pct(r.overrunPct)} over${r.avgMinutes != null ? ` · average ${num(r.avgMinutes, 1)} min` : ""}${by === "gate" && r.refused ? ` · ${num(r.refused)} refused` : ""}`,
            }))}
          onSelect={(item) => {
            const row = rows.find((r) => r.key === item.key);
            if (row) onDrill({ title: `${row.label}: tea breaks`, filter: { by, group: row.key } });
          }}
          emptyText="No tea breaks in this period."
          testId="md-tea-group-bars"
        />
      )}
    </SectionCard>
  );
}

/** The people who overran most often, with how much time; a name opens their breaks. */
export function OffendersCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<TeaOffenders>;
  ask: string;
  onDrill: (drill: TeaDrill) => void;
}) {
  const data = query.data;
  return (
    <SectionCard
      title="Repeat overrunners"
      subtitle={
        data
          ? `${num(data.total)} ${data.total === 1 ? "person" : "people"} over the allowance ${data.threshold} or more times (${pct(data.shareOfMinutesLostPct)} of the minutes lost)`
          : undefined
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-tea-offenders"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : (
        <BarList
          items={(data?.rows ?? []).map((r) => ({
            key: r.employeeCode,
            label: `${r.employeeName} (${r.employeeCode})`,
            value: r.overruns,
            display: `${num(r.overruns)} times`,
            sub: `${r.department} · ${num(r.minutesLost)} minutes lost · worst ${num(r.worstMinutes)} min`,
          }))}
          color={CHART.bad}
          onSelect={(item) => {
            const row = data?.rows.find((r) => r.employeeCode === item.key);
            if (row?.employeeId) {
              onDrill({ title: `${row.employeeName}: tea breaks`, filter: { employee: row.employeeId } });
            }
          }}
          emptyText="Nobody overran their break this often in this period."
          testId="md-tea-offender-bars"
        />
      )}
    </SectionCard>
  );
}
