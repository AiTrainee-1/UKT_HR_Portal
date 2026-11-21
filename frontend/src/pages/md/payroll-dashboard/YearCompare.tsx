// The year-on-year card of both sides of the Payroll page: the year so far (January to the chosen month) against the same
// months a year before, the whole year before, and a Jan-Dec chart of this year's months beside last year's.

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART, axisStyle, gridProps } from "@/components/md/kit/chartTheme";
import { inr, inrCompact, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { arrowText, axisMoney, deltaOf } from "./logic";
import { ChartFrame, ChartLegend, Explain, Figure, TooltipCard, type LegendItem } from "./parts";
import type { PayChange, PayYearMonth } from "./types";

/** One side of the comparison, whichever payroll it comes from. */
export type YearSide = {
  label: string;
  months: number;
  companyCost: number;
  netPaid: number;
  /** staff: earned salary; production: gross pay */
  pay: number;
  bonus: number;
  deductions: number;
  employees: number;
};

export type YearChanges = Partial<
  Record<"companyCost" | "netPaid" | "pay" | "bonus" | "deductions" | "employees", PayChange>
>;

export type YearRow = { key: string; label: string; current: number | null; previous: number | null };

/** The Jan-Dec rows of the chart: company cost this year and the year before (null: no payroll that month). */
export function yearRows(months: PayYearMonth[] | undefined): YearRow[] {
  return (months ?? []).map((m) => ({
    key: String(m.month),
    label: m.label,
    current: m.current?.companyCost ?? null,
    previous: m.previous?.companyCost ?? null,
  }));
}

const LEGEND = (year: number): LegendItem[] => [
  { key: "previous", label: String(year - 1), color: CHART.slate, shape: "bar" },
  { key: "current", label: String(year), color: CHART.brand, shape: "bar" },
];

type TipProps = { active?: boolean; payload?: { payload?: YearRow }[] };

function YearTip({ year, ...props }: TipProps & { year: number }) {
  const row = props.active ? props.payload?.[0]?.payload : undefined;
  if (!row) return null;
  return (
    <TooltipCard
      title={row.label}
      lines={[
        {
          label: String(year),
          value: row.current == null ? "no payroll" : inr(row.current),
          color: CHART.brand,
          strong: true,
        },
        { label: String(year - 1), value: row.previous == null ? "no payroll" : inr(row.previous), color: CHART.slate },
      ]}
      foot="Company cost"
    />
  );
}

export function YearChart({ rows, year, height = 220 }: { rows: YearRow[]; year: number; height?: number }) {
  return (
    <ChartFrame height={height} testId="md-pay-year-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barCategoryGap="24%" barGap={2}>
          <CartesianGrid {...gridProps} />
          <XAxis dataKey="label" tick={axisStyle} axisLine={false} tickLine={false} interval={0} minTickGap={0} />
          <YAxis
            tickFormatter={(v: number) => axisMoney(v)}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <Tooltip content={<YearTip year={year} />} cursor={{ fill: CHART.grid }} />
          <Bar dataKey="previous" fill={CHART.slate} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
          <Bar dataKey="current" fill={CHART.brand} radius={[4, 4, 0, 0]} maxBarSize={16} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

function Delta({
  change,
  goodWhen = "neutral",
}: {
  change: PayChange | undefined;
  goodWhen?: "up" | "down" | "neutral";
}) {
  const d = deltaOf(change ?? null, "money", goodWhen);
  if (!d) return null;
  return (
    <span
      className={cn(
        "md-chip md-money-delta ml-1",
        d.tone === "good" && "md-chip-success",
        d.tone === "bad" && "md-chip-danger",
      )}
    >
      {arrowText(d)}
    </span>
  );
}

/**
 * The year so far against the same months a year before. `payLabel` names the pay line of the side ("Earned salary" for
 * staff, "Gross pay" for production).
 */
export default function YearCompare({
  year,
  current,
  previous,
  previousFull,
  change,
  months,
  payLabel,
  sameMonth,
  testId = "md-pay-year",
}: {
  year: number;
  current: YearSide | null;
  previous: YearSide | null;
  previousFull: YearSide | null;
  change: YearChanges | null;
  months: PayYearMonth[] | undefined;
  payLabel: string;
  /** "Sep 2025: ₹4.1 L company cost (+12%)", when the side has one */
  sameMonth?: string | null;
  testId?: string;
}) {
  const rows = yearRows(months);
  const hasLastYear = rows.some((r) => r.previous != null);
  return (
    <SectionCard
      testId={testId}
      title={`${year} so far against ${year - 1}`}
      subtitle={
        current
          ? `${current.label}: ${num(current.months)} month${current.months === 1 ? "" : "s"} with payroll${previous ? `, against ${previous.label}` : ""}`
          : "No payroll this year yet"
      }
      actions={<Explain ids={["yearly"]} />}
    >
      {current ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2.5 @3xl:grid-cols-4" data-testid={`${testId}-figures`}>
            <Figure
              label="Company cost"
              value={
                <>
                  {inrCompact(current.companyCost)}
                  <Delta change={change?.companyCost} />
                </>
              }
              sub={previous ? `was ${inrCompact(previous.companyCost)}` : "nothing to compare a year before"}
              emphasis
              testId={`${testId}-cost`}
            />
            <Figure
              label="Net paid"
              value={
                <>
                  {inrCompact(current.netPaid)}
                  <Delta change={change?.netPaid} />
                </>
              }
              sub={previous ? `was ${inrCompact(previous.netPaid)}` : undefined}
              testId={`${testId}-net`}
            />
            <Figure
              label={payLabel}
              value={inrCompact(current.pay)}
              sub={`${inrCompact(current.deductions)} deducted${current.bonus ? ` · ${inrCompact(current.bonus)} excess - detection` : ""}`}
              testId={`${testId}-pay`}
            />
            <Figure
              label={`Whole of ${year - 1}`}
              value={previousFull ? inrCompact(previousFull.companyCost) : "—"}
              sub={
                previousFull
                  ? `${num(previousFull.months)} month${previousFull.months === 1 ? "" : "s"} · ${num(previousFull.employees)} people`
                  : "no payroll that year"
              }
              testId={`${testId}-last-year`}
            />
          </div>
          {sameMonth && (
            <p className="px-1 text-[12px] font-medium text-md-ink-soft" data-testid={`${testId}-same-month`}>
              {sameMonth}
            </p>
          )}
          {rows.length > 0 && (
            <div>
              <YearChart rows={rows} year={year} />
              <ChartLegend items={LEGEND(year)} testId={`${testId}-legend`} />
              {!hasLastYear && (
                <p className="mt-1 px-1 text-[11.5px] text-md-ink-soft">
                  There is no payroll in {year - 1} to set beside it.
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <p className="md-panel-sand px-3 py-6 text-center text-[13px] text-md-ink-soft">No payroll in {year} yet.</p>
      )}
    </SectionCard>
  );
}
