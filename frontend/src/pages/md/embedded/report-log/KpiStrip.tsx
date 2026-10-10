import type { ComponentType } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  CalendarX2,
  CheckCheck,
  ClipboardList,
  FileDown,
  HelpCircle,
  ShieldAlert,
  UserCheck,
  Users,
} from "lucide-react";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { kpiTiles, previousText, type TileIcon } from "./logic";
import { refreshingClass } from "./parts";
import type { RlSummary, RlTrend } from "./types";

const ICONS: Record<TileIcon, ComponentType<{ size?: number }>> = {
  absences: ClipboardList,
  followed: CheckCheck,
  notInformed: ShieldAlert,
  unmarked: HelpCircle,
  gaps: CalendarX2,
  exports: FileDown,
  people: Users,
  latest: UserCheck,
};

/** What the strip shows while the first answer is on its way: the same eight tiles, empty. */
const SKELETON: { id: string; label: string; icon: TileIcon; tone: StatTone }[] = [
  { id: "absences", label: "Absences to follow up", icon: "absences", tone: "blue" },
  { id: "followed", label: "Followed up", icon: "followed", tone: "green" },
  { id: "notInformed", label: "Not informed", icon: "notInformed", tone: "red" },
  { id: "unmarked", label: "Not yet marked", icon: "unmarked", tone: "amber" },
  { id: "gaps", label: "Days nobody made the call", icon: "gaps", tone: "purple" },
  { id: "exports", label: "Attendance report exports", icon: "exports", tone: "indigo" },
  { id: "people", label: "People who export them", icon: "people", tone: "teal" },
  { id: "latest", label: "Latest export", icon: "latest", tone: "slate" },
];

/** The eight headline figures, each against the previous period (green or red by whether the change is good news), with
 *  a sparkline of the exports from the trend. */
export default function KpiStrip({
  summary,
  trend,
}: {
  summary: UseQueryResult<RlSummary>;
  trend: UseQueryResult<RlTrend>;
}) {
  const data = summary.data;
  return (
    <div>
      <div
        className={`grid grid-cols-2 gap-3 @3xl:grid-cols-4 ${refreshingClass(summary)}`}
        data-testid="md-reportlog-kpis"
      >
        {data
          ? kpiTiles(data, trend.data).map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-reportlog-kpi-${tile.id}`}
                label={tile.label}
                value={tile.value}
                sub={tile.sub}
                icon={ICONS[tile.icon]}
                tone={tile.tone}
                delta={tile.delta}
                spark={tile.spark}
                provenance={data.provenance}
                provenanceIds={tile.provenanceIds}
              />
            ))
          : SKELETON.map((tile) => (
              <StatCard
                key={tile.id}
                testId={`md-reportlog-kpi-${tile.id}`}
                label={tile.label}
                value="—"
                icon={ICONS[tile.icon]}
                tone={tile.tone}
                loading={summary.isPending}
              />
            ))}
      </div>
      {data && (
        <p className="mt-2 px-1 text-[11px] text-[#006496]/55" data-testid="md-reportlog-compare">
          Changes compare with {previousText(data)}, the same number of days just before.
        </p>
      )}
    </div>
  );
}
