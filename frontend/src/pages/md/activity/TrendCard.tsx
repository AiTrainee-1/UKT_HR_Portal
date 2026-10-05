import { LineChart } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import TrendChart, { type TrendSeries } from "@/components/md/kit/TrendChart";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayShort, num } from "@/lib/md/format";
import { ask, trendCaption, trendRows } from "./logic";
import type { ActivityTrend } from "./types";

const SERIES: TrendSeries[] = [
  { key: "actions", label: "Actions", kind: "area", color: CHART.brand },
  { key: "sensitive", label: "Sensitive", kind: "line", color: CHART.bad },
  { key: "afterHours", label: "After hours", kind: "line", color: CHART.warn, dashed: true },
];

/** Actions over time with the sensitive ones laid over them (a week at a time for long periods). */
export default function TrendCard({ params, label }: { params: MdQueryParams; label: string }) {
  const q = useMdQuery<ActivityTrend>("activity/trend", params);
  const t = q.data;
  return (
    <SectionCard
      title="Activity over time"
      subtitle="Actions each day, with the sensitive and after-hours ones marked"
      provenance={t?.provenance}
      provenanceIds={["trend", "sensitive"]}
      loading={q.isPending}
      actions={<AskAiButton question={ask.trend(label)} />}
      testId="md-activity-trend"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : t && t.total.actions === 0 ? (
        <EmptyBlock icon={LineChart} title="No activity in this period" testId="md-activity-trend-empty">
          Nothing was done in the HR portal, or the audit trail holds no entries for these dates.
        </EmptyBlock>
      ) : t ? (
        <>
          <TrendChart
            data={trendRows(t)}
            xKey="date"
            series={SERIES}
            xFormat={dayShort}
            yFormat={(n) => num(n)}
            height={240}
          />
          <p className="mt-2 text-xs text-[#006496]/60" data-testid="md-activity-trend-caption">
            {trendCaption(t)}
          </p>
        </>
      ) : null}
    </SectionCard>
  );
}
