import { useState, type CSSProperties, type PointerEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { tooltipStyle } from "./chartTheme";

// Light charts for the MD portal (2026-11-21): a ring, stacked columns (with an optional line) and stacked bars, drawn with
// a little SVG and CSS. They look like the recharts versions they replace on the Dashboard (same palette, rounded ends, the
// glass tooltip) but weigh a few kilobytes instead of ~110 KB of chart library, and they need no measuring (no
// ResizeObserver): the browser lays them out. Use them where the chart is simple; keep recharts for zoomable or
// many-series analysis charts.

export type Segment = { key: string; label: string; value: number; color: string };

type Tip = { content: ReactNode; x: number; y: number } | null;

/** The glass tooltip at a point inside the chart's box (kept inside the box at the edges). */
function TipBox({ tip, width }: { tip: Tip; width?: number }) {
  if (!tip) return null;
  const style: CSSProperties = {
    ...tooltipStyle,
    position: "absolute",
    left: tip.x,
    top: tip.y,
    transform: `translate(${width && tip.x > width * 0.6 ? "-100%" : width && tip.x < width * 0.4 ? "0%" : "-50%"}, calc(-100% - 10px))`,
    pointerEvents: "none",
    whiteSpace: "nowrap",
    zIndex: 5,
  };
  return (
    <div style={style} role="presentation">
      {tip.content}
    </div>
  );
}

function pointIn(e: PointerEvent<Element>): { x: number; y: number; width: number } {
  const box = (e.currentTarget as Element).closest("[data-lite-chart]")?.getBoundingClientRect();
  return box ? { x: e.clientX - box.left, y: e.clientY - box.top, width: box.width } : { x: 0, y: 0, width: 0 };
}

const TAU = Math.PI * 2;
const at = (r: number, angle: number) => [50 + r * Math.sin(angle), 50 - r * Math.cos(angle)] as const;

/** One slice of a ring, as a closed path: from `a0` to `a1` (radians, clockwise from 12 o'clock). */
function slicePath(inner: number, outer: number, a0: number, a1: number): string {
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = at(outer, a0);
  const [x1, y1] = at(outer, a1);
  const [x2, y2] = at(inner, a1);
  const [x3, y3] = at(inner, a0);
  const f = (n: number) => n.toFixed(3);
  return `M${f(x0)} ${f(y0)}A${outer} ${outer} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${inner} ${inner} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

/**
 * A ring of segments (a donut) with rounded corners and a small gap between slices, and whatever `children` says in its
 * middle. `inner` and `outer` are fractions of the radius (recharts' innerRadius / outerRadius). Hover a slice for its
 * figure. The size comes from the parent (give the wrapper a width and height).
 */
export function Donut({
  segments,
  inner = 0.68,
  outer = 0.96,
  gapDegrees = 2.5,
  corner = 2,
  format = (n) => n.toLocaleString("en-IN"),
  tipText,
  children,
  className,
  testId,
  ariaLabel,
}: {
  segments: Segment[];
  inner?: number;
  outer?: number;
  gapDegrees?: number;
  /** Corner rounding, in hundredths of the ring's width. */
  corner?: number;
  format?: (n: number) => string;
  /** The tooltip's words for a slice (default: "label: value"). */
  tipText?: (segment: Segment, total: number) => ReactNode;
  children?: ReactNode;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const [tip, setTip] = useState<Tip>(null);
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  const R = 50 * outer;
  const r = 50 * inner;
  // rounded corners: draw each slice smaller by `c` all round and stroke it 2c wide in its own colour with round joins
  const c = Math.min(corner, (R - r) / 3);
  const gap = shown.length > 1 ? (gapDegrees * Math.PI) / 180 : 0;
  let start = 0;
  return (
    <div
      className={cn("relative", className)}
      data-testid={testId}
      data-lite-chart=""
      onPointerLeave={() => setTip(null)}
    >
      <svg viewBox="0 0 100 100" className="h-full w-full" role={ariaLabel ? "img" : undefined} aria-label={ariaLabel}>
        {shown.length === 1 && (
          <circle cx={50} cy={50} r={(R + r) / 2} fill="none" stroke={shown[0].color} strokeWidth={R - r} />
        )}
        {shown.length > 1 &&
          shown.map((s) => {
            const sweep = (s.value / total) * TAU;
            const a0 = start + gap / 2;
            const a1 = start + sweep - gap / 2;
            start += sweep;
            if (a1 <= a0) return null;
            const mid = (R + r) / 2;
            const trim = Math.min(c / mid, (a1 - a0) / 2.5);
            return (
              <path
                key={s.key}
                d={slicePath(r + c, R - c, a0 + trim, a1 - trim)}
                fill={s.color}
                stroke={s.color}
                strokeWidth={2 * c}
                strokeLinejoin="round"
                onPointerMove={(e) => {
                  const p = pointIn(e);
                  setTip({ content: tipText ? tipText(s, total) : `${s.label}: ${format(s.value)}`, x: p.x, y: p.y });
                }}
              />
            );
          })}
      </svg>
      {children && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">{children}</div>
      )}
      <TipBox tip={tip} />
    </div>
  );
}

/** Round "nice" steps for an axis from 0 to at least `max`: [0, step, 2 step, ...]. */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? raw;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export type ColumnSeries = { key: string; label: string; color: string };

/**
 * Stacked columns over a row of categories (days, months), with gridlines and a left axis, an optional line on its own
 * right axis (people paid over pay), a lighter column where `dim` says so, and a tooltip for the column under the pointer.
 * The height comes from the parent's class (`className="h-[220px]"`).
 */
export function StackedColumns<Row>({
  rows,
  series,
  value,
  label,
  rowKey,
  dim,
  line,
  tooltip,
  yFormat = (n) => n.toLocaleString("en-IN"),
  labelEvery,
  axisWidth = 36,
  className,
  testId,
  ariaLabel,
}: {
  rows: Row[];
  series: readonly ColumnSeries[];
  value: (row: Row, key: string) => number;
  label: (row: Row) => string;
  rowKey: (row: Row) => string;
  dim?: (row: Row) => boolean;
  line?: { value: (row: Row) => number; color: string; format?: (n: number) => string };
  tooltip: (row: Row) => ReactNode;
  yFormat?: (n: number) => string;
  /** Show every n-th label (default: enough to stay readable on a phone). */
  labelEvery?: number;
  /** Room for the left axis's figures, in pixels (wider for rupees). */
  axisWidth?: number;
  className?: string;
  testId?: string;
  ariaLabel?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const totals = rows.map((row) => series.reduce((sum, s) => sum + Math.max(0, value(row, s.key)), 0));
  const ticks = niceTicks(Math.max(0, ...totals));
  const top = ticks[ticks.length - 1] || 1;
  const lineValues = line ? rows.map(line.value) : [];
  const lineTicks = line ? niceTicks(Math.max(0, ...lineValues)) : [];
  const lineTop = lineTicks[lineTicks.length - 1] || 1;
  const n = rows.length || 1;
  const every = labelEvery ?? (n <= 8 ? 1 : n <= 16 ? 2 : Math.ceil(n / 8));
  const lineFormat = line?.format ?? ((v: number) => v.toLocaleString("en-IN"));
  const pct = (v: number, max: number) => `${Math.max(0, Math.min(100, (100 * v) / max))}%`;

  return (
    <div
      className={cn("flex w-full flex-col text-[11px] font-medium text-md-ink-soft", className)}
      data-testid={testId}
      role="img"
      aria-label={ariaLabel}
    >
      <div className="flex min-h-0 flex-1 gap-1.5">
        {/* left axis */}
        <div className="relative shrink-0 tabular-nums" style={{ width: axisWidth }} aria-hidden>
          {ticks.map((t) => (
            <span key={t} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: pct(t, top) }}>
              {yFormat(t)}
            </span>
          ))}
        </div>
        {/* plot */}
        <div className="relative min-w-0 flex-1" data-lite-chart="" onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <span
              key={t}
              aria-hidden
              className="absolute inset-x-0 border-t border-dashed border-md-ink/10"
              style={{ bottom: pct(t, top) }}
            />
          ))}
          <div className="absolute inset-0 flex items-stretch">
            {rows.map((row, i) => {
              const faded = dim?.(row) ?? false;
              let stacked = 0;
              const parts = series.map((s) => {
                const v = Math.max(0, value(row, s.key));
                const part = { key: s.key, color: s.color, from: stacked, v };
                stacked += v;
                return part;
              });
              const last = [...parts].reverse().find((p) => p.v > 0)?.key;
              return (
                <div
                  key={rowKey(row)}
                  className={cn(
                    "relative flex h-full flex-1 justify-center rounded-md transition-colors",
                    hover === i && "bg-md-wine/[0.05]",
                  )}
                  onPointerEnter={() => setHover(i)}
                  data-col={rowKey(row)}
                >
                  <div className="relative h-full" style={{ width: "72%", maxWidth: 44 }}>
                    {parts.map((p) =>
                      p.v > 0 ? (
                        <span
                          key={p.key}
                          aria-hidden
                          className={cn("md-grow-y absolute inset-x-0", p.key === last && "rounded-t-[5px]")}
                          style={{
                            bottom: pct(p.from, top),
                            height: pct(p.v, top),
                            backgroundColor: p.color,
                            opacity: faded ? 0.5 : 1,
                          }}
                        />
                      ) : null,
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          {line && rows.length > 0 && (
            <>
              <svg
                aria-hidden
                className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                viewBox={`0 0 ${n} 100`}
                preserveAspectRatio="none"
              >
                <polyline
                  fill="none"
                  stroke={line.color}
                  strokeWidth={2.5}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                  points={lineValues.map((v, i) => `${i + 0.5},${100 - (100 * v) / lineTop}`).join(" ")}
                />
              </svg>
              {lineValues.map((v, i) => (
                <span
                  key={i}
                  aria-hidden
                  className="pointer-events-none absolute h-[7px] w-[7px] -translate-x-1/2 translate-y-1/2 rounded-full"
                  style={{ left: `${((i + 0.5) / n) * 100}%`, bottom: pct(v, lineTop), backgroundColor: line.color }}
                />
              ))}
            </>
          )}
          {hover !== null && rows[hover] && (
            <div
              style={{
                ...tooltipStyle,
                position: "absolute",
                left: `${((hover + 0.5) / n) * 100}%`,
                top: 0,
                transform: `translateX(${hover < n / 3 ? "-10%" : hover > (2 * n) / 3 ? "-90%" : "-50%"})`,
                pointerEvents: "none",
                whiteSpace: "nowrap",
                zIndex: 5,
              }}
              role="presentation"
            >
              {tooltip(rows[hover])}
            </div>
          )}
        </div>
        {/* right axis (the line's) */}
        {line && (
          <div className="relative w-7 shrink-0 tabular-nums" aria-hidden>
            {lineTicks.map((t) => (
              <span
                key={t}
                className="absolute left-0 translate-y-1/2 leading-none"
                style={{ bottom: pct(t, lineTop) }}
              >
                {lineFormat(t)}
              </span>
            ))}
          </div>
        )}
      </div>
      {/* category labels */}
      <div className="mt-1.5 flex gap-1.5" aria-hidden>
        <div className="shrink-0" style={{ width: axisWidth }} />
        <div className="flex min-w-0 flex-1">
          {rows.map((row, i) => (
            <span key={rowKey(row)} className="flex-1 truncate text-center leading-none">
              {i % every === 0 || i === rows.length - 1 ? label(row) : ""}
            </span>
          ))}
        </div>
        {line && <div className="w-7 shrink-0" />}
      </div>
    </div>
  );
}

export type BarRow = {
  key: string;
  name: string;
  parts: { key: string; label: string; value: number; color: string }[];
};

/**
 * One horizontal stacked bar per row (a unit's staff and production, its present / CL / absent), the longest row full
 * width, the row's total at its end. The exact numbers are usually in a table under it; hover a part for its figure.
 */
export function StackedBars({
  rows,
  format = (n) => n.toLocaleString("en-IN"),
  className,
  testId,
}: {
  rows: BarRow[];
  format?: (n: number) => string;
  className?: string;
  testId?: string;
}) {
  const totals = rows.map((r) => r.parts.reduce((sum, p) => sum + Math.max(0, p.value), 0));
  const max = Math.max(1, ...totals);
  return (
    <ul className={cn("space-y-2.5", className)} data-testid={testId}>
      {rows.map((row, i) => {
        const shown = row.parts.filter((p) => p.value > 0);
        return (
          <li key={row.key} className="flex items-center gap-2.5 text-[12px]">
            <span className="w-24 shrink-0 truncate font-semibold text-md-ink" title={row.name}>
              {row.name}
            </span>
            <span className="flex h-5 min-w-0 flex-1 items-stretch" aria-hidden>
              <span className="md-grow-x flex h-full" style={{ width: `${(100 * totals[i]) / max}%` }}>
                {shown.map((p, j) => (
                  <span
                    key={p.key}
                    title={`${p.label}: ${format(p.value)}`}
                    className={cn("h-full", j === 0 && "rounded-l-[6px]", j === shown.length - 1 && "rounded-r-[6px]")}
                    style={{ width: `${(100 * p.value) / Math.max(1, totals[i])}%`, backgroundColor: p.color }}
                  />
                ))}
              </span>
            </span>
            <span className="w-10 shrink-0 text-right font-bold tabular-nums text-md-ink">{format(totals[i])}</span>
          </li>
        );
      })}
    </ul>
  );
}
