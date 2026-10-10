// Small presentational pieces shared by the Recruitment sections: a label chip, the "open for N days" and applicant-mix
// meters, the segmented switch, an initials avatar, and the error block for a section whose request failed. Cards
// themselves come from the MD kit; the glass classes (md-chip, md-btn, md-seg) from md-theme/glass.css and the rest from
// md-theme/areas/people.css.

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { CHART } from "@/components/md/kit/chartTheme";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { cn } from "@/lib/utils";
import { MIX_META, ageBar, initialsOf, mixSegments, mixTitle } from "./logic";
import type { QueryLike, StageMix } from "./types";

/** The glass chip each tone uses. The tone names are the ones the page's logic hands out (slate = neutral, amber = watch,
 *  red = bad, green = good, blue = information); the colours are the portal's palette (md-theme/glass.css). */
export const CHIP_TONES = {
  slate: "",
  amber: "md-chip-warning",
  red: "md-chip-danger",
  green: "md-chip-success",
  blue: "md-people-chip-info",
} as const;

export type ChipTone = keyof typeof CHIP_TONES;

/** A small label pill (not a button: nothing in it is clickable). */
export function Chip({
  tone = "slate",
  children,
  className,
  testId,
}: {
  tone?: ChipTone;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <span className={cn("md-chip whitespace-nowrap", CHIP_TONES[tone], className)} data-testid={testId}>
      {children}
    </span>
  );
}

/** A round badge with a person's initials (drawn by CSS, so only the name is read out and searched). */
export function Avatar({ name, className }: { name: string; className?: string }) {
  return <span className={cn("md-people-avatar", className)} data-initials={initialsOf(name)} aria-hidden="true" />;
}

/** The error block for a section whose request failed and has nothing older to show. */
export function QueryError({ query }: { query: QueryLike<unknown> }) {
  if (!query.isError || query.data) return null;
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
}

/** A segmented switch: a frosted track, the chosen option a wine glass pill. Tabs, like the period switch above it. */
export function SegTabs({
  items,
  value,
  onChange,
  label,
}: {
  items: { value: string; label: ReactNode }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="md-seg max-w-full" role="tablist" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          role="tab"
          aria-selected={item.value === value}
          onClick={() => onChange(item.value)}
          className="md-seg-item min-h-9 whitespace-nowrap"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A ranked list that shows its first few rows and expands on request ("Show all 12"), like the tables' "Show more". */
export function Expandable<T>({
  items,
  initial = 8,
  children,
}: {
  items: T[];
  initial?: number;
  children: (shown: T[]) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, initial);
  return (
    <>
      {children(shown)}
      {items.length > initial && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            data-testid="show-more-bars"
            className="md-btn md-btn-soft md-btn-sm min-h-9"
          >
            {open ? "Show fewer" : `Show all ${items.length}`}
            <ChevronDown
              size={14}
              className={cn("transition-transform motion-reduce:transition-none", open && "rotate-180")}
            />
          </button>
        </div>
      )}
    </>
  );
}

const AGE_FILL = { ok: CHART.brand, warn: CHART.warn, stale: CHART.bad } as const;

/** How long a position has been open, against the oldest one, with a tick where "stale" begins. */
export function AgeBarView({ days, staleAfter, maxDays }: { days: number; staleAfter: number; maxDays: number }) {
  const bar = ageBar(days, staleAfter, maxDays);
  return (
    <div className="md-people-meter mt-1.5 w-full min-w-[7rem]" data-tone={bar.tone}>
      <div className="md-people-meter-fill" style={{ width: `${bar.widthPct}%`, background: AGE_FILL[bar.tone] }} />
      <span
        className="md-people-meter-tick"
        style={{ left: `${bar.markerPct}%` }}
        title={`Stale after ${staleAfter} days`}
        aria-hidden="true"
      />
    </div>
  );
}

/** The applicants of one position by status, as one proportional bar (hover for the words, or see the key under the table). */
export function MixBar({ mix }: { mix: StageMix }) {
  const segments = mixSegments(mix);
  if (segments.length === 0) return <span className="text-xs text-md-ink-soft">None yet</span>;
  return (
    <div
      className="md-people-meter md-people-meter-mix w-full min-w-[5rem]"
      title={mixTitle(mix)}
      role="img"
      aria-label={mixTitle(mix)}
    >
      {segments.map((s) => (
        <i key={s.key} style={{ width: `${s.widthPct}%`, background: s.color }} />
      ))}
    </div>
  );
}

/** What each colour of the applicants bar stands for, so the colours are not the only way to read it. */
export function MixKey() {
  return (
    <ul className="md-people-key" aria-label="Applicant colours" data-testid="md-recruitment-mix-key">
      {MIX_META.map((m) => (
        <li key={m.key}>
          <i style={{ background: m.color }} aria-hidden="true" />
          {m.label}
        </li>
      ))}
    </ul>
  );
}
