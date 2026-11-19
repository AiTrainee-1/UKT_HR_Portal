import type { ComponentType, CSSProperties, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";
import { AlertTriangle, Inbox } from "lucide-react";
import { DataPagination } from "@/components/ui/DataPagination";
import { EmptyNote } from "@/components/payroll/kit/parts";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type IconType = ComponentType<{ size?: number; className?: string }>;

export type DataColumn<T> = {
  key: string;
  header: ReactNode;
  /** What the cell shows. */
  cell: (row: T) => ReactNode;
  /** The cell as plain text: its tooltip (the whole of a cut-off text). Default: none. */
  text?: (row: T) => string | null | undefined;
  align?: "left" | "right" | "center";
  /** Cut the cell to one line with an ellipsis (default). Off for a cell that holds its own layout (a chip, a button). */
  truncate?: boolean;
  /** The widest the column gets before it cuts (px, default 240). */
  maxWidth?: number;
  /** The narrowest it gets (px). */
  minWidth?: number;
  /** Hidden below the tablet width (a column a phone can do without). */
  hideOnPhone?: boolean;
  className?: string;
  headerClassName?: string;
};

export type DataTablePagination = {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizes?: number[];
};

/** How many pages `total` rows make (at least 1). */
const pageCount = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / Math.max(1, pageSize)));

/**
 * A page past the end (the list shrank under it: rows checked out, deleted or filtered away elsewhere, or an old link) goes
 * to the last page, so the table never sits on an empty page with rows before it. Only for a loaded list with rows: while
 * it loads the total may still be the previous one, and an empty list has no page to go to. Every table of the three
 * modules gets this from here, whichever way it keeps its page (the address or its own state).
 */
function usePageClamp(pagination: DataTablePagination | undefined, lastPage: number) {
  const onPageChange = useRef(pagination?.onPageChange);
  onPageChange.current = pagination?.onPageChange;
  const tooFar = !!pagination && pagination.total > 0 && pagination.page > lastPage;
  useEffect(() => {
    if (tooFar) onPageChange.current?.(lastPage);
  }, [tooFar, lastPage]);
}

/** Clicks on these inside a row are theirs, not the row's. */
const OWN_CLICK = "button, a, input, select, textarea, label, [role='menuitem'], [data-row-ignore]";

