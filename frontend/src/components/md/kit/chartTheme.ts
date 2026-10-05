import type { CSSProperties } from "react";

/** The MD portal's chart palette: the portal's own blues, with fixed meanings for good / bad / attention. */
export const CHART = {
  brand: "#006496",
  sky: "#0096c7",
  light: "#4FB8F0",
  deep: "#023e8a",
  gold: "#e0a83a",
  good: "#22c55e",
  bad: "#ef4444",
  warn: "#f59e0b",
  leave: "#a855f7",
  teal: "#0d9488",
  slate: "#64748b",
  grid: "rgba(0,100,150,.08)",
  /** Categorical series, in the order they are meant to be assigned. */
  series: ["#006496", "#0096c7", "#4FB8F0", "#0d9488", "#f59e0b", "#8b5cf6", "#ef4444", "#64748b"],
  /** A blue ramp for ranked bars and heatmaps (light to dark). */
  ramp: ["#d6ecf8", "#a9d7ee", "#79c0e4", "#4FB8F0", "#0096c7", "#0080bf", "#006496", "#023e8a"],
} as const;

export const tooltipStyle: CSSProperties = {
  fontSize: 11,
  borderRadius: 12,
  border: "1px solid rgba(0,100,150,.1)",
  background: "#fff",
  boxShadow: "6px 6px 14px rgba(0,100,150,.1), -3px -3px 8px rgba(255,255,255,.8)",
  color: "#1a3a4a",
};

export const axisStyle = { fontSize: 10, fill: "rgba(0,60,100,.65)" } as const;

export const gridProps = { strokeDasharray: "3 3", stroke: CHART.grid, vertical: false } as const;

/** A colour from the ramp for a 0-1 position (heatmaps, intensity bars). */
export function rampColor(position: number): string {
  const i = Math.max(0, Math.min(CHART.ramp.length - 1, Math.round(position * (CHART.ramp.length - 1))));
  return CHART.ramp[i];
}
