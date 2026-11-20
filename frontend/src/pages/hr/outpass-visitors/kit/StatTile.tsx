import { Children, type ComponentType, type ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { cn } from "@/lib/utils";
import { fmtCount, NONE } from "./fmt";
import type { KitTone } from "./StatusChip";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** The tones of a tile's icon: the brand colour for a plain count, the status tones for a count that means something. */
export type TileTone = KitTone | "primary";

const ICON_TONE: Record<TileTone, string> = {
  primary: "bg-primary/10 text-primary",
  teal: "bg-teal-50 text-teal-700",
  amber: "bg-amber-50 text-amber-700",
  rose: "bg-rose-50 text-rose-700",
  indigo: "bg-indigo-50 text-indigo-700",
  slate: "bg-slate-100 text-slate-600",
};

/** A count that is bad news is written in its colour (Denied 4 in rose); the others stay ink. */
const VALUE_TONE: Partial<Record<TileTone, string>> = { rose: "text-rose-700", amber: "text-amber-700" };

/**
 * One headline figure: a small label, the number (or a short text such as "08:02"), an optional hint beside it and an icon
 * on the right. Flat (border only, no shadow), so the Clean theme has nothing to undo. With `onClick` the whole tile is a
 * button that filters the list (`active` marks the filter that is on); it only filters, so a View-only role keeps it.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  tone = "primary",
  emphasis = false,
  loading = false,
  onClick,
  active = false,
  title,
  testId,
  className,
  wrapLabel = false,
  wrapHint = false,
}: {
  label: string;
  /** A number is grouped the Indian way (1,240); a string is shown as it is; nothing is a dash. */
  value: number | string | null | undefined;
  hint?: ReactNode;
  icon?: IconType;
  tone?: TileTone;
  /** Writes the number in the tone's colour (rose / amber only): for a count that needs attention. */
  emphasis?: boolean;
  loading?: boolean;
  onClick?: () => void;
  active?: boolean;
  title?: string;
  /** The tile's test id; the number carries `<testId>-value`. */
  testId?: string;
  className?: string;
  /**
   * The label wraps onto a second line instead of being cut with an ellipsis (narrow tiles in a row of many). On a phone
   * (below 640 px) the icon is smaller and the letters are not spaced out, so a word fits a 360 px screen whole.
   */
  wrapLabel?: boolean;
  /** The hint wraps (onto its own line under the number when it has to) instead of being cut with an ellipsis. */
  wrapHint?: boolean;
}) {
  const shown = typeof value === "number" ? fmtCount(value) : (value ?? NONE);
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            "min-w-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500",
            wrapLabel ? "break-words leading-snug max-sm:tracking-normal" : "truncate",
          )}
          data-testid={testId ? `${testId}-label` : undefined}
        >
          {label}
        </p>
        {Icon && (
          <span
            className={cn(
              "flex size-8 shrink-0 items-center justify-center rounded-lg",
              wrapLabel && "max-sm:size-6",
              ICON_TONE[tone],
            )}
            aria-hidden="true"
          >
            <Icon size={16} />
          </span>
        )}
      </div>
      <div className={cn("mt-1 flex min-w-0 items-baseline gap-2", wrapHint && "flex-wrap gap-y-0.5")}>
        {loading ? (
          <Skeleton className="h-7 w-16" />
        ) : (
          <span
            className={cn("text-2xl font-bold leading-none tabular-nums text-slate-900", emphasis && VALUE_TONE[tone])}
            data-testid={testId ? `${testId}-value` : undefined}
          >
            {shown}
          </span>
        )}
        {hint && !loading && (
          <span
            className={cn("min-w-0 text-xs text-slate-500", wrapHint ? "break-words leading-snug" : "truncate")}
            data-testid={testId ? `${testId}-hint` : undefined}
          >
            {hint}
          </span>
        )}
      </div>
    </>
  );
  const box = cn(
    "min-w-0 rounded-2xl border bg-white px-4 py-3 text-left",
    active ? "border-primary ring-1 ring-primary" : "border-slate-200/80",
    className,
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        title={title}
        className={cn(box, "min-h-11 transition-colors hover:border-slate-300 focus-visible:outline-2")}
        data-testid={testId}
        {...{ [VIEW_SAFE_ATTR]: "" }}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={box} title={title} data-testid={testId}>
      {body}
    </div>
  );
}

const LG_COLS: Record<number, string> = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  5: "lg:grid-cols-5",
  6: "lg:grid-cols-6",
};

/** The row of 4-6 tiles under the tabs: two per line on a phone, three on a tablet, all of them on a wide screen. */
export function StatRow({
  children,
  columns,
  testId,
  className,
}: {
  children: ReactNode;
  /** Tiles per line on a wide screen (2-6). Default: as many as there are tiles. */
  columns?: number;
  testId?: string;
  className?: string;
}) {
  const count = Math.min(6, Math.max(2, columns ?? Children.toArray(children).length));
  return (
    <div className={cn("grid grid-cols-2 gap-3 sm:grid-cols-3", LG_COLS[count], className)} data-testid={testId}>
      {children}
    </div>
  );
}
