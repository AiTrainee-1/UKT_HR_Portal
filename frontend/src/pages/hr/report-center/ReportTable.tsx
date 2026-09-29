import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from "lucide-react";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import type { ReportColumn, ReportRow } from "@/lib/report-center";
import { badgeTone, formatCell, isNumericType, rowMatches, sortRows, type SortDir } from "@/lib/report-format";

const PAGE_SIZES = [25, 50, 100, 200];
/** Past this many columns the first column stays put while scrolling sideways. */
const FREEZE_FIRST_AFTER = 6;

function alignClass(c: ReportColumn): string {
  const a =
    c.align ??
    (isNumericType(c.type) ? "right" : ["date", "time", "datetime", "badge"].includes(c.type) ? "center" : "left");
  return a === "right" ? "text-right" : a === "center" ? "text-center" : "text-left";
}

function Cell({ column, value }: { column: ReportColumn; value: unknown }) {
  if (column.type === "badge" && value !== null && value !== undefined && value !== "") {
    const text = String(value);
    return <StatusBadge tone={badgeTone(text)}>{text}</StatusBadge>;
  }
  return <>{formatCell(value, column.type)}</>;
}

/** The result grid: sticky header, sort, quick search, pagination, structural (subtotal/total) rows, totals footer. */
export function ReportTable({
  columns,
  rows,
  totals,
  dimmed,
}: {
  columns: ReportColumn[];
  rows: ReportRow[];
  totals: Record<string, number | null> | null;
  dimmed?: boolean;
}) {
  const [sort, setSort] = useState<{ key: string; dir: SortDir } | null>(null);
  const [needle, setNeedle] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  const searchKeys = useMemo(
    () => columns.filter((c) => c.type === "text" || c.type === "badge" || c.type === "date").map((c) => c.key),
    [columns],
  );
  const searching = needle.trim().length > 0;

  const visible = useMemo(() => {
    // While searching, subtotal rows would misrepresent the filtered list, so they are hidden.
    let out = searching
      ? rows.filter(
          (r) => !r._kind && rowMatches(r, searchKeys.length ? searchKeys : columns.map((c) => c.key), needle),
        )
      : rows;
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) out = sortRows(out, sort.key, sort.dir, col.type);
    }
    return out;
  }, [rows, columns, searchKeys, needle, searching, sort]);

  const dataRowCount = useMemo(() => visible.filter((r) => !r._kind).length, [visible]);
  const totalPages = Math.max(1, Math.ceil(visible.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * pageSize, safePage * pageSize);
  const freeze = columns.length > FREEZE_FIRST_AFTER;

  const toggleSort = (key: string) => {
    setPage(1);
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));
  };

  let zebra = 0;
  return (
    <div className="overflow-hidden rounded-xl border bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-white px-4 py-2.5">
        <p className="text-sm text-gray-600" aria-live="polite">
          <span className="font-semibold text-gray-900">{dataRowCount.toLocaleString("en-IN")}</span>{" "}
          {searching ? `of ${rows.filter((r) => !r._kind).length.toLocaleString("en-IN")} ` : ""}
          record{dataRowCount === 1 ? "" : "s"}
        </p>
        <div className="relative w-full sm:w-64">
          <Search
            size={14}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={needle}
            onChange={(e) => {
              setNeedle(e.target.value);
              setPage(1);
            }}
            placeholder="Search in results…"
            aria-label="Search in results"
            className="h-8 pl-8 pr-8 text-sm"
          />
          {needle && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setNeedle("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-gray-100"
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      <div className={`max-h-[70vh] overflow-auto transition-opacity ${dimmed ? "opacity-50" : ""}`}>
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              {columns.map((c, i) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                    className={`sticky top-0 border-b bg-slate-50 px-3 py-2 text-[10px] font-bold uppercase tracking-wide text-gray-500 ${
                      freeze && i === 0 ? "left-0 z-30" : "z-20"
                    } ${alignClass(c)}`}
                  >
                    <button
                      type="button"
                      onClick={() => toggleSort(c.key)}
                      className={`inline-flex items-center gap-1 uppercase hover:text-gray-900 ${
                        c.type === "text" ? "" : "flex-row-reverse"
                      }`}
                      aria-label={`Sort by ${c.label}`}
                    >
                      <span>{c.label}</span>
                      {active ? (
                        sort.dir === "asc" ? (
                          <ArrowUp size={11} />
                        ) : (
                          <ArrowDown size={11} />
                        )
                      ) : (
                        <ArrowUpDown size={11} className="opacity-30" />
                      )}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td
                  colSpan={Math.max(1, columns.length)}
                  className="px-4 py-10 text-center text-sm text-muted-foreground"
                >
                  {searching ? `Nothing matches “${needle}”.` : "No records."}
                </td>
              </tr>
            )}
            {pageRows.map((row, ri) => {
              const structural = row._kind === "subtotal" || row._kind === "total";
              if (!structural) zebra += 1;
              const bg =
                row._kind === "total"
                  ? "bg-slate-200"
                  : row._kind === "subtotal"
                    ? "bg-slate-100"
                    : zebra % 2 === 0
                      ? "bg-slate-50"
                      : "bg-white";
              return (
                <tr key={ri} className={`${bg} ${structural ? "font-bold" : "hover:bg-sky-50/50"}`}>
                  {columns.map((c, i) => (
                    <td
                      key={c.key}
                      className={`border-b border-slate-100 px-3 py-1.5 ${alignClass(c)} ${
                        isNumericType(c.type) || c.type === "date" || c.type === "time" || c.type === "datetime"
                          ? "whitespace-nowrap tabular-nums"
                          : ""
                      } ${c.type === "text" ? "min-w-[7rem]" : ""} ${freeze && i === 0 ? "sticky left-0 z-10 bg-inherit" : ""}`}
                    >
                      {structural && row[c.key] === null ? "" : <Cell column={c} value={row[c.key]} />}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
          {totals && !searching && (
            <tfoot>
              <tr>
                {columns.map((c, i) => {
                  const v = totals[c.key];
                  return (
                    <td
                      key={c.key}
                      className={`sticky bottom-0 border-t-2 border-slate-300 bg-slate-100 px-3 py-2 font-bold ${alignClass(c)} ${
                        freeze && i === 0 ? "left-0 z-20" : "z-10"
                      } whitespace-nowrap tabular-nums`}
                    >
                      {v !== null && v !== undefined ? formatCell(v, c.type) : i === 0 ? "Total" : ""}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
      </div>

      <div className="border-t bg-white px-4 py-2">
        <DataPagination
          page={safePage}
          totalPages={totalPages}
          totalItems={visible.length}
          pageSize={pageSize}
          pageSizes={PAGE_SIZES}
          onPageChange={setPage}
          onPageSizeChange={(n) => {
            setPageSize(n);
            setPage(1);
          }}
        />
      </div>
    </div>
  );
}
