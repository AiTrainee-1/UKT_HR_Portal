import type { ComponentType, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import type { Tone } from "@/lib/md/format";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import { CHART } from "./chartTheme";
import ProvenanceButton from "./ProvenanceButton";
import Sparkline from "./Sparkline";

type IconType = ComponentType<{ size?: number; className?: string }>;

/**
 * The figure's colour, by the names pages already use. `box` is a tone class (md-theme areas/shell.css sets the colour the icon
 * tile and the corner glow take from it), `accent` the sparkline's and the loader's colour. Wine and indigo are the brand and
 * the neutral; sage, ochre and crimson keep their meaning (good, watch, bad) and are meant for figures that carry it.
 */
export const STAT_TONES = {
  slate: { box: "md-shell-tone-ink", accent: CHART.deep },
  green: { box: "md-shell-tone-sage", accent: CHART.good },
  amber: { box: "md-shell-tone-ochre", accent: CHART.warn },
  blue: { box: "md-shell-tone-wine", accent: CHART.brand },
  indigo: { box: "md-shell-tone-periwinkle", accent: CHART.info },
  red: { box: "md-shell-tone-crimson", accent: CHART.bad },
  purple: { box: "md-shell-tone-mauve", accent: CHART.leave },
  teal: { box: "md-shell-tone-rose", accent: CHART.sky },
} as const;

export type StatTone = keyof typeof STAT_TONES;

const DELTA_STYLE: Record<Tone, string> = {
  good: "md-chip-success",
  bad: "md-chip-danger",
  neutral: "",
};

/** "▲ 3.2 pts" next to a figure: the change against the previous period, coloured by whether it is good news (sage), bad news
 *  (crimson) or neither (frosted). The arrow carries the direction, so the colour is never the only signal. */
export function DeltaChip({ text, tone, direction }: { text: string; tone: Tone; direction?: "up" | "down" | "flat" }) {
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <span className={cn("md-chip md-shell-delta", DELTA_STYLE[tone])}>
      <Arrow size={11} strokeWidth={2.6} aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * One headline figure: label, value, an optional change chip and sparkline, and the "how is this calculated" button, on a
 * glass card with a tinted icon tile and a faint glow of the tone in its corner. While `loading` it shows the portal's
 * running-border loader instead of a value. With `onClick` the whole card is a button.
 */
export default function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = "slate",
  delta,
  spark,
  loading,
  provenance,
  provenanceIds,
  onClick,
  testId,
  children,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon: IconType;
  tone?: StatTone;
  delta?: { text: string; tone: Tone; direction?: "up" | "down" | "flat" } | null;
  spark?: (number | null | undefined)[];
  loading?: boolean;
  provenance?: Provenance[];
  provenanceIds?: string[];
  onClick?: () => void;
  testId?: string;
  children?: ReactNode;
}) {
  const t = STAT_TONES[tone];
  const clickable = !!onClick;
  return (
    <div
      className={cn(
        "md-card md-shell-stat relative flex flex-col justify-between gap-3 p-4 @2xl:p-5",
        t.box,
        clickable && "cursor-pointer",
      )}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && onClick?.() : undefined}
      data-testid={testId}
    >
      {loading && <KpiRunningBorder accent={t.accent} radius={20} />}
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-0.5 pt-1">
          <p className="min-w-0 text-xs font-semibold leading-snug text-md-ink-soft">{label}</p>
          {provenance && provenance.length > 0 && (
            <ProvenanceButton provenance={provenance} ids={provenanceIds} className="-my-1.5 -mr-0.5" />
          )}
        </div>
        <span className="md-shell-tile">
          <Icon size={17} />
        </span>
      </div>
      <div className="min-w-0">
        <p
          className={cn(
            "text-[1.65rem] font-black leading-none tracking-tight tabular-nums text-md-ink [overflow-wrap:anywhere]",
            loading && "opacity-0",
          )}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value}
        </p>
        {sub && <p className="mt-2 text-xs leading-snug text-md-ink-soft">{sub}</p>}
      </div>
      {(delta || (spark && spark.length > 1) || children) && (
        <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1.5">
          <div className="min-w-0">
            {delta ? <DeltaChip {...delta} /> : null}
            {children}
          </div>
          {/* wraps under the change chip in a narrow card instead of overlapping it */}
          {spark && spark.length > 1 && (
            <div className="ml-auto">
              <Sparkline values={spark} color={t.accent} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
