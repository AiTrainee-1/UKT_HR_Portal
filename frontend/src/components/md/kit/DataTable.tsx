import { useMemo, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type Column<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable: the value to sort by. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: "left" | "right" | "center";
  className?: string;
};

type Sort = { key: string; dir: "asc" | "desc" };

/**
 * A compact read-only table: sortable columns, "Show more" paging, an empty state and the portal's header style.
 * Rows are plain objects; nothing in it edits anything.
 */
export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  initialSort,
  pageSize = 10,
  empty = "Nothing to show.",
  onRowClick,
  testId,
  dense,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  initialSort?: Sort;
  pageSize?: number;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  testId?: string;
  dense?: boolean;
}) {
  const [sort, setSort] = useState<Sort | null>(initialSort ?? null);
  const [shown, setShown] = useState(pageSize);

  const sorted = useMemo(() => {
    const column = columns.find((c) => c.key === sort?.key);
    if (!sort || !column?.sortValue) return rows;
    const get = column.sortValue;
    const sign = sort.dir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // empty values always last
      if (y == null) return -1;
      return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * sign;
    });
  }, [rows, columns, sort]);

  if (rows.length === 0) return <p className="py-8 text-center text-sm text-muted-foreground">{empty}</p>;

  const alignClass = (a?: Column<T>["align"]) =>
    a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";

  return (
    <div data-testid={testId}>
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => {
              const active = sort?.key === c.key;
              const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
              return (
                <TableHead
                  key={c.key}
                  className={cn(
                    "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60",
                    alignClass(c.align),
                    c.className,
                  )}
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                >
                  {c.sortValue ? (
                    <button
                      type="button"
                      onClick={() =>
                        setSort(
                          active
                            ? { key: c.key, dir: sort.dir === "asc" ? "desc" : "asc" }
                            : { key: c.key, dir: "desc" },
                        )
                      }
                      className={cn(
                        "inline-flex items-center gap-1 uppercase tracking-wider hover:text-[#006496]",
                        active && "text-[#006496]",
                      )}
                    >
                      {c.header}
                      <Icon size={12} className={active ? "" : "opacity-40"} />
                    </button>
                  ) : (
                    c.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.slice(0, shown).map((row) => (
            <TableRow
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(onRowClick && "cursor-pointer")}
              data-testid={`row-${rowKey(row)}`}
            >
              {columns.map((c) => (
                <TableCell
                  key={c.key}
                  className={cn(dense ? "py-1.5" : "py-2.5", "text-sm", alignClass(c.align), c.className)}
                >
                  {c.cell(row)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {sorted.length > shown && (
        <div className="flex items-center justify-between border-t px-2 pt-2 text-xs text-muted-foreground">
          <span>
            Showing {shown} of {sorted.length}
          </span>
          <Button variant="ghost" size="sm" onClick={() => setShown((n) => n + pageSize)} data-testid="show-more">
            Show more
          </Button>
        </div>
      )}
    </div>
  );
}
