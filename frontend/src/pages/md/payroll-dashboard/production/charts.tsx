// The Production side's charts (recharts), in the page's colours: a cycle's periods, the production months by cycle, the
// departments of a period and one worker's periods. Bars that stand for a period are buttons: a click picks it.

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, axisStyle, gridProps } from "@/components/md/kit/chartTheme";
import { inr, num, pct } from "@/lib/md/format";
import { axisMoney, shortName } from "../logic";
import { ChartFrame, TooltipCard, type LegendItem, type TooltipLine } from "../parts";
import type { ProdCycle } from "../types";
import { CYCLE_LABEL, type MonthCycleRow, type PeriodChartRow, type ProdDeptBar, type WorkerChartRow } from "./logic";

export const PROD_COLORS = {
  netPaid: CHART.brand,
  deductions: CHART.sky,
  companyCost: CHART.deep,
  grossPay: CHART.teal,
  shifts: CHART.gold,
} as const;

export const CYCLE_COLORS: Record<ProdCycle, string> = {
  weekly: CHART.info,
  biweekly: CHART.brand,
  monthly: CHART.teal,
  none: CHART.slate,
};

const BAND = { fill: CHART.brand, fillOpacity: 0.07, stroke: "none", ifOverflow: "extendDomain" } as const;
const cursor = { fill: CHART.grid };
const tickMoney = (v: number) => axisMoney(v);

type TipProps<T> = { active?: boolean; payload?: { payload?: T }[] };
const rowOf = <T,>(p: TipProps<T>): T | undefined => (p.active ? p.payload?.[0]?.payload : undefined);
const clicked = <T,>(entry: unknown): T | undefined => (entry as { payload?: T } | undefined)?.payload;

// ── a cycle's periods ────────────────────────────────────────────────────────────────────────────────────────────

export const PERIOD_LEGEND: LegendItem[] = [
  { key: "netPaid", label: "Net paid", color: PROD_COLORS.netPaid, shape: "bar" },
  { key: "deductions", label: "Deductions", color: PROD_COLORS.deductions, shape: "bar" },
  { key: "companyCost", label: "Company cost", color: PROD_COLORS.companyCost, shape: "line" },
];

function PeriodTip(props: TipProps<PeriodChartRow>) {
  const row = rowOf(props);
  if (!row) return null;
  const lines: TooltipLine[] = [
    { label: "Gross pay", value: inr(row.grossPay) },
    { label: "Excess - detection", value: inr(row.bonus) },
    { label: "Deductions", value: inr(row.deductions), color: PROD_COLORS.deductions },
    { label: "Net paid", value: inr(row.netPaid), color: PROD_COLORS.netPaid, strong: true },
    { label: "Company cost", value: inr(row.companyCost), color: PROD_COLORS.companyCost, shape: "line", strong: true },
  ];
  return (
    <TooltipCard
      title={row.label}
      lines={lines}
      foot={`${num(row.employees)} workers · ${num(row.shifts, 1)} shifts · click to open`}
    />
  );
}

