import { useState } from "react";
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import { CHART, axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { useElementWidth } from "@/components/payroll/statement/use-element-width";
import { inr, inrCompact, num } from "@/lib/md/format";
import { bandRows, bandTickLines, type BandKind } from "./logic";
import { CardError, Metric, OVERLINE, SegTabs, emptyReason, failed } from "./parts";
import type { PayrollQueries } from "./queries";

const KINDS: { value: BandKind; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "staff", label: "Staff" },
  { value: "production", label: "Production" },
];

/** Narrower than this (a phone's card) the histogram fits the card instead of scrolling, its band names on two lines. */
const HISTOGRAM_NARROW = 440;

/** A band's name under a narrow column, on two short lines (see bandTickLines). */
function BandTick({ x = 0, y = 0, payload }: { x?: number; y?: number; payload?: { value?: string } }) {
  const lines = bandTickLines(String(payload?.value ?? ""));
  return (
    <text x={x} y={y} textAnchor="middle" fontSize={11} fill={axisStyle.fill}>
      {lines.map((line, i) => (
        <tspan key={line} x={x} dy={i === 0 ? 10 : 12}>
          {line}
        </tspan>
      ))}
    </text>
  );
}

/** How take-home pay is spread (people per net-pay band; counts only, never a name) and gross pay by designation. */
export default function DistributionCard({ query, label }: { query: PayrollQueries["distribution"]; label: string }) {
  const [kind, setKind] = useState<BandKind>("all");
  const data = query.data;
  const rows = bandRows(data?.bands ?? [], kind);
  const stats = data?.stats;
  // 0 until measured (and in a test DOM): the wide chart
  const [measure, boxWidth] = useElementWidth<HTMLDivElement>();
  const narrow = boxWidth > 0 && boxWidth < HISTOGRAM_NARROW;
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
          <div className="grid grid-cols-2 gap-3 @xl:grid-cols-4" data-testid="md-payroll-distribution-stats">
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
          <SegTabs label="People in the histogram" items={KINDS} value={kind} onChange={setKind} />
          <div className="overflow-x-auto" ref={measure}>
            <div
              style={narrow ? { height: 210 } : { height: 220, minWidth: 440 }}
              data-testid="md-payroll-distribution-chart"
              data-layout={narrow ? "fit" : undefined}
            >
              <ResponsiveContainer width="100%" height="100%">
                {/* about 30 px of the axis stays visible either way: a three-figure count ("100") needs all of it */}
                <BarChart data={rows} margin={{ top: 18, right: 8, left: narrow ? -2 : -10, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis
                    dataKey="tick"
                    tick={narrow ? <BandTick /> : axisStyle}
                    {...(narrow ? { height: 36 } : {})}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={axisStyle}
                    axisLine={false}
                    tickLine={false}
                    width={narrow ? 32 : 40}
                  />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    cursor={{ fill: "var(--md-wine)", fillOpacity: 0.05 }}
                    formatter={(value) => [`${num(Number(value))} people`, "Net pay band"]}
                    labelFormatter={(_, items) => items?.[0]?.payload?.label ?? ""}
                  />
                  <Bar dataKey="count" fill={CHART.brand} radius={[6, 6, 0, 0]} isAnimationActive={false}>
                    <LabelList dataKey="count" position="top" fontSize={11} fontWeight={700} fill="var(--md-ink-800)" />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div>
            <h4 className={`mb-3 ${OVERLINE}`}>Gross pay by designation</h4>
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
              <p className="mt-2 text-[11.5px] text-md-ink-soft">Top 6 of {data.designationsTotal} designations.</p>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}
