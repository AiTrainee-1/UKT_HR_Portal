import { useMemo, useState } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { TrendingUp } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { minutesText, num } from "@/lib/md/format";
import SegTabs from "../embedded/shared/SegTabs";
import { hasTrendData, periodPhrase, trendLabel, trendRows, type TrendView } from "./logic";
import type { TrendResponse } from "./types";

const VIEWS = [
  { value: "counts", label: "Visits & outpasses" },
  { value: "time", label: "Time out" },
];

/** Visits and outpasses over the period (a point per day, per week once the period is long), or the time spent out. */
export default function TrendCard({ query }: { query: UseQueryResult<TrendResponse> }) {
  const [view, setView] = useState<TrendView>("counts");
  const d = query.isError ? undefined : query.data;
  const rows = useMemo(() => trendRows(d?.points ?? []), [d]);
  const showForms = (d?.totals.gateFormExits ?? 0) > 0;

  const series: TrendSeries[] =
    view === "counts"
      ? [
          { key: "visits", label: "Visits", kind: "bar", color: CHART.brand },
          { key: "passes", label: "Outpass requests", kind: "line", color: CHART.deep },
          ...(showForms
            ? [
                {
                  key: "gateFormExits",
                  label: "Gate-form exits",
                  kind: "line" as const,
                  color: CHART.slate,
                  dashed: true,
                },
              ]
            : []),
        ]
      : [{ key: "minutesOut", label: "Time out on outpasses", kind: "area", color: CHART.deep }];

  return (
    <SectionCard
      title="Visitors and outpasses over time"
      subtitle={
        d ? (d.granularity === "week" ? "One point per week (Monday to Sunday)" : "One point per day") : undefined
      }
      loading={query.isPending}
      provenance={query.data?.provenance}
      provenanceIds={view === "counts" ? ["trend"] : ["trend", "hours-out"]}
      actions={
        <AskAiButton
          question={`How have visitors and outpasses changed ${periodPhrase(d?.period)}? Was any day unusual?`}
        />
      }
      testId="md-visitors-trend"
    >
      {query.isError ? (
        <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
      ) : d && !hasTrendData(d.points) ? (
        <EmptyBlock icon={TrendingUp} title="Nothing recorded in this period" testId="md-visitors-trend-empty">
          No visitor checked in and no outpass was requested between {d.period?.label ?? "these dates"}.
        </EmptyBlock>
      ) : (
        <div className="space-y-3">
          <div className="max-w-full" data-testid="md-visitors-trend-tabs">
            <SegTabs label="What to chart" items={VIEWS} value={view} onChange={(v) => setView(v as TrendView)} />
          </div>
          <TrendChart
            data={rows}
            xKey="key"
            series={series}
            xFormat={trendLabel(d?.granularity ?? "day")}
            yFormat={view === "time" ? (v) => minutesText(v) : (v) => num(v)}
            height={250}
          />
          {d && (
            <p className="md-analytics-note" data-testid="md-visitors-trend-totals">
              In the period: {num(d.totals.visits)} visits · {num(d.totals.passes)} outpass requests ·{" "}
              {minutesText(d.totals.minutesOut)} out
              {showForms ? ` · ${num(d.totals.gateFormExits)} gate-form exits` : ""}
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}
