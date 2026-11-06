import { memo, useEffect, useMemo, useState } from "react";
import { ChevronRight, FileSpreadsheet, FileText, Search, Users, X } from "lucide-react";
import type { AttendanceDailyRecord } from "@/lib/api-client/custom-hooks";
import { Avatar } from "@/components/payroll/kit/parts";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { CompensationChip } from "@/components/attendance-compensation";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useDebounced } from "@/hooks/use-debounced";
import { cn } from "@/lib/utils";
import { useCompany } from "../report-log/useCompany";
import {
  BOARD_META,
  departmentsOf,
  filterRows,
  indexRows,
  leaveFacts,
  type BoardState,
  type StatusFilter,
  boardStateOf,
} from "./logic";
import { PunchLegend, PunchTimeline } from "./PunchTimeline";

const PAGE_SIZE = 25;

/** The status a row is filed under: a coloured dot and the card's own label. */
export function StateBadge({ state, className }: { state: BoardState; className?: string }) {
  const meta = BOARD_META[state];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        meta.wash,
        meta.ink,
        className,
      )}
      data-testid="row-state"
      data-state={state}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", meta.fill)} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** What else is true of the row's day: marked by hand, the leave / On-Duty facts, a compensation, late / early, shifts. */
function RowFacts({ row }: { row: AttendanceDailyRecord }) {
  const facts = leaveFacts(row);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1">
      {row.status === "manual" && (
        <span className="rounded-md border border-purple-200 bg-purple-50 px-1.5 py-0.5 text-[11px] font-semibold text-purple-800">
          Marked by hand
        </span>
      )}
      {facts.map((f) => (
        <span
          key={f}
          className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] font-medium text-slate-700"
          data-testid="row-leave-fact"
        >
          {f}
        </span>
      ))}
      <CompensationChip day={row} size="sm" />
      {row.isLate && (
        <span
          className="rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800"
          title={row.ruleNote ?? undefined}
        >
          Late
        </span>
      )}
      {row.isEarlyOut && (
        <span className="rounded-md border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[11px] font-semibold text-orange-800">
          Early out
        </span>
      )}
      {typeof row.shiftsEarned === "number" && (
        <span
          className="rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] font-semibold tabular-nums text-slate-700"
          title={[row.ruleGroup, row.ruleNote].filter(Boolean).join(": ") || undefined}
        >
          {row.shiftsEarned.toFixed(2)} shifts
        </span>
      )}
    </div>
  );
}

/**
 * The day's list: search by name or code, one department, the status the cards picked, sorted by name or by arrival. Every
 * row shows the day's punches; clicking a row (or the name) opens the person's month. Export gives the list as filtered.
 */
