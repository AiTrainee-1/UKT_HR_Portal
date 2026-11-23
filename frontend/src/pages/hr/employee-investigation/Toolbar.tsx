import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { InvestigationKind } from "@/lib/api-client/custom-hooks/employee-investigation";
import { cn } from "@/lib/utils";
import { ALL, KINDS, KIND_LABEL, type Filters, type Option } from "./logic";

function FilterSelect({
  value,
  onChange,
  label,
  allLabel,
  options,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  allLabel: string;
  options: Option[];
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-10 min-w-0 lg:w-52" aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** All / Staff / Production (asked from the server), the search and the department / unit filters (in the page). */
export function Toolbar({
  kind,
  onKind,
  filters,
  onChange,
  departments,
  units,
  showing,
  onClear,
}: {
  kind: InvestigationKind;
  onKind: (kind: InvestigationKind) => void;
  filters: Filters;
  onChange: (patch: Partial<Filters>) => void;
  departments: Option[];
  /** One unit or none: the unit filter is not shown. */
  units: Option[];
  showing: string | null;
  /** Set when a filter is on: shows Clear filters. */
  onClear: (() => void) | null;
}) {
  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="inv-toolbar">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Staff or production">
        {KINDS.map((k) => {
          const on = k === kind;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              onClick={() => onKind(k)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1",
                on
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:text-indigo-700",
              )}
              data-testid={`inv-kind-${k}`}
            >
              {KIND_LABEL[k]}
            </button>
          );
        })}
      </div>
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center" role="search">
        <div className="relative min-w-0 flex-1 lg:min-w-[240px]">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            value={filters.search}
            onChange={(e) => onChange({ search: e.target.value })}
            placeholder="Search by name, employee code or phone"
            aria-label="Search employees"
            className="h-10 pl-9 pr-9"
            data-testid="inv-search"
          />
          {filters.search && (
            <button
              type="button"
              onClick={() => onChange({ search: "" })}
              aria-label="Clear the search text"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
          <FilterSelect
            value={filters.department}
            onChange={(department) => onChange({ department })}
            label="Filter by department"
            allLabel="All departments"
            options={departments}
            testId="inv-department"
          />
          {units.length > 1 && (
            <FilterSelect
              value={filters.unit}
              onChange={(unit) => onChange({ unit })}
              label="Filter by unit"
              allLabel="All units"
              options={units}
              testId="inv-unit"
            />
          )}
        </div>
        <p className="text-xs text-gray-500 lg:ml-auto">
          {showing && <span data-testid="inv-showing">{showing}</span>}
          {onClear && (
            <button
              type="button"
              onClick={onClear}
              className="ml-2 font-semibold text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="inv-clear-filters"
            >
              Clear filters
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
