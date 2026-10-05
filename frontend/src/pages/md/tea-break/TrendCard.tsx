import { useMemo } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { HelpCircle, Minus, TrendingDown, TrendingUp } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, dayShort, minutesText, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { VERDICT_STYLE, hasMeasuredBreaks, trendRows } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { TeaTrend, Verdict } from "./types";

/** The arrow follows the overrun rate: falling is "better". */
const VERDICT_ICON: Record<Verdict, typeof TrendingUp> = {
  better: TrendingDown,
  worse: TrendingUp,
  steady: Minus,
  unclear: HelpCircle,
};

const MINUTES_LOST: TrendSeries = { key: "minutesLost", label: "Minutes lost", kind: "bar", color: CHART.warn };
const OVERRUN_RATE: TrendSeries = {
  key: "overrunPct",
  label: "Overrun rate",
  kind: "line",
  color: CHART.bad,
  rightAxis: true,
};
const AVERAGE: TrendSeries = {
  key: "average",
  label: "7-day average",
  kind: "line",
  color: CHART.brand,
  dashed: true,
  rightAxis: true,
};

/** Is it getting better or worse? A one-line verdict (the last 7 days against the 7 before), then minutes lost per day
 *  as bars and the overrun rate as a line with its 7-day average. */
export default function TrendCard({ query, ask }: { query: UseQueryResult<TeaTrend>; ask: string }) {
  const trend = query.data;
  const rows = useMemo(() => (trend ? trendRows(trend) : []), [trend]);
  const weekly = trend?.granularity === "week";
  const series = weekly ? [MINUTES_LOST, OVERRUN_RATE] : [MINUTES_LOST, OVERRUN_RATE, AVERAGE];
  const verdict = trend?.momentum.verdict;
  const VerdictIcon = verdict ? VERDICT_ICON[verdict] : Minus;

  return (
    <SectionCard
      title="Is it getting better or worse?"
      subtitle={
        trend
          ? `${weekly ? "Week by week" : "Day by day"}: minutes lost, and the share of breaks that ran past ${trend.allowedMinutes} minutes`
          : undefined
      }
      loading={query.isPending}
      provenance={trend?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-tea-break-trend"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : trend && verdict && hasMeasuredBreaks(trend) ? (
        <>
          <div
            className={cn("mb-3 flex items-start gap-2 rounded-xl border p-3 text-sm", VERDICT_STYLE[verdict].box)}
            data-testid="md-tea-break-verdict"
            data-verdict={verdict}
          >
            <VerdictIcon size={16} className="mt-0.5 shrink-0" aria-label={VERDICT_STYLE[verdict].label} />
            <p>{trend.momentum.text}</p>
          </div>
          <TrendChart
            data={rows}
            xKey="date"
            series={series}
            height={260}
            xFormat={dayShort}
            yFormat={(v) => num(v)}
            rightFormat={(v) => pct(v, 0)}
          />
          {trend.worstDay && (
            <p className="mt-2 text-xs text-[#006496]/70" data-testid="md-tea-break-worst-day">
              Worst day: {dayLong(trend.worstDay.date)}, {minutesText(trend.worstDay.minutesLost)} lost
              {trend.worstDay.overrunPct != null ? ` (${pct(trend.worstDay.overrunPct, 0)} of breaks ran over)` : ""}.
            </p>
          )}
          {weekly && (
            <p className="mt-1 text-[11px] text-[#006496]/55">
              Each point is a week (Monday to Sunday), labelled by its first day.
            </p>
          )}
        </>
      ) : trend ? (
        <EmptyBlock title="No measured breaks in this period" testId="md-tea-break-trend-empty">
          Nobody scanned a completed tea break for this selection, so there is no overrun rate to chart.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
