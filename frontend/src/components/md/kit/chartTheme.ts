import type { CSSProperties } from "react";
import { MD_CHART } from "@/lib/md/theme";

/**
 * The MD portal's chart palette: wine and midnight indigo first, then dusty rose, ochre, sage and periwinkle, with fixed
 * meanings for good / bad / attention. The names are the old ones (brand, sky, light, deep ...), kept so every chart keeps
 * working; what they point at is the wine and indigo family now. Colours live in lib/md/theme.ts (MD_CHART) and the md-*
 * ramps in md-theme/tokens.css: add a colour there, not here.
 */
export const CHART = {
  /** the primary series: wine */
  brand: "#7F011F",
  /** the secondary series: dusty rose */
  sky: "#B85670",
  /** a light tint of the primary */
  light: "#E39AA9",
  /** the deepest tone: midnight indigo */
  deep: "#282B4A",
  /** periwinkle: information, and the sixth series colour */
  info: "#5559AB",
  gold: "#D49E32",
  good: "#428A5D",
  bad: "#CE3D3D",
  warn: "#B98220",
  leave: "#985880",
  teal: "#568565",
  slate: "#8C8FAD",
  grid: MD_CHART.grid,
  /** Categorical series, in the order they are meant to be assigned. */
  series: MD_CHART.series,
  /** A wine ramp for ranked bars and heatmaps (light to dark). */
  ramp: ["#F8E1E6", "#F0C4CD", "#E39AA9", "#D2677C", "#BC3550", "#9E1530", "#7F011F", "#4F0113"],
} as const;

/** The chart tooltip: small, light glass with a soft indigo shadow (recharts draws it with these inline styles). */
export const tooltipStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 14,
  padding: "8px 12px",
  border: "1px solid rgba(255, 255, 255, 0.85)",
  background: "rgba(255, 255, 255, 0.88)",
  backdropFilter: "blur(16px) saturate(1.6)",
  WebkitBackdropFilter: "blur(16px) saturate(1.6)",
  boxShadow: "0 16px 36px -12px rgba(40, 43, 74, 0.38), 0 2px 6px rgba(40, 43, 74, 0.08)",
  color: "var(--md-ink-800)",
};

/** Axis labels: 11 px, secondary ink (6:1 on the cards). */
export const axisStyle = { fontSize: 11, fill: MD_CHART.axis } as const;

export const gridProps = { strokeDasharray: "3 4", stroke: CHART.grid, vertical: false } as const;

/** The legend's text: ink, not the series colour (a pale series colour is hard to read as text); the dot keeps the colour. */
export const legendStyle: CSSProperties = { fontSize: 11, fontWeight: 600, color: "var(--md-ink-700)" };

/** A colour from the ramp for a 0-1 position (heatmaps, intensity bars). */
export function rampColor(position: number): string {
  const i = Math.max(0, Math.min(CHART.ramp.length - 1, Math.round(position * (CHART.ramp.length - 1))));
  return CHART.ramp[i];
}
