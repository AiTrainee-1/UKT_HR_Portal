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

/** The green "Live" chip next to a page title. */
export function LiveChip({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700",
        className,
      )}
      data-testid="md-live"
    >
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
      Live
    </span>
  );
}

export type FrameTab = "operations" | "insights";

const TAB_ICON = { operations: LayoutGrid, insights: BrainCircuit } as const;
const TAB_LABEL = { operations: "Operations", insights: "Insights & AI" } as const;

/** The switch between a page itself and its Insights: a pale track, the chosen side in amber. */
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
      className={cn("inline-flex shrink-0 items-center gap-1 rounded-xl bg-[#e8eff7] p-1", className)}
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
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[13px] font-bold transition-colors",
              on ? "bg-[#f59e0b] text-white shadow-sm" : "text-[#1a3a4a]/75 hover:bg-white/70 hover:text-[#1a3a4a]",
            )}
          >
            <Icon size={14} strokeWidth={2.2} /> {TAB_LABEL[id]}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The far right of the title row: when the data on screen arrived (or, on the analytics pages, the moment the server made
 * its numbers: `stamp`) over a Refresh button that reloads everything on the page. A hairline sets it apart from the
 * page's own buttons.
 */
export function UpdatedRefresh({ stamp, className }: { stamp?: ReactNode; className?: string }) {
  const { refresh, busy, lastUpdated } = useRefreshAction();
  return (
    <div className={cn("flex shrink-0 items-stretch gap-3 print:hidden", className)} data-testid="md-refresh-stack">
      <span aria-hidden className="w-px self-stretch bg-[#006496]/15" />
      <div className="flex flex-col items-end justify-center leading-tight">
        {stamp ? (
          <span className="text-[11px] tabular-nums text-gray-500" data-testid="md-updated">
            {stamp}
          </span>
        ) : (
          lastUpdated > 0 && (
            <span className="text-[11px] tabular-nums text-gray-500" data-testid="md-updated">
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
          className="mt-0.5 inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#0b78b0] transition-colors hover:text-[#006496] disabled:opacity-60"
        >
          <RefreshCw size={13} className={busy ? "animate-spin" : ""} /> Refresh
        </button>
      </div>
    </div>
  );
}
