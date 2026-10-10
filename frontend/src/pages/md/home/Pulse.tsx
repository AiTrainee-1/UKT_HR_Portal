import type { ComponentType } from "react";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  Briefcase,
  Clock,
  Coffee,
  DoorOpen,
  IndianRupee,
  Minus,
  TrendingDown,
  UserCheck,
  UserX,
  Users,
} from "lucide-react";
import { Link } from "wouter";
import { CHART } from "@/components/md/kit/chartTheme";
import { kpiDelta, type KpiDelta } from "@/components/md/kit/dto";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import Sparkline from "@/components/md/kit/Sparkline";
import { MD_NAV_BY_ID } from "@/components/md/md-nav";
import { cn } from "@/lib/utils";
import { SKELETON_KPIS, kpiLook, provenanceFor, type KpiIconKey, type KpiLook } from "../dashboard/logic";
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

/** The tile colours: only wine, indigo and sand (sage, ochre and crimson are kept for good, watch and bad, which the change
 *  chip carries). The card's old tint keys the choice so a card keeps its colour; the line is wine, or indigo on indigo. */
const TILE: Record<KpiLook["tone"], { tile: "wine" | "ink" | "sand"; spark: string }> = {
  blue: { tile: "ink", spark: CHART.deep },
  green: { tile: "wine", spark: CHART.brand },
  amber: { tile: "sand", spark: CHART.brand },
  red: { tile: "ink", spark: CHART.deep },
  indigo: { tile: "wine", spark: CHART.brand },
  purple: { tile: "sand", spark: CHART.brand },
  teal: { tile: "ink", spark: CHART.deep },
  slate: { tile: "wine", spark: CHART.brand },
};

/** The figure a tile shows: the dashboard's own text for it (written the way the page behind it writes it). */
const valueText = (display: string | null | undefined) => display ?? "—";

/** "▲ +0.9%": the change against the previous period; sage when it is good news, crimson when it is not, and the arrow
 *  and the sign say the same without the colour. */
function Delta({ text, tone, direction }: KpiDelta) {
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "md-chip shrink-0 tabular-nums",
        tone === "good" && "md-chip-success",
        tone === "bad" && "md-chip-danger",
      )}
    >
      <Arrow size={12} aria-hidden />
      {text}
    </span>
  );
}

/**
 * "The pulse": the company's headline figures as glass tiles: a gradient icon, a big figure, how it changed, its trend line
 * and a way into the page behind it. The figures are the same ones the pages show (the dashboard calculates nothing itself).
 */
export default function Pulse({ overview, failed }: { overview: DashboardOverview | undefined; failed?: boolean }) {
  if (overview && overview.kpis.length === 0) {
    return (
      <p className="md-card p-6 text-center text-sm font-medium text-md-ink-soft" data-testid="md-home-pulse-empty">
        No figures could be read just now. The reason and a Retry are at the top of the page.
      </p>
    );
  }
  const tiles = overview
    ? overview.kpis.map((kpi) => ({ kpi, look: kpiLook(kpi) }))
    : SKELETON_KPIS.map((s) => ({ kpi: null, look: s.look, id: s.id, label: s.label }));

  return (
    <div className="@container" data-testid="md-dashboard-kpis">
      <div className="grid grid-cols-2 gap-3 sm:gap-4 @3xl:grid-cols-4">
        {tiles.map((t) => {
          const look = t.look;
          const paint = TILE[look.tone];
          const Ico = ICONS[look.icon];
          if (!t.kpi) {
            const skeleton = t as { id: string; label: string };
            return (
              <div
                key={skeleton.id}
                className="md-card md-dashboard-skeleton h-[172px] motion-safe:animate-pulse"
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
              <div className="flex items-start justify-between gap-2">
                <span className={cn("md-dashboard-icon", `md-dashboard-icon-${paint.tile}`)}>
                  <Ico size={18} />
                </span>
                {delta && <Delta {...delta} />}
              </div>
              <div className="mt-4 flex items-end justify-between gap-2">
                <p
                  className="md-dashboard-figure text-[1.65rem] font-black leading-none text-md-ink @[14rem]:text-[1.95rem]"
                  data-testid={`kpi-${kpi.id}-value`}
                >
                  {valueText(kpi.display)}
                </p>
                {kpi.spark && (
                  <span className="hidden shrink-0 @[14rem]:block">
                    <Sparkline values={kpi.spark} color={paint.spark} width={72} height={28} />
                  </span>
                )}
              </div>
              <p className="mt-2 flex items-center gap-1 text-[13px] font-bold leading-tight text-md-ink">
                {kpi.label}
                {page && <ArrowUpRight size={13} className="md-dashboard-kpi-arrow shrink-0" aria-hidden />}
              </p>
              <p className="mt-1 line-clamp-2 min-h-[2.75em] pr-7 text-[12px] leading-snug text-md-ink-soft">
                {kpi.sub}
              </p>
            </>
          );
          return (
            <div
              key={kpi.id}
              className={cn("md-card md-dashboard-kpi @container", `md-dashboard-kpi-${paint.tile}`)}
              data-interactive={page ? "" : undefined}
              data-testid={`kpi-${kpi.id}`}
            >
              {page ? (
                <Link
                  href={page.path}
                  className="md-dashboard-kpi-link"
                  aria-label={`${kpi.label}: open ${page.title}`}
                >
                  {body}
                </Link>
              ) : (
                <div className="md-dashboard-kpi-link">{body}</div>
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
