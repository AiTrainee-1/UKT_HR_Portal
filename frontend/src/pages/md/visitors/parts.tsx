import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** The heading of a group of cards ("Visitors", "Outpasses"): an icon tile, the title and what to keep in mind. */
export function SectionHeading({
  icon: Icon,
  title,
  subtitle,
  testId,
}: {
  icon: IconType;
  title: string;
  subtitle?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-start gap-3 pt-1" data-testid={testId}>
      <div className="mt-0.5 rounded-xl bg-white p-2 text-[#006496] shadow-sm">
        <Icon size={16} />
      </div>
      <div className="min-w-0">
        <h3 className="text-lg font-black leading-tight text-gray-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  );
}

const CHIP_TONES = {
  blue: "border-blue-200 bg-blue-50 text-blue-700",
  indigo: "border-indigo-200 bg-indigo-50 text-indigo-700",
  slate: "border-slate-200 bg-slate-50 text-slate-600",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-700",
  green: "border-green-200 bg-green-50 text-green-700",
} as const;

export type ChipTone = keyof typeof CHIP_TONES;

/** A small label pill. Not a Badge: those lift on hover, and these are not clickable. */
export function Chip({
  children,
  tone = "slate",
  className,
}: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        CHIP_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A person in a table: the name, and under it the code and department (or any small line). */
export function PersonCell({ name, sub }: { name: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-[#1a3a4a]">{name}</p>
      {sub && <p className="truncate text-[11px] text-[#006496]/60">{sub}</p>}
    </div>
  );
}

/** Small print under a chart: a caveat or a reading hint. */
export function CardNote({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return (
    <p
      className={cn(
        "mt-3 text-xs",
        tone === "warn" ? "rounded-lg bg-amber-50 px-3 py-2 text-amber-900" : "text-[#006496]/60",
      )}
    >
      {children}
    </p>
  );
}

/** A figure with a caption, for the little stat rows inside a card. */
export function MiniStat({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" | "good" }) {
  return (
    <div className="rounded-xl bg-[#006496]/[0.05] px-3 py-2 text-center">
      <p className={cn("text-lg font-black tabular-nums text-[#1a3a4a]", tone === "bad" && "text-red-700")}>{value}</p>
      <p className="text-[11px] text-[#006496]/60">{label}</p>
    </div>
  );
}

/** What the MD is told wherever a viewer might look for who is inside now (there is no check-out). */
export const NO_CHECKOUT_TEXT =
  "Visitors are recorded at check-in only, so who is inside right now and how long a visitor stayed cannot be shown.";
