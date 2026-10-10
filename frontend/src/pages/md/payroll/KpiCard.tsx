import type { ComponentType, ReactNode } from "react";
import { CHART } from "@/components/md/kit/chartTheme";
import ProvenanceButton from "@/components/md/kit/ProvenanceButton";
import Sparkline from "@/components/md/kit/Sparkline";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { Delta, toneClass, type MoneyTone } from "./parts";
import type { DeltaView } from "./logic";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** The loader's running border and the sparkline need a real colour (not a class): one per tone, from the chart palette. */
const ACCENT: Record<MoneyTone, string> = {
  wine: CHART.brand,
  ink: CHART.deep,
  rose: CHART.series[2],
  info: CHART.series[5],
  mauve: CHART.leave,
  clay: CHART.series[7],
  sky: CHART.slate,
  neutral: CHART.slate,
  success: CHART.good,
  warning: CHART.warn,
  danger: CHART.bad,
};

/** The entrance of a card: a short rise and fade, staggered by place (nothing moves under prefers-reduced-motion). */
const RISE =
  "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2 motion-safe:duration-300 motion-safe:fill-mode-backwards";

type Props = {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: IconType;
  tone?: MoneyTone;
  /** The statement card: dark indigo glass (md-hero) with the figure in white, for the one number the page is about. */
  dark?: boolean;
  delta?: DeltaView | null;
  spark?: (number | null | undefined)[];
  loading?: boolean;
  provenance?: Provenance[];
  provenanceIds?: string[];
  testId?: string;
  className?: string;
  /** Place in the strip (0 first): the cards rise into view one after the other. */
  order?: number;
  /** Extra content under the figure (a meter). */
  children?: ReactNode;
};

/**
 * One headline figure of the month: a gradient icon tile and its label, the figure, a line of context, and (when there is
 * one) the change on last month and the twelve-month line. A glass card; the `dark` one is the page's statement piece.
 * While `loading` the running border replaces the figure, as it does on the other pages.
 *
 * The label sits beside the tile where the cards are wide (the page is at least 64rem across) and under it where they are
 * narrow, so "Employer cost (estimate)" never ends up four lines tall.
 */
export default function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "wine",
  dark,
  delta,
  spark,
  loading,
  provenance,
  provenanceIds,
  testId,
  className,
  order,
  children,
}: Props) {
  const accent = dark ? CHART.light : ACCENT[tone];
  return (
    <div
      className={cn(dark ? "md-hero md-money-hero" : "md-card md-money-kpi", RISE, toneClass(tone), className)}
      style={order ? { animationDelay: `${order * 35}ms` } : undefined}
      data-testid={testId}
    >
      {loading && <KpiRunningBorder accent={accent} radius={dark ? 28 : 20} />}
      <div className="grid grid-cols-[1fr_auto] items-start gap-x-2.5 gap-y-2.5 @5xl:grid-cols-[auto_1fr_auto]">
        <span className={cn("md-money-tile md-money-tile-md", dark && "md-money-tile-sand")}>
          <Icon size={17} aria-hidden />
        </span>
        <p
          className={cn(
            "order-last col-span-2 text-[12.5px] font-bold leading-snug @5xl:order-none @5xl:col-span-1 @5xl:pt-0.5",
            dark ? "text-md-sand/85" : "text-md-ink-soft",
          )}
        >
          {label}
        </p>
        {provenance && provenance.length > 0 && (
          <ProvenanceButton
            provenance={provenance}
            ids={provenanceIds}
            className={cn("-mr-1.5 -mt-0.5 shrink-0", dark && "text-md-sand/75 hover:bg-white/10 hover:text-white")}
          />
        )}
      </div>
      <div className="min-w-0">
        <p
          className={cn(
            "font-black leading-none tracking-tight tabular-nums",
            dark ? "text-[32px] text-white" : "text-[28px] text-md-ink",
            loading && "opacity-0",
          )}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </p>
        {sub && (
          <p className={cn("mt-2 text-[12px] leading-snug", dark ? "text-md-sand/80" : "text-md-ink-soft")}>{sub}</p>
        )}
      </div>
      {children}
      {(delta || (spark && spark.length > 1)) && (
        <div className="mt-auto flex flex-wrap items-end justify-between gap-x-2 gap-y-1.5">
          <div className="min-w-0">{delta ? <Delta {...delta} /> : null}</div>
          {spark && spark.length > 1 && (
            <div className="ml-auto">
              <Sparkline values={spark} color={dark ? "var(--md-sand)" : accent} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
