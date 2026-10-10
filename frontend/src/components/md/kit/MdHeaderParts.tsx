import type { ReactNode } from "react";
import { BrainCircuit, LayoutGrid, RefreshCw } from "lucide-react";
import { clock, useRefreshAction } from "@/components/PageRefreshBar";
import { cn } from "@/lib/utils";

// The pieces of the header every MD page shares, so that the title row looks and lines up the same everywhere:
//
//   Title  (Live)  [ Operations | Insights & AI ]  ..................  [page's own buttons]  |  Updated 10:31:22 am
//   date or what the page is for                                                              |  Refresh
//
// MdPageHeader (kit) lays them out for the pages the MD portal owns; MdEmbeddedFrame slots the same pieces into the title
// row of an HR page's copy (embedded/headerRow.ts), so both kinds of page read alike.

/** The sage "Live" chip next to a page title: a pill with a softly ringed dot. */
export function LiveChip({ className }: { className?: string }) {
  return (
    <span className={cn("md-chip md-chip-success shrink-0", className)} data-testid="md-live">
      <span className="md-shell-live-dot motion-safe:animate-pulse" aria-hidden="true" />
      Live
    </span>
  );
}

export type FrameTab = "operations" | "insights";

const TAB_ICON = { operations: LayoutGrid, insights: BrainCircuit } as const;
const TAB_LABEL = { operations: "Operations", insights: "Insights & AI" } as const;

/** The switch between a page itself and its Insights: a frosted track, the chosen side a wine glass pill. */
export function ModeTabs({
  active,
  onSelect,
  label,
  className,
}: {
  active: FrameTab;
  onSelect: (tab: FrameTab) => void;
  /** The tablist's accessible name ("Employees views"). */
  label: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("md-seg md-shell-seg max-w-full shrink-0", className)}
      data-testid="md-tabs"
    >
      {(["operations", "insights"] as const).map((id) => {
        const Icon = TAB_ICON[id];
        const on = active === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={on}
            data-testid={`md-tab-${id}`}
            onClick={() => onSelect(id)}
            className="md-seg-item whitespace-nowrap"
          >
            <Icon size={14} strokeWidth={2.2} aria-hidden="true" /> {TAB_LABEL[id]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The far right of the title row: when the data on screen arrived (or, on the analytics pages, the moment the server made
 * its numbers: `stamp`) over a Refresh button that reloads everything on the page. A hairline sets it apart from the
 * page's own buttons. It stays under 44 px tall: the HR pages' copies pin it to a 44 px corner of their own title row.
 */
export function UpdatedRefresh({ stamp, className }: { stamp?: ReactNode; className?: string }) {
  const { refresh, busy, lastUpdated } = useRefreshAction();
  return (
    <div className={cn("flex shrink-0 items-stretch gap-3 print:hidden", className)} data-testid="md-refresh-stack">
      <span aria-hidden className="w-px self-stretch bg-md-line" />
      <div className="flex flex-col items-end justify-center gap-0.5 leading-tight">
        {stamp ? (
          <span className="text-[11px] font-medium tabular-nums text-md-ink-soft" data-testid="md-updated">
            {stamp}
          </span>
        ) : (
          lastUpdated > 0 && (
            <span className="text-[11px] font-medium tabular-nums text-md-ink-soft" data-testid="md-updated">
              Updated {clock(lastUpdated)}
            </span>
          )
        )}
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          aria-label="Refresh this page"
          data-testid="md-refresh"
          className="md-btn md-btn-soft md-shell-refresh"
        >
          <RefreshCw size={12} strokeWidth={2.4} className={cn("text-md-wine", busy && "motion-safe:animate-spin")} />{" "}
          Refresh
        </button>
      </div>
    </div>
  );
}
