import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * KPI card loading border -the supplied loader's running "car", traced
 * around the card's own outline instead of around a small rectangle.
 *
 * Why it ports at any size: the tracer is a rect with pathLength={100} and
 * `stroke-dasharray: 25 75`, so the lit dash is always a quarter of the
 * perimeter no matter what that perimeter actually measures. One keyframe
 * drives every card; nothing is recalculated per card.
 *
 * `accent` recolours it per instance, which is what gives each KPI card its
 * own colour. It must be a real colour value (hex/rgb) -a Tailwind class
 * name in a CSS custom property renders nothing.
 *
 * Used on the Dashboard and Attendance KPI cards only; every other page in
 * the portal keeps its own Skeleton placeholders.
 *
 * The host element must be `relative`.
 */
export function KpiRunningBorder({
  accent,
  radius = 16,
  className,
}: {
  accent?: string;
  /** Match the card's own border-radius in px, or the tracer cuts corners. */
  radius?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("ukt-kpi-run", className)}
      style={
        {
          ...(accent ? { "--kpi-accent": accent } : {}),
          "--kpi-radius": `${radius}px`,
        } as CSSProperties
      }
    >
      <svg className="ukt-kpi-run-svg" width="100%" height="100%">
        <rect className="ukt-kpi-run-track" pathLength={100} />
        <rect className="ukt-kpi-run-car" pathLength={100} />
      </svg>
    </span>
  );
}

export default KpiRunningBorder;
