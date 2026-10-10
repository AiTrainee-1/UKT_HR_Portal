import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Briefcase,
  CameraOff,
  CheckSquare,
  Factory,
  RefreshCw,
  Search,
  Square,
  Users,
  X,
} from "lucide-react";
import EmployeeAvatar from "@/components/EmployeeAvatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import type { Employee } from "@/lib/api-client/generated/api.schemas";
import { cn } from "@/lib/utils";
import {
  GAP_LABEL,
  NO_FILTERS,
  PAGE_SIZE,
  addIds,
  allSelected,
  cardGaps,
  facetsOf,
  filterEmployees,
  filtersActive,
  fullName,
  isProduction,
  removeIds,
  summarizeEmployees,
  toggleId,
  type DetailsFilter,
  type PickerFilters,
  type TypeFilter,
} from "./logic";

type Props = {
  employees: Employee[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  selectedIds: number[];
  onSelect: (ids: number[]) => void;
};

const DETAILS: { value: DetailsFilter; label: string }[] = [
  { value: "all", label: "All employees" },
  { value: "has_photo", label: "Has a photo" },
  { value: "no_photo", label: "No photo" },
  { value: "incomplete", label: "Missing any detail" },
];

/** The left column: find employees (search, branch, department, type, card details) and tick the ones to make cards for. */
export default function EmployeePicker({ employees, loading, error, onRetry, selectedIds, onSelect }: Props) {
  const [filters, setFilters] = useState<PickerFilters>(NO_FILTERS);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const set = (patch: Partial<PickerFilters>) => setFilters((f) => ({ ...f, ...patch }));

  const summary = useMemo(() => summarizeEmployees(employees), [employees]);
  const facets = useMemo(() => facetsOf(employees), [employees]);
  const shown = useMemo(() => filterEmployees(employees, filters), [employees, filters]);
  const chosen = useMemo(() => new Set(selectedIds), [selectedIds]);
  const everyShownChosen = allSelected(shown, selectedIds);
  const active = filtersActive(filters);

  // a new search starts from the top of the list again
  useEffect(() => setVisible(PAGE_SIZE), [filters]);

  return (
    <Card className="no-print rounded-2xl border lg:sticky lg:top-4" data-testid="id-picker">
      <CardContent className="space-y-3 p-3">
        <div className="relative">
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <Input
            className="h-9 pl-8 pr-8 text-sm"
            placeholder="Name, code, designation, department"
            aria-label="Search employees"
            value={filters.query}
            onChange={(e) => set({ query: e.target.value })}
            data-testid="id-search"
          />
          {filters.query && (
            <button
              type="button"
              onClick={() => set({ query: "" })}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <PillTabs
          size="sm"
          items={[
            { value: "all", label: "All", count: summary.total },
            { value: "staff", label: "Staff", count: summary.staff },
            { value: "production", label: "Production", count: summary.production },
          ]}
          value={filters.type}
          onChange={(v) => set({ type: v as TypeFilter })}
        />

        <div className="grid grid-cols-2 gap-2">
          {facets.branches.length > 1 && (
            <Select value={filters.branch} onValueChange={(v) => set({ branch: v })}>
              <SelectTrigger className="h-8 text-xs" aria-label="Filter by branch" data-testid="id-filter-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All branches</SelectItem>
                {facets.branches.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={filters.department} onValueChange={(v) => set({ department: v })}>
            <SelectTrigger className="h-8 text-xs" aria-label="Filter by department" data-testid="id-filter-department">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All departments</SelectItem>
              {facets.departments.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.details} onValueChange={(v) => set({ details: v as DetailsFilter })}>
            <SelectTrigger className="h-8 text-xs" aria-label="Filter by card details" data-testid="id-filter-details">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DETAILS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <p className="text-gray-500" data-testid="id-count">
            Showing <b>{shown.length}</b> of {employees.length}
            {active && (
              <button
                type="button"
                onClick={() => setFilters(NO_FILTERS)}
                className="ml-1.5 font-semibold text-blue-600 hover:underline"
                data-testid="id-clear-filters"
              >
                Clear filters
              </button>
            )}
          </p>
          <div className="flex items-center gap-3 font-semibold">
            <button
              type="button"
              disabled={shown.length === 0}
              onClick={() =>
                onSelect(
                  everyShownChosen
                    ? removeIds(
                        selectedIds,
                        shown.map((e) => e.id),
                      )
                    : addIds(
                        selectedIds,
                        shown.map((e) => e.id),
                      ),
                )
              }
              className="text-blue-600 hover:underline disabled:text-gray-300 disabled:no-underline"
              data-testid="id-select-shown"
            >
              {everyShownChosen ? `Deselect these ${shown.length}` : `Select these ${shown.length}`}
            </button>
            {selectedIds.length > 0 && (
              <button
                type="button"
                onClick={() => onSelect([])}
                className="text-gray-500 hover:underline"
                data-testid="id-clear-selection"
              >
                Clear ({selectedIds.length})
              </button>
            )}
          </div>
        </div>

        <div className="max-h-[560px] space-y-1 overflow-y-auto" data-testid="id-list">
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-11 w-full rounded-lg" />)
          ) : error ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="id-error">
              <AlertTriangle size={22} className="text-red-500" />
              <p className="text-xs font-semibold text-gray-700">The employees could not be loaded</p>
              <Button size="sm" variant="outline" className="h-7 gap-1.5 text-xs" onClick={onRetry}>
                <RefreshCw size={12} /> Retry
              </Button>
            </div>
          ) : employees.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="id-empty">
              <Users size={22} className="text-gray-300" />
              <p className="text-xs text-gray-500">No active employees yet. Add employees to make their ID cards.</p>
            </div>
          ) : shown.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center" data-testid="id-no-match">
              <Search size={22} className="text-gray-300" />
              <p className="text-xs text-gray-500">No employee matches.</p>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            </div>
          ) : (
            <>
              {shown.slice(0, visible).map((emp) => {
                const checked = chosen.has(emp.id);
                const gaps = cardGaps(emp);
                const subtitle = [emp.designationTitle, emp.departmentName].filter(Boolean).join(" · ");
                return (
                  <button
                    key={emp.id}
                    type="button"
                    role="checkbox"
                    aria-checked={checked}
                    onClick={() => onSelect(toggleId(selectedIds, emp.id))}
                    data-testid={`id-row-${emp.employeeCode}`}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
                      checked ? "border-blue-200 bg-blue-50" : "border-transparent hover:bg-gray-50",
                    )}
                  >
                    {checked ? (
                      <CheckSquare size={15} className="shrink-0 text-blue-600" />
                    ) : (
                      <Square size={15} className="shrink-0 text-gray-300" />
                    )}
                    <EmployeeAvatar photoUrl={emp.photoUrl} name={fullName(emp)} size={28} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-semibold">{fullName(emp)}</p>
                      <p className="truncate text-[10px] text-gray-400">
                        <span className="font-mono">{emp.employeeCode}</span>
                        {subtitle && ` · ${subtitle}`}
                      </p>
                    </div>
                    {gaps.length > 0 && (
                      <span
                        className="shrink-0 text-amber-500"
                        title={`The card will be missing: ${gaps.map((g) => GAP_LABEL[g]).join(", ")}`}
                        data-testid="id-gap"
                      >
                        {gaps.includes("photo") ? <CameraOff size={12} /> : <AlertTriangle size={12} />}
                      </span>
                    )}
                    {isProduction(emp) ? (
                      <Factory size={12} className="shrink-0 text-orange-400" aria-label="Production" />
                    ) : (
                      <Briefcase size={12} className="shrink-0 text-blue-400" aria-label="Staff" />
                    )}
                  </button>
                );
              })}
              {shown.length > visible && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  data-testid="id-show-more"
                >
                  Show more ({shown.length - visible} left)
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
