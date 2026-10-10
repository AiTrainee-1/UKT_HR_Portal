import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, num, pct } from "@/lib/md/format";
import { hasAbsences, trendCaption, trendRows } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { RlTrend } from "./types";

const STACK = "marks";
const INFORMED: TrendSeries = { key: "informed", label: "Informed", kind: "bar", color: CHART.good, stackId: STACK };
const NOT_INFORMED: TrendSeries = {
  key: "notInformed",
  label: "Not informed",
  kind: "bar",
  color: CHART.bad,
  stackId: STACK,
};
const UNMARKED: TrendSeries = {
  key: "unmarked",
  label: "Not yet marked",
  kind: "bar",
  color: CHART.warn,
  stackId: STACK,
};
const FOLLOWED: TrendSeries = {
  key: "reviewedPct",
  label: "Followed up %",
  kind: "line",
  color: CHART.brand,
  dashed: true,
  rightAxis: true,
};

/** Are absences being followed up? Each day's absences stacked by how HR marked them (Informed, Not informed, not yet
 *  marked) with the followed-up share as a line on the right-hand scale. Today and later days have no figures: the day is
 *  still running. */
export default function FollowUpCard({ query, ask }: { query: UseQueryResult<RlTrend>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend) : []), [trend]);
  const weekly = trend?.granularity === "week";
  const caption = trend ? trendCaption(trend) : null;
  return (
    <SectionCard
      title="Are absences being followed up?"
      subtitle={
        trend
          ? `${weekly ? "Week by week" : "Day by day"}: absences on scheduled days by how HR marked them on the Daily Report`
          : undefined
      }
      loading={query.isPending}
      provenance={trend?.provenance}
      provenanceIds={["reportlog-trend", "reportlog-followup", "reportlog-absences"]}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-followup"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && hasAbsences(trend) ? (
        <>
          <TrendChart
            data={rows}
            xKey="date"
            series={[INFORMED, NOT_INFORMED, UNMARKED, FOLLOWED]}
            height={260}
            xFormat={dayShort}
            yFormat={(v) => num(v)}
            rightFormat={(v) => pct(v, 0)}
          />
          {caption && (
            <p className="mt-2 text-xs text-[#006496]/70" data-testid="md-reportlog-followup-caption">
              {caption}
            </p>
          )}
          {weekly && (
            <p className="mt-1 text-[11px] text-[#006496]/55">
              Each point is a week (Monday to Sunday), labelled by its first day.
            </p>
          )}
        </>
      ) : trend ? (
        <EmptyBlock title="No absences to follow up in this period" testId="md-reportlog-followup-empty">
          Nobody was absent on a scheduled day for this selection (weekly offs, holidays and approved leave are not
          absences), or the days have not been processed in Attendance yet.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
