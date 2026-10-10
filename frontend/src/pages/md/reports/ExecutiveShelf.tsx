import { ArrowDown, Hourglass, Landmark } from "lucide-react";
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
      <div className="mb-4 flex items-center gap-3">
        <span className="md-money-tile md-money-tile-solid md-money-t-wine">
          <Landmark size={20} aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 id="md-executive-heading" className="text-lg font-black leading-tight tracking-tight text-md-ink">
            Executive reports
          </h3>
          <p className="mt-0.5 text-[13px] text-md-ink-soft">One-page summaries prepared for the Managing Director</p>
        </div>
      </div>

      {groups.length > 0 ? (
        <div className="grid grid-cols-1 gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
          {groups.map((g, i) => (
            <ExecutiveCard key={g.key} group={g} order={i} />
          ))}
        </div>
      ) : (
        <div
          className="md-panel-sand flex flex-col items-center gap-4 px-6 py-7 text-center sm:flex-row sm:text-left"
          data-testid="md-executive-empty"
        >
          <span className="md-money-tile md-money-tile-lg md-money-t-warning">
            <Hourglass size={22} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-base font-black text-md-ink">Executive reports are being prepared</p>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-md-ink-soft">
              One-page summaries for you will appear here, ready to view, print or export. Every report in the library
              below is already open to you.
            </p>
          </div>
          <button type="button" onClick={scrollToLibrary} className="md-btn md-btn-soft shrink-0">
            Browse the library <ArrowDown size={14} aria-hidden />
          </button>
        </div>
      )}
    </section>
  );
}