/**
 * The table of the three modules: one card with an optional summary line ("128 passes · 117 back · 11 out") and tools on
 * top, a header that stays in view, single-line rows of ~48 px (long text cut with its tooltip), skeleton rows while the
 * first page loads (with a hidden "Loading…" for screen readers and the tests' `ready()`), a note when nothing matches,
 * and the pagination bar under it. The rows scroll sideways inside the card, never the page.
 *
 * With `onRowClick` every row opens its details: by mouse, or by keyboard (Tab to the row, Enter or Space). A button or
 * link inside a row keeps its own click.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  selectedKey,
  loading = false,
  skeletonRows = 8,
  error,
  onRetry,
  empty,
  summary,
  toolbar,
  pagination,
  maxHeight,
  caption,
  testId,
  className,
}: {
  columns: readonly DataColumn<T>[];
  rows: readonly T[] | undefined;
  rowKey: (row: T) => string | number;
  onRowClick?: (row: T) => void;
  /** How a screen reader names a row that opens something: "Open the pass of Ravi Kumar". */
  rowLabel?: (row: T) => string;
  /** The row whose details are open (marked). */
  selectedKey?: string | number | null;
  /** The list is loading. With rows already shown (the previous page), they stay, dimmed. */
  loading?: boolean;
  skeletonRows?: number;
  /** The list could not be loaded: what to say. */
  error?: string | null;
  onRetry?: () => void;
  empty?: { icon?: IconType; title: string; hint?: ReactNode; action?: ReactNode };
  summary?: ReactNode;
  toolbar?: ReactNode;
  pagination?: DataTablePagination;
  /** A height for the rows' box ("60vh"): the header then stays in view while the rows scroll inside it. */
  maxHeight?: string;
  /** What the table is, for screen readers ("Gate records"). */
  caption?: string;
  testId?: string;
  className?: string;
}) {
  const list = rows ?? [];
  const firstLoad = loading && list.length === 0;
  const showEmpty = !loading && !error && list.length === 0;
  const lastPage = pagination ? pageCount(pagination.total, pagination.pageSize) : 1;
  usePageClamp(pagination && !loading && !error ? pagination : undefined, lastPage);

  const activate = (row: T) => onRowClick?.(row);
  const onClick = (e: MouseEvent<HTMLTableRowElement>, row: T) => {
    const own = (e.target as HTMLElement).closest(OWN_CLICK);
    if (own && own !== e.currentTarget && e.currentTarget.contains(own)) return;
    activate(row);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTableRowElement>, row: T) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
      e.preventDefault();
      activate(row);
    }
  };

  const cellStyle = (c: DataColumn<T>): CSSProperties => ({
    maxWidth: c.truncate === false ? undefined : (c.maxWidth ?? 240),
    minWidth: c.minWidth,
  });
  const alignClass = (c: DataColumn<T>) =>
    c.align === "right" ? "text-right" : c.align === "center" ? "text-center" : "text-left";

  return (
    <div
      className={cn("min-w-0 max-w-full overflow-hidden rounded-2xl border border-slate-200/80 bg-white", className)}
      data-testid={testId}
      aria-busy={loading || undefined}
    >
      {(summary || toolbar) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <div className="min-w-0 text-sm text-slate-600">{summary}</div>
          {toolbar && <div className="flex flex-wrap items-center gap-2">{toolbar}</div>}
        </div>
      )}

      {loading && (
        <span className="sr-only" role="status">
          Loading…
        </span>
      )}

      {error ? (
        <div className="flex flex-col items-center gap-2 px-6 py-10 text-center" role="alert">
          <AlertTriangle size={26} className="text-rose-500" />
          <p className="text-sm font-semibold text-slate-800">Could not load this list.</p>
          <p className="max-w-md text-xs text-slate-500">{error}</p>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 h-11 rounded-lg border border-slate-200 px-4 text-sm font-medium text-slate-700 hover:bg-slate-50 sm:h-9"
            >
              Try again
            </button>
          )}
        </div>
      ) : showEmpty ? (
        <div className="p-4">
          <EmptyNote
            icon={empty?.icon ?? Inbox}
            title={empty?.title ?? "Nothing to show"}
            hint={empty?.hint ?? "Try other dates, or clear the filters."}
            action={empty?.action}
          />
        </div>
      ) : (
        // the rows' own scroll box: reachable by Tab when no row is (so a keyboard can scroll it sideways)
        <div
          className="overflow-x-auto focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
          style={maxHeight ? { maxHeight, overflowY: "auto" } : undefined}
          role="region"
          aria-label={caption ?? "Table"}
          tabIndex={onRowClick && list.length > 0 ? -1 : 0}
        >
          <table className="w-full min-w-full border-separate border-spacing-0 text-[13px] tabular-nums">
            {caption && <caption className="sr-only">{caption}</caption>}
            <thead>
              <tr>
                {columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={cn(
                      "sticky top-0 z-[1] whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500",
                      alignClass(c),
                      c.hideOnPhone && "hidden sm:table-cell",
                      c.headerClassName,
                    )}
                    style={{ minWidth: c.minWidth }}
                  >
                    {c.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn(loading && !firstLoad && "opacity-60")}>
              {firstLoad
                ? Array.from({ length: skeletonRows }).map((_, i) => (
                    <tr key={`skeleton-${i}`} aria-hidden="true">
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn("h-12 border-b border-slate-100 px-3", c.hideOnPhone && "hidden sm:table-cell")}
                        >
                          <Skeleton className="h-3.5 w-full max-w-[8rem]" />
                        </td>
                      ))}
                    </tr>
                  ))
                : list.map((row) => {
                    const key = rowKey(row);
                    const selected = selectedKey !== undefined && selectedKey !== null && selectedKey === key;
                    return (
                      <tr
                        key={key}
                        data-row-key={key}
                        tabIndex={onRowClick ? 0 : undefined}
                        aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                        aria-current={selected ? "true" : undefined}
                        onClick={onRowClick ? (e) => onClick(e, row) : undefined}
                        onKeyDown={onRowClick ? (e) => onKeyDown(e, row) : undefined}
                        className={cn(
                          "group",
                          onRowClick &&
                            "cursor-pointer outline-none hover:bg-slate-50 focus-visible:bg-sky-50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary",
                          selected && "bg-sky-50",
                        )}
                      >
                        {columns.map((c) => {
                          const tip = c.text?.(row) ?? undefined;
                          return (
                            <td
                              key={c.key}
                              className={cn(
                                "h-12 whitespace-nowrap border-b border-slate-100 px-3 py-1.5 align-middle text-slate-700",
                                alignClass(c),
                                c.hideOnPhone && "hidden sm:table-cell",
                                c.className,
                              )}
                              style={cellStyle(c)}
                            >
                              {c.truncate === false ? (
                                c.cell(row)
                              ) : (
                                <div className="truncate" title={tip || undefined}>
                                  {c.cell(row)}
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
            </tbody>
          </table>
        </div>
      )}

      {pagination && !error && pagination.total > 0 && (
        <DataPagination
          page={pagination.page}
          totalPages={lastPage}
          onPageChange={pagination.onPageChange}
          pageSize={pagination.pageSize}
          onPageSizeChange={pagination.onPageSizeChange}
          pageSizes={pagination.pageSizes}
          totalItems={pagination.total}
          className={cn(
            "border-t border-slate-100 px-4 py-2 [&>div]:flex-wrap",
            "max-sm:[&_[data-slot=page-number]]:size-11 max-sm:[&_[data-slot=page-step]]:size-11",
          )}
        />
      )}
    </div>
  );
}
