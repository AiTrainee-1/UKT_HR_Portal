import type { ReactNode } from "react";
import { CHART } from "./chartTheme";
import { cn } from "@/lib/utils";

export type BarItem = {
  key: string;
  label: ReactNode;
  value: number;
  /** Small grey text under the label ("12 of 40 employees"). */
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
  if (items.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1);
  return (
    <ul className="space-y-2.5" data-testid={testId}>
      {items.map((item) => {
        const width = Math.max(2, Math.min(100, (Math.abs(item.value) / top) * 100));
        const body = (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-[13px] font-medium text-[#1a3a4a]">{item.label}</span>
              <span className="shrink-0 text-[13px] font-bold tabular-nums text-[#1a3a4a]">
                {item.display ?? format(item.value)}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-[#006496]/[0.07]">
              <div
                className="h-full rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${width}%`, background: item.color ?? color }}
              />
            </div>
            {item.sub && <p className="mt-0.5 text-[11px] text-[#006496]/55">{item.sub}</p>}
          </>
        );
        return (
          <li key={item.key} data-testid={`bar-${item.key}`}>
            {onSelect ? (
              <button
                type="button"
                onClick={() => onSelect(item)}
                className={cn("block w-full rounded-lg p-1 text-left transition-colors hover:bg-[#006496]/[0.05]")}
              >
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
