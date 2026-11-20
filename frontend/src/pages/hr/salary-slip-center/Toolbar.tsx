import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ACCENT } from "./parts";
import {
  ALL,
  SLIP_TABS,
  TAB_LABEL,
  isSlipTab,
  type CategoryFilter,
  type Option,
  type SlipFilter,
  type SlipFilters,
  type SlipTab,
  type StatusFilter,
} from "./logic";

const SEARCH_DELAY_MS = 250;

/** The search box: typed here, handed to the address after a pause (one history entry per pause, not per letter). */
function SearchBox({ value, onChange }: { value: string; onChange: (q: string) => void }) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    // the page changed the search (Clear filters, the address): the box follows
    if (value !== committed.current) {
      committed.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => {
    if (draft === committed.current) return;
    const timer = setTimeout(() => {
      committed.current = draft;
      latest.current(draft);
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft]);
  const clear = () => {
    committed.current = "";
    setDraft("");
    onChange("");
  };
  return (
    <div className="relative min-w-0 flex-1 lg:min-w-[240px]">
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search by name or employee code"
        aria-label="Search employees"
        className="h-10 pl-9 pr-9"
        data-testid="ssc-search"
      />
      {draft && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear the search text"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function FilterSelect({
  value,
  onChange,
  label,
  allLabel,
  options,
  testId,
  className = "lg:w-44",
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  allLabel?: string;
  options: Option[];
  testId: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={`h-10 min-w-0 ${className}`} aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const CATEGORY_OPTIONS: Option[] = [
  { value: "staff", label: "Staff" },
  { value: "production", label: "Production" },
];
const STATUS_OPTIONS: Option[] = [
  { value: "active", label: "Active employees" },
  { value: "inactive", label: "Inactive employees" },
];
const SLIP_OPTIONS: Option[] = [
  { value: "generated", label: "Slip generated" },
  { value: "not_generated", label: "Slip not generated" },
];

/** The filters, the category tabs with their counts, and what the list is showing. */
export function Toolbar({
  filters,
  onChange,
  onCategory,
  departments,
  designations,
  units,
  tab,
  onTab,
  counts,
  showing,
  filtered,
  onClear,
}: {
  filters: SlipFilters;
  onChange: (patch: Partial<SlipFilters>) => void;
  /** A category was picked (the department and designation lists follow it). */
  onCategory: (category: CategoryFilter) => void;
  departments: Option[];
  designations: Option[];
  /** Empty when the company has one unit: the unit filter is not shown. */
  units: Option[];
  tab: SlipTab;
  onTab: (tab: SlipTab) => void;
  counts: Record<SlipTab, number> | null;
  showing: string | null;
  filtered: boolean;
  onClear: () => void;
}) {
  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="ssc-toolbar" role="search">
      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
        <SearchBox value={filters.search} onChange={(search) => onChange({ search })} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:flex lg:flex-wrap">
          <FilterSelect
            value={filters.category}
            onChange={(v) => onCategory(v as CategoryFilter)}
            label="Filter by category"
            allLabel="Staff and production"
            options={CATEGORY_OPTIONS}
            testId="ssc-category"
          />
          <FilterSelect
            value={filters.department}
            onChange={(department) => onChange({ department })}
            label="Filter by department"
            allLabel="All departments"
            options={departments}
            testId="ssc-department"
            className="lg:w-48"
          />
          <FilterSelect
            value={filters.designation}
            onChange={(designation) => onChange({ designation })}
            label="Filter by designation"
            allLabel="All designations"
            options={designations}
            testId="ssc-designation"
            className="lg:w-48"
          />
          {units.length > 1 && (
            <FilterSelect
              value={filters.unit}
              onChange={(unit) => onChange({ unit })}
              label="Filter by unit"
              allLabel="All units"
              options={units}
              testId="ssc-unit"
            />
          )}
          <FilterSelect
            value={filters.status}
            onChange={(v) => onChange({ status: v as StatusFilter })}
            label="Filter by employee status"
            allLabel="Active and inactive"
            options={STATUS_OPTIONS}
            testId="ssc-status"
          />
          <FilterSelect
            value={filters.slip}
            onChange={(v) => onChange({ slip: v as SlipFilter })}
            label="Filter by slip status"
            allLabel="Any slip status"
            options={SLIP_OPTIONS}
            testId="ssc-slip"
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-full overflow-x-auto">
          <PillTabs
            size="sm"
            baseColor={ACCENT}
            items={SLIP_TABS.map((t) => ({
              value: t,
              label: (
                <span data-testid={`ssc-tab-${t}`}>
                  {TAB_LABEL[t]} <span className="font-semibold opacity-70">({counts ? counts[t] : "—"})</span>
                </span>
              ),
            }))}
            value={tab}
            onChange={(v) => isSlipTab(v) && onTab(v)}
          />
        </div>
        <p className="text-xs text-gray-500">
          {showing && <span data-testid="ssc-showing">{showing}</span>}
          {filtered && (
            <button
              type="button"
              onClick={onClear}
              className="ml-2 font-semibold text-indigo-600 hover:underline"
              data-testid="ssc-clear-filters"
            >
              Clear filters
            </button>
          )}
        </p>
      </div>
    </div>
  );
}
