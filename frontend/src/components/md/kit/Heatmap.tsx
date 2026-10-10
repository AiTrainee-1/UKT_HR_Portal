import { CHART, rampColor } from "./chartTheme";

/**
 * A grid of intensity cells (departments by day, weekday by hour...). `values[row][col]` is a number or null (no
 * data: shown as a faint dash). Colour runs light-to-dark across the range actually present, or across `domain` when
 * a fixed scale makes sense (e.g. attendance 70-100%). `invert` makes LOW values the dark ones (worst = darkest).
 */
export default function Heatmap({
  rows,
  cols,
  values,
  format = (n) => String(n),
  domain,
  invert,
  cellHeight = 28,
  testId,
  rowHeaderWidth = 120,
}: {
  rows: string[];
  cols: string[];
  values: (number | null)[][];
  format?: (n: number) => string;
  domain?: [number, number];
  invert?: boolean;
  cellHeight?: number;
  testId?: string;
  rowHeaderWidth?: number;
}) {
  const flat = values.flat().filter((v): v is number => v != null);
  if (rows.length === 0 || flat.length === 0) {
    return <p className="py-8 text-center text-sm text-md-ink-soft">Nothing to show.</p>;
  }
  const [lo, hi] = domain ?? [Math.min(...flat), Math.max(...flat)];
  const span = hi - lo || 1;
  const position = (v: number) => {
    const p = Math.max(0, Math.min(1, (v - lo) / span));
    return invert ? 1 - p : p;
  };
  return (
    <div className="overflow-x-auto p-1" data-testid={testId}>
      <div
        className="grid gap-[3px]"
        style={{
          gridTemplateColumns: `${rowHeaderWidth}px repeat(${cols.length}, minmax(26px, 1fr))`,
          minWidth: rowHeaderWidth + cols.length * 30,
        }}
      >
        <div />
        {cols.map((c) => (
          <div key={c} className="truncate text-center text-[10px] font-semibold text-md-ink-soft">
            {c}
          </div>
        ))}
        {rows.map((r, ri) => (
          <div key={r} className="contents">
            <div
              className="flex items-center truncate pr-2 text-[11px] font-semibold text-md-ink"
              style={{ height: cellHeight }}
              title={r}
            >
              <span className="truncate">{r}</span>
            </div>
            {cols.map((c, ci) => {
              const v = values[ri]?.[ci] ?? null;
              const p = v == null ? 0 : position(v);
              // text colour by the ramp step the cell lands on: deep ink on the four lighter steps (4.8:1 or better), white on the
              // four darker wines (5.6:1 or better)
              const dark = Math.round(p * (CHART.ramp.length - 1)) <= 3;
              return (
                <div
                  key={c}
                  title={v == null ? `${r} · ${c}: no data` : `${r} · ${c}: ${format(v)}`}
                  className={
                    v == null
                      ? "flex items-center justify-center rounded-lg bg-md-ink/[0.05] text-[9.5px] font-semibold text-md-ink-500"
                      : "md-shell-heat-cell flex items-center justify-center rounded-lg text-[9.5px] font-bold"
                  }
                  style={
                    v == null
                      ? { height: cellHeight }
                      : { height: cellHeight, background: rampColor(p), color: dark ? "var(--md-ink-900)" : "white" }
                  }
                >
                  {v == null ? "·" : format(v)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2 text-[10px] font-semibold text-md-ink-soft">
        <span>{invert ? format(hi) : format(lo)}</span>
        <span className="md-shell-ramp flex h-2 w-24 overflow-hidden rounded-full">
          {CHART.ramp.map((c) => (
            <i key={c} className="h-full flex-1" style={{ background: c }} />
          ))}
        </span>
        <span>{invert ? format(lo) : format(hi)}</span>
      </div>
    </div>
  );
}
