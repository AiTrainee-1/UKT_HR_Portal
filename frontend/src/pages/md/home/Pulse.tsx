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
import { Link } from "wouter";
import { kpiDelta } from "@/components/md/kit/dto";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import Sparkline from "@/components/md/kit/Sparkline";
import { DeltaChip, STAT_TONES } from "@/components/md/kit/StatCard";
import { MD_NAV_BY_ID } from "@/components/md/md-nav";
import { cn } from "@/lib/utils";
import { SKELETON_KPIS, kpiLook, provenanceFor, type KpiIconKey } from "../dashboard/logic";
import type { DashboardOverview } from "../dashboard/types";

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

/** The figure a tile shows: the dashboard's own text for it (written the way the page behind it writes it). */
const valueText = (display: string | null | undefined) => display ?? "—";

/**
 * "The pulse": the company's headline figures as tall tiles: a big number, how it changed, its trend line and a way into
 * the page behind it. The figures are the same ones the pages show (the dashboard calculates nothing itself).
 */
export default function Pulse({ overview, failed }: { overview: DashboardOverview | undefined; failed?: boolean }) {
  if (overview && overview.kpis.length === 0) {
    return (
      <p
        className="rounded-2xl p-6 text-center text-sm text-muted-foreground clay-card"
        data-testid="md-home-pulse-empty"
      >
        No figures could be read just now. The reason and a Retry are at the top of the page.
      </p>
    );
  }
  const tiles = overview
    ? overview.kpis.map((kpi) => ({ kpi, look: kpiLook(kpi) }))
    : SKELETON_KPIS.map((s) => ({ kpi: null, look: s.look, id: s.id, label: s.label }));

  return (
    <div className="@container" data-testid="md-dashboard-kpis">
      <div className="grid grid-cols-2 gap-3 @3xl:grid-cols-4">
        {tiles.map((t) => {
          const look = t.look;
          const tone = STAT_TONES[look.tone];
          const Ico = ICONS[look.icon];
          if (!t.kpi) {
            const skeleton = t as { id: string; label: string };
            return (
              <div
                key={skeleton.id}
                className="h-[132px] animate-pulse rounded-2xl clay-card"
                data-testid={`kpi-${skeleton.id}`}
                aria-busy={!failed}
              />
            );
          }
          const kpi = t.kpi;
          const delta = kpiDelta(kpi);
          const page = kpi.page ? MD_NAV_BY_ID[kpi.page] : undefined;
          const body = (
            <>
              <span
                aria-hidden
                className="absolute inset-y-3 left-0 w-1 rounded-r-full"
                style={{ background: tone.accent }}
              />
              <div className="flex items-start justify-between gap-2">
                <span className={cn("rounded-xl p-2", tone.box)}>
                  <Ico size={16} />
                </span>
                {delta && <DeltaChip {...delta} />}
              </div>
              <p
                className="mt-3 text-[28px] font-black leading-none tracking-tight text-[#1a3a4a]"
                data-testid={`kpi-${kpi.id}-value`}
              >
                {valueText(kpi.display)}
              </p>
              <p className="mt-1.5 text-xs font-semibold text-[#1a3a4a]">{kpi.label}</p>
              <div className="mt-1 flex items-end justify-between gap-2">
                <p className="line-clamp-2 text-[11px] text-muted-foreground">{kpi.sub}</p>
                {kpi.spark && <Sparkline values={kpi.spark} color={tone.accent} width={72} height={24} />}
              </div>
            </>
          );
          const classes =
            "relative block overflow-hidden rounded-2xl p-4 pl-5 clay-card transition-transform hover:-translate-y-0.5";
          return (
            <div key={kpi.id} className="relative" data-testid={`kpi-${kpi.id}`}>
              {page ? (
                <Link href={page.path} className={classes} aria-label={`${kpi.label}: open ${page.title}`}>
                  {body}
                </Link>
              ) : (
                <div className={classes}>{body}</div>
              )}
              <div className="absolute bottom-2 right-2">
                <ProvenanceButton provenance={provenanceFor(kpi, overview!.provenance)} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
