import { useMemo } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DEFAULT_SORT,
  NO_FILTERS,
  SORT_OPTIONS,
  filtersActive,
  parseSort,
  statusCounts,
  type Filters,
  type Sort,
  type SettlementRow,
} from "./logic";
import { distinct, rangeProblem } from "./shared";

type Props = {
  rows: SettlementRow[];
  filters: Filters;
  onFilters: (next: Filters) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  shown: number;
};

const TRIGGER = "h-10";

/** Search, filters and sorting for the advances list, with how many match. */
export default function Toolbar({ rows, filters, onFilters, sort, onSort, shown }: Props) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const counts = useMemo(() => statusCounts(rows, filters), [rows, filters]);
  const branches = useMemo(() => distinct(rows.map((r) => r.employeeBranch)), [rows]);
  const departments = useMemo(() => distinct(rows.map((r) => r.employeeDepartment)), [rows]);
  const problem = rangeProblem(filters.from, filters.to);
  const active = filtersActive(filters);

  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="settlement-toolbar">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search by employee name or code, department, branch or purpose"
            aria-label="Search advances"
            className="h-10 pl-9 pr-9"
            data-testid="settlement-search"
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
          <SelectTrigger className={`${TRIGGER} lg:w-52`} aria-label="Sort advances" data-testid="settlement-sort">
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

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <Select value={filters.type} onValueChange={(v) => set({ type: v as Filters["type"] })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by advance type" data-testid="filter-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="general">General advance</SelectItem>
            <SelectItem value="term">Term loan</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.branch} onValueChange={(v) => set({ branch: v })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by branch" data-testid="filter-branch">
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
          <SelectTrigger className={TRIGGER} aria-label="Filter by department" data-testid="filter-department">
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
        <Select value={filters.employeeType} onValueChange={(v) => set({ employeeType: v })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by employee type" data-testid="filter-employee-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Staff and production</SelectItem>
            <SelectItem value="staff">Staff</SelectItem>
            <SelectItem value="production">Production</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filters.employee} onValueChange={(v) => set({ employee: v as Filters["employee"] })}>
          <SelectTrigger className={TRIGGER} aria-label="Filter by employment" data-testid="filter-employment">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees</SelectItem>
            <SelectItem value="active">Still employed</SelectItem>
            <SelectItem value="left">Has left</SelectItem>
          </SelectContent>
        </Select>
        <div className="col-span-2 flex items-center gap-1.5 md:col-span-3 xl:col-span-2">
          <Input
            type="date"
            value={filters.from}
            max={filters.to || undefined}
            onChange={(e) => set({ from: e.target.value })}
            aria-label="Raised from"
            title="Raised from"
            className="h-10 min-w-0 px-2 text-xs"
            data-testid="filter-from"
          />
          <span className="text-xs text-gray-400">to</span>
          <Input
            type="date"
            value={filters.to}
            min={filters.from || undefined}
            onChange={(e) => set({ to: e.target.value })}
            aria-label="Raised to"
            title="Raised to"
            className="h-10 min-w-0 px-2 text-xs"
            data-testid="filter-to"
          />
        </div>
      </div>
      {problem && (
        <p className="text-xs font-medium text-red-600" role="alert" data-testid="filter-range-error">
          {problem}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-full overflow-x-auto">
          <PillTabs
            size="sm"
            items={[
              { value: "pending", label: "Pending approval", count: counts.pending },
              { value: "approved", label: "Active", count: counts.approved },
              { value: "closed", label: "Completed", count: counts.closed },
              { value: "rejected", label: "Rejected", count: counts.rejected, color: "#dc2626" },
              { value: "all", label: "All", count: counts.all },
            ]}
            value={filters.status}
            onChange={(v) => set({ status: v as Filters["status"] })}
          />
        </div>
        <p className="text-xs text-gray-500" data-testid="settlement-count">
          Showing <b>{shown}</b> of {rows.length}
          {(active || sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) && (
            <button
              type="button"
              onClick={() => {
                onFilters(NO_FILTERS);
                onSort(DEFAULT_SORT);
              }}
              className="ml-2 font-semibold text-blue-600 hover:underline"
              data-testid="settlement-clear-filters"
            >
              Clear filters
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
