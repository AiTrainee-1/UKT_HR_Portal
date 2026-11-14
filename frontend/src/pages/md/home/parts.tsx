import type { ReactNode } from "react";
import { CHART } from "@/components/md/kit/chartTheme";
import { MD_CHART } from "@/lib/md/theme";
import { cn } from "@/lib/utils";

/** One colour per meaning across the three overviews, from the MD palette: staff midnight indigo, production wine;
 *  present sage, absent crimson, Casual Leave periwinkle. */
export const HOME_COLORS = {
  staff: CHART.deep,
  production: CHART.brand,
  present: MD_CHART.good,
  absent: MD_CHART.bad,
  watch: MD_CHART.watch,
  cl: CHART.info,
} as const;

/** The head of an overview card: its title (the dashboard's display face), one line saying what it shows, and the
 *  card's own controls on the right. */
export function OverviewHeader({
  id,
  title,
  subtitle,
  children,
}: {
  id: string;
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-4 gap-y-3 border-b border-md-ink/10 pb-4">
      <div className="min-w-0">
        <h2 id={id} className="text-xl font-black tracking-tight text-md-ink @3xl:text-2xl">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-xs font-medium leading-snug text-md-ink-soft">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </header>
  );
}

/** A small set of choices drawn as pills (a radio group): who a chart counts, or which pay figure it draws. */
export function Pills<T extends string>({
  label,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-full border border-md-ink/10 bg-white/60 p-1 shadow-sm backdrop-blur"
      data-testid={testId}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            data-testid={testId ? `${testId}-${o.value}` : undefined}
            className={cn(
              "min-h-8 rounded-full px-3.5 text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-wine",
              active ? "bg-md-wine text-white shadow" : "text-md-ink-soft hover:bg-md-wine/[0.06] hover:text-md-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A coloured dot and a word, for a chart's legend (the colour is never the only thing saying it). */
export function LegendDot({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-md-ink-soft">
      <span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: color }} />
      {children}
    </span>
  );
}

/** What a card says while its data is on the way, or when it could not be read. */
export function CardState({
  loading,
  error,
  onRetry,
}: {
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <div className="grid gap-3 @3xl:grid-cols-3" aria-busy="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="md-dashboard-skeleton h-28 rounded-2xl motion-safe:animate-pulse" />
        ))}
      </div>
    );
  }
  if (error) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-md-danger-50 px-4 py-3 text-sm text-md-danger-700">
        <span>{error}</span>
        {onRetry && (
          <button type="button" onClick={onRetry} className="md-btn md-btn-soft md-btn-sm">
            Retry
          </button>
        )}
      </div>
    );
  }
  return null;
}