export const DayList = memo(function DayList({
  rows,
  loading,
  date,
  view,
  filter,
  onFilter,
  onOpen,
}: {
  rows: AttendanceDailyRecord[];
  loading: boolean;
  date: string;
  view: "staff" | "production";
  filter: StatusFilter;
  onFilter: (next: StatusFilter) => void;
  onOpen: (employeeId: number) => void;
}) {
  const company = useCompany();
  const [query, setQuery] = useState("");
  const search = useDebounced(query, 200);
  const [department, setDepartment] = useState("");
  const [sort, setSort] = useState<"name" | "arrival">("name");
  const [page, setPage] = useState(1);

  const index = useMemo(() => indexRows(rows), [rows]);
  const departments = useMemo(() => departmentsOf(rows), [rows]);
  const shown = useMemo(() => {
    const list = filterRows(index, { status: filter, query: search, department });
    if (sort === "arrival") {
      list.sort((a, b) => (a.firstPunch ?? "99").localeCompare(b.firstPunch ?? "99"));
    }
    return list;
  }, [index, filter, search, department, sort]);

  // a different filter starts at the first page
  useEffect(() => setPage(1), [filter, search, department, sort, date, view]);

  const totalPages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = shown.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);
  const narrowed = filter !== "all" || !!department || !!search.trim();

  const scope = [
    filter !== "all" ? `Status: ${BOARD_META[filter].label}` : "",
    department ? `Department: ${department}` : "",
    search.trim() ? `Search: "${search.trim()}"` : "",
  ]
    .filter(Boolean)
    .join(", ");

  const exportInput = () => ({
    ...company.excel,
    date,
    view,
    rows: shown,
    scope,
    totalRows: rows.length,
    now: new Date(),
  });

  const clearAll = () => {
    setQuery("");
    setDepartment("");
    onFilter("all");
  };

  return (
    <section
      className="clay-card min-w-0 rounded-2xl border border-slate-100 bg-white"
      aria-labelledby="day-list-title"
      data-testid="attendance-day-list"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-4 pt-4 sm:px-5">
        <div className="min-w-0">
          <h3 id="day-list-title" className="text-sm font-bold text-slate-900">
            Everyone on the day
          </h3>
          <p className="mt-0.5 text-xs text-slate-500" data-testid="day-list-count">
            {loading ? "Loading" : `${shown.length} of ${rows.length} shown. Click a person to open their month.`}
          </p>
        </div>
        <ExportMenu
          testId="day-export-menu"
          label="Export day"
          heading="The list as filtered"
          disabled={loading || shown.length === 0}
          items={[
            {
              key: "day-xlsx",
              label: "Excel",
              hint: `${shown.length} rows, every punch with its source`,
              icon: FileSpreadsheet,
              run: async () => (await import("./export")).downloadDayExcel(exportInput()),
            },
            {
              key: "day-pdf",
              label: "PDF",
              hint: "A4 landscape, for printing",
              icon: FileText,
              run: async () => (await import("./export")).downloadDayPdf(exportInput()),
            },
          ]}
        />
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-2 px-4 sm:px-5">
        <div className="relative w-full sm:w-64">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
            aria-hidden="true"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Name or code"
            aria-label="Search the list by name or code"
            className="h-9 rounded-xl pl-8 text-sm"
            data-testid="day-list-search"
          />
        </div>
        <select
          value={department}
          onChange={(e) => setDepartment(e.target.value)}
          aria-label="Department"
          className="h-9 min-w-0 max-w-full rounded-xl border border-slate-200 bg-white px-2.5 text-sm text-slate-700"
          data-testid="day-list-department"
        >
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <div
          className="inline-flex h-9 items-center rounded-xl border border-slate-200 bg-slate-50 p-0.5 text-xs font-semibold"
          role="group"
          aria-label="Sort the list"
        >
          {(
            [
              ["name", "By name"],
              ["arrival", "By first punch"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={sort === key}
              onClick={() => setSort(key)}
              className={cn(
                "h-full rounded-lg px-2.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400",
                sort === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {filter !== "all" && (
          <button
            type="button"
            onClick={() => onFilter("all")}
            className={cn(
              "inline-flex h-9 items-center gap-1.5 rounded-xl px-2.5 text-xs font-semibold ring-1 focus-visible:outline-none focus-visible:ring-2",
              BOARD_META[filter].wash,
              BOARD_META[filter].ink,
              BOARD_META[filter].ring,
            )}
            aria-label={`Showing ${BOARD_META[filter].label} only. Show everyone`}
            data-testid="day-list-filter-chip"
          >
            {BOARD_META[filter].label}
            <X size={12} aria-hidden="true" />
          </button>
        )}
        <PunchLegend className="ml-auto hidden xl:flex" />
      </div>

      <div className="mt-3">
        {loading ? (
          <div className="space-y-2 px-4 pb-4 sm:px-5">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="mx-4 mb-4 flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 px-6 py-10 text-center sm:mx-5">
            <Users size={22} className="text-slate-400" aria-hidden="true" />
            <p className="text-sm font-semibold text-slate-700">
              {rows.length === 0 ? "No employees on this list" : "Nobody matches"}
            </p>
            {narrowed && rows.length > 0 && (
              <button
                type="button"
                onClick={clearAll}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50"
              >
                Show everyone
              </button>
            )}
          </div>
        ) : (
          <>
            {/* phones: one card per person */}
            <ul
              key={`cards-${filter}-${department}-${search}-${safePage}-${sort}`}
              className="divide-y divide-slate-100 border-t border-slate-100 md:hidden motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
              data-testid="day-list-cards"
            >
              {pageRows.map((row) => (
                <li
                  key={row.employeeId}
                  onClick={() => onOpen(row.employeeId)}
                  className="flex cursor-pointer items-start gap-3 px-4 py-3 hover:bg-slate-50"
                  data-testid="day-list-card"
                >
                  <Avatar name={row.employeeName} size={34} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpen(row.employeeId);
                          }}
                          className="block max-w-full truncate text-left text-sm font-semibold text-slate-900 focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                        >
                          {row.employeeName}
                        </button>
                        <p className="truncate text-[11px] text-slate-500">
                          <span className="tabular-nums">{row.employeeCode}</span>
                          {row.department ? `, ${row.department}` : ""}
                        </p>
                      </div>
                      <StateBadge state={boardStateOf(row)} />
                    </div>
                    <div className="mt-2">
                      <PunchTimeline punches={row.punches} dayDate={date} size="sm" />
                    </div>
                    <RowFacts row={row} />
                  </div>
                </li>
              ))}
            </ul>

            {/* tablets and up: the table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm" data-testid="day-list-table">
                <thead>
                  <tr className="border-y border-slate-100 bg-slate-50/70 text-left text-xs font-semibold text-slate-500">
                    <th scope="col" className="px-5 py-2.5">
                      Employee
                    </th>
                    <th scope="col" className="hidden px-3 py-2.5 lg:table-cell">
                      Department
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      Status
                    </th>
                    <th scope="col" className="px-3 py-2.5">
                      Punches
                    </th>
                    <th scope="col" className="w-8 px-3 py-2.5">
                      <span className="sr-only">Open</span>
                    </th>
                  </tr>
                </thead>
                <tbody
                  key={`rows-${filter}-${department}-${search}-${safePage}-${sort}`}
                  className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
                >
                  {pageRows.map((row) => (
                    <tr
                      key={row.employeeId}
                      onClick={() => onOpen(row.employeeId)}
                      className="group cursor-pointer border-b border-slate-100 align-top transition-colors last:border-b-0 hover:bg-slate-50/80"
                      data-testid="day-list-row"
                      data-employee-code={row.employeeCode}
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-start gap-3">
                          <Avatar name={row.employeeName} size={34} />
                          <div className="min-w-0">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpen(row.employeeId);
                              }}
                              className="max-w-[16rem] truncate text-left font-semibold text-slate-900 underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                            >
                              {row.employeeName}
                            </button>
                            <p className="text-[11px] text-slate-500">
                              <span className="tabular-nums">{row.employeeCode}</span>
                              {row.designation ? `, ${row.designation}` : ""}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="hidden px-3 py-3 text-slate-600 lg:table-cell">{row.department ?? "-"}</td>
                      <td className="px-3 py-3">
                        <StateBadge state={boardStateOf(row)} />
                        <RowFacts row={row} />
                      </td>
                      <td className="px-3 py-3">
                        <PunchTimeline punches={row.punches} dayDate={date} size="sm" />
                      </td>
                      <td className="px-3 py-3 text-slate-300">
                        <ChevronRight
                          size={15}
                          className="transition-transform group-hover:translate-x-0.5 group-hover:text-slate-500"
                          aria-hidden="true"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <DataPagination
              page={safePage}
              totalPages={totalPages}
              totalItems={shown.length}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
              className="border-t border-slate-100 px-4 sm:px-5"
            />
          </>
        )}
      </div>
    </section>
  );
});
