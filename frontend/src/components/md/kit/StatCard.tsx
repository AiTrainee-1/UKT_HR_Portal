import type { ComponentType, ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import type { Tone } from "@/lib/md/format";
import type { Provenance } from "@/lib/md/types";
import { cn } from "@/lib/utils";
import ProvenanceButton from "./ProvenanceButton";
import Sparkline from "./Sparkline";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** Tints, written out in full because Tailwind can't build class names from variables. Same family as the HR pages. */
export const STAT_TONES = {
  slate: { box: "bg-slate-100 text-slate-800", accent: "#475569" },
  green: { box: "bg-green-50 text-green-800", accent: "#16a34a" },
  amber: { box: "bg-amber-50 text-amber-800", accent: "#d97706" },
  blue: { box: "bg-blue-50 text-blue-800", accent: "#006496" },
  indigo: { box: "bg-indigo-50 text-indigo-800", accent: "#4f46e5" },
  red: { box: "bg-red-50 text-red-800", accent: "#dc2626" },
  purple: { box: "bg-purple-50 text-purple-800", accent: "#9333ea" },
  teal: { box: "bg-teal-50 text-teal-800", accent: "#0d9488" },
} as const;

export type StatTone = keyof typeof STAT_TONES;

const DELTA_STYLE: Record<Tone, string> = {
  good: "bg-green-100 text-green-800",
  bad: "bg-red-100 text-red-800",
  neutral: "bg-white/70 text-slate-600",
};

/** "▲ 3.2 pts" next to a figure: the change against the previous period, coloured by whether it is good news. */
export function DeltaChip({ text, tone, direction }: { text: string; tone: Tone; direction?: "up" | "down" | "flat" }) {
  const Arrow = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10.5px] font-bold",
        DELTA_STYLE[tone],
      )}
    >
      <Arrow size={11} />
      {text}
    </span>
  );
}

/**
 * One headline figure: label, value, an optional change chip and sparkline, and the "how is this calculated" button.
 * While `loading` it shows the portal's running-border loader instead of a value.
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
        "relative flex flex-col justify-between gap-2 rounded-2xl p-4 transition-transform",
        t.box,
        clickable && "cursor-pointer hover:scale-[1.015]",
      )}
      onClick={onClick}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => (e.key === "Enter" || e.key === " ") && onClick?.() : undefined}
      data-testid={testId}
    >
      {loading && <KpiRunningBorder accent={t.accent} radius={16} />}
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-xl bg-white/60 p-2">
          <Icon size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-1">
            <p className="text-xs font-medium opacity-70">{label}</p>
            {provenance && provenance.length > 0 && (
              <ProvenanceButton
                provenance={provenance}
                ids={provenanceIds}
                className="-mr-1 -mt-1 h-5 w-5 text-current opacity-60"
              />
            )}
          </div>
          <p
            className={cn("text-2xl font-black leading-tight", loading && "opacity-0")}
            data-testid={testId ? `${testId}-value` : undefined}
          >
            {value}
          </p>
          {sub && <p className="mt-0.5 text-xs leading-snug opacity-60">{sub}</p>}
        </div>
      </div>
      {(delta || (spark && spark.length > 1) || children) && (
        <div className="flex flex-wrap items-end justify-between gap-x-2 gap-y-1">
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
