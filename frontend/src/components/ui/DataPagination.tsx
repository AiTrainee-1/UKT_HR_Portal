import { useMemo } from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * The portal's pagination bar: page counter on the left, numbered controls
 * in the middle, page-size picker on the right.
 *
 * One component for every list in the app, so the controls behave the same
 * everywhere -the same hover, the same keyboard target size, the same
 * ellipsis behaviour. Pages supply state and a page-change handler; nothing
 * about the look is decided per page.
 */

/** How many numbered buttons to show before collapsing to an ellipsis. */
const WINDOW = 4;

const PAGE_SIZES = [10, 25, 50, 100];

export interface DataPaginationProps {
  /** 1-based. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Omit the picker entirely by leaving these out. */
  pageSize?: number;
  onPageSizeChange?: (size: number) => void;
  pageSizes?: number[];
  /** Total row count, for the "1–10 of 240" readout. */
  totalItems?: number;
  className?: string;
}

/**
 * The numbers to render, with `null` standing for an ellipsis.
 *
 * Always keeps the first page, the last page and a window around the current
 * one. Collapsing only when it actually helps -a 6-page list shows all six
 * rather than "1 … 4 5 6", which is longer AND less useful.
 */
function pageItems(page: number, totalPages: number): (number | null)[] {
  if (totalPages <= WINDOW + 2) {
    return Array.from({ length: totalPages }, (_, i) => i + 1);
  }

  const items: (number | null)[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(totalPages - 1, start + WINDOW - 2);

  if (start > 2) items.push(null);
  for (let p = start; p <= end; p++) items.push(p);
  if (end < totalPages - 1) items.push(null);

  items.push(totalPages);
  return items;
}

function NavButton({
  label, disabled, onClick, children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          className={cn(
            "flex size-9 items-center justify-center rounded-lg text-gray-500",
            "transition-all duration-150",
            "hover:bg-gray-100 hover:text-gray-900 active:scale-95",
            "disabled:pointer-events-none disabled:opacity-30",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function DataPagination({
  page,
  totalPages,
  onPageChange,
  pageSize,
  onPageSizeChange,
  pageSizes = PAGE_SIZES,
  totalItems,
  className,
}: DataPaginationProps) {
  const items = useMemo(() => pageItems(page, totalPages), [page, totalPages]);

  // Nothing to paginate through -rendering a lone disabled "1" is noise.
  if (totalPages <= 1 && !onPageSizeChange) return null;

  const go = (p: number) => {
    const next = Math.min(Math.max(1, p), totalPages);
    if (next !== page) onPageChange(next);
  };

  const from = pageSize ? (page - 1) * pageSize + 1 : null;
  const to = pageSize && totalItems != null
    ? Math.min(page * pageSize, totalItems)
    : pageSize ? page * pageSize : null;

  return (
    <TooltipProvider delayDuration={250}>
      <div
        className={cn(
          "flex flex-wrap items-center justify-between gap-4 py-4",
          className,
        )}
      >
        {/* ── Counter ── */}
        <p className="text-sm text-gray-400">
          Page <span className="font-semibold text-gray-900">{page}</span> of{" "}
          <span className="font-semibold text-gray-900">{totalPages}</span>
          {from != null && totalItems != null && totalItems > 0 && (
            <span className="ml-2 hidden text-xs text-gray-400 sm:inline">
              ({from.toLocaleString()}–{to?.toLocaleString()} of {totalItems.toLocaleString()})
            </span>
          )}
        </p>

        {/* ── Controls ── */}
        <div className="flex items-center gap-1">
          <NavButton label="Previous page" disabled={page <= 1} onClick={() => go(page - 1)}>
            <ChevronLeft className="size-4" />
          </NavButton>

          {items.map((item, i) =>
            item === null ? (
              <span
                key={`gap-${i}`}
                aria-hidden="true"
                className="flex size-9 items-center justify-center text-gray-400"
              >
                <MoreHorizontal className="size-4" />
              </span>
            ) : (
              <Tooltip key={item}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={`Page ${item}`}
                    aria-current={item === page ? "page" : undefined}
                    onClick={() => go(item)}
                    className={cn(
                      "flex size-9 items-center justify-center rounded-lg text-sm font-semibold",
                      "transition-all duration-150 active:scale-95",
                      item === page
                        // The current page is a raised card, matching how the
                        // rest of the portal marks a selected surface.
                        ? "border border-gray-200 bg-white text-gray-900 shadow-sm"
                        : "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                    )}
                  >
                    {item}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {item === page ? `Page ${item} (current)` : `Go to page ${item}`}
                </TooltipContent>
              </Tooltip>
            ),
          )}

          <NavButton label="Next page" disabled={page >= totalPages} onClick={() => go(page + 1)}>
            <ChevronRight className="size-4" />
          </NavButton>
        </div>

        {/* ── Page size ── */}
        {onPageSizeChange && pageSize != null ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div>
                <Select
                  value={String(pageSize)}
                  onValueChange={(v) => {
                    onPageSizeChange(Number(v));
                    // Row 1 of the new size, not "page 7 of a list that is
                    // now 3 pages long".
                    onPageChange(1);
                  }}
                >
                  <SelectTrigger className="h-9 w-[116px] rounded-lg text-sm font-medium">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pageSizes.map((s) => (
                      <SelectItem key={s} value={String(s)}>
                        {s} / page
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </TooltipTrigger>
            <TooltipContent>Rows per page</TooltipContent>
          </Tooltip>
        ) : (
          // Keeps the numbered controls optically centred when there is no
          // picker, instead of letting them drift right.
          <span aria-hidden="true" className="hidden w-[116px] sm:block" />
        )}
      </div>
    </TooltipProvider>
  );
}

export default DataPagination;
