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
    return <p className="py-8 text-center text-sm text-muted-foreground">Nothing to show.</p>;
  }
  const [lo, hi] = domain ?? [Math.min(...flat), Math.max(...flat)];
  const span = hi - lo || 1;
  const position = (v: number) => {
    const p = Math.max(0, Math.min(1, (v - lo) / span));
    return invert ? 1 - p : p;
  };
  return (
    <div className="overflow-x-auto" data-testid={testId}>
      <div
        className="grid gap-[3px]"
        style={{
          gridTemplateColumns: `${rowHeaderWidth}px repeat(${cols.length}, minmax(26px, 1fr))`,
          minWidth: rowHeaderWidth + cols.length * 30,
        }}
      >
        <div />
        {cols.map((c) => (
          <div key={c} className="truncate text-center text-[10px] font-medium text-[#006496]/60">
            {c}
          </div>
        ))}
        {rows.map((r, ri) => (
          <div key={r} className="contents">
            <div
              className="flex items-center truncate pr-2 text-[11px] font-medium text-[#1a3a4a]"
              style={{ height: cellHeight }}
              title={r}
            >
              <span className="truncate">{r}</span>
            </div>
            {cols.map((c, ci) => {
              const v = values[ri]?.[ci] ?? null;
              const p = v == null ? 0 : position(v);
              return (
                <div
                  key={c}
                  title={v == null ? `${r} · ${c}: no data` : `${r} · ${c}: ${format(v)}`}
                  className="flex items-center justify-center rounded-md text-[9.5px] font-semibold"
                  style={{
                    height: cellHeight,
                    background: v == null ? "rgba(0,100,150,.04)" : rampColor(p),
                    color: v == null ? "rgba(0,100,150,.3)" : p > 0.55 ? "#fff" : "#0b3b57",
                  }}
                >
                  {v == null ? "·" : format(v)}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-end gap-1.5 text-[10px] text-[#006496]/55">
        <span>{invert ? format(hi) : format(lo)}</span>
        <span className="flex h-2 w-24 overflow-hidden rounded-full">
          {CHART.ramp.map((c) => (
            <i key={c} className="h-full flex-1" style={{ background: c }} />
          ))}
        </span>
        <span>{invert ? format(lo) : format(hi)}</span>
      </div>
    </div>
  );
}
