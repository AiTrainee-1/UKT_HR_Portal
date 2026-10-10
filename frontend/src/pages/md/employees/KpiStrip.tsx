import type { ComponentType } from "react";
import { ArrowLeftRight, Hourglass, Percent, Timer, UserMinus, UserPlus, UserRound, Users } from "lucide-react";
import StatCard, { type StatTone } from "@/components/md/kit/StatCard";
import { kpiTiles, type TileIcon } from "./logic";
import type { EmployeesMovement, EmployeesSummary } from "./types";

const ICONS: Record<TileIcon, ComponentType<{ size?: number }>> = {
  users: Users,
  joiners: UserPlus,
  leavers: UserMinus,
  net: ArrowLeftRight,
  attrition: Percent,
  tenure: Hourglass,
  early: Timer,
  people: UserRound,
};

/** What the strip shows while the first answer is on its way: the same eight tiles, empty. */
const SKELETON: { id: string; label: string; icon: TileIcon; tone: StatTone }[] = [
  { id: "headcount", label: "Active headcount", icon: "users", tone: "blue" },
  { id: "joiners", label: "Joiners", icon: "joiners", tone: "green" },
  { id: "leavers", label: "Leavers", icon: "leavers", tone: "amber" },
  { id: "net", label: "Net change", icon: "net", tone: "indigo" },
  { id: "attrition", label: "Attrition", icon: "attrition", tone: "red" },
  { id: "tenure", label: "Average tenure", icon: "tenure", tone: "blue" },
  { id: "early", label: "Left within 90 days", icon: "early", tone: "purple" },
  { id: "people", label: "Women · average age", icon: "people", tone: "slate" },
];

/** The eight headline figures, each against the previous period, with a sparkline from the movement chart's data. */
export default function KpiStrip({
  summary,
  movement,
  failed,
}: {
  summary: EmployeesSummary | undefined;
  movement: EmployeesMovement | undefined;
  /** The summary could not be loaded: the tiles stop pulsing and show dashes. */
  failed?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-4" data-testid="md-employees-kpis">
      {summary
        ? kpiTiles(summary, movement).map((tile) => {
            const Icon = ICONS[tile.icon];
            return (
              <StatCard
                key={tile.id}
                testId={`md-employees-kpi-${tile.id}`}
                label={tile.label}
                value={tile.value}
                sub={tile.sub}
                icon={Icon}
                tone={tile.tone}
                delta={tile.delta}
                spark={tile.spark}
                provenance={summary.provenance}
                provenanceIds={tile.provenanceIds}
              >
                {tile.note && <p className="mt-1 text-[11px] leading-tight text-md-ink-soft">{tile.note}</p>}
              </StatCard>
            );
          })
        : SKELETON.map((tile) => (
            <StatCard
              key={tile.id}
              testId={`md-employees-kpi-${tile.id}`}
              label={tile.label}
              value="—"
              icon={ICONS[tile.icon]}
              tone={tile.tone}
              loading={!failed}
            />
          ))}
    </div>
  );
}
