import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { HelpCircle, Minus, TrendingDown, TrendingUp } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, dayShort, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { VERDICT_STYLE, hasActivity, trendRows } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { GeoTrend, Verdict } from "./types";

const VERDICT_ICON: Record<Verdict, typeof TrendingUp> = {
  rising: TrendingUp,
  falling: TrendingDown,
  steady: Minus,
  unclear: HelpCircle,
};

const SESSIONS: TrendSeries = { key: "sessions", label: "Sessions", kind: "bar", color: CHART.brand };
const PUNCHES: TrendSeries = { key: "punches", label: "On-duty punches", kind: "bar", color: CHART.deep };
const AVERAGE: TrendSeries = {
  key: "average",
  label: "7-day average of sessions",
  kind: "line",
  color: CHART.sky,
  dashed: true,
};
const OFFICE: TrendSeries = {
  key: "officePunches",
  label: "Office geo punches",
  kind: "line",
  color: CHART.slate,
  rightAxis: true,
};

/** Is on-duty work rising or falling? A one-line verdict (the last 7 days against the 7 before), then sessions and
 *  on-duty punches per day as bars, their 7-day average, and the office geo punches on the right-hand scale. */
export default function TrendCard({ query, ask }: { query: UseQueryResult<GeoTrend>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend) : []), [trend]);
  const weekly = trend?.granularity === "week";
  const series = weekly ? [SESSIONS, PUNCHES, OFFICE] : [SESSIONS, PUNCHES, AVERAGE, OFFICE];
  const verdict = trend?.momentum.verdict;
  const VerdictIcon = verdict ? VERDICT_ICON[verdict] : Minus;

  return (
    <SectionCard
      title="Is on-duty work rising or falling?"
      subtitle={
        trend
          ? `${weekly ? "Week by week" : "Day by day"}: sessions requested, on-duty punches taken, and office geo punches (right-hand scale)`
          : undefined
      }
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && verdict && hasActivity(trend) ? (
        <>
          <div
            className={cn("md-analytics-verdict", VERDICT_STYLE[verdict].box)}
            data-testid="md-geo-verdict"
            data-verdict={verdict}
          >
            <span className="md-analytics-verdict-icon">
              <VerdictIcon size={16} aria-label={VERDICT_STYLE[verdict].label} />
            </span>
            <p className="min-w-0 self-center">{trend.momentum.text}</p>
          </div>
          <TrendChart
            data={rows}
            xKey="date"
            series={series}
            height={260}
            xFormat={dayShort}
            yFormat={(v) => num(v)}
            rightFormat={(v) => num(v)}
          />
          {trend.busiestDay && (
            <p className="md-analytics-note" data-testid="md-geo-busiest-day">
              Busiest day: {dayLong(trend.busiestDay.date)}, {num(trend.busiestDay.sessions)}{" "}
              {trend.busiestDay.sessions === 1 ? "session" : "sessions"} and {num(trend.busiestDay.punches)} on-duty{" "}
              {trend.busiestDay.punches === 1 ? "punch" : "punches"}.
            </p>
          )}
          {weekly && (
            <p className="md-analytics-note">Each point is a week (Monday to Sunday), labelled by its first day.</p>
          )}
        </>
      ) : trend ? (
        <EmptyBlock title="No on-duty work in this period" testId="md-geo-trend-empty">
          Nobody asked to work away from the unit and nobody made an office geo punch for this selection, so there is
          nothing to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