/** Net paid + deductions per period (stacked), company cost over them; the chosen period marked by a band. */
export function PeriodTrendChart({
  rows,
  onSelect,
  height = 300,
}: {
  rows: PeriodChartRow[];
  onSelect?: (key: string) => void;
  height?: number;
}) {
  const chosen = rows.find((r) => r.selected)?.key ?? null;
  const pick = (entry: unknown) => {
    const row = clicked<PeriodChartRow>(entry);
    if (row && onSelect) onSelect(row.key);
  };
  return (
    <ChartFrame height={height} testId="md-prod-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tickFormatter={(key: string) => rows.find((r) => r.key === key)?.tick ?? ""}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={10}
          />
          {chosen && <ReferenceArea x1={chosen} x2={chosen} {...BAND} />}
          <YAxis tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<PeriodTip />} cursor={cursor} />
          <Bar
            dataKey="netPaid"
            stackId="pay"
            fill={PROD_COLORS.netPaid}
            maxBarSize={34}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
          <Bar
            dataKey="deductions"
            stackId="pay"
            fill={PROD_COLORS.deductions}
            maxBarSize={34}
            radius={[5, 5, 0, 0]}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
          <Line
            dataKey="companyCost"
            stroke={PROD_COLORS.companyCost}
            strokeWidth={2.4}
            dot={{ r: 2.5, fill: PROD_COLORS.companyCost, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── production months by cycle ───────────────────────────────────────────────────────────────────────────────────

export const monthLegend = (cycles: ProdCycle[]): LegendItem[] =>
  cycles.map((c) => ({ key: c, label: CYCLE_LABEL[c], color: CYCLE_COLORS[c], shape: "bar" }));

function MonthTip({ cycles, ...props }: TipProps<MonthCycleRow> & { cycles: ProdCycle[] }) {
  const row = rowOf(props);
  if (!row) return null;
  const lines: TooltipLine[] = [
    ...cycles
      .filter((c) => row[c] != null)
      .map((c) => ({ label: CYCLE_LABEL[c], value: inr(row[c] ?? 0), color: CYCLE_COLORS[c] })),
    { label: "Company cost", value: inr(row.companyCost), strong: true },
    { label: "Net paid", value: inr(row.netPaid) },
  ];
  return (
    <TooltipCard
      title={row.label}
      lines={lines}
      foot={`${num(row.employees)} workers · ${num(row.periods)} pay period${row.periods === 1 ? "" : "s"}`}
    />
  );
}

/** Company cost of production per month, each cycle its own stacked part. */
export function MonthCycleChart({
  rows,
  cycles,
  height = 240,
}: {
  rows: MonthCycleRow[];
  cycles: ProdCycle[];
  height?: number;
}) {
  return (
    <ChartFrame height={height} testId="md-prod-month-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barCategoryGap="24%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tickFormatter={(key: string) => rows.find((r) => r.key === key)?.label.slice(0, 3) ?? ""}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          <YAxis tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<MonthTip cycles={cycles} />} cursor={cursor} />
          {cycles.map((c, i) => (
            <Bar
              key={c}
              dataKey={c}
              stackId="cycles"
              fill={CYCLE_COLORS[c]}
              maxBarSize={34}
              radius={i === cycles.length - 1 ? [5, 5, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── departments of a period ──────────────────────────────────────────────────────────────────────────────────────

function DeptTip(props: TipProps<ProdDeptBar>) {
  const row = rowOf(props);
  if (!row) return null;
  return (
    <TooltipCard
      title={row.name}
      lines={[
        { label: "Company cost", value: inr(row.companyCost), color: PROD_COLORS.companyCost, strong: true },
        { label: "Net paid", value: inr(row.netPaid), color: PROD_COLORS.netPaid },
        { label: "Share", value: pct(row.sharePct) },
      ]}
      foot="click to see its workers"
    />
  );
}

/** One horizontal bar per department: company cost, net paid beside it. */
export function DeptChart({ rows, onSelect }: { rows: ProdDeptBar[]; onSelect?: (name: string) => void }) {
  const height = Math.max(180, rows.length * 34 + 40);
  const pick = (entry: unknown) => {
    const row = clicked<ProdDeptBar>(entry);
    if (row && onSelect) onSelect(row.name.replace(/ \(.*\)$/, ""));
  };
  return (
    <ChartFrame height={height} phoneCap={false} testId="md-prod-dept-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }} barGap={2}>
          <CartesianGrid {...gridProps} horizontal={false} vertical />
          <XAxis type="number" tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            tickFormatter={(name: string) => shortName(name, 14)}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            width={96}
          />
          <Tooltip content={<DeptTip />} cursor={cursor} />
          <Bar
            dataKey="companyCost"
            fill={PROD_COLORS.companyCost}
            radius={[0, 4, 4, 0]}
            maxBarSize={14}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
          <Bar
            dataKey="netPaid"
            fill={PROD_COLORS.netPaid}
            radius={[0, 4, 4, 0]}
            maxBarSize={14}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

export const DEPT_LEGEND: LegendItem[] = [
  { key: "companyCost", label: "Company cost", color: PROD_COLORS.companyCost, shape: "bar" },
  { key: "netPaid", label: "Net paid", color: PROD_COLORS.netPaid, shape: "bar" },
];

// ── one worker's periods ─────────────────────────────────────────────────────────────────────────────────────────

export const WORKER_LEGEND: LegendItem[] = [
  { key: "netPaid", label: "Net paid", color: PROD_COLORS.netPaid, shape: "bar" },
  { key: "deductions", label: "Deductions", color: PROD_COLORS.deductions, shape: "bar" },
  { key: "shifts", label: "Shifts", color: PROD_COLORS.shifts, shape: "line" },
];

function WorkerTip(props: TipProps<WorkerChartRow>) {
  const row = rowOf(props);
  if (!row) return null;
  return (
    <TooltipCard
      title={row.label}
      lines={[
        { label: "Net paid", value: inr(row.netPaid), color: PROD_COLORS.netPaid, strong: true },
        { label: "Deductions", value: inr(row.deductions), color: PROD_COLORS.deductions },
        { label: "Shifts", value: num(row.shifts, 1), color: PROD_COLORS.shifts, shape: "line" },
      ]}
      foot="click to see its days"
    />
  );
}

export function WorkerChart({
  rows,
  selected,
  onSelect,
  height = 240,
}: {
  rows: WorkerChartRow[];
  selected?: string | null;
  onSelect?: (key: string) => void;
  height?: number;
}) {
  const pick = (entry: unknown) => {
    const row = clicked<WorkerChartRow>(entry);
    if (row && onSelect) onSelect(row.key);
  };
  return (
    <ChartFrame height={height} testId="md-prod-worker-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 0, left: -6, bottom: 0 }} barCategoryGap="24%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tickFormatter={(key: string) => rows.find((r) => r.key === key)?.tick ?? ""}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
          />
          {selected && <ReferenceArea yAxisId="money" x1={selected} x2={selected} {...BAND} />}
          <YAxis
            yAxisId="money"
            tickFormatter={tickMoney}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <YAxis yAxisId="shifts" orientation="right" tick={axisStyle} axisLine={false} tickLine={false} width={28} />
          <Tooltip content={<WorkerTip />} cursor={cursor} />
          <Bar
            yAxisId="money"
            dataKey="netPaid"
            stackId="pay"
            fill={PROD_COLORS.netPaid}
            maxBarSize={30}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
          <Bar
            yAxisId="money"
            dataKey="deductions"
            stackId="pay"
            fill={PROD_COLORS.deductions}
            maxBarSize={30}
            radius={[5, 5, 0, 0]}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
          <Line
            yAxisId="shifts"
            dataKey="shifts"
            stroke={PROD_COLORS.shifts}
            strokeWidth={2.2}
            dot={{ r: 2.5, fill: PROD_COLORS.shifts, strokeWidth: 0 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
