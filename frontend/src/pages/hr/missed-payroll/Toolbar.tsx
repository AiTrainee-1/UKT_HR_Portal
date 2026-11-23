import { useEffect, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MissedCategory } from "@/lib/api-client/custom-hooks/missed-payroll";
import { cn } from "@/lib/utils";
import { ACCENT } from "../salary-slip-center/parts";
import type { Option } from "../salary-slip-center/logic";
import {
  ALL,
  MISSED_CATEGORIES,
  STATUSES,
  STATUS_LABEL,
  VIEWS,
  VIEW_LABEL,
  isView,
  type CategoryPill,
  type MissedFilters,
  type MissedView,
  type StatusPill,
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
        data-testid="mp-search"
      />
      {draft && (
        <button
          type="button"
          onClick={clear}
          aria-label="Clear the search text"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <SelectTrigger className="h-10 min-w-0 lg:w-48" aria-label={label} data-testid={testId}>
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

/** A row of small toggle pills with counts (the Missed view's reasons, the Processed view's statuses). */
function Pills<T extends string>({
  label,
  items,
  value,
  onChange,
  testPrefix,
}: {
  label: string;
  items: { value: T; label: string; count: number | null }[];
  value: T;
  onChange: (value: T) => void;
  testPrefix: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      {items.map((item) => {
        const on = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(item.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-1",
              on
                ? "border-indigo-600 bg-indigo-600 text-white"
                : "border-gray-200 bg-white text-gray-600 hover:border-indigo-200 hover:text-indigo-700",
            )}
            data-testid={`${testPrefix}-${item.value}`}
          >
            {item.label}{" "}
            <span className={cn("tabular-nums", on ? "opacity-80" : "opacity-60")}>({item.count ?? "—"})</span>
          </button>
        );
      })}
    </div>
  );
}

/** The views of the tab with their counts, the view's pills, the filters, what the list is showing, and its files. */
export function Toolbar({
  filters,
  onChange,
  departments,
  units,
  view,
  onView,
  viewCounts,
  category,
  onCategory,
  categoryCounts,
  categoryLabels,
  status,
  onStatus,
  statusCounts,
  showing,
  filtered,
  onClear,
  files,
}: {
  filters: MissedFilters;
  onChange: (patch: Partial<MissedFilters>) => void;
  departments: Option[];
  /** Empty or one unit: the unit filter is not shown. */
  units: Option[];
  view: MissedView;
  onView: (view: MissedView) => void;
  viewCounts: Record<MissedView, number> | null;
  category: CategoryPill;
  onCategory: (category: CategoryPill) => void;
  categoryCounts: Record<CategoryPill, number> | null;
  categoryLabels: Record<MissedCategory, string>;
  status: StatusPill;
  onStatus: (status: StatusPill) => void;
  statusCounts: Record<StatusPill, number> | null;
  showing: string | null;
  filtered: boolean;
  onClear: () => void;
  /** The view's files menu (everyone listed with an entry). */
  files?: ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-2xl border bg-white p-3" data-testid="mp-toolbar">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="max-w-full overflow-x-auto">
          <PillTabs
            size="sm"
            baseColor={ACCENT}
            items={VIEWS.map((v) => ({
              value: v,
              label: (
                <span data-testid={`mp-view-${v}`}>
                  {VIEW_LABEL[v]} <span className="font-semibold opacity-70">({viewCounts ? viewCounts[v] : "—"})</span>
                </span>
              ),
            }))}
            value={view}
            onChange={(v) => isView(v) && onView(v)}
          />
        </div>
        {files}
      </div>

      {view === "missed" && (
        <Pills<CategoryPill>
          label="Why they were missed"
          testPrefix="mp-cat"
          value={category}
          onChange={onCategory}
          items={[
            { value: ALL, label: "All reasons", count: categoryCounts?.all ?? null },
            ...MISSED_CATEGORIES.map((c) => ({
              value: c,
              label: categoryLabels[c],
              count: categoryCounts ? categoryCounts[c] : null,
            })),
          ]}
        />
      )}
      {view === "processed" && (
        <Pills<StatusPill>
          label="Status"
          testPrefix="mp-status"
          value={status}
          onChange={onStatus}
          items={[
            { value: ALL, label: "Every status", count: statusCounts?.all ?? null },
            ...STATUSES.map((s) => ({
              value: s,
              label: STATUS_LABEL[s],
              count: statusCounts ? statusCounts[s] : null,
            })),
          ]}
        />
      )}

      <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center" role="search">
        <SearchBox value={filters.search} onChange={(search) => onChange({ search })} />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
          <FilterSelect
            value={filters.department}
            onChange={(department) => onChange({ department })}
            label="Filter by department"
            allLabel="All departments"
            options={departments}
            testId="mp-department"
          />
          {units.length > 1 && (
            <FilterSelect
              value={filters.unit}
              onChange={(unit) => onChange({ unit })}
              label="Filter by unit"
              allLabel="All units"
              options={units}
              testId="mp-unit"
            />
          )}
        </div>
        <p className="text-xs text-gray-500 lg:ml-auto">
          {showing && <span data-testid="mp-showing">{showing}</span>}
          {filtered && (
            <button
              type="button"
              onClick={onClear}
              className="ml-2 font-semibold text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
