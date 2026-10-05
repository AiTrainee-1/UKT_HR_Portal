import { ArrowDown, Hourglass, Landmark } from "lucide-react";
import { MD_GOLD_GRADIENT } from "@/components/md/MdSidebar";
import type { ReportGroup } from "@/lib/report-catalog";
import { ExecutiveCard } from "./ReportCards";

/** Scrolls the report library into view (the shelf's way of saying "meanwhile, everything else is open to you"). */
function scrollToLibrary() {
  document.getElementById("md-report-library")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/**
 * The MD's own reports, big, at the top of the page. While the backend has none (they arrive with a later release) it
 * says so plainly and points at the library, so the page reads as "being prepared" and not as "broken".
 */
export function ExecutiveShelf({ groups }: { groups: ReportGroup[] }) {
  return (
    <section aria-labelledby="md-executive-heading" data-testid="md-executive-shelf">
      <div className="mb-3 flex items-center gap-2.5">
        <span
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-[#5b3d00] shadow-sm"
          style={{ background: MD_GOLD_GRADIENT }}
        >
          <Landmark size={16} />
        </span>
        <div>
          <h3 id="md-executive-heading" className="text-base font-black text-[#1a3a4a]">
            Executive reports
          </h3>
          <p className="text-xs text-[#006496]/60">One-page summaries prepared for the Managing Director</p>
        </div>
      </div>

      {groups.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
          {groups.map((g) => (
            <ExecutiveCard key={g.key} group={g} />
          ))}
        </div>
      ) : (
        <div
          className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-[#e0a83a]/60 bg-gradient-to-br from-[#fffaf0] to-white px-6 py-7 text-center sm:flex-row sm:text-left"
          data-testid="md-executive-empty"
        >
          <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#fbf3dc] text-[#8a5d00]">
            <Hourglass size={22} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-[#1a3a4a]">Executive reports are being prepared</p>
            <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
              One-page summaries for you will appear here, ready to view, print or export. Every report in the library
              below is already open to you.
            </p>
          </div>
          <button
            type="button"
            onClick={scrollToLibrary}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[#006496]/15 bg-white px-3.5 py-1.5 text-xs font-semibold text-[#006496] shadow-sm transition-colors hover:bg-[#006496]/[0.05]"
          >
            Browse the library <ArrowDown size={13} />
          </button>
        </div>
      )}
    </section>
  );
}
