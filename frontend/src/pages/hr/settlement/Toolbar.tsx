import { categoryForEmploymentType, keepIfOffered, namedOrgOptions } from "@/lib/departments";
import { OrgSelectItems } from "@/lib/org-select";
import { useMemo } from "react";
import { CalendarDays, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  BASIS_OPTIONS,
  DEFAULT_SORT,
  SORT_OPTIONS,
  filtersActive,
  parseSort,
  sortValue,
  statusCounts,
  type Filters,
  type MonthBasis,
  type Period,
  type SettlementTab,
  type Sort,
  type SettlementRow,
} from "./logic";
import { MONTH_FULL, distinct, rangeProblem } from "./shared";

type Props = {
  tab: SettlementTab;
  /** The tab's advances in the chosen month: the status counts, the choices and "of N" read these. */
  rows: SettlementRow[];
  filters: Filters;
  onFilters: (next: Filters) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  period: Period;
  basis: MonthBasis;
  years: number[];
  onPeriod: (next: Period) => void;
  onBasis: (next: MonthBasis) => void;
  /** Clears the filters, the sort and the month. */
  onClear: () => void;
  shown: number;
};

const TRIGGER = "h-10";
const ALL_MONTHS = "all";

/** The month, search, filters and sorting for one tab's list, with how many match. */
export default function Toolbar({
  tab,
  rows,
  filters,
  onFilters,
  sort,
  onSort,
  period,
  basis,
  years,
  onPeriod,
  onBasis,
  onClear,
  shown,
}: Props) {
  const set = (patch: Partial<Filters>) => onFilters({ ...filters, ...patch });
  const counts = useMemo(() => statusCounts(rows, filters), [rows, filters]);
  const branches = useMemo(() => distinct(rows.map((r) => r.employeeBranch)), [rows]);
  // Staff / Production have departments of their own: an employee type offers only its kind's, "all" both kinds under
  // Staff and Production headings (two CUTTINGs told apart).
  const departmentsFor = (type: string) =>
    namedOrgOptions(
      rows,
      (r) => r.employeeDepartment,
      (r) => r.employeeType,
      categoryForEmploymentType(type),
    );
  const departments = departmentsFor(filters.employeeType);
  const problem = rangeProblem(filters.from, filters.to);
  const active = filtersActive(filters) || period !== null || sortValue(sort) !== sortValue(DEFAULT_SORT);
  const overview = tab === "overview";
  const thisYear = new Date().getFullYear();

  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="settlement-toolbar">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            placeholder="Search by employee name or code, department, branch, purpose or remark"
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
        <Select value={sortValue(sort)} onValueChange={(v) => onSort(parseSort(v))}>
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

      {/* the month: when the advance was applied, decided or is deducted (any of them by default) */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_minmax(0,1.4fr)] xl:max-w-3xl">
        <Select
          value={period ? String(period.month) : ALL_MONTHS}
          onValueChange={(v) =>
            onPeriod(v === ALL_MONTHS ? null : { month: Number(v), year: period?.year ?? thisYear })
          }
        >
          <SelectTrigger className={TRIGGER} aria-label="Month" data-testid="filter-month">
            <span className="flex min-w-0 items-center gap-2">
              <CalendarDays size={14} className="shrink-0 text-gray-400" />
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_MONTHS}>All months</SelectItem>
            {MONTH_FULL.map((m, i) => (
              <SelectItem key={m} value={String(i + 1)}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(period?.year ?? thisYear)}
          onValueChange={(v) => period && onPeriod({ month: period.month, year: Number(v) })}
          disabled={!period}
        >
          <SelectTrigger className={TRIGGER} aria-label="Year" data-testid="filter-year">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {years.map((y) => (
              <SelectItem key={y} value={String(y)}>
                {y}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={basis} onValueChange={(v) => onBasis(v as MonthBasis)} disabled={!period}>
          <SelectTrigger
            className={`${TRIGGER} col-span-2 md:col-span-1`}
            aria-label="Which activity counts for the month"
            title={period ? undefined : "Choose a month first"}
            data-testid="filter-basis"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BASIS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {overview && (
          <Select value={filters.type} onValueChange={(v) => set({ type: v as Filters["type"] })}>
            <SelectTrigger className={TRIGGER} aria-label="Filter by advance type" data-testid="filter-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              <SelectItem value="term">Term loan</SelectItem>
              <SelectItem value="general">Term advance</SelectItem>
            </SelectContent>
          </Select>
        )}
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
            <OrgSelectItems options={departments} />
          </SelectContent>
        </Select>
        <Select
          value={filters.employeeType}
          onValueChange={(v) =>
            set({ employeeType: v, department: keepIfOffered(filters.department, departmentsFor(v), "all") })
          }
        >
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
          {active && (
            <button
              type="button"
              onClick={onClear}
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
