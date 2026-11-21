import { ArrowDown, Hourglass, Landmark } from "lucide-react";
import { MonthPicker, monthLabel, thisMonthKey } from "@/components/md/kit/MonthPicker";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { ReportGroup } from "@/lib/report-catalog";
import type { NamedOption } from "@/lib/report-center";
import { cn } from "@/lib/utils";
import { ExecutiveCard } from "./ReportCards";
import { executiveHref } from "./report-library";

const ALL = "__all__";

/** Scrolls the report library into view (the shelf's way of saying "meanwhile, everything else is open to you"). */
function scrollToLibrary() {
  document.getElementById("md-report-library")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
}

/**
 * The MD's own reports, big, at the top of the page. A month and a unit chosen above the cards (kept in the address) open
 * each report already filtered to them and run; with no month a report opens with its own defaults. While the backend
 * has none it says so plainly and points at the library, so the page reads as "being prepared" and not as "broken".
 */
export function ExecutiveShelf({
  groups,
  month,
  branch,
  branches,
  onMonth,
  onBranch,
}: {
  groups: ReportGroup[];
  month: string | null;
  branch: string;
  branches: NamedOption[];
  onMonth: (month: string | null) => void;
  onBranch: (branch: string) => void;
}) {
  return (
    <section aria-labelledby="md-executive-heading" data-testid="md-executive-shelf">
      <div className="mb-3 flex flex-wrap items-center gap-3 @lg:mb-4">
        <span className="md-money-tile md-money-tile-solid md-money-t-wine">
          <Landmark size={20} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="md-executive-heading" className="text-lg font-black leading-tight tracking-tight text-md-ink">
            Executive reports
          </h3>
          <p className="mt-0.5 text-[13px] text-md-ink-soft">
            {month
              ? `One-page summaries prepared for the Managing Director, opened for ${monthLabel(month)}`
              : "One-page summaries prepared for the Managing Director"}
          </p>
        </div>
        {groups.length > 0 && (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto" data-testid="md-executive-filters">
            <MonthPicker value={month ?? thisMonthKey()} onChange={(m) => onMonth(m)} label="Month for the reports" />
            <button
              type="button"
              onClick={() => onMonth(null)}
              aria-pressed={!month}
              className={cn("md-btn md-btn-sm", month ? "md-btn-ghost" : "md-btn-soft")}
              data-testid="md-executive-defaults"
            >
              Each report's own period
            </button>
            {branches.length > 1 && (
              <Select value={branch || ALL} onValueChange={(v) => onBranch(v === ALL ? "" : v)}>
                <SelectTrigger
                  className="md-field h-9 w-full text-xs font-semibold sm:w-[10.5rem]"
                  aria-label="Unit for the reports"
                  data-testid="md-executive-unit"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All units</SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        )}
      </div>

      {groups.length > 0 ? (
        // two across on a phone (an odd last card takes the whole row); one, two or three across as the page widens
        <div className="grid grid-cols-2 gap-3 @lg:grid-cols-1 @lg:gap-4 @xl:grid-cols-2 @4xl:grid-cols-3 @max-lg:[&>*:last-child:nth-child(odd)]:col-span-2">
          {groups.map((g, i) => (
            <ExecutiveCard key={g.key} group={g} order={i} href={executiveHref(g.primary, month, branch)} />
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
