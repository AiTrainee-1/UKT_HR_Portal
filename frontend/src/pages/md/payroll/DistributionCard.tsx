import { useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART, axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { PillTabs } from "@/components/ui/pill-tabs";
import { inr, inrCompact, num } from "@/lib/md/format";
import { bandRows, type BandKind } from "./logic";
import { CardError, Metric, emptyReason, failed } from "./parts";
import type { PayrollQueries } from "./queries";

const KINDS: { value: BandKind; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Staff" },
  { value: "production", label: "Production" },
];

/** How take-home pay is spread (people per net-pay band; counts only, never a name) and gross pay by designation. */
export default function DistributionCard({ query, label }: { query: PayrollQueries["distribution"]; label: string }) {
  const [kind, setKind] = useState<BandKind>("all");
  const data = query.data;
  const rows = bandRows(data?.bands ?? [], kind);
  const stats = data?.stats;
  return (
    <SectionCard
      testId="md-payroll-distribution"
      title="How take-home pay is spread"
      subtitle={`People by net pay in ${label}, and cost by designation`}
      loading={query.isPending}
      provenance={data?.provenance}
      provenanceIds={["distribution"]}
      actions={<AskAiButton question={`How is take-home pay spread across employees in ${label}?`} />}
    >
      {failed(query) ? (
        <CardError query={query} />
      ) : !data?.hasData || !stats ? (
        <EmptyBlock title="No pay to spread">
          {emptyReason(data?.notes, "There is no payroll for this month in this selection.")}
        </EmptyBlock>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 @xl:grid-cols-4" data-testid="md-payroll-distribution-stats">
            <Metric label="Median take-home" value={inrCompact(stats.median)} />
            <Metric label="Average take-home" value={inrCompact(stats.average)} />
            <Metric
              label="Lowest · highest"
              value={
                <>
                  <span className="whitespace-nowrap">{inrCompact(stats.lowest)}</span>
                  {" · "}
                  <span className="whitespace-nowrap">{inrCompact(stats.highest)}</span>
                </>
              }
            />
            <Metric label="Under ₹10,000" value={num(stats.belowTenThousand)} sub={`of ${num(stats.people)} people`} />
          </div>
          <PillTabs size="sm" items={KINDS} value={kind} onChange={(v) => setKind(v as BandKind)} />
          <div className="overflow-x-auto">
            <div style={{ height: 220, minWidth: 440 }} data-testid="md-payroll-distribution-chart">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 18, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis dataKey="tick" tick={axisStyle} axisLine={false} tickLine={false} interval={0} />
                  <YAxis allowDecimals={false} tick={axisStyle} axisLine={false} tickLine={false} width={40} />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ fill: "rgba(0,100,150,.05)" }}
                    formatter={(value) => [`${num(Number(value))} people`, "Net pay band"]}
                    labelFormatter={(_, items) => items?.[0]?.payload?.label ?? ""}
                  />
                  <Bar dataKey="count" fill={CHART.brand} radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    <LabelList dataKey="count" position="top" fontSize={10} fill="#1a3a4a" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <h4 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
              Gross pay by designation
            </h4>
            <BarList
              testId="md-payroll-designation-bars"
              color={CHART.sky}
              items={data.byDesignation.slice(0, 6).map((d) => ({
                key: d.designation,
                label: d.designation,
                value: d.grossPay,
                display: inrCompact(d.grossPay),
                sub: `${num(d.headcount)} ${d.headcount === 1 ? "person" : "people"}${
                  d.averageGrossPay != null ? ` · average ${inr(d.averageGrossPay)}` : ""
                }`,
              }))}
            />
            {data.designationsTotal > 6 && (
              <p className="mt-1 text-[11px] text-[#006496]/60">Top 6 of {data.designationsTotal} designations.</p>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
