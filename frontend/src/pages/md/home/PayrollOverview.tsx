import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Link } from "wouter";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART, axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
import { inr, inrCompact, num, pct, signed } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { currentAndPrevious, payrollRows, staffShare, type PayMeasure, type PayRow } from "./home-logic";
import type { PayrollMonth } from "./home-types";
import { CountUp, Reveal } from "./motion";
import { CardState, HOME_COLORS, LegendDot, OverviewHeader, Pills } from "./parts";

const MEASURES: { value: PayMeasure; label: string }[] = [
  { value: "gross", label: "Gross pay" },
  { value: "net", label: "Net pay" },
];

const STATE_TONE: Record<PayrollMonth["state"], string> = {
  paid: "md-chip-success",
  part_paid: "md-chip-warning",
  // Payroll Done (the month is locked), payment still pending
  finalized: "md-chip-warning",
  generated: "md-chip-warning",
  in_progress: "",
  not_generated: "md-chip-danger",
  not_started: "",
  no_data: "",
};

/** "▲ +12.3%" against the month before; for pay a rise is shown plainly (more pay is neither good nor bad by itself). */
function Change({ value, suffix }: { value: number | null; suffix: string }) {
  if (value == null) return null;
  const Arrow = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus;
  return (
    <span className="md-chip tabular-nums" data-testid="md-home-pay-change">
      <Arrow size={12} aria-hidden />
      {signed(value)}% {suffix}
    </span>
  );
}

/** One month: its state, the chosen pay figure counting up, the other figure, people paid, and the staff / production
 *  split as a bar with both amounts. */
function MonthCard({
  title,
  month,
  measure,
  change,
  previousLabel,
  testId,
}: {
  title: string;
  month: PayrollMonth | null;
  measure: PayMeasure;
  change?: number | null;
  previousLabel?: string;
  testId: string;
}) {
  const figures = month?.figures ?? null;
  const main = figures ? (measure === "gross" ? figures.grossPay : figures.netPay) : 0;
  const other = figures ? (measure === "gross" ? figures.netPay : figures.grossPay) : 0;
  const staff = month?.staff ? (measure === "gross" ? month.staff.grossPay : month.staff.netPay) : 0;
  const production = month?.production
    ? measure === "gross"
      ? month.production.grossPay
      : month.production.netPay
    : 0;
  const share = staffShare(month, measure);

  return (
    <div
      className={cn(
        "md-panel relative h-full overflow-hidden rounded-2xl p-3 @3xl:p-5",
        month?.current && "md-panel-wine",
      )}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-md-ink-soft">{title}</p>
          <h3 className="mt-0.5 text-base font-black text-md-ink @3xl:text-lg">{month?.label ?? "—"}</h3>
        </div>
        {month && <span className={cn("md-chip", STATE_TONE[month.state])}>{month.stateLabel}</span>}
      </div>

      {!figures ? (
        <p className="mt-6 text-sm text-md-ink-soft" data-testid={`${testId}-empty`}>
          No payroll has been generated for this month yet.
        </p>
      ) : (
        <>
          <p className="md-dashboard-figure mt-3 text-xl font-black leading-none text-md-ink @[30rem]:text-3xl @3xl:mt-4 @3xl:text-4xl">
            <CountUp value={main} format={(n) => inr(Math.round(n))} testId={`${testId}-value`} />
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-md-ink-soft @3xl:text-xs">
            <span>
              {measure === "gross" ? "Net pay" : "Gross pay"} {inr(other)}
            </span>
            <span aria-hidden className="hidden @3xl:inline">
              ·
            </span>
            <span>{num(figures.headcount)} people paid</span>
            {change !== undefined && (
              <Change value={change ?? null} suffix={`vs ${previousLabel ?? "the month before"}`} />
            )}
          </div>
          <div className="mt-4">
            <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-md-ink/[0.08]" aria-hidden>
              <div className="h-full" style={{ width: `${share ?? 0}%`, backgroundColor: HOME_COLORS.staff }} />
              <div
                className="h-full flex-1"
                style={{ backgroundColor: production > 0 ? HOME_COLORS.production : "transparent" }}
              />
            </div>
            <div className="mt-2 flex flex-wrap justify-between gap-x-2 gap-y-1 text-[11px] @3xl:text-xs">
              <LegendDot color={HOME_COLORS.staff}>
                Staff <b className="tabular-nums text-md-ink">{inrCompact(staff)}</b>
              </LegendDot>
              <LegendDot color={HOME_COLORS.production}>
                Production <b className="tabular-nums text-md-ink">{inrCompact(production)}</b>
              </LegendDot>
            </div>
          </div>
          {month?.current && !month.monthEnded && (
            <p className="mt-3 hidden text-[11px] font-medium leading-snug text-md-ink-soft @3xl:block">
              The month is still running: this is what has been generated so far ({num(month.slips)} slip
              {month.slips === 1 ? "" : "s"}), and staff days still to come count as not worked until it is generated
              again.
            </p>
          )}
        </>
      )}
    </div>
  );
}

