// The Payroll page's charts (recharts). Each one draws the same three-part pay bill wherever it fits (what was paid, what
// the slip deducted, what attendance cost), in the same colours, so a month, a department and an employee read alike.
// Bars that stand for a month, a department or a person are buttons: a click picks it.

import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, axisStyle, gridProps } from "@/components/md/kit/chartTheme";
import { MD_CHART } from "@/lib/md/theme";
import { inr, inrCompact, num, pct } from "@/lib/md/format";
import {
  DEDUCTION_KEYS,
  DEDUCTION_LABEL,
  axisMoney,
  daysText,
  monthTick,
  shortName,
  type ClRow,
  type DeductionKey,
  type DeductionRow,
  type DepartmentBar,
  type DepartmentMeasure,
  type FlowRow,
  type PersonBar,
  type PersonChartRow,
} from "./logic";
import { ChartFrame, TooltipCard, type LegendItem, type TooltipLine } from "./parts";

/** One colour per figure, the same on every chart of the page. */
export const PAY_COLORS = {
  netPaid: CHART.brand,
  otherDeductions: CHART.sky,
  attendanceDeduction: CHART.gold,
  companyCost: CHART.deep,
  earnedSalary: CHART.teal,
  actualSalary: CHART.slate,
  averageEarned: CHART.teal,
  averageNetPaid: CHART.brand,
  clAmount: CHART.leave,
  clDays: CHART.deep,
  deductions: CHART.sky,
} as const;

export const DEDUCTION_COLORS: Record<DeductionKey, string> = {
  lossOfPay: MD_CHART.series[7],
  late: CHART.gold,
  pf: CHART.info,
  esi: CHART.teal,
  tds: CHART.deep,
  advance: CHART.leave,
  other: CHART.slate,
};

/** The three parts of the pay bill, bottom to top. */
export const PAY_STACK: LegendItem[] = [
  { key: "netPaid", label: "Net paid", color: PAY_COLORS.netPaid, shape: "bar" },
  { key: "otherDeductions", label: "Other deductions", color: PAY_COLORS.otherDeductions, shape: "bar" },
  { key: "attendanceDeduction", label: "Attendance deductions", color: PAY_COLORS.attendanceDeduction, shape: "bar" },
];

/** The chosen month: a faint wine band behind its bars and its name in wine on the axis (no dimming of the other months,
 *  which would make a faded series look like another one). */
const BAND = { fill: CHART.brand, fillOpacity: 0.07, stroke: "none", ifOverflow: "extendDomain" } as const;

function MonthTick({
  x,
  y,
  payload,
  selected,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
  selected?: string | null;
}) {
  const value = payload?.value ?? "";
  const on = !!selected && value === selected;
  return (
    <text
      x={x}
      y={y}
      dy="0.9em"
      textAnchor="middle"
      fontSize={11}
      fontWeight={on ? 800 : 500}
      fill={on ? CHART.brand : MD_CHART.axis}
    >
      {value ? monthTick(value) : ""}
    </text>
  );
}

const tickMoney = (v: number) => axisMoney(v);
const cursor = { fill: CHART.grid };

type TipProps<T> = { active?: boolean; payload?: { payload?: T }[] };
const rowOf = <T,>(p: TipProps<T>): T | undefined => (p.active ? p.payload?.[0]?.payload : undefined);

/** recharts hands a clicked bar's data row over as `payload` */
const clicked = <T,>(entry: unknown): T | undefined => (entry as { payload?: T } | undefined)?.payload;

// ── the twelve months ─────────────────────────────────────────────────────────────────────────────────────────────

export const TREND_LEGEND: LegendItem[] = [
  ...PAY_STACK,
  { key: "earnedSalary", label: "Earned salary", color: PAY_COLORS.earnedSalary, shape: "dash" },
  { key: "companyCost", label: "Company cost", color: PAY_COLORS.companyCost, shape: "line" },
];

function TrendTip(props: TipProps<FlowRow>) {
  const row = rowOf(props);
  if (!row) return null;
  const lines: TooltipLine[] = [
    { label: "Actual salary", value: inr(row.actualSalary) },
    { label: "Earned salary", value: inr(row.earnedSalary), color: PAY_COLORS.earnedSalary, shape: "dash" },
    { label: "Overtime + bonus", value: inr(row.overtime + row.bonus) },
    { label: "Attendance deductions", value: inr(row.attendanceDeduction), color: PAY_COLORS.attendanceDeduction },
    { label: "Other deductions", value: inr(row.otherDeductions), color: PAY_COLORS.otherDeductions },
    { label: "Net paid", value: inr(row.netPaid), color: PAY_COLORS.netPaid, strong: true },
    { label: "Company cost", value: inr(row.companyCost), color: PAY_COLORS.companyCost, shape: "line", strong: true },
  ];
  return <TooltipCard title={row.label} lines={lines} foot={`${num(row.employees)} employees paid · click to open`} />;
}

