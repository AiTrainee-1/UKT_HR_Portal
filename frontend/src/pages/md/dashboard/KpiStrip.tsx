import type { ComponentType } from "react";
import {
  Activity,
  Briefcase,
  Clock,
  Coffee,
  DoorOpen,
  IndianRupee,
  TrendingDown,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import KpiCard from "@/components/md/kit/KpiCard";
import StatCard from "@/components/md/kit/StatCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { SKELETON_KPIS, kpiLook, provenanceFor, type KpiIconKey } from "./logic";
import type { DashboardOverview } from "./types";

type Icon = ComponentType<{ size?: number; className?: string }>;

const ICONS: Record<KpiIconKey, Icon> = {
  users: Users,
  attendance: UserCheck,
  absence: UserX,
  attrition: TrendingDown,
  rupee: IndianRupee,
  overtime: Clock,
  briefcase: Briefcase,
  door: DoorOpen,
  coffee: Coffee,
  activity: Activity,
};

/** The eight headline figures: the page's own cards, each with its change, a sparkline and a way to the page behind it. */
export default function KpiStrip({ overview, failed }: { overview: DashboardOverview | undefined; failed?: boolean }) {
  return (
    <div className="@container" data-testid="md-dashboard-kpis">
      {overview && overview.kpis.length === 0 ? (
        <div className="md-card">
          <EmptyBlock title="No figures could be read just now">
            The pages that make these cards did not answer. The reason and a Retry are at the top of the page.
          </EmptyBlock>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 @4xl:grid-cols-4">
          {overview
            ? overview.kpis.map((kpi) => {
                const look = kpiLook(kpi);
                return (
                  <KpiCard
                    key={kpi.id}
                    kpi={kpi}
                    icon={ICONS[look.icon]}
                    tone={look.tone}
                    provenance={provenanceFor(kpi, overview.provenance)}
                  />
                );
              })
            : SKELETON_KPIS.map((tile) => (
                <StatCard
                  key={tile.id}
                  testId={`kpi-${tile.id}`}
                  label={tile.label}
                  value="—"
                  icon={ICONS[tile.look.icon]}
                  tone={tile.look.tone}
                  loading={!failed}
                />
              ))}
        </div>
      )}
    </div>
  );
}