function PayTip({ active, payload }: { active?: boolean; payload?: { payload: PayRow }[] }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div style={tooltipStyle}>
      <p className="mb-1 font-extrabold">
        {row.label}
        {row.current ? " (this month)" : row.previous ? " (last month)" : ""}
      </p>
      <p className="font-medium">Staff: {inr(row.staff)}</p>
      <p className="font-medium">Production: {inr(row.production)}</p>
      <p className="font-bold">Total: {inr(row.total)}</p>
      <p className="font-medium">{num(row.people)} people paid</p>
      <p className="mt-1 text-[11px] font-medium opacity-80">{row.state}</p>
    </div>
  );
}

/**
 * Monthly Payroll: the current month (still running) and the month before it, side by side with the change, then the
 * last six months as stacked staff / production bars with the people paid as a line. Gross or net, by the pills.
 */
export default function PayrollOverview({
  months,
  loading,
  error,
  onRetry,
}: {
  months: PayrollMonth[] | undefined;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [measure, setMeasure] = useState<PayMeasure>("gross");
  const list = months ?? [];
  const pair = currentAndPrevious(list);
  const rows = payrollRows(list, measure);
  const hasPay = rows.some((r) => r.total > 0);

  return (
    <Reveal
      index={2}
      className="md-card md-dashboard-card @container"
      testId="md-home-payroll"
      labelledBy="md-home-payroll-title"
    >
      <OverviewHeader
        id="md-home-payroll-title"
        title="Monthly Payroll Overview"
        subtitle="Gross = salary earned + overtime; net = what is paid after deductions. Staff and production slips together."
      >
        <Pills
          label="Which pay figure"
          value={measure}
          options={MEASURES}
          onChange={setMeasure}
          testId="md-home-pay-measure"
        />
        <AskAiButton question="Why did payroll change compared with last month?" />
        <Link href="/md/payroll" className="md-btn md-btn-soft md-btn-sm">
          Payroll analysis <ArrowUpRight size={12} aria-hidden />
        </Link>
      </OverviewHeader>

      {loading || error || !months ? (
        <CardState loading={loading || (!error && !months)} error={error} onRetry={onRetry} />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-2 @[28rem]:gap-3 @3xl:gap-4">
            <MonthCard
              title="Current month"
              month={pair.current}
              measure={measure}
              change={measure === "gross" ? pair.grossChange : pair.netChange}
              previousLabel={pair.previous?.label.split(" ")[0]}
              testId="md-home-pay-current"
            />
            <MonthCard title="Previous month" month={pair.previous} measure={measure} testId="md-home-pay-previous" />
          </div>

          <div className="md-panel rounded-2xl p-3 @lg:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-extrabold text-md-ink">Month by month</h3>
              <div className="flex flex-wrap gap-3">
                <LegendDot color={HOME_COLORS.staff}>Staff</LegendDot>
                <LegendDot color={HOME_COLORS.production}>Production</LegendDot>
                <LegendDot color={CHART.gold}>People paid</LegendDot>
              </div>
            </div>
            {!hasPay ? (
              <p className="py-10 text-center text-sm text-md-ink-soft">
                No payroll has been generated in these months.
              </p>
            ) : (
              <div className="h-[220px] @lg:h-[280px]" data-testid="md-home-pay-chart">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }} barCategoryGap="28%">
                    <CartesianGrid {...gridProps} />
                    <XAxis dataKey="label" tick={axisStyle} axisLine={false} tickLine={false} />
                    <YAxis
                      yAxisId="pay"
                      tick={axisStyle}
                      axisLine={false}
                      tickLine={false}
                      width={52}
                      tickFormatter={(v: number) => inrCompact(v)}
                    />
                    <YAxis
                      yAxisId="people"
                      orientation="right"
                      tick={axisStyle}
                      axisLine={false}
                      tickLine={false}
                      width={36}
                      allowDecimals={false}
                    />
                    <Tooltip content={<PayTip />} cursor={{ fill: "rgba(127, 1, 31, 0.05)" }} />
                    <Bar yAxisId="pay" dataKey="staff" stackId="pay" fill={HOME_COLORS.staff}>
                      {rows.map((r) => (
                        <Cell key={r.month} fillOpacity={r.current || r.previous ? 1 : 0.5} />
                      ))}
                    </Bar>
                    <Bar
                      yAxisId="pay"
                      dataKey="production"
                      stackId="pay"
                      fill={HOME_COLORS.production}
                      radius={[6, 6, 0, 0]}
                    >
                      {rows.map((r) => (
                        <Cell key={r.month} fillOpacity={r.current || r.previous ? 1 : 0.5} />
                      ))}
                    </Bar>
                    <Line
                      yAxisId="people"
                      type="monotone"
                      dataKey="people"
                      stroke={CHART.gold}
                      strokeWidth={2.5}
                      dot={{ r: 3.5, fill: CHART.gold, strokeWidth: 0 }}
                      activeDot={{ r: 5 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="mt-2 text-[11px] font-medium text-md-ink-soft">
              The last two bars are this month and last month; the earlier months are lighter.
              {pair.peopleChange != null && pair.peopleChange !== 0
                ? ` ${num(Math.abs(pair.peopleChange))} ${pair.peopleChange > 0 ? "more" : "fewer"} people paid this month so far than last month.`
                : ""}
              {pair.current?.figures && pair.previous?.figures
                ? ` This month so far is ${pct((100 * pair.current.figures.grossPay) / Math.max(1, pair.previous.figures.grossPay), 0)} of last month's gross.`
                : ""}
            </p>
          </div>
        </div>
      )}
    </Reveal>
  );
}
