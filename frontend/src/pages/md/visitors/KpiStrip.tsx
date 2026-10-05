import type { LucideIcon } from "lucide-react";
import { BellRing, Clock, DoorOpen, Hourglass, ShieldX, Timer, Undo2, Users } from "lucide-react";
import StatCard from "@/components/md/kit/StatCard";
import type { Provenance } from "@/lib/md/types";
import { KPI_KEYS, KPI_LABELS, buildKpis, type KpiKey } from "./logic";
import type { SummaryResponse } from "./types";

const ICONS: Record<KpiKey, LucideIcon> = {
  visits: Users,
  peak: Clock,
  outpasses: DoorOpen,
  hoursOut: Hourglass,
  returnRate: Undo2,
  waiting: BellRing,
  approvalTime: Timer,
  rejection: ShieldX,
};

/** The headline figures: each against the previous period of the same length, coloured by whether the change is good. */
export default function KpiStrip({ summary, loading }: { summary?: SummaryResponse; loading: boolean }) {
  const specs = summary ? buildKpis(summary) : [];
  const provenance: Provenance[] | undefined = summary?.provenance;
  return (
    <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4" data-testid="md-visitors-kpis">
      {KPI_KEYS.map((key) => {
        const spec = specs.find((s) => s.key === key);
        return (
          <StatCard
            key={key}
            label={KPI_LABELS[key]}
            value={spec?.value ?? "—"}
            sub={spec?.sub ?? undefined}
            icon={ICONS[key]}
            tone={spec?.tone ?? "slate"}
            delta={spec?.delta}
            loading={loading}
            provenance={provenance}
            provenanceIds={spec?.provenanceIds}
            testId={`md-visitors-kpi-${key}`}
          />
        );
      })}
    </div>
  );
}
