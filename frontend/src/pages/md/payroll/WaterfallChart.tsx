import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { CHART, axisStyle, gridProps, tooltipStyle } from "@/components/md/kit/chartTheme";
import { inr, inrCompact } from "@/lib/md/format";
import { signedInr, signedInrCompact, waterfallDomain, type WaterfallBar } from "./logic";

// Cost going up is bad (red), cost going down is good (green); the two totals are the portal blue.
const FILL = { total: CHART.brand, up: CHART.bad, down: CHART.good } as const;

type TipProps = { active?: boolean; payload?: { payload?: WaterfallBar }[] };

function WaterfallTooltip({ active, payload }: TipProps) {
  const bar = payload?.[0]?.payload;
  if (!active || !bar) return null;
  return (
    <div style={tooltipStyle} className="max-w-[16rem] p-2.5">
      <p className="font-bold">{bar.label}</p>
      <p className="mt-0.5 text-sm font-black">{bar.kind === "total" ? inr(bar.amount, 2) : signedInr(bar.amount)}</p>
      {bar.people != null && bar.people > 0 && (
        <p className="text-[11px] opacity-70">
          {bar.people} {bar.people === 1 ? "person" : "people"}
        </p>
      )}
      {bar.detail && <p className="mt-1 text-[11px] opacity-70">{bar.detail}</p>}
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
        fill="#1a3a4a"
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
            <BarChart data={bars} margin={{ top: 24, right: 8, left: -4, bottom: 0 }} barCategoryGap="16%">
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
              <Tooltip content={<WaterfallTooltip />} cursor={{ fill: "rgba(0,100,150,.05)" }} />
              <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
              <Bar dataKey="value" stackId="w" isAnimationActive={false} radius={[4, 4, 0, 0]}>
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
        <p className="mt-1 text-[11px] text-[#006496]/60" data-testid="md-payroll-waterfall-axis-note">
          The vertical axis starts at {inrCompact(domain.min)}, not zero, so the steps can be seen. Exact amounts are
          listed beside the chart.
        </p>
      )}
    </div>
  );
}
