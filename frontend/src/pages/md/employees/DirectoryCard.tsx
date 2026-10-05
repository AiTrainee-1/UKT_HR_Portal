import { useEffect, useMemo, useState } from "react";
import { Search, Users, X } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayLong, dayShort, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import {
  DEFAULT_DIRECTORY,
  DIRECTORY_SORTS,
  directoryFiltersActive,
  directoryParams,
  type DirectoryFilters,
} from "./logic";
import { PersonCell, StatusChip } from "./parts";
import type { DirectoryPerson, DirectoryStatus, EmployeesDirectory } from "./types";

const ANY = "__any__";
const SEARCH_DELAY_MS = 300;

/** A value that follows `value` after it has stopped changing for `ms`: a search that waits for the typing to pause. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const STATUS_TABS: { value: DirectoryStatus; label: string }[] = [
  { value: "active", label: "Working here" },
  { value: "inactive", label: "Left" },
  { value: "all", label: "Everyone" },
];

function columns(onSelect: (id: number) => void): Column<DirectoryPerson>[] {
  return [
    {
      key: "name",
      header: "Employee",
      cell: (p) => (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSelect(p.id);
          }}
          className="max-w-[16rem] text-left"
          aria-label={`Open ${p.name}`}
        >
          <PersonCell name={p.name} code={p.code} />
        </button>
      ),
    },
    {
      key: "designation",
      header: "Designation",
      cell: (p) => p.designation ?? "—",
      className: "hidden @xl:table-cell",
    },
    { key: "department", header: "Department", cell: (p) => p.department ?? "—" },
    { key: "unit", header: "Unit", cell: (p) => p.unit ?? "—", className: "hidden @4xl:table-cell" },
    {
      key: "joined",
      header: "Joined",
      cell: (p) => dayLong(p.joinDate),
      className: "hidden whitespace-nowrap @3xl:table-cell",
    },
    { key: "tenure", header: "Tenure", cell: (p) => p.tenure ?? "—", className: "whitespace-nowrap" },
    {
      key: "status",
      header: "Status",
      cell: (p) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <StatusChip status={p.status} />
          {p.leftOn && <span className="text-[10px] text-[#006496]/55">{dayShort(p.leftOn)}</span>}
        </span>
      ),
      className: "hidden @xl:table-cell",
    },
  ];
}

/** The people directory: search, filters and one page at a time from the server; a row opens the person's profile. */
export default function DirectoryCard({
  scopeParams,
  scopeKey,
  question,
  onSelect,
}: {
  /** The unit / department / type chosen at the top of the page. */
  scopeParams: MdQueryParams;
  scopeKey: string;
  question: string;
  onSelect: (employeeId: number) => void;
}) {
  const [filters, setFilters] = useState<DirectoryFilters>(DEFAULT_DIRECTORY);
  const [search, setSearch] = useState("");
  const typed = useDebounced(search, SEARCH_DELAY_MS);

  // a new search, or a new part of the company, starts again at the first page
  useEffect(() => setFilters((f) => (f.q === typed ? f : { ...f, q: typed, page: 1 })), [typed]);
  useEffect(() => setFilters((f) => (f.page === 1 ? f : { ...f, page: 1 })), [scopeKey]);

  const query = useMdQuery<EmployeesDirectory>("employees/directory", { ...scopeParams, ...directoryParams(filters) });
  const data = query.data;
  const set = (patch: Partial<DirectoryFilters>) => setFilters((f) => ({ ...f, ...patch, page: patch.page ?? 1 }));
  const cols = useMemo(() => columns(onSelect), [onSelect]);
  const sortValue = DIRECTORY_SORTS.find((s) => s.sort === filters.sort && s.dir === filters.dir)?.value ?? "name:asc";
  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.page * data.pageSize, data.total) : 0;
  const filtered = directoryFiltersActive(filters);

  return (
    <SectionCard
      title="People directory"
      subtitle="Search anyone; open a row for their story"
      provenance={data?.provenance}
      loading={query.isPending}
      actions={<AskAiButton question={question} />}
      testId="md-employees-directory"
    >
      <div className="space-y-3">
        <div className="flex flex-col gap-2 @3xl:flex-row @3xl:items-center">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or employee code"
              aria-label="Search people"
              className="h-10 pl-9 pr-9"
              data-testid="md-employees-search"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 @3xl:flex">
            <Select value={filters.designation || ANY} onValueChange={(v) => set({ designation: v === ANY ? "" : v })}>
              <SelectTrigger className="h-10 @3xl:w-48" aria-label="Designation" data-testid="md-employees-designation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>All designations</SelectItem>
                {(data?.options.designations ?? []).map((d) => (
                  <SelectItem key={d} value={d}>
                    {d}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={sortValue}
              onValueChange={(v) => {
                const chosen = DIRECTORY_SORTS.find((s) => s.value === v);
                if (chosen) set({ sort: chosen.sort, dir: chosen.dir });
              }}
            >
              <SelectTrigger className="h-10 @3xl:w-48" aria-label="Sort by" data-testid="md-employees-sort">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DIRECTORY_SORTS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    {s.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs
            size="sm"
            items={STATUS_TABS}
            value={filters.status}
            onChange={(v) => set({ status: v as DirectoryStatus })}
          />
          <p className="text-xs text-gray-500" data-testid="md-employees-count">
            {data
              ? data.total === 0
                ? "No one found"
                : `Showing ${num(first)}-${num(last)} of ${num(data.total)}`
              : ""}
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setFilters({
                    ...DEFAULT_DIRECTORY,
                    pageSize: filters.pageSize,
                    sort: filters.sort,
                    dir: filters.dir,
                  });
                }}
                className="ml-2 font-semibold text-blue-600 hover:underline"
                data-testid="md-employees-clear"
              >
                Clear filters
              </button>
            )}
          </p>
        </div>

        {query.isError && !data ? (
          <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
        ) : data && data.rows.length === 0 ? (
          <EmptyBlock icon={Users} title="No one matches" testId="md-employees-directory-empty">
            {filtered
              ? "Try fewer words, or clear the filters."
              : "There are no people in this unit, department and type."}
          </EmptyBlock>
        ) : (
          <div className={cn("transition-opacity", query.isFetching && query.isPlaceholderData && "opacity-60")}>
            <DataTable
              columns={cols}
              rows={data?.rows ?? []}
              rowKey={(p) => p.id}
              pageSize={100}
              onRowClick={(p) => onSelect(p.id)}
              testId="md-employees-directory-table"
            />
          </div>
        )}

        {data && data.total > 0 && (
          <DataPagination
            page={data.page}
            totalPages={data.pages}
            onPageChange={(page) => setFilters((f) => ({ ...f, page }))}
            pageSize={filters.pageSize}
            onPageSizeChange={(pageSize) => setFilters((f) => ({ ...f, pageSize, page: 1 }))}
            totalItems={data.total}
            className="py-1"
          />
        )}
      </div>
    </SectionCard>
  );
}
