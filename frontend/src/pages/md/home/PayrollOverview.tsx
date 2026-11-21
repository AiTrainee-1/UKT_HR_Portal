import { useState } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Link } from "wouter";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import { StackedColumns } from "@/components/md/kit/LiteCharts";
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

const PAY_SERIES = [
  { key: "staff", label: "Staff", color: HOME_COLORS.staff },
  { key: "production", label: "Production", color: HOME_COLORS.production },
] as const;

function PayTip({ row, running }: { row: PayRow; running: boolean }) {
  return (
    <div>
      <p className="mb-1 font-extrabold">
        {row.label}
        {row.current ? (running ? " (this month)" : " (chosen month)") : row.previous ? " (month before)" : ""}
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
 * Monthly Payroll: the chosen month (the running one by default, still running) and the month before it, side by side
 * with the change, then the six months ending with it as stacked staff / production columns with the people paid as a
 * line (light chart, kit/LiteCharts). Gross or net, by the pills. "Payroll analysis" opens /md/payroll on that month.
 */
export default function PayrollOverview({
  months,
  month,
  loading,
  error,
  onRetry,
}: {
  months: PayrollMonth[] | undefined;
  /** The Dashboard's month ("2026-11"), when one was chosen; the running month otherwise. */
  month?: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [measure, setMeasure] = useState<PayMeasure>("gross");
  const list = months ?? [];
  const pair = currentAndPrevious(list);
  const rows = payrollRows(list, measure);
  const hasPay = rows.some((r) => r.total > 0);
  const running = !!pair.current?.current;
  const analysis = month ? `/md/payroll?month=${month}` : "/md/payroll";

  return (
    <Reveal
      index={3}
      className="md-card md-dashboard-card md-dashboard-defer @container"
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
        <Link href={analysis} className="md-btn md-btn-soft md-btn-sm" data-testid="md-home-pay-link">
          Payroll analysis <ArrowUpRight size={12} aria-hidden />
        </Link>
      </OverviewHeader>

      {loading || error || !months ? (
        <CardState loading={loading || (!error && !months)} error={error} onRetry={onRetry} shape="payroll" />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-2 @[28rem]:gap-3 @3xl:gap-4">
            <MonthCard
              title={running ? "Current month" : "Chosen month"}
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
              <StackedColumns
                className="h-[220px] @lg:h-[280px]"
                testId="md-home-pay-chart"
                ariaLabel="Payroll month by month: staff and production, with the people paid"
                rows={rows}
                series={PAY_SERIES}
                rowKey={(r) => r.month}
                label={(r) => r.label}
                value={(r, key) => r[key as "staff" | "production"]}
                dim={(r) => !(r.current || r.previous)}
                yFormat={(v) => inrCompact(v)}
                axisWidth={52}
                line={{ value: (r) => r.people, color: CHART.gold }}
                tooltip={(r) => <PayTip row={r} running={running} />}
              />
            )}
            <p className="mt-2 text-[11px] font-medium text-md-ink-soft">
              {running
                ? "The last two bars are this month and last month; the earlier months are lighter."
                : `The last two bars are ${pair.current?.label ?? "the chosen month"} and the month before; the earlier months are lighter.`}
              {pair.peopleChange != null && pair.peopleChange !== 0
                ? ` ${num(Math.abs(pair.peopleChange))} ${pair.peopleChange > 0 ? "more" : "fewer"} people paid ${running ? "this month so far" : "that month"} than the month before.`
                : ""}
              {pair.current?.figures && pair.previous?.figures
                ? ` ${running ? "This month so far" : "That month"} is ${pct((100 * pair.current.figures.grossPay) / Math.max(1, pair.previous.figures.grossPay), 0)} of the month before's gross.`
                : ""}
            </p>
          </div>
        </div>
      )}
    </Reveal>
  );
}
