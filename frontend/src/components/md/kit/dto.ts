// Turning what the backend sends (insights, headline KPIs) into what the kit components show.

import { changeTone, inr, inrCompact, minutesText, num, pct, signed, type Tone } from "@/lib/md/format";
import type { MdInsightDto, MdKpiDto } from "@/lib/md/types";
import { MD_NAV_BY_ID } from "../md-nav";
import type { Insight } from "./InsightList";

/** An insight DTO as the list shows it: the page id becomes a link ("payroll" -> /md/payroll, "Payroll Analysis"). */
export function toInsight(dto: MdInsightDto): Insight {
  const page = dto.page ? MD_NAV_BY_ID[dto.page] : undefined;
  return {
    id: dto.id,
    severity: dto.severity,
    title: dto.title,
    detail: dto.detail ?? undefined,
    metric: dto.metric ?? undefined,
    page: page ? { path: page.path, label: page.title } : undefined,
    ask: dto.ask ?? undefined,
  };
}

const SEVERITY_ORDER: Record<MdInsightDto["severity"], number> = { critical: 0, warning: 1, info: 2, good: 3 };

/** Most severe first; equal severities keep the order the server gave. */
export function sortInsights<T extends { severity: MdInsightDto["severity"] }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => SEVERITY_ORDER[a.item.severity] - SEVERITY_ORDER[b.item.severity] || a.index - b.index)
    .map(({ item }) => item);
}

/** The figure as text, by its declared format ("pct" -> "91.8%", "inr_compact" -> "₹12.4 L"). */
export function kpiValueText(kpi: Pick<MdKpiDto, "value" | "format">): string {
  const { value, format } = kpi;
  if (value == null) return "—";
  if (format === "text") return String(value);
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  switch (format) {
    case "pct":
      return pct(n);
    case "inr":
      return inr(n);
    case "inr_compact":
      return inrCompact(n);
    case "minutes":
      return minutesText(n);
    default:
      return num(n, Number.isInteger(n) ? 0 : 1);
  }
}

export type KpiDelta = { text: string; tone: Tone; direction: "up" | "down" | "flat" };

/** The change chip for a KPI: percentage points for a percentage, a percent change otherwise; coloured by `good`. */
export function kpiDelta(kpi: Pick<MdKpiDto, "format" | "delta">): KpiDelta | null {
  const delta = kpi.delta;
  if (!delta || delta.abs == null) return null;
  const direction = delta.abs > 0 ? "up" : delta.abs < 0 ? "down" : "flat";
  let text: string;
  if (kpi.format === "pct") text = `${signed(delta.abs, 1)} pts`;
  else if (delta.pct != null) text = `${signed(delta.pct, 1)}%`;
  else if (kpi.format === "inr_compact" || kpi.format === "inr") text = inrCompact(delta.abs);
  else if (kpi.format === "minutes") text = `${signed(delta.abs, 0)}m`;
  else text = signed(delta.abs, Number.isInteger(delta.abs) ? 0 : 1);
  const tone = delta.good ? changeTone(delta.abs, delta.good === "up") : "neutral";
  return { text, tone, direction };
}
