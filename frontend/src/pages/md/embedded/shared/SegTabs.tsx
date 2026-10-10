import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export type SegItem = {
  value: string;
  label: ReactNode;
  /** A count shown in a small pill after the label. */
  count?: number;
  icon?: ReactNode;
};

/**
 * The switch between a few views of one card (Departments / Units, Today / Yesterday): a frosted glass track holding pills,
 * the chosen one a wine glass pill (md-seg, md-theme/glass.css). Same roles as the old pill tabs (a tablist of buttons with
 * aria-selected), so a keyboard and a screen reader meet what they met before. On a phone the track scrolls sideways inside
 * its own strip instead of making the page wider.
 */
export default function SegTabs({
  items,
  value,
  onChange,
  label,
  className,
  testId,
}: {
  items: SegItem[];
  value: string;
  onChange: (value: string) => void;
  /** What the switch chooses ("Group by"): read out by a screen reader. */
  label?: string;
  className?: string;
  testId?: string;
}) {
  return (
    <div className={cn("md-analytics-segs", className)} data-testid={testId}>
      <div role="tablist" aria-label={label} className="md-seg">
        {items.map((item) => (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={item.value === value}
            onClick={() => onChange(item.value)}
            className="md-seg-item"
          >
            {item.icon}
            {item.label}
            {item.count !== undefined && <span className="md-analytics-seg-count">{item.count}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
