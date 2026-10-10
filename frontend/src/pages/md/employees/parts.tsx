// Small pieces the Employees cards share: an avatar, a label pill, a person's name cell and a labelled value.

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { initials } from "./logic";

/** Soft two-tone washes from the palette's ramps (wine, indigo, ochre, rose, sage, periwinkle, mauve, terracotta). */
const AVATAR_TONES = [
  "from-md-wine-100 to-md-wine-200/70 text-md-wine-800",
  "from-md-ink-100 to-md-ink-200/70 text-md-ink-800",
  "from-md-warning-100 to-md-warning-200/70 text-md-warning-800",
  "from-md-rose-100 to-md-rose-200/70 text-md-rose-800",
  "from-md-sage-100 to-md-sage-200/70 text-md-sage-800",
  "from-md-info-100 to-md-info-200/70 text-md-info-800",
  "from-md-mauve-100 to-md-mauve-200/70 text-md-mauve-800",
  "from-md-clay-100 to-md-clay-200/70 text-md-clay-800",
];

/** The same person always gets the same colour. */
const toneOf = (key: string) =>
  AVATAR_TONES[[...key].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 997, 7) % AVATAR_TONES.length];

export function PersonAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" | "lg" }) {
  return (
    <div
      aria-hidden
      className={cn(
        "flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-1 ring-inset ring-white/70",
        size === "lg" ? "h-14 w-14 text-lg" : size === "sm" ? "h-8 w-8 text-[11px]" : "h-9 w-9 text-xs",
        toneOf(name),
      )}
    >
      {initials(name)}
    </div>
  );
}

const CHIP_TONES = {
  neutral: "md-analytics-tone-neutral",
  info: "md-analytics-tone-info",
  watch: "md-analytics-tone-watch",
  good: "md-analytics-tone-good",
  bad: "md-analytics-tone-bad",
} as const;

export type ChipTone = keyof typeof CHIP_TONES;

/** A small label pill (a glass chip with a tone). */
export function Chip({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: ChipTone;
  className?: string;
}) {
  return <span className={cn("md-chip whitespace-nowrap", CHIP_TONES[tone], className)}>{children}</span>;
}

export function StatusChip({ status }: { status: "active" | "inactive" }) {
  return status === "active" ? <Chip tone="good">Active</Chip> : <Chip tone="neutral">Left</Chip>;
}

/** What a card says when its data could not be loaded (the reason is in the banner at the top of the page). */
export function Unavailable() {
  return (
    <p className="py-6 text-center text-sm text-md-ink-soft" data-testid="md-employees-unavailable">
      This could not be loaded, so nothing is shown here. The reason is at the top of the page.
    </p>
  );
}

/** A name over its employee code, with an avatar: how a person appears in every list on this page. */
export function PersonCell({ name, code, sub }: { name: string; code?: string; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <PersonAvatar name={name} size="sm" />
      <div className="min-w-0">
        <p className="truncate text-[13px] font-semibold text-md-ink">{name}</p>
        <p className="truncate text-[11px] text-md-ink-soft">{[code, sub].filter(Boolean).join(" · ")}</p>
      </div>
    </div>
  );
}

/** "LABEL" over a value: for the facts at the top of a profile. */
export function Fact({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="min-w-0" data-testid={testId}>
      <p className="text-[10.5px] font-bold uppercase tracking-wider text-md-ink-soft">{label}</p>
      <p className="mt-0.5 truncate text-[13px] font-semibold text-md-ink">{children}</p>
    </div>
  );
}
