import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, axisStyle, gridProps, tooltipStyle } from "./chartTheme";

export type TrendSeries = {
  key: string;
  label: string;
  color?: string;
  /** How it is drawn. Default "line". */
  kind?: "area" | "line" | "bar";
  /** Series with the same stackId stack on top of each other (bars and areas). */
  stackId?: string;
  dashed?: boolean;
  /** Right-hand axis (a second unit, e.g. % over counts). */
  rightAxis?: boolean;
};

type Row = Record<string, string | number | null | undefined>;

/**
 * One time-series chart that can mix areas, lines and bars. Built on recharts like the HR dashboard, with its own
 * tooltip (the stock shadcn one hides a 0). `xFormat` / `yFormat` shape the labels; `references` draws target lines.
 */
export default function TrendChart({
  data,
  xKey,
  series,
  height = 240,
  xFormat,
  yFormat,
  yDomain,
  references,
  legend = true,
  rightFormat,
  allTicks = false,
}: {
  data: Row[];
  xKey: string;
  series: TrendSeries[];
  height?: number;
  xFormat?: (value: string) => string;
  yFormat?: (value: number) => string;
  yDomain?: [number | "auto" | "dataMin", number | "auto" | "dataMax"];
  references?: { y: number; label?: string; color?: string }[];
  legend?: boolean;
  rightFormat?: (value: number) => string;
  /** Label every column. For a handful of named categories (age bands, weekdays); a long run of dates should be left to
   *  thin itself out. */
  allTicks?: boolean;
}) {
  const hasRight = series.some((s) => s.rightAxis);
  // Wrapped, never passed on as they are: recharts calls a tick formatter with (value, index), and a formatter such as
  // num(value, places) would read the index as its second argument ("240.000").
  const fmtY = (v: number) => (yFormat ? yFormat(v) : String(v));
  const fmtRight = (v: number) => (rightFormat ? rightFormat(v) : fmtY(v));
  const fmtX = (v: string) => (xFormat ? xFormat(v) : v);
  return (
    <div style={{ height }} data-testid="trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: hasRight ? 4 : 8, left: -8, bottom: 0 }}>
          <defs>
            {series.map((s, i) => {
              const color = s.color ?? CHART.series[i % CHART.series.length];
              return (
                <linearGradient key={s.key} id={`md-grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              );
            })}
          </defs>
          <CartesianGrid {...gridProps} />
          <XAxis
            dataKey={xKey}
            tickFormatter={(v: string) => fmtX(v)}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            interval={allTicks ? 0 : "preserveEnd"}
            minTickGap={allTicks ? 0 : 18}
          />
          <YAxis
            yAxisId="left"
            tickFormatter={(v: number) => fmtY(v)}
            tick={axisStyle}
            axisLine={false}
            tickLine={false}
            width={46}
            domain={yDomain}
          />
          {hasRight && (
            <YAxis
              yAxisId="right"
              orientation="right"
              tickFormatter={(v: number) => fmtRight(v)}
              tick={axisStyle}
              axisLine={false}
              tickLine={false}
              width={40}
            />
          )}
          <Tooltip
            contentStyle={tooltipStyle}
            labelFormatter={(label) => fmtX(String(label))}
            formatter={(value, name, item) => {
              const s = series.find((x) => x.label === name);
              const f = s?.rightAxis ? fmtRight : fmtY;
              const n = typeof value === "number" ? value : Number(value);
              void item;
              return [Number.isNaN(n) ? "—" : f(n), name];
            }}
          />
          {legend && series.length > 1 && <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />}
          {references?.map((r) => (
            <ReferenceLine
              key={`${r.y}-${r.label}`}
              yAxisId="left"
              y={r.y}
              stroke={r.color ?? CHART.slate}
              strokeDasharray="4 4"
              label={
                r.label
                  ? { value: r.label, fontSize: 10, fill: r.color ?? CHART.slate, position: "insideTopRight" }
                  : undefined
              }
            />
          ))}
          {series.map((s, i) => {
            const color = s.color ?? CHART.series[i % CHART.series.length];
            const yAxisId = s.rightAxis ? "right" : "left";
            if (s.kind === "bar") {
              return (
                <Bar
                  key={s.key}
                  yAxisId={yAxisId}
                  dataKey={s.key}
                  name={s.label}
                  fill={color}
                  stackId={s.stackId}
                  radius={s.stackId ? 0 : [4, 4, 0, 0]}
                  maxBarSize={28}
                />
              );
            }
            if (s.kind === "area") {
              return (
                <Area
                  key={s.key}
                  yAxisId={yAxisId}
                  type="monotone"
                  dataKey={s.key}
                  name={s.label}
                  stroke={color}
                  strokeWidth={2}
                  fill={`url(#md-grad-${s.key})`}
                  stackId={s.stackId}
                  connectNulls
                  dot={false}
                />
              );
            }
            return (
              <Line
                key={s.key}
                yAxisId={yAxisId}
                type="monotone"
                dataKey={s.key}
                name={s.label}
                stroke={color}
                strokeWidth={2}
                strokeDasharray={s.dashed ? "5 4" : undefined}
                dot={false}
                activeDot={{ r: 4 }}
                connectNulls
              />
            );
          })}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
