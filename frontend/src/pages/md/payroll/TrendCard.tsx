import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { inrCompact, num } from "@/lib/md/format";
import { tickMonth, trendChartRows } from "./logic";
import { CardError, Metric, failed } from "./parts";
import type { PayrollQueries } from "./queries";

/** Twelve months of gross pay (bars, lighter where the month is still provisional) and people paid (line). */
export default function TrendCard({ query }: { query: PayrollQueries["trend"] }) {
  const data = query.data;
  const rows = data?.hasData ? trendChartRows(data.months) : [];
  const anyProvisional = rows.some((r) => r.grossProvisional != null);
  return (
    <SectionCard
      testId="md-payroll-trend"
      title="Payroll cost, last 12 months"
      subtitle="Gross pay (bars) and people paid (line)"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question="How has payroll cost moved over the last 12 months, and is overtime rising?" />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : rows.length === 0 ? (
        <EmptyBlock title="No payroll to chart yet">
          The trend appears once HR has generated payroll for at least one month.
        </EmptyBlock>
      ) : (
        <>
          <TrendChart
            data={rows}
            xKey="month"
            height={260}
            xFormat={tickMonth}
            yFormat={inrCompact}
            rightFormat={num}
            series={[
              { key: "gross", label: "Gross pay", kind: "bar", color: CHART.brand, stackId: "gross" },
              {
                key: "grossProvisional",
                label: "Gross pay (provisional)",
                kind: "bar",
                color: CHART.light,
                stackId: "gross",
              },
              { key: "headcount", label: "People paid", kind: "line", color: CHART.deep, rightAxis: true },
            ]}
          />
          {anyProvisional && (
            <p className="mt-2 text-[11.5px] leading-snug text-md-ink-soft">
              Lighter bars are months still running or with staff slips generated before month end: they understate pay.
            </p>
          )}
          <div className="mt-4 grid grid-cols-1 gap-3 @xl:grid-cols-3">
            <Metric label="Average month" value={data?.average != null ? inrCompact(data.average) : "—"} />
            <Metric
              label="Highest month"
              value={data?.highest ? inrCompact(data.highest.grossPay) : "—"}
              sub={data?.highest?.label}
            />
            <Metric
              label="Lowest month"
              value={data?.lowest ? inrCompact(data.lowest.grossPay) : "—"}
              sub={data?.lowest?.label}
            />
          </div>
        </>
      )}
    </SectionCard>
  );
}
