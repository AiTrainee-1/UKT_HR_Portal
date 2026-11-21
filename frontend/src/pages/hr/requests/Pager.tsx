import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { PAGE_SIZES, pageButtons, pageRange } from "./logic";

/**
 * The list's pages (owner brief 2026-11-21): "Showing 26-50 of 212", rows per page, and the page buttons. The server
 * sends one page at a time, so a long list never loads all at once. A phone shows Previous / Page x of y / Next.
 */
export default function Pager({
  page,
  pages,
  pageSize,
  total,
  loading,
  onPage,
  onPageSize,
}: {
  page: number;
  pages: number;
  pageSize: number;
  total: number;
  /** A page is on its way: the buttons wait so a double click does not skip one. */
  loading?: boolean;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const { first, last } = pageRange(page, pageSize, total);
  const go = (n: number) => () => onPage(Math.min(Math.max(1, n), pages));
  const atStart = page <= 1;
  const atEnd = page >= pages;
  const arrow = "h-9 w-9 p-0";

  return (
    <nav
      aria-label="Pages of the request list"
      className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between"
      data-testid="requests-pager"
    >
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-gray-600">
        <p data-testid="requests-range" aria-live="polite">
          {total === 0 ? (
            "No requests"
          ) : (
            <>
              Showing{" "}
              <b className="tabular-nums text-gray-900">
                {first}-{last}
              </b>{" "}
              of <b className="tabular-nums text-gray-900">{total}</b> request{total === 1 ? "" : "s"}
            </>
          )}
        </p>
        <label className="flex items-center gap-2">
          <span>Rows per page</span>
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger
              className="h-8 w-[4.5rem] text-xs"
              aria-label="Rows per page"
              data-testid="requests-page-size"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {pages > 1 && (
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            className={cn(arrow, "hidden sm:inline-flex")}
            onClick={go(1)}
            disabled={atStart || loading}
            aria-label="First page"
          >
            <ChevronsLeft size={15} />
          </Button>
          <Button
            variant="outline"
            className="h-9 gap-1 px-2.5"
            onClick={go(page - 1)}
            disabled={atStart || loading}
            aria-label="Previous page"
            data-testid="requests-page-prev"
          >
            <ChevronLeft size={15} />
            <span className="sm:hidden">Previous</span>
          </Button>

          {/* phones: one line of text instead of a row of numbers */}
          <span
            className="px-2 text-xs font-semibold tabular-nums text-gray-700 sm:hidden"
            data-testid="requests-page-of"
          >
            Page {page} of {pages}
          </span>
          <div className="hidden items-center gap-1 sm:flex">
            {pageButtons(page, pages).map((n, i) =>
              n === "gap" ? (
                <span key={`gap-${i}`} className="px-1 text-xs text-gray-400" aria-hidden>
                  ...
                </span>
              ) : (
                <Button
                  key={n}
                  variant={n === page ? "default" : "outline"}
                  className={cn("h-9 min-w-9 px-2 tabular-nums", n === page && "pointer-events-none")}
                  onClick={go(n)}
                  disabled={loading && n !== page}
                  aria-label={`Page ${n}`}
                  aria-current={n === page ? "page" : undefined}
                  data-testid={`requests-page-${n}`}
                >
                  {n}
                </Button>
              ),
            )}
          </div>

          <Button
            variant="outline"
            className="h-9 gap-1 px-2.5"
            onClick={go(page + 1)}
            disabled={atEnd || loading}
            aria-label="Next page"
            data-testid="requests-page-next"
          >
            <span className="sm:hidden">Next</span>
            <ChevronRight size={15} />
          </Button>
          <Button
            variant="outline"
            className={cn(arrow, "hidden sm:inline-flex")}
            onClick={go(pages)}
            disabled={atEnd || loading}
            aria-label="Last page"
          >
            <ChevronsRight size={15} />
          </Button>
        </div>
      )}
    </nav>
  );
}
