import type { ReactNode } from "react";
import { CHART } from "./chartTheme";

export type BarItem = {
  key: string;
  label: ReactNode;
  value: number;
  /** Small secondary text under the label ("12 of 40 employees"). */
  sub?: ReactNode;
  color?: string;
  /** The text shown at the right; defaults to the formatted value. */
  display?: ReactNode;
};

/**
 * Ranked horizontal bars (departments by absenteeism, units by cost...). Pure CSS, so it stays crisp at any width and
 * costs nothing next to a chart. Click a row with `onSelect` to drill in.
 */
export default function BarList({
  items,
  format = (n) => String(n),
  max,
  color = CHART.brand,
  onSelect,
  emptyText = "Nothing to show.",
  testId,
}: {
  items: BarItem[];
  format?: (n: number) => string;
  /** The value a full bar stands for; default is the largest value. */
  max?: number;
  color?: string;
  onSelect?: (item: BarItem) => void;
  emptyText?: string;
  testId?: string;
}) {
  if (items.length === 0) return <p className="py-6 text-center text-sm text-md-ink-soft">{emptyText}</p>;
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return (
    <ul className="space-y-3.5" data-testid={testId}>
      {items.map((item) => {
        const width = Math.max(2, Math.min(100, (Math.abs(item.value) / top) * 100));
        const body = (
          <>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-[13px] font-semibold text-md-ink">{item.label}</span>
              <span className="shrink-0 text-[13px] font-extrabold tabular-nums text-md-ink">
                {item.display ?? format(item.value)}
              </span>
            </div>
            <div className="md-shell-bar-track">
              <div className="md-shell-bar-fill" style={{ width: `${width}%`, background: item.color ?? color }} />
            </div>
            {item.sub && <p className="mt-1 text-[11px] leading-snug text-md-ink-soft">{item.sub}</p>}
          </>
        );
        return (
          <li key={item.key} data-testid={`bar-${item.key}`}>
            {onSelect ? (
              <button type="button" onClick={() => onSelect(item)} className="md-shell-bar-row">
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
