import { Fragment, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortDir } from "./logic";

export type Col<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** the totals row's cell */
  total?: ReactNode;
  /** makes the header a sort button for this key */
  sortKey?: string;
  align?: "left" | "right";
  /** what the column means, on hovering its header */
  title?: string;
  className?: string;
};

/**
 * A money table: sortable headers (the page decides how: on the server or here), an optional totals row, rows that open
 * something, and a detail row under a row. Wide tables scroll sideways inside their own box (never the page), with the
 * first column pinned so a row stays readable while scrolling.
 */
export default function SortTable<T>({
  columns,
  rows,
  rowKey,
  sort,
  onSort,
  onRowClick,
  rowLabel,
  highlight,
  detail,
  totals,
  minWidth = "56rem",
  caption,
  testId,
}: {
  columns: Col<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  sort?: { key: string; dir: SortDir } | null;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  /** read out for a row that opens something ("Open Anitha's salary history") */
  rowLabel?: (row: T) => string;
  highlight?: (row: T) => boolean;
  /** a row of detail under a row (shown when it returns something) */
  detail?: (row: T) => ReactNode;
  totals?: boolean;
  minWidth?: string;
  caption?: string;
  testId?: string;
}) {
  const align = (a?: "left" | "right") => (a === "right" ? "text-right" : "text-left");
  // the pinned first column needs a solid background to hide what scrolls under it: the card's own, or the wine tint
  // of a chosen row and of the totals row
  const pin = (i: number, tinted = false) =>
    i === 0
      ? cn(
          "sticky left-0 z-[1] shadow-[1px_0_0_var(--md-line)]",
          tinted
            ? "bg-[color-mix(in_srgb,var(--md-wine)_6%,white)]"
            : "bg-[color-mix(in_srgb,var(--md-alabaster)_55%,white)]",
        )
      : "";

  // `relative`: an absolutely placed piece inside (a screen-reader-only header) must be clipped by this box too, or it
  // stretches the whole page sideways
  return (
    <div
      className="relative -mx-1 overflow-x-auto overscroll-x-contain px-1 pb-1"
      role="region"
      aria-label={caption}
      tabIndex={0}
      data-testid={testId}
    >
      <table className="md-money-table w-full text-[13px] text-md-ink" style={{ minWidth }}>
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c, i) => {
              const active = !!c.sortKey && sort?.key === c.sortKey;
              const Icon = !active ? ChevronsUpDown : sort?.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <th
                  key={c.key}
                  scope="col"
                  title={c.title}
                  // a header may wrap onto two lines ("Attendance / ded."), so the table fits a laptop's width before
                  // it has to scroll; the figures under it never wrap
                  className={cn("leading-tight whitespace-normal!", align(c.align), pin(i), c.className)}
                  aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {c.sortKey && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(c.sortKey!)}
                      className={cn(
                        "md-shell-sort uppercase text-left",
                        c.align === "right" && "flex-row-reverse text-right",
                        active && "text-md-wine",
                      )}
                      data-testid={`sort-${c.sortKey}`}
                    >
                      {c.header}
                      <Icon size={12} strokeWidth={2.4} className={active ? "" : "opacity-50"} aria-hidden="true" />
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const key = rowKey(row);
            const extra = detail?.(row);
            const on = highlight?.(row) ?? false;
            return (
              <Fragment key={key}>
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter" && e.target === e.currentTarget) onRowClick(row);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                  aria-current={on ? "true" : undefined}
                  className={cn(
                    onRowClick && "cursor-pointer focus-visible:outline-2 focus-visible:outline-md-wine-500",
                    on && "bg-md-wine/[0.06]",
                  )}
                  data-testid={`row-${key}`}
                >
                  {columns.map((c, i) => (
                    <td key={c.key} className={cn("whitespace-nowrap", align(c.align), pin(i, on), c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
                {extra && (
                  <tr className="hover:bg-transparent" data-testid={`detail-${key}`}>
                    <td colSpan={columns.length} className="bg-md-sand/25 py-2.5!">
                      {extra}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {totals && (
            <tr className="md-money-total" data-testid="row-totals">
              {columns.map((c, i) => (
                <td key={c.key} className={cn("whitespace-nowrap", align(c.align), pin(i, true), c.className)}>
                  {c.total ?? ""}
                </td>
              ))}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
