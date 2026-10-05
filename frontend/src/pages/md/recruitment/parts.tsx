// Small presentational pieces shared by the Recruitment sections: a label chip, the "open for N days" bar, the
// applicant-mix bar, and the error block for a section whose request failed. Cards themselves come from the MD kit.

import { useState, type ReactNode } from "react";
import { CHART } from "@/components/md/kit/chartTheme";
import { ErrorBanner } from "@/components/md/kit/states";
import { Button } from "@/components/ui/button";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { cn } from "@/lib/utils";
import { ageBar, mixSegments, mixTitle } from "./logic";
import type { QueryLike, StageMix } from "./types";

/** Tints written out in full (Tailwind cannot build class names from variables). */
export const CHIP_TONES = {
  slate: "border-slate-200 bg-slate-100 text-slate-700",
  amber: "border-amber-200 bg-amber-50 text-amber-800",
  red: "border-red-200 bg-red-50 text-red-700",
  green: "border-green-200 bg-green-50 text-green-700",
  blue: "border-blue-200 bg-blue-50 text-blue-700",
} as const;

export type ChipTone = keyof typeof CHIP_TONES;

/** A small label pill (not a Badge: those lift on hover, and these are not clickable). */
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
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        CHIP_TONES[tone],
        className,
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

/** The error block for a section whose request failed and has nothing older to show. */
export function QueryError({ query }: { query: QueryLike<unknown> }) {
  if (!query.isError || query.data) return null;
  return <ErrorBanner message={describeMdError(query.error)} onRetry={() => void query.refetch()} />;
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
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setOpen((o) => !o)} data-testid="show-more-bars">
            {open ? "Show fewer" : `Show all ${items.length}`}
          </Button>
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
    <div className="relative mt-1.5 h-2 w-full min-w-[7rem] rounded-full bg-[#006496]/[0.07]" data-tone={bar.tone}>
      <div
        className="h-full rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${bar.widthPct}%`, background: AGE_FILL[bar.tone] }}
      />
      <span
        className="absolute -top-[3px] h-[14px] w-px bg-slate-400"
        style={{ left: `${bar.markerPct}%` }}
        title={`Stale after ${staleAfter} days`}
        aria-hidden="true"
      />
    </div>
  );
}

/** The applicants of one position by status, as one proportional bar (hover for the words). */
export function MixBar({ mix }: { mix: StageMix }) {
  const segments = mixSegments(mix);
  if (segments.length === 0) return <span className="text-xs text-[#006496]/50">None yet</span>;
  return (
    <div
      className="flex h-2 w-full min-w-[5rem] overflow-hidden rounded-full bg-[#006496]/[0.07]"
      title={mixTitle(mix)}
    >
      {segments.map((s) => (
        <i key={s.key} className="h-full" style={{ width: `${s.widthPct}%`, background: s.color }} />
      ))}
    </div>
  );
}
