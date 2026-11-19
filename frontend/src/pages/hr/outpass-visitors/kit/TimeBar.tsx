import { cn } from "@/lib/utils";
import { fmtMinutes } from "./fmt";

/**
 * How long something took against what is allowed (a tea break against the tea-break rule, a pass against its expected
 * return): a thin bar with a mark at the allowance, and the minutes written beside it. Teal within the allowance, rose
 * over it, amber while it is still running. The words carry the meaning; the bar only shows it at a glance.
 */
export function TimeBar({
  minutes,
  allowed,
  running = false,
  showLabel = true,
  testId,
  className,
}: {
  minutes: number | null | undefined;
  /** The allowance in minutes (the mark on the bar). */
  allowed: number;
  /** Still going on (on break now): amber, and the label says "so far". */
  running?: boolean;
  showLabel?: boolean;
  testId?: string;
  className?: string;
}) {
  const value = minutes !== null && minutes !== undefined && Number.isFinite(minutes) ? Math.max(0, minutes) : null;
  const allowance = Math.max(0, allowed);
  const scale = Math.max(allowance * 2, value ?? 0, 1);
  const over = value !== null && value > allowance ? Math.round(value - allowance) : 0;
  const tone = running ? "amber" : over > 0 ? "rose" : "teal";
  const fill = { teal: "bg-teal-500", amber: "bg-amber-500", rose: "bg-rose-500" }[tone];
  const text =
    value === null
      ? "No time recorded"
      : `${fmtMinutes(value)}${running ? " so far" : ""}${over > 0 ? `, ${fmtMinutes(over)} over` : ""}`;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)} data-testid={testId} data-tone={tone}>
      <div
        className="relative h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-slate-100"
        role="img"
        aria-label={`${text}; ${fmtMinutes(allowance)} allowed`}
      >
        {value !== null && (
          <div
            className={cn("h-full rounded-full", fill)}
            style={{ width: `${Math.min(100, (value / scale) * 100)}%` }}
          />
        )}
        <div
          className="absolute inset-y-0 w-px bg-slate-500"
          style={{ left: `${Math.min(100, (allowance / scale) * 100)}%` }}
          aria-hidden="true"
        />
      </div>
      {showLabel && (
        <span
          className={cn("truncate text-xs tabular-nums", over > 0 && !running ? "text-rose-700" : "text-slate-600")}
        >
          {text}
        </span>
      )}
    </div>
  );
}
