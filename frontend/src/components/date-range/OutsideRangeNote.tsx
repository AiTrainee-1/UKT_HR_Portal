import { CalendarClock } from "lucide-react";
import { dayLabel } from "@/lib/date-range";
import { cn } from "@/lib/utils";

/**
 * "2 more waiting outside November 2026 (the earliest is for 28 Oct) · Show them": a list that waits for a decision only
 * shows the dates of the filter, so the things still waiting on other dates are never out of mind (owner 2026-11-02: keep
 * the "waiting in another month" note). `onShow` widens the filter to reach them (the page decides how); without an
 * `earliest` day that can be shown (only later days), the note has no button.
 */
export function OutsideRangeNote({
  count,
  what,
  rangeLabel,
  earliest,
  onShow,
  testId = "outside-range",
  className,
}: {
  count: number;
  /** "request" / "requests" style words, already chosen for `count`. */
  what: string;
  /** The filter's days in words ("November 2026"). */
  rangeLabel: string;
  /** The earliest day among them (YYYY-MM-DD), when it can be shown. */
  earliest?: string;
  onShow?: () => void;
  testId?: string;
  className?: string;
}) {
  if (count <= 0) return null;
  return (
    <p
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900",
        className,
      )}
      role="status"
      data-testid={testId}
      data-count={count}
    >
      <CalendarClock size={14} aria-hidden className="shrink-0 text-amber-600" />
      <span>
        <b className="font-semibold">
          {count} more {what}
        </b>{" "}
        outside {rangeLabel}
        {earliest ? ` (the earliest is for ${dayLabel(earliest, { year: true })})` : ""}.
      </span>
      {onShow && earliest && (
        <button
          type="button"
          onClick={onShow}
          className="font-semibold text-amber-800 underline-offset-2 hover:underline"
          data-testid={`${testId}-show`}
        >
          Show them
        </button>
      )}
    </p>
  );
}
