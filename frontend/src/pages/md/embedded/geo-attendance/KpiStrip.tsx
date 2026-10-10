import type { ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { Building2, CheckCircle2, Hourglass, MapPinned, Navigation, ShieldAlert, Timer, Users } from "lucide-react";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { kpiTiles, previousText, type TileIcon } from "./logic";
import { refreshingClass } from "./parts";
import type { GeoSummary, GeoTrend, GeoVerification } from "./types";

const ICONS: Record<TileIcon, ComponentType<{ size?: number }>> = {
  sessions: MapPinned,
  people: Users,
  punches: Navigation,
  office: Building2,
  verified: CheckCircle2,
  waiting: Hourglass,
  speed: Timer,
  mocked: ShieldAlert,
};

/** What the strip shows while the first answer is on its way: the same eight tiles, empty. */
const SKELETON: { id: string; label: string; icon: TileIcon; tone: StatTone }[] = [
  { id: "sessions", label: "On-duty sessions", icon: "sessions", tone: "blue" },
  { id: "people", label: "Employees who went out", icon: "people", tone: "indigo" },
  { id: "punches", label: "On-duty punches", icon: "punches", tone: "teal" },
  { id: "office", label: "Office geo punches", icon: "office", tone: "slate" },
  { id: "verified", label: "Verified by HR", icon: "verified", tone: "green" },
  { id: "waiting", label: "Waiting for HR now", icon: "waiting", tone: "amber" },
  { id: "speed", label: "Median time to verify", icon: "speed", tone: "purple" },
  { id: "mocked", label: "Simulated GPS punches", icon: "mocked", tone: "red" },
];

/** The eight headline figures, each against the previous period (green or red by whether the change is good news), with
 *  a sparkline from the trend where there is one. */
export default function KpiStrip({
  summary,
  trend,
  verification,
}: {
  summary: UseQueryResult<GeoSummary>;
  trend: UseQueryResult<GeoTrend>;
  verification: UseQueryResult<GeoVerification>;
}) {
  const data = summary.data;
  return (
    <div>
      <div className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 ${refreshingClass(summary)}`} data-testid="md-geo-kpis">
        {data
          ? kpiTiles(data, trend.data, verification.data).map((tile) => {
              const source = tile.source === "verification" ? verification.data : data;
              return (
                <StatCard
                  key={tile.id}
                  testId={`md-geo-kpi-${tile.id}`}
                  label={tile.label}
                  value={tile.value}
                  sub={tile.sub}
                  icon={ICONS[tile.icon]}
                  tone={tile.tone}
                  delta={tile.delta}
                  spark={tile.spark}
                  loading={tile.source === "verification" && verification.isPending}
                  provenance={source?.provenance}
                  provenanceIds={tile.provenanceIds}
                />
              );
            })
          : SKELETON.map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-geo-kpi-${tile.id}`}
                label={tile.label}
                value="—"
                icon={ICONS[tile.icon]}
                tone={tile.tone}
                loading={summary.isPending}
              />
            ))}
      </div>
      {data && (
        <p className="mt-2 px-1 text-[11px] text-[#006496]/55" data-testid="md-geo-compare">
          Changes compare with {previousText(data)}, the same number of days just before.
        </p>
      )}
    </div>
  );
}
