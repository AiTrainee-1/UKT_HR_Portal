import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { pageCount, pageNumbers, pageRangeText, PAGE_SIZE } from "./logic";

/** Under the request list: which rows are shown ("Showing 11–20 of 23") and, when there is more than one page,
 *  Previous / the page numbers / Next. */
export default function Pagination({
  total,
  page,
  onPage,
  size = PAGE_SIZE,
}: {
  total: number;
  page: number;
  onPage: (page: number) => void;
  size?: number;
}) {
  const pages = pageCount(total, size);
  const current = Math.min(Math.max(1, page), pages);
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-md-line pt-4"
      data-testid="md-approvals-pagination"
    >
      <p className="text-xs font-semibold tabular-nums text-md-ink-soft" aria-live="polite">
        {pageRangeText(total, current, size)}
      </p>
      {pages > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            className="md-btn md-btn-soft md-btn-sm"
            onClick={() => onPage(current - 1)}
            disabled={current === 1}
            data-testid="md-approvals-page-prev"
          >
            <ChevronLeft size={14} aria-hidden="true" /> Previous
          </button>
          {pageNumbers(current, pages).map((n, i) =>
            n === "…" ? (
              <span key={`gap-${i}`} className="px-1 text-xs text-md-ink-soft" aria-hidden="true">
                …
              </span>
            ) : (
              <button
                key={n}
                type="button"
                onClick={() => onPage(n)}
                aria-current={n === current ? "page" : undefined}
                aria-label={`Page ${n}`}
                data-testid={`md-approvals-page-${n}`}
                className={cn(
                  "min-h-8 min-w-8 rounded-full px-2 text-xs font-bold tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-md-wine",
                  n === current
                    ? "bg-md-wine text-white shadow"
                    : "text-md-ink-soft hover:bg-md-wine/[0.06] hover:text-md-ink",
                )}
              >
                {n}
              </button>
            ),
          )}
          <button
            type="button"
            className="md-btn md-btn-soft md-btn-sm"
            onClick={() => onPage(current + 1)}
            disabled={current === pages}
            data-testid="md-approvals-page-next"
          >
            Next <ChevronRight size={14} aria-hidden="true" />
          </button>
        </nav>
      )}
    </div>
  );
}
