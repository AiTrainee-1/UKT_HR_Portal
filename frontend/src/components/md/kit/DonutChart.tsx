import type { ReactNode } from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { CHART, tooltipStyle } from "./chartTheme";

export type DonutSlice = { name: string; value: number; color?: string };

/** A donut with the total (or any text) in the middle and a legend that shows each slice's value and share. */
export default function DonutChart({
  data,
  center,
  format = (n) => String(n),
  height = 190,
  testId,
}: {
  data: DonutSlice[];
  center?: ReactNode;
  format?: (n: number) => string;
  height?: number;
  testId?: string;
}) {
  const slices = data.filter((d) => d.value > 0);
  const total = slices.reduce((sum, d) => sum + d.value, 0);
  if (slices.length === 0) return <p className="py-8 text-center text-sm text-md-ink-soft">Nothing to show.</p>;
  // The legend sits beside the ring only when the card is wide enough for both (the card's width, not the screen's: a
  // narrow column on a wide screen, or the assistant panel taking half of it, leaves a card too narrow for a side legend)
  return (
    <div className="@container" data-testid={testId}>
      <div className="flex flex-col items-center gap-4 @min-[20rem]:flex-row">
        <div className="relative shrink-0" style={{ width: height, height }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={slices}
                dataKey="value"
                nameKey="name"
                innerRadius="64%"
                outerRadius="94%"
                paddingAngle={2.5}
                cornerRadius={5}
                stroke="none"
              >
                {slices.map((s, i) => (
                  <Cell key={s.name} fill={s.color ?? CHART.series[i % CHART.series.length]} />
                ))}
              </Pie>
              <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [format(Number(v)), name]} />
            </PieChart>
          </ResponsiveContainer>
          {center && (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center text-md-ink">
              {center}
            </div>
          )}
        </div>
        <ul className="w-full min-w-0 flex-1 space-y-1 text-[13px]">
          {slices.map((s, i) => (
            <li
              key={s.name}
              className="flex items-center justify-between gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-md-wine/[0.04]"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <i
                  className="md-shell-dot h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: s.color ?? CHART.series[i % CHART.series.length] }}
                />
                <span className="truncate font-medium text-md-ink">{s.name}</span>
              </span>
              <span className="shrink-0 tabular-nums text-md-ink">
                <b className="font-extrabold">{format(s.value)}</b>{" "}
                <span className="text-[11px] font-semibold text-md-ink-soft">
                  {Math.round((s.value / total) * 100)}%
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
