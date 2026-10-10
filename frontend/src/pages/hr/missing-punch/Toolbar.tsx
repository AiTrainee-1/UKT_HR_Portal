import { useMemo } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { distinct, rangeProblem } from "../settlement/shared";
import {
  DEFAULT_SORT,
  NO_FILTERS,
  PUNCH_SLOT_LABEL,
  SORT_OPTIONS,
  filtersActive,
  parseSort,
  statusCounts,
  type Filters,
  type MissingRow,
  type Sort,
} from "./logic";
import type { MissingPunchSlot } from "@/lib/api-client/custom-hooks";

type Props = {
  rows: MissingRow[];
  filters: Filters;
  onFilters: (next: Filters) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  shown: number;
};

const TRIGGER = "h-10";

/** Search, filters and sorting for the requests, with how many match. */
export default function Toolbar({ rows, filters, onFilters, sort, onSort, shown }: Props) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const counts = useMemo(() => statusCounts(rows, filters), [rows, filters]);
  const branches = useMemo(() => distinct(rows.map((r) => r.branch)), [rows]);
  const departments = useMemo(() => distinct(rows.map((r) => r.department)), [rows]);
  const problem = rangeProblem(filters.from, filters.to);
  const sortChanged = sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir;

  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="mp-toolbar">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search by employee, date, punch (e.g. lunch), reason, department or branch"
            aria-label="Search missing punch requests"
            className="h-10 pl-9 pr-9"
            data-testid="mp-search"
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
        <Select value={`${sort.key}:${sort.dir}`} onValueChange={(v) => onSort(parseSort(v))}>
          <SelectTrigger className={`${TRIGGER} lg:w-56`} aria-label="Sort requests" data-testid="mp-sort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SORT_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Select value={filters.slot} onValueChange={(v) => set({ slot: v as Filters["slot"] })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by punch" data-testid="mp-filter-slot">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every punch</SelectItem>
            {(Object.keys(PUNCH_SLOT_LABEL) as MissingPunchSlot[]).map((s) => (
              <SelectItem key={s} value={s}>
                {PUNCH_SLOT_LABEL[s]}
              </SelectItem>
            ))}
            <SelectItem value="other">No slot named</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.branch} onValueChange={(v) => set({ branch: v })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by branch" data-testid="mp-filter-branch">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All branches</SelectItem>
            {branches.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filters.department} onValueChange={(v) => set({ department: v })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by department" data-testid="mp-filter-department">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All departments</SelectItem>
            {departments.map((d) => (
              <SelectItem key={d} value={d}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1.5">
          <Input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
            aria-label="Missed date from"
            title="Missed date from"
            className="h-10 min-w-0 px-2 text-xs"
            data-testid="mp-filter-from"
          />
          <span className="text-xs text-gray-400">to</span>
          <Input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
            aria-label="Missed date to"
            title="Missed date to"
            className="h-10 min-w-0 px-2 text-xs"
            data-testid="mp-filter-to"
          />
        </div>
      </div>
      {problem && (
        <p className="text-xs font-medium text-red-600" role="alert" data-testid="mp-range-error">
          {problem}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-full overflow-x-auto">
          <PillTabs
            size="sm"
            items={[
              { value: "pending", label: "Pending", count: counts.pending },
              { value: "pending_hr", label: "Awaiting HR", count: counts.pending_hr },
              { value: "pending_hod", label: "Awaiting HOD", count: counts.pending_hod },
              { value: "approved", label: "Approved", count: counts.approved },
              { value: "rejected", label: "Rejected", count: counts.rejected, color: "#dc2626" },
              { value: "all", label: "All", count: counts.all },
            ]}
            value={filters.status}
            onChange={(v) => set({ status: v as Filters["status"] })}
          />
        </div>
        <p className="text-xs text-gray-500" data-testid="mp-count">
          Showing <b>{shown}</b> of {rows.length}
          {(filtersActive(filters) || sortChanged) && (
            <button
              type="button"
              onClick={() => {
                onFilters(NO_FILTERS);
                onSort(DEFAULT_SORT);
              }}
              className="ml-2 font-semibold text-blue-600 hover:underline"
              data-testid="mp-clear-filters"
            >
              Clear filters
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
