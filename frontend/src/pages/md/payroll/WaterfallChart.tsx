import type { ComponentProps } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHART, axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
import { inr, inrCompact } from "@/lib/md/format";
import { signedInr, signedInrCompact, waterfallDomain, type WaterfallBar } from "./logic";

// Cost going up is bad (crimson), cost going down is good (sage); the two totals are the portal wine.
const FILL = { total: CHART.brand, up: CHART.bad, down: CHART.good } as const;

/** The share of each column left empty between two bars (recharts' barCategoryGap). */
const CATEGORY_GAP = 0.22;

type ShapeProps = ComponentProps<typeof Rectangle> & { index?: number };

/** A bar and, from its end level, a dashed rule across to the next bar: the eye follows the running total from one step to
 *  the next. A step that falls ends at its bottom edge, everything else at its top. */
function stepShape(bars: WaterfallBar[]) {
  // recharts types a custom shape's props as unknown; they are the rectangle's own (x, y, width, height, fill ...)
  return function Step(raw: unknown) {
    const props = raw as ShapeProps;
    const { index = 0 } = props;
    const x = Number(props.x ?? 0);
    const y = Number(props.y ?? 0);
    const width = Number(props.width ?? 0);
    const height = Number(props.height ?? 0);
    const bar = bars[index];
    const hasNext = index < bars.length - 1;
    const level = bar?.kind === "down" ? y + height : y;
    const gap = (width / (1 - CATEGORY_GAP)) * CATEGORY_GAP;
    return (
      <g>
        <Rectangle {...props} />
        {hasNext && width > 0 && (
          <line
            x1={x + width}
            x2={x + width + gap}
            y1={level}
            y2={level}
            stroke="var(--md-ink-400)"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        )}
      </g>
    );
  };
}

type TipProps = { active?: boolean; payload?: { payload?: WaterfallBar }[] };

function WaterfallTooltip({ active, payload }: TipProps) {
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;
  return (
    <div style={tooltipStyle} className="max-w-[16rem] p-3">
      <p className="text-[12px] font-bold">{bar.label}</p>
      <p className="mt-0.5 text-base font-black tabular-nums">
        {bar.kind === "total" ? inr(bar.amount, 2) : signedInr(bar.amount)}
      </p>
      {bar.people != null && bar.people > 0 && (
        <p className="text-[11px] text-md-ink-soft">
          {bar.people} {bar.people === 1 ? "person" : "people"}
        </p>
      )}
      {bar.detail && <p className="mt-1 text-[11px] leading-snug text-md-ink-soft">{bar.detail}</p>}
    </div>
  );
}

type LabelArgs = { x?: number | string; y?: number | string; width?: number | string; index?: number };

/**
 * The waterfall: the previous month's gross pay, one floating bar per step (red raises cost, green lowers it) and this
 * month's. Built from recharts' stacked bars with an invisible base under each floating step. The axis does not start
 * at zero (the steps would be invisible next to the totals); every bar carries its amount and the tooltip the exact one.
 * On a phone it scrolls sideways inside its card rather than squeezing the labels.
 */
export default function WaterfallChart({ bars }: { bars: WaterfallBar[] }) {
  const domain = waterfallDomain(bars);
  const label = ({ x = 0, y = 0, width = 0, index = 0 }: LabelArgs) => {
    const bar = bars[index];
    if (!bar) return null;
    return (
      <text
        x={Number(x) + Number(width) / 2}
        y={Number(y) - 6}
        textAnchor="middle"
        fontSize={10}
        fontWeight={700}
        fill="var(--md-ink-800)"
      >
        {bar.kind === "total" ? inrCompact(bar.amount) : signedInrCompact(bar.amount)}
      </text>
    );
  };
  return (
    <div>
      <div className="overflow-x-auto" data-testid="md-payroll-waterfall-scroll">
        <div style={{ height: 300, minWidth: 540 }} data-testid="md-payroll-waterfall-chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={bars}
              margin={{ top: 24, right: 8, left: -4, bottom: 0 }}
              barCategoryGap={`${CATEGORY_GAP * 100}%`}
            >
              <CartesianGrid {...gridProps} />
              <XAxis dataKey="shortLabel" tick={axisStyle} axisLine={false} tickLine={false} interval={0} />
              <YAxis
                tickFormatter={inrCompact}
                tick={axisStyle}
                axisLine={false}
                tickLine={false}
                width={54}
                domain={[domain.min, domain.max]}
                allowDataOverflow
              />
              <Tooltip content={<WaterfallTooltip />} cursor={{ fill: "var(--md-wine)", fillOpacity: 0.05 }} />
              <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
              <Bar dataKey="value" stackId="w" isAnimationActive={false} radius={[6, 6, 0, 0]} shape={stepShape(bars)}>
                {bars.map((b) => (
                  <Cell key={b.key} fill={FILL[b.kind]} />
                ))}
                <LabelList dataKey="value" content={label} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      {domain.truncated && (
        <p className="mt-1 text-[11.5px] leading-snug text-md-ink-soft" data-testid="md-payroll-waterfall-axis-note">
          The vertical axis starts at {inrCompact(domain.min)}, not zero, so the steps can be seen. Exact amounts are
          listed beside the chart.
        </p>
      )}
    </div>
  );
}
