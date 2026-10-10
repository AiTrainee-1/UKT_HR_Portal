import { useId } from "react";
import { CHART } from "./chartTheme";

/** A tiny trend line for stat cards. Plain SVG (no chart library): cheap enough to put on every card. */
export default function Sparkline({
  values,
  color = CHART.brand,
  width = 84,
  height = 26,
}: {
  values: (number | null | undefined)[];
  color?: string;
  width?: number;
  height?: number;
}) {
  const id = useId();
  const points = values.map((v, i) => ({ v: v == null || Number.isNaN(v) ? null : v, i }));
  const real = points.filter((p): p is { v: number; i: number } => p.v != null);
  if (real.length < 2) return null;
  const min = Math.min(...real.map((p) => p.v));
  const max = Math.max(...real.map((p) => p.v));
  const span = max - min || 1;
  const stepX = width / Math.max(1, values.length - 1);
  const pad = 2;
  const coords = real.map((p) => [p.i * stepX, height - pad - ((p.v - min) / span) * (height - pad * 2)] as const);
  const line = coords.map(([x, y], idx) => `${idx === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${height} L${coords[0][0].toFixed(1)},${height} Z`;
  const last = coords[coords.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.24} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      {/* the latest value: a dot with a white ring, so it stands out from the line and the card behind it */}
      <circle cx={last[0]} cy={last[1]} r={2.8} fill={color} stroke="white" strokeWidth={1.5} />
    </svg>
  );
}
