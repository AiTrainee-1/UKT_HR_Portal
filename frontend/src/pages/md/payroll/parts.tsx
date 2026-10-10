import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import type { Tone } from "@/lib/md/format";
import { cn } from "@/lib/utils";

/** True when a query has nothing to show and failed: the card shows its error instead of a body. */
export const failed = (query: UseQueryResult<unknown>) => query.isError && !query.data;

/** An error inside one card (what the server said, and a retry): the rest of the page keeps working. */
export function CardError({ query }: { query: UseQueryResult<unknown> }) {
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** The server's notes without the "Matched department 'x' to 'y'" ones: the page shows those once, at the top. */
export const cardNotes = (notes: string[] | undefined): string[] =>
  (notes ?? []).filter((n) => !n.startsWith("Matched "));

/** Why a card is empty: the server's first note that is not about the filters, else a plain sentence. */
export const emptyReason = (notes: string[] | undefined, fallback: string): string => cardNotes(notes)[0] ?? fallback;

/** The small caps label above a block inside a card ("Earnings", "How long ago they were sanctioned"). */
export const OVERLINE = "text-[11px] font-extrabold uppercase tracking-[0.08em] text-md-ink-soft";

/** The tones of money-page tiles and badges (md-theme/areas/money.css): wine is the accent, sage / ochre / crimson only
 *  ever mean good / watch / bad. */
export type MoneyTone =
  "wine" | "ink" | "rose" | "info" | "mauve" | "clay" | "sky" | "neutral" | "success" | "warning" | "danger";

export const toneClass = (tone: MoneyTone) => `md-money-t-${tone}`;

/** A small figure with its label, inside a card: a quiet glass tile (`wine` for the one that matters most). */
export function Metric({
  label,
  value,
  sub,
  className,
  testId,
  emphasis,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
  testId?: string;
  emphasis?: boolean;
}) {
  return (
    <div className={cn("md-money-metric", emphasis && "md-money-metric-wine", className)} data-testid={testId}>
      <p className="text-[12px] font-semibold leading-snug text-md-ink-soft">{label}</p>
      <p className="mt-0.5 text-xl font-black leading-tight tracking-tight tabular-nums text-md-ink">{value}</p>
      {sub && <p className="mt-1 text-[11.5px] leading-snug text-md-ink-soft">{sub}</p>}
    </div>
  );
}

/** A coloured pill for a status: pass an md-chip tone (`md-chip-success`, `md-money-pill-info` ...). */
export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("md-chip whitespace-nowrap", className)}>{children}</span>;
}

/** "▲ 3.2%" next to a figure: the change against the previous period, sage when it is good news, crimson when it is not
 *  (the arrow and the sign say the same, so colour is never the only signal). */
export function Delta({
  text,
  tone,
  direction,
  className,
}: {
  text: string;
  tone: Tone;
  direction?: "up" | "down" | "flat";
  className?: string;
}) {
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "md-chip md-money-delta",
        tone === "good" && "md-chip-success",
        tone === "bad" && "md-chip-danger",
        className,
      )}
      data-tone={tone}
    >
      <Arrow size={12} aria-hidden />
      {text}
    </span>
  );
}

/** A segmented switch (md-seg): a frosted track, the chosen option a wine glass pill. role=tablist / tab, like the pill
 *  tabs it replaces, so the keyboard and the screen reader treat it the same. */
export function SegTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: {
  items: { value: T; label: ReactNode; count?: number }[];
  value: T;
  onChange: (value: T) => void;
  /** The tablist's accessible name. */
  label: string;
  className?: string;
}) {
  return (
    // the track scrolls sideways inside the card on a phone rather than pushing the page wider
    <div className="-mx-1 max-w-full overflow-x-auto px-1 pb-2 pt-0.5">
      <div role="tablist" aria-label={label} className={cn("md-seg", className)}>
        {items.map((item) => {
          const on = item.value === value;
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(item.value)}
              className={cn("md-seg-item min-h-9 shrink-0 justify-center whitespace-nowrap", on && "md-money-seg-on")}
            >
              {item.label}
              {item.count !== undefined && (
                <span className={cn("md-money-count", on && "md-money-count-on")}>{item.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
