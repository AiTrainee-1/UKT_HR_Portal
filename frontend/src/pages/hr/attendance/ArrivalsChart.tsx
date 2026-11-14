import { memo } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Tooltip, XAxis, YAxis } from "recharts";
import { Clock3 } from "lucide-react";
import { ChartContainer } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { ArrivalSlot } from "./logic";
import { prefersReducedMotion } from "./useCountUp";
import { usePhone } from "./usePhone";

// The brand blue and the indigo of the page (both re-coloured by the MD skin, see md-theme/hr-copies-data.css).
const SLOT_FILL = "#0080bf";
const CURVE = "#4338ca";

function ArrivalTooltip({ active, payload }: { active?: boolean; payload?: { payload: ArrivalSlot }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-md">
      <p className="font-semibold text-slate-800">{p.label}</p>
      <p className="mt-0.5 text-slate-600">
        <span className="font-semibold tabular-nums text-slate-900">{p.arrived}</span> arrived
      </p>
      <p className="text-slate-600">
        <span className="font-semibold tabular-nums text-slate-900">{p.inBy}</span> in by {p.label.split("-")[1]}
      </p>
    </div>
  );
}

/** When people arrived: first punches per half hour (bars) and how many were in by then (the curve). */
export const ArrivalsChart = memo(function ArrivalsChart({
  curve,
  stats,
  loading,
}: {
  curve: ArrivalSlot[];
  stats: { first: string; median: string; last: string };
  loading: boolean;
}) {
  // phones: 11 px ticks (nothing smaller is readable there) and a little more room between the time labels
  const phone = usePhone();
  const tick = { fontSize: phone ? 11 : 10 };
  return (
    <section
      className="clay-card flex min-w-0 flex-col rounded-2xl border border-slate-100 bg-white p-3.5 sm:p-5"
      aria-labelledby="arrivals-title"
      data-testid="attendance-arrivals"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 rounded-lg bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
          <Clock3 size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id="arrivals-title" className="text-sm font-bold text-slate-900">
            Arrivals
          </h3>
          <p className="text-xs text-slate-500">First punch of each person, per half hour</p>
        </div>
      </div>
      <div className="mt-3 min-h-[11rem] flex-1">
        {loading ? (
          <Skeleton className="h-44 w-full" />
        ) : curve.length === 0 ? (
          <div className="flex h-44 items-center justify-center rounded-xl border border-dashed border-slate-200 text-sm text-slate-500">
            Nobody has punched in yet
          </div>
        ) : (
          <ChartContainer config={{ arrived: { color: SLOT_FILL }, inBy: { color: CURVE } }} className="h-44 w-full">
            <ComposedChart data={curve} margin={{ top: 6, right: 6, left: phone ? -16 : -22, bottom: 0 }}>
              <defs>
                <linearGradient id="arrivals-curve" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CURVE} stopOpacity={0.22} />
                  <stop offset="100%" stopColor={CURVE} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="slot" tick={tick} interval="preserveStartEnd" minTickGap={phone ? 24 : 18} />
              <YAxis allowDecimals={false} tick={tick} width={40} />
              <Tooltip content={<ArrivalTooltip />} cursor={{ fillOpacity: 0.06 }} />
              <Area
                type="monotone"
                dataKey="inBy"
                stroke={CURVE}
                strokeWidth={2}
                fill="url(#arrivals-curve)"
                isAnimationActive={false}
                name="In by"
              />
              <Bar
                dataKey="arrived"
                fill={SLOT_FILL}
                radius={[3, 3, 0, 0]}
                maxBarSize={14}
                name="Arrived"
                isAnimationActive={!prefersReducedMotion()}
              />
            </ComposedChart>
          </ChartContainer>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-center">
        {(
          [
            ["First in", stats.first],
            ["Half in by", stats.median],
            ["Last in", stats.last],
          ] as const
        ).map(([label, value]) => (
          <div key={label}>
            <dd className="text-sm font-bold tabular-nums text-slate-900">{value || "-"}</dd>
            <dt className="text-[11px] text-slate-500">{label}</dt>
          </div>
        ))}
      </dl>
    </section>
  );
});
