import { ChevronRight } from "lucide-react";
import { Avatar, Chip } from "@/components/payroll/kit/parts";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useIsMobile } from "@/hooks/use-mobile";
import type { HodCategory, HodRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { DASH, boardTotals, hodSubline, waitingText, waitingTone } from "./logic";

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

/** One category's count in the table: a dash when the head may not decide it, a quiet 0, or a button into the detail. */
function CountCell({
  row,
  category,
  onOpen,
}: {
  row: HodRow;
  category: HodCategory;
  onOpen: (row: HodRow, category?: string) => void;
}) {
  const v = row.byCategory[category.key];
  if (typeof v !== "number")
    return (
      <span className="text-gray-300" title={`${row.name} does not approve ${category.label} requests`}>
        {DASH}
      </span>
    );
  if (v === 0) return <span className="text-gray-300">0</span>;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen(row, category.key);
      }}
      className="inline-flex min-w-8 justify-center rounded-full bg-amber-100 px-2 py-0.5 text-xs font-black text-amber-800 hover:bg-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
      aria-label={`${v} ${category.label} pending with ${row.name}: show them`}
      data-testid={`hod-cell-${row.managerId}-${category.key}`}
    >
      {v}
    </button>
  );
}

function OldestChip({ row }: { row: HodRow }) {
  if (row.pending <= 0) return <span className="text-xs text-gray-300">{DASH}</span>;
  return (
    <Chip tone={waitingTone(row.oldestDays)} title="How long the oldest of these has been waiting">
      {waitingText(row.oldestDays)}
    </Chip>
  );
}

/**
 * The board: a table of every head x category on a wide screen (with the totals row), a card per head on a phone. A click on
 * a head (or on a count) opens the detail of what is pending with them.
 */
export default function HodBoard({
  rows,
  categories,
  onOpen,
}: {
  rows: HodRow[];
  categories: HodCategory[];
  onOpen: (row: HodRow, category?: string) => void;
}) {
  // one layout at a time: a head's test id is on the page once
  const phone = useIsMobile();
  const totals = boardTotals(rows, categories);

  if (phone) {
    return (
      <ul className="divide-y" data-testid="hod-cards">
        {rows.map((row) => {
          const busy = categories.filter((c) => (row.byCategory[c.key] ?? 0) > 0);
          return (
            <li key={row.managerId}>
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
                data-testid={`hod-row-${row.managerId}`}
              >
                <Avatar name={row.name} size={36} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-bold text-gray-900">{row.name}</span>
                    <span
                      className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-xs font-black",
                        row.pending > 0 ? "bg-amber-500 text-white" : "bg-slate-100 text-slate-500",
                      )}
                    >
                      {row.pending} pending
                    </span>
                  </span>
                  <span className="block truncate text-xs text-gray-500">{hodSubline(row)}</span>
                  {busy.length > 0 && (
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {busy.map((c) => (
                        <Chip key={c.key} tone="warning">
                          {c.label} {row.byCategory[c.key]}
                        </Chip>
                      ))}
                      {row.oldestDays !== null && (
                        <Chip tone={waitingTone(row.oldestDays)}>oldest {waitingText(row.oldestDays)}</Chip>
                      )}
                    </span>
                  )}
                </span>
                <ChevronRight size={16} className="mt-2 shrink-0 text-gray-300" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto" data-testid="hod-table">
      <Table>
        <TableHeader>
          <TableRow className="bg-slate-50/70 hover:bg-slate-50/70">
            <TableHead className={cn(HEAD, "sticky left-0 z-10 min-w-52 bg-slate-50")}>HoD</TableHead>
            {/* the total first, so the main figure is never behind the sideways scroll */}
            <TableHead className={cn(HEAD, "text-center")}>Total</TableHead>
            {categories.map((c) => (
              <TableHead key={c.key} className={cn(HEAD, "min-w-16 whitespace-normal text-center leading-tight")}>
                {c.label}
              </TableHead>
            ))}
            <TableHead className={cn(HEAD, "whitespace-nowrap text-center")}>Oldest waiting</TableHead>
            <TableHead className="w-8" aria-hidden />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.managerId}
              className="cursor-pointer"
              onClick={() => onOpen(row)}
              data-testid={`hod-row-${row.managerId}`}
            >
              <TableCell className="sticky left-0 z-10 bg-white">
                <div className="flex min-w-0 items-center gap-2.5">
                  <Avatar name={row.name} size={34} />
                  <div className="min-w-0">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpen(row);
                      }}
                      className="block max-w-56 truncate text-left text-sm font-bold text-gray-900 hover:underline focus-visible:underline focus-visible:outline-none"
                      data-testid={`hod-open-${row.managerId}`}
                    >
                      {row.name}
                    </button>
                    <p className="max-w-56 truncate text-xs text-gray-500">
                      {[row.code, hodSubline(row)].filter(Boolean).join(" · ")}
                    </p>
                  </div>
                </div>
              </TableCell>
              <TableCell className="text-center">
                <span
                  className={cn("text-sm font-black tabular-nums", row.pending > 0 ? "text-gray-900" : "text-gray-300")}
                  data-testid={`hod-total-${row.managerId}`}
                >
                  {row.pending}
                </span>
              </TableCell>
              {categories.map((c) => (
                <TableCell key={c.key} className="text-center text-sm tabular-nums">
                  <CountCell row={row} category={c} onOpen={onOpen} />
                </TableCell>
              ))}
              <TableCell className="text-center">
                <OldestChip row={row} />
              </TableCell>
              <TableCell>
                <ChevronRight size={15} className="text-gray-300" aria-hidden />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow className="bg-slate-50 font-bold hover:bg-slate-50" data-testid="hod-totals">
            <TableCell className="sticky left-0 z-10 bg-slate-50 text-sm">
              Total · {rows.length} HoD{rows.length === 1 ? "" : "s"}
            </TableCell>
            <TableCell
              className="text-center text-sm font-black tabular-nums text-amber-700"
              data-testid="hod-totals-all"
            >
              {totals.pending}
            </TableCell>
            {categories.map((c) => {
              const v = totals.byCategory[c.key];
              return (
                <TableCell
                  key={c.key}
                  className={cn("text-center text-sm tabular-nums", typeof v !== "number" && "text-gray-300")}
                  data-testid={`hod-totals-${c.key}`}
                >
                  {typeof v === "number" ? v : DASH}
                </TableCell>
              );
            })}
            <TableCell colSpan={2} />
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}
