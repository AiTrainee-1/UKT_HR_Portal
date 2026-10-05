import type { ComponentType } from "react";
import { useLocation } from "wouter";
import type { MdKpiDto } from "@/lib/md/types";
import type { Provenance } from "@/lib/md/types";
import { MD_NAV_BY_ID } from "../md-nav";
import { kpiDelta, kpiValueText } from "./dto";
import StatCard, { type StatTone } from "./StatCard";

/** A StatCard from a backend KPI (value formatted by its `format`, change chip coloured by its `good` direction).
 *  Clicking opens the page the KPI belongs to. */
export default function KpiCard({
  kpi,
  icon,
  tone,
  loading,
  provenance,
  link = true,
}: {
  kpi: MdKpiDto;
  icon: ComponentType<{ size?: number; className?: string }>;
  tone?: StatTone;
  loading?: boolean;
  provenance?: Provenance[];
  link?: boolean;
}) {
  const [, navigate] = useLocation();
  const target = link && kpi.page ? MD_NAV_BY_ID[kpi.page] : undefined;
  return (
    <StatCard
      label={kpi.label}
      value={kpiValueText(kpi)}
      sub={kpi.sub ?? undefined}
      icon={icon}
      tone={tone}
      delta={kpiDelta(kpi)}
      spark={kpi.spark ?? undefined}
      loading={loading}
      provenance={provenance}
      onClick={target ? () => navigate(target.path) : undefined}
      testId={`kpi-${kpi.id}`}
    />
  );
}