/**
 * How the month's pay bill splits, month by month: each bar is net paid + the slip's other deductions + the attendance
 * deductions (together: the actual salary, overtime and bonus before anything was taken), with earned salary and the
 * company cost drawn over it. The chosen month is marked by a faint band and its name in wine.
 */
export function SalaryTrendChart({
  rows,
  onSelect,
  height = 300,
  grow = false,
}: {
  rows: FlowRow[];
  onSelect?: (month: string) => void;
  height?: number;
  /** fill the rest of its card (see ChartFrame) */
  grow?: boolean;
}) {
  const chosen = rows.find((r) => r.selected)?.key ?? null;
  const pick = (entry: unknown) => {
    const row = clicked<FlowRow>(entry);
    if (row && onSelect) onSelect(row.key);
  };
  return (
    <ChartFrame height={height} grow={grow} testId="md-pay-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barCategoryGap="22%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tick={<MonthTick selected={chosen} />}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={10}
          />
          {chosen && <ReferenceArea x1={chosen} x2={chosen} {...BAND} />}
          <YAxis tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<TrendTip />} cursor={cursor} />
          {PAY_STACK.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="pay"
              fill={s.color}
              maxBarSize={34}
              radius={i === PAY_STACK.length - 1 ? [5, 5, 0, 0] : 0}
              onClick={pick}
              cursor={onSelect ? "pointer" : undefined}
              isAnimationActive={false}
            />
          ))}
          <Line
            dataKey="earnedSalary"
            name="Earned salary"
            stroke={PAY_COLORS.earnedSalary}
            strokeWidth={2}
            strokeDasharray="5 4"
            dot={false}
            activeDot={{ r: 4, stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
          <Line
            dataKey="companyCost"
            name="Company cost"
            stroke={PAY_COLORS.companyCost}
            strokeWidth={2.4}
            dot={{ r: 2.5, fill: PAY_COLORS.companyCost, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── deductions by type ────────────────────────────────────────────────────────────────────────────────────────────

export const DEDUCTION_LEGEND: LegendItem[] = DEDUCTION_KEYS.map((k) => ({
  key: k,
  label: DEDUCTION_LABEL[k],
  color: DEDUCTION_COLORS[k],
  shape: "bar",
}));

function DeductionTip(props: TipProps<DeductionRow> & { hidden: Set<string> }) {
  const row = rowOf(props);
  if (!row) return null;
  const shown = DEDUCTION_KEYS.filter((k) => !props.hidden.has(k));
  const total = shown.reduce((a, k) => a + row[k], 0);
  return (
    <TooltipCard
      title={row.label}
      lines={[
        ...[...shown].reverse().map((k) => ({
          label: DEDUCTION_LABEL[k],
          value: inr(row[k]),
          color: DEDUCTION_COLORS[k],
        })),
        { label: "Total shown", value: inr(total), strong: true },
      ]}
    />
  );
}

/** Every kind of deduction, month by month, stacked: the attendance part at the bottom (loss of pay, then the late /
 *  early-out penalty), the slip's own lines above it. A type switched off in the legend leaves the chart. */
export function DeductionTypesChart({
  rows,
  hidden,
  onSelect,
  height = 260,
}: {
  rows: DeductionRow[];
  hidden: Set<string>;
  onSelect?: (month: string) => void;
  height?: number;
}) {
  const shown = DEDUCTION_KEYS.filter((k) => !hidden.has(k));
  const pick = (entry: unknown) => {
    const row = clicked<DeductionRow>(entry);
    if (row && onSelect) onSelect(row.key);
  };
  const chosen = rows.find((r) => r.selected)?.key ?? null;
  return (
    <ChartFrame height={height} testId="md-pay-deductions-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barCategoryGap="24%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tick={<MonthTick selected={chosen} />}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={10}
          />
          {chosen && <ReferenceArea x1={chosen} x2={chosen} {...BAND} />}
          <YAxis tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<DeductionTip hidden={hidden} />} cursor={cursor} />
          {shown.map((k, i) => (
            <Bar
              key={k}
              dataKey={k}
              name={DEDUCTION_LABEL[k]}
              stackId="d"
              fill={DEDUCTION_COLORS[k]}
              maxBarSize={30}
              radius={i === shown.length - 1 ? [5, 5, 0, 0] : 0}
              onClick={pick}
              cursor={onSelect ? "pointer" : undefined}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── casual leave ──────────────────────────────────────────────────────────────────────────────────────────────────

export const CL_LEGEND: LegendItem[] = [
  { key: "clAmount", label: "CL amount (₹)", color: PAY_COLORS.clAmount, shape: "bar" },
  { key: "clDays", label: "CL days", color: PAY_COLORS.clDays, shape: "line" },
];

function ClTip(props: TipProps<ClRow>) {
  const row = rowOf(props);
  if (!row) return null;
  return (
    <TooltipCard
      title={row.label}
      lines={[
        { label: "CL amount", value: inr(row.clAmount), color: PAY_COLORS.clAmount, strong: true },
        { label: "CL days", value: daysText(row.clDays), color: PAY_COLORS.clDays, shape: "line" },
        {
          label: "Per CL day",
          value: row.clDays > 0 ? inr(row.clAmount / row.clDays) : "—",
        },
      ]}
    />
  );
}

/** Casual leave paid each month: the amount as bars (left axis, rupees), the days as a line (right axis). */
export function ClChart({
  rows,
  onSelect,
  height = 260,
}: {
  rows: ClRow[];
  onSelect?: (month: string) => void;
  height?: number;
}) {
  const pick = (entry: unknown) => {
    const row = clicked<ClRow>(entry);
    if (row && onSelect) onSelect(row.key);
  };
  const chosen = rows.find((r) => r.selected)?.key ?? null;
  return (
    <ChartFrame height={height} testId="md-pay-cl-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 0, left: -6, bottom: 0 }} barCategoryGap="28%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tick={<MonthTick selected={chosen} />}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={10}
          />
          {chosen && <ReferenceArea yAxisId="amount" x1={chosen} x2={chosen} {...BAND} />}
          <YAxis
            yAxisId="amount"
            tickFormatter={tickMoney}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            width={44}
          />
          <YAxis
            yAxisId="days"
            orientation="right"
            tickFormatter={(v: number) => daysText(v)}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            width={30}
            allowDecimals={false}
          />
          <Tooltip content={<ClTip />} cursor={cursor} />
          <Bar
            yAxisId="amount"
            dataKey="clAmount"
            name="CL amount"
            fill={PAY_COLORS.clAmount}
            maxBarSize={28}
            radius={[5, 5, 0, 0]}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
            isAnimationActive={false}
          />
          <Line
            yAxisId="days"
            dataKey="clDays"
            name="CL days"
            stroke={PAY_COLORS.clDays}
            strokeWidth={2.2}
            dot={{ r: 2.5, fill: PAY_COLORS.clDays, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── departments ───────────────────────────────────────────────────────────────────────────────────────────────────

export const DEPARTMENT_LEGEND: Record<DepartmentMeasure, LegendItem[]> = {
  cost: [{ key: "companyCost", label: "Company cost", color: PAY_COLORS.companyCost, shape: "bar" }],
  pay: PAY_STACK,
  average: [
    { key: "averageEarned", label: "Average earned salary", color: PAY_COLORS.averageEarned, shape: "bar" },
    { key: "averageNetPaid", label: "Average net paid", color: PAY_COLORS.averageNetPaid, shape: "bar" },
  ],
};

function DepartmentTip(props: TipProps<DepartmentBar>) {
  const row = rowOf(props);
  if (!row) return null;
  return (
    <TooltipCard
      title={row.name}
      lines={[
        { label: "Company cost", value: inr(row.companyCost), color: PAY_COLORS.companyCost, strong: true },
        { label: "Share of the total", value: pct(row.sharePct) },
        { label: "Net paid", value: inr(row.netPaid), color: PAY_COLORS.netPaid },
        { label: "Other deductions", value: inr(row.otherDeductions), color: PAY_COLORS.otherDeductions },
        {
          label: "Attendance deductions",
          value: inr(row.attendanceDeduction),
          color: PAY_COLORS.attendanceDeduction,
        },
        { label: "Average earned", value: inr(row.averageEarned) },
        { label: "Average net paid", value: inr(row.averageNetPaid) },
      ]}
      foot={`${num(row.employees)} employees · click to see them`}
    />
  );
}

/** The amount at the end of a department's bar, on one line (recharts' own label wraps it to the bar's width). */
function BarEndLabel({
  x,
  y,
  width,
  height,
  value,
}: {
  x?: number | string;
  y?: number | string;
  width?: number | string;
  height?: number | string;
  value?: number | string;
}) {
  const n = (v: number | string | undefined) => Number(v ?? 0);
  return (
    <text
      x={n(x) + n(width) + 6}
      y={n(y) + n(height) / 2}
      dy="0.35em"
      fontSize={11}
      fontWeight={700}
      fill={MD_CHART.label}
      className="tabular-nums"
    >
      {inrCompact(Number(value))}
    </text>
  );
}

/** One bar per department, biggest company cost at the top: the company cost, how its pay splits, or the average pay per
 *  employee. A click on a bar opens the department's employees. */
export function DepartmentChart({
  bars,
  measure,
  onPick,
  narrow,
}: {
  bars: DepartmentBar[];
  measure: DepartmentMeasure;
  onPick?: (bar: DepartmentBar) => void;
  narrow: boolean;
}) {
  const rowHeight = measure === "average" ? 34 : narrow ? 26 : 30;
  const height = bars.length * rowHeight + 30;
  const labelWidth = narrow ? 92 : 140;
  const pick = (entry: unknown) => {
    const bar = clicked<DepartmentBar>(entry);
    if (bar && onPick) onPick(bar);
  };
  const common = { onClick: pick, cursor: onPick ? "pointer" : undefined, isAnimationActive: false } as const;
  return (
    <ChartFrame height={height} phoneCap={false} testId="md-pay-department-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={bars}
          layout="vertical"
          margin={{ top: 0, right: measure === "cost" ? 56 : 10, left: 0, bottom: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid {...gridProps} horizontal={false} vertical />
          <XAxis type="number" tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            width={labelWidth}
            tick={axisStyle}
            tickFormatter={(v: string) => shortName(v, narrow ? 12 : 20)}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip content={<DepartmentTip />} cursor={cursor} />
          {measure === "cost" && (
            <Bar
              dataKey="companyCost"
              name="Company cost"
              fill={PAY_COLORS.companyCost}
              radius={[0, 5, 5, 0]}
              {...common}
            >
              <LabelList dataKey="companyCost" content={<BarEndLabel />} />
            </Bar>
          )}
          {measure === "pay" &&
            PAY_STACK.map((s, i) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="pay"
                fill={s.color}
                radius={i === PAY_STACK.length - 1 ? [0, 5, 5, 0] : 0}
                {...common}
              />
            ))}
          {measure === "average" &&
            DEPARTMENT_LEGEND.average.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[0, 4, 4, 0]} {...common} />
            ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── employees ─────────────────────────────────────────────────────────────────────────────────────────────────────

function PersonBarTip(props: TipProps<PersonBar>) {
  const row = rowOf(props);
  if (!row) return null;
  return (
    <TooltipCard
      title={`${row.name} · ${row.code}`}
      lines={[
        { label: "Net paid", value: inr(row.netPaid), color: PAY_COLORS.netPaid, strong: true },
        { label: "Other deductions", value: inr(row.otherDeductions), color: PAY_COLORS.otherDeductions },
        {
          label: "Attendance deductions",
          value: inr(row.attendanceDeduction),
          color: PAY_COLORS.attendanceDeduction,
        },
        { label: "Company cost", value: inr(row.companyCost) },
      ]}
      foot="Click to open the salary history"
    />
  );
}

/** The employees on the list's page side by side: what each was paid and what was taken, in the list's order. */
export function PeopleChart({
  bars,
  onOpen,
  narrow,
}: {
  bars: PersonBar[];
  onOpen?: (id: number) => void;
  narrow: boolean;
}) {
  const height = bars.length * (narrow ? 24 : 26) + 30;
  const pick = (entry: unknown) => {
    const bar = clicked<PersonBar>(entry);
    if (bar && onOpen) onOpen(bar.id);
  };
  return (
    <ChartFrame height={height} phoneCap={false} testId="md-pay-people-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars} layout="vertical" margin={{ top: 0, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
          <CartesianGrid {...gridProps} horizontal={false} vertical />
          <XAxis type="number" tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} />
          <YAxis
            type="category"
            dataKey="name"
            width={narrow ? 92 : 132}
            tick={axisStyle}
            tickFormatter={(v: string) => shortName(v, narrow ? 12 : 19)}
            axisLine={false}
            tickLine={false}
            interval={0}
          />
          <Tooltip content={<PersonBarTip />} cursor={cursor} />
          {PAY_STACK.map((s, i) => (
            <Bar
              key={s.key}
              dataKey={s.key}
              name={s.label}
              stackId="pay"
              fill={s.color}
              radius={i === PAY_STACK.length - 1 ? [0, 5, 5, 0] : 0}
              onClick={pick}
              cursor={onOpen ? "pointer" : undefined}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}

// ── one employee ──────────────────────────────────────────────────────────────────────────────────────────────────

export const PERSON_LEGEND: LegendItem[] = [
  { key: "actualSalary", label: "Actual salary", color: PAY_COLORS.actualSalary, shape: "bar" },
  { key: "earnedSalary", label: "Earned salary", color: PAY_COLORS.earnedSalary, shape: "bar" },
  { key: "netPaid", label: "Net paid", color: PAY_COLORS.netPaid, shape: "bar" },
  { key: "deductions", label: "Deductions", color: PAY_COLORS.deductions, shape: "dash" },
];

function PersonTip(props: TipProps<PersonChartRow>) {
  const row = rowOf(props);
  if (!row) return null;
  return (
    <TooltipCard
      title={row.label}
      lines={[
        { label: "Actual salary", value: inr(row.actualSalary), color: PAY_COLORS.actualSalary },
        { label: "Earned salary", value: inr(row.earnedSalary), color: PAY_COLORS.earnedSalary },
        { label: "Attendance deductions", value: inr(row.attendanceDeduction) },
        { label: "Deductions", value: inr(row.deductions), color: PAY_COLORS.deductions, shape: "dash" },
        { label: "Net paid", value: inr(row.netPaid), color: PAY_COLORS.netPaid, strong: true },
      ]}
      foot="Click to find the month in the history"
    />
  );
}

/** One employee, month by month: actual salary (staff), what the paid days earned and what was paid, with the deductions
 *  as a dashed line. */
export function PersonChart({
  rows,
  selected,
  onSelect,
  height = 260,
}: {
  rows: PersonChartRow[];
  /** the month highlighted in the history */
  selected?: string | null;
  onSelect?: (month: string) => void;
  height?: number;
}) {
  const chosen = selected && rows.some((r) => r.key === selected) ? selected : null;
  const staff = rows.some((r) => r.actualSalary != null);
  const pick = (entry: unknown) => {
    const row = clicked<PersonChartRow>(entry);
    if (row && onSelect) onSelect(row.key);
  };
  const bar = { maxBarSize: 16, radius: [4, 4, 0, 0] as [number, number, number, number], isAnimationActive: false };
  return (
    <ChartFrame height={height} testId="md-pay-person-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 8, right: 6, left: -6, bottom: 0 }} barGap={2} barCategoryGap="20%">
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey="key"
            tick={<MonthTick selected={chosen} />}
            axisLine={false}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={10}
          />
          {chosen && <ReferenceArea x1={chosen} x2={chosen} {...BAND} />}
          <YAxis tickFormatter={tickMoney} tick={axisStyle} axisLine={false} tickLine={false} width={44} />
          <Tooltip content={<PersonTip />} cursor={cursor} />
          {staff && (
            <Bar
              dataKey="actualSalary"
              name="Actual salary"
              fill={PAY_COLORS.actualSalary}
              {...bar}
              onClick={pick}
              cursor={onSelect ? "pointer" : undefined}
            />
          )}
          <Bar
            dataKey="earnedSalary"
            name="Earned salary"
            fill={PAY_COLORS.earnedSalary}
            {...bar}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
          />
          <Bar
            dataKey="netPaid"
            name="Net paid"
            fill={PAY_COLORS.netPaid}
            {...bar}
            onClick={pick}
            cursor={onSelect ? "pointer" : undefined}
          />
          <Line
            dataKey="deductions"
            name="Deductions"
            stroke={PAY_COLORS.deductions}
            strokeWidth={2.2}
            strokeDasharray="5 4"
            dot={{ r: 2.5, fill: PAY_COLORS.deductions, strokeWidth: 0 }}
            activeDot={{ r: 5, stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
