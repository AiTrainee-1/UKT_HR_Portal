import type { ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Coffee, Gauge, Repeat, ShieldCheck, Timer, TimerOff } from "lucide-react";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { kpiTiles, previousText, type TileIcon } from "./logic";
import { refreshingClass } from "./parts";
import type { TeaOffenders, TeaSummary, TeaTrend } from "./types";

const ICONS: Record<TileIcon, ComponentType<{ size?: number }>> = {
  breaks: Coffee,
  average: Timer,
  overrun: TimerOff,
  lost: Gauge,
  within: ShieldCheck,
  repeat: Repeat,
};

/** What the strip shows while the first answer is on its way: the same six tiles, empty. */
const SKELETON: { id: string; label: string; icon: TileIcon; tone: StatTone }[] = [
  { id: "breaks", label: "Breaks taken", icon: "breaks", tone: "blue" },
  { id: "average", label: "Average break", icon: "average", tone: "slate" },
  { id: "overrun", label: "Overrun rate", icon: "overrun", tone: "amber" },
  { id: "lost", label: "Minutes lost", icon: "lost", tone: "red" },
  { id: "within", label: "Within allowance", icon: "within", tone: "green" },
  { id: "repeat", label: "Repeat overrunners", icon: "repeat", tone: "purple" },
];

/** The six headline figures, each against the previous period (green or red by whether the change is good news),
 *  with a sparkline from the trend. */
export default function KpiStrip({
  summary,
  trend,
  offenders,
}: {
  summary: UseQueryResult<TeaSummary>;
  trend: UseQueryResult<TeaTrend>;
  offenders: UseQueryResult<TeaOffenders>;
}) {
  const data = summary.data;
  return (
    <div>
      <div
        className={`grid grid-cols-2 gap-3 @3xl:grid-cols-3 @6xl:grid-cols-6 ${refreshingClass(summary)}`}
        data-testid="md-tea-break-kpis"
      >
        {data
          ? kpiTiles(data, trend.data, offenders.data).map((tile) => {
              const source = tile.source === "offenders" ? offenders.data : data;
              return (
                <StatCard
                  key={tile.id}
                  testId={`md-tea-break-kpi-${tile.id}`}
                  label={tile.label}
                  value={tile.value}
                  sub={tile.sub}
                  icon={ICONS[tile.icon]}
                  tone={tile.tone}
                  delta={tile.delta}
                  spark={tile.spark}
                  loading={tile.source === "offenders" && offenders.isPending}
                  provenance={source?.provenance}
                  provenanceIds={tile.provenanceIds}
                />
              );
            })
          : SKELETON.map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-tea-break-kpi-${tile.id}`}
                label={tile.label}
                value="—"
                icon={ICONS[tile.icon]}
                tone={tile.tone}
                loading={summary.isPending}
              />
            ))}
      </div>
      {data && (
        <p className="mt-2 px-1 text-[11px] text-[#006496]/55" data-testid="md-tea-break-compare">
          Changes compare with {previousText(data)}, the same number of days just before.
        </p>
      )}
    </div>
  );
}
