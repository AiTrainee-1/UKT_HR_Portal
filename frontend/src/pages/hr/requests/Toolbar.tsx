import { Download, FileSpreadsheet, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  NO_FILTERS,
  PERIOD_LABELS,
  SORT_LABELS,
  STATUS_LABELS,
  activeFilterCount,
  filtersActive,
  rangeInvalid,
  type Filters,
  type HubOptions,
  type Period,
  type SortKey,
  type StatusFilter,
} from "./logic";

const REQUEST_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "leave", label: "Leave" },
  { value: "salary_enquiry", label: "Salary enquiry" },
  { value: "shift_correction", label: "Shift correction" },
  { value: "advance", label: "Advance" },
  { value: "permission", label: "Permission" },
  { value: "general", label: "General query" },
];

/** Search, filters, the order and the download of the list. The first change to a filter updates the list at once. */
export default function Toolbar({
  filters,
  onFilters,
  options,
  showRequestType,
  shown,
  total,
  canExport,
  onExport,
}: {
  filters: Filters;
  onFilters: (next: Filters) => void;
  options: HubOptions;
  /** The Other requests tab: its own kind of request has types worth filtering by. */
  showRequestType: boolean;
  /** Requests on the screen now (after every filter) and how many the tab holds before the search and the client filters. */
  shown: number;
  total: number;
  canExport: boolean;
  onExport: (format: "xlsx" | "csv") => void;
}) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const departments =
    filters.branch === "all"
      ? options.departments
      : options.departments.filter((d) => String(d.branchId ?? "") === filters.branch || d.branchId == null);
  const narrowed = activeFilterCount(filters);

  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="requests-toolbar">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search by employee, code, reason, subject or details"
            aria-label="Search requests"
            className="h-10 pl-9 pr-9"
            data-testid="requests-search"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => set({ query: "" })}
              aria-label="Clear search"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="flex gap-2">
          <Select value={filters.sort} onValueChange={(v) => set({ sort: v as SortKey })}>
            <SelectTrigger className="h-10 w-full lg:w-52" aria-label="Sort requests" data-testid="requests-sort">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((s) => (
                <SelectItem key={s} value={s}>
                  {SORT_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* a download only reads, so the MD's view-only lock (which would disable any "Export") leaves it alone */}
          <span data-view-safe>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" className="h-10 gap-1.5" disabled={!canExport} data-testid="requests-export">
                  <Download size={14} /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" data-view-safe>
                <DropdownMenuItem onSelect={() => onExport("xlsx")} data-testid="requests-export-xlsx">
                  <FileSpreadsheet size={14} /> Excel (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => onExport("csv")} data-testid="requests-export-csv">
                  <Download size={14} /> CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 lg:flex lg:flex-wrap">
        <Select value={filters.status} onValueChange={(v) => set({ status: v as StatusFilter })}>
          <SelectTrigger className="h-9 lg:w-44" aria-label="Filter by status" data-testid="filter-status">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as StatusFilter[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.period} onValueChange={(v) => set({ period: v as Period })}>
          <SelectTrigger className="h-9 lg:w-40" aria-label="Filter by submitted date" data-testid="filter-period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(PERIOD_LABELS) as Period[]).map((p) => (
              <SelectItem key={p} value={p}>
                {PERIOD_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filters.period === "custom" && (
          <>
            <Input
              type="date"
              value={filters.from}
              max={filters.to || undefined}
              onChange={(e) => set({ from: e.target.value })}
              aria-label="Submitted from"
              className="h-9 lg:w-40"
              data-testid="filter-from"
            />
            <Input
              type="date"
              value={filters.to}
              min={filters.from || undefined}
              onChange={(e) => set({ to: e.target.value })}
              aria-label="Submitted until"
              className="h-9 lg:w-40"
              data-testid="filter-to"
            />
          </>
        )}
        {options.branches.length > 1 && (
          <Select value={filters.branch} onValueChange={(v) => set({ branch: v, department: "all" })}>
            <SelectTrigger className="h-9 lg:w-40" aria-label="Filter by branch" data-testid="filter-branch">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All branches</SelectItem>
              {options.branches.map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {departments.length > 0 && (
          <Select value={filters.department} onValueChange={(v) => set({ department: v })}>
            <SelectTrigger className="h-9 lg:w-44" aria-label="Filter by department" data-testid="filter-department">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Select value={filters.type} onValueChange={(v) => set({ type: v })}>
          <SelectTrigger className="h-9 lg:w-40" aria-label="Filter by employee type" data-testid="filter-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Staff and production</SelectItem>
            <SelectItem value="staff">Staff</SelectItem>
            <SelectItem value="production">Production</SelectItem>
          </SelectContent>
        </Select>
        {showRequestType && (
          <Select value={filters.requestType} onValueChange={(v) => set({ requestType: v })}>
            <SelectTrigger
              className="h-9 lg:w-44"
              aria-label="Filter by kind of request"
              data-testid="filter-request-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Every kind of request</SelectItem>
              {REQUEST_TYPE_OPTIONS.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-gray-500" data-testid="requests-count">
          Showing <b>{shown}</b> of {total} request{total === 1 ? "" : "s"}
          {narrowed > 0 && ` · ${narrowed} filter${narrowed === 1 ? "" : "s"} on`}
        </p>
        {rangeInvalid(filters) && (
          <p className="text-xs font-semibold text-red-600" role="alert">
            The range ends before it starts.
          </p>
        )}
        {filtersActive(filters) && (
          <button
            type="button"
            onClick={() => onFilters({ ...NO_FILTERS, sort: filters.sort })}
            className="text-xs font-semibold text-blue-600 hover:underline"
            data-testid="requests-clear-filters"
          >
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
