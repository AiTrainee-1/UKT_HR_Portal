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
    <div className="md-analytics-heading" data-testid={testId}>
      <div className="md-icon-tile md-icon-tile-solid mt-0.5 h-10 w-10 shrink-0">
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <h3 className="md-analytics-heading-title">{title}</h3>
        {subtitle && <p className="md-analytics-heading-sub">{subtitle}</p>}
      </div>
    </div>
  );
}

/** What a chip's tone means (md-theme/areas/analytics.css): blue is information, indigo the brand, amber to watch, red bad,
 *  green good, slate a plain label. */
const CHIP_TONES = {
  blue: "md-analytics-tone-info",
  indigo: "md-analytics-tone-wine",
  slate: "md-analytics-tone-neutral",
  amber: "md-analytics-tone-watch",
  red: "md-analytics-tone-bad",
  green: "md-analytics-tone-good",
} as const;

export type ChipTone = keyof typeof CHIP_TONES;

/** A small label pill (a glass chip with a tone). Not a Badge: those lift on hover, and these are not clickable. */
export function Chip({
  children,
  tone = "slate",
  className,
}: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
}) {
  return <span className={cn("md-chip whitespace-nowrap", CHIP_TONES[tone], className)}>{children}</span>;
}

/** A person in a table: the name, and under it the code and department (or any small line). */
export function PersonCell({ name, sub }: { name: string; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-semibold text-md-ink">{name}</p>
      {sub && <p className="truncate text-[11px] text-md-ink-soft">{sub}</p>}
    </div>
  );
}

/** Small print under a chart: a caveat or a reading hint. */
export function CardNote({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" }) {
  return tone === "warn" ? (
    <p className="md-analytics-callout md-analytics-tone-watch">{children}</p>
  ) : (
    <p className="md-analytics-note">{children}</p>
  );
}

/** A figure with a caption, for the little stat rows inside a card. */
export function MiniStat({ label, value, tone }: { label: string; value: ReactNode; tone?: "bad" | "good" }) {
  return (
    <div
      className={cn(
        "md-analytics-stat text-center",
        tone === "bad" && "md-analytics-tone-bad",
        tone === "good" && "md-analytics-tone-good",
      )}
    >
      <p className="md-analytics-stat-value">{value}</p>
      <p className="md-analytics-stat-label">{label}</p>
    </div>
  );
}

/** What the MD is told wherever a viewer might look for who is inside now (there is no check-out). */
export const NO_CHECKOUT_TEXT =
  "Visitors are recorded at check-in only, so who is inside right now and how long a visitor stayed cannot be shown.";
