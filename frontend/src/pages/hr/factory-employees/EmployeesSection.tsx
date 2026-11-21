import type { ReactNode } from "react";
import { ChevronDown, Search, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { FactoryEmployee, FactoryLabel } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { EmployeeList, type RowActions } from "./EmployeeList";
import {
  ALL,
  PAGE_SIZE,
  isCategoryFilter,
  isStatusFilter,
  safeColor,
  showingText,
  sortLabels,
  type Attention,
  type EmptyInfo,
  type Filters,
  type LabelTabItem,
  type ListSelection,
  type PageOf,
  type Rights,
  type Selection,
} from "./logic";
import { EmptyState, ListSkeleton, LoadError } from "./parts";

type Props = {
  filters: Filters;
  onFilters: (patch: Partial<Filters>) => void;
  onClearFilters: () => void;
  filtered: boolean;
  tabs: LabelTabItem[];
  labelTab: string;
  onLabelTab: (tab: string) => void;
  onManageLabels: () => void;
  attention: Attention;
  onAttention: (a: Attention) => void;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  stale: boolean;
  rows: FactoryEmployee[];
  paged: PageOf<FactoryEmployee>;
  onPage: (page: number) => void;
  selection: Selection;
  selected: FactoryEmployee[];
  listState: ListSelection;
  hidden: number;
  onToggle: (row: FactoryEmployee) => void;
  onToggleAll: () => void;
  onClearSelection: () => void;
  labels: FactoryLabel[];
  rights: Rights;
  actions: RowActions;
  /** The bulk bar's label change (confirmed first: the label is also the department and designation). */
  onBulkLabel: (rows: FactoryEmployee[], labelId: number | null) => void;
  busy: boolean;
  empty: EmptyInfo;
  addButtons: ReactNode;
};

const ATTENTION_TEXT: Record<Exclude<Attention, "all">, string> = {
  payroll: "Showing only those payroll skips",
  shift: "Showing only those with no shift",
};

/** The Employees section: filters, the label tabs, the bulk bar and the list. */
export function EmployeesSection(p: Props) {
  const n = p.selection.size;
  return (
    <div className="space-y-4" data-testid="fe-employees">
      <div className="space-y-3 rounded-2xl border bg-white p-3">
        <div className="flex flex-col gap-2 xl:flex-row xl:items-center">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={p.filters.search}
              onChange={(e) => p.onFilters({ search: e.target.value })}
              placeholder="Search by name, employee code or phone"
              aria-label="Search factory employees"
              className="h-10 pl-9 pr-9"
              data-testid="fe-search"
            />
            {p.filters.search && (
              <button
                type="button"
                onClick={() => p.onFilters({ search: "" })}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
              >
                <X size={14} />
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2 xl:flex">
            <Select
              value={p.filters.category}
              onValueChange={(v) => isCategoryFilter(v) && p.onFilters({ category: v })}
            >
              <SelectTrigger
                className="h-10 xl:w-44"
                aria-label="Filter by payroll category"
                data-testid="fe-category-filter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Both payrolls</SelectItem>
                <SelectItem value="staff">Staff Payroll</SelectItem>
                <SelectItem value="production">Production Payroll</SelectItem>
              </SelectContent>
            </Select>
            <Select value={p.filters.status} onValueChange={(v) => isStatusFilter(v) && p.onFilters({ status: v })}>
              <SelectTrigger className="h-10 xl:w-40" aria-label="Filter by status" data-testid="fe-status-filter">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="inactive">Inactive</SelectItem>
                <SelectItem value="all">Active and inactive</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="-mx-1 flex min-w-0 flex-1 gap-1.5 overflow-x-auto px-1 pb-1"
            role="tablist"
            aria-label="Labels"
            data-testid="fe-label-tabs"
          >
            {p.tabs.map((t) => {
              const on = p.labelTab === t.value;
              const color = t.color ? safeColor(t.color) : "#111827";
              return (
                <button
                  key={t.value}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => p.onLabelTab(t.value)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                    on ? "text-white shadow-sm" : "bg-white text-gray-700 hover:bg-gray-50",
                  )}
                  style={on ? { background: color, borderColor: color } : undefined}
                  data-testid={`fe-tab-${t.value}`}
                >
                  {t.color && (
                    <span className="h-2 w-2 rounded-full" style={{ background: on ? "#ffffff" : color }} aria-hidden />
                  )}
                  {t.label} <span className={cn("tabular-nums", on ? "opacity-90" : "text-gray-400")}>{t.count}</span>
                </button>
              );
            })}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="hidden shrink-0 gap-1 text-xs sm:inline-flex"
            onClick={p.onManageLabels}
            data-testid="fe-manage-labels"
          >
            <Settings2 size={13} /> Labels
          </Button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
          <p>
            {p.rows.length > 0 && <span data-testid="fe-showing">{showingText(p.paged)}</span>}
            {p.attention !== "all" && (
              <span className="ml-2 font-semibold text-amber-800" data-testid="fe-attention-note">
                {ATTENTION_TEXT[p.attention]}
                <button
                  type="button"
                  onClick={() => p.onAttention("all")}
                  className="ml-1.5 text-blue-600 hover:underline"
                >
                  Show everyone
                </button>
              </span>
            )}
          </p>
          {p.filtered && (
            <button
              type="button"
              onClick={p.onClearFilters}
              className="font-semibold text-blue-600 hover:underline"
              data-testid="fe-clear-filters"
            >
              Clear filters
            </button>
          )}
        </div>
      </div>

      {n > 0 && (
        <div
          className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-teal-200 bg-teal-50/95 px-3 py-2.5 shadow-sm backdrop-blur"
          data-testid="fe-bulk-bar"
        >
          <p className="text-sm font-semibold text-teal-900" data-testid="fe-selected-count">
            {p.listState === "all" && p.hidden === 0 ? `All ${n} selected` : `${n} selected`}
            {p.hidden > 0 && (
              <span className="ml-1 font-normal text-teal-700">({p.hidden} not shown by the current filters)</span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            {p.rights.manage && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 bg-white"
                    disabled={p.busy}
                    data-testid="fe-bulk-label"
                  >
                    Assign label <ChevronDown size={13} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel className="text-xs text-gray-500">Give the {n} selected</DropdownMenuLabel>
                  {sortLabels(p.labels).map((l) => (
                    <DropdownMenuItem
                      key={l.id}
                      onSelect={() => p.onBulkLabel(p.selected, l.id)}
                      data-testid={`fe-bulk-label-${l.id}`}
                    >
                      <span
                        className="mr-2 inline-block h-2.5 w-2.5 rounded-full"
                        style={{ background: safeColor(l.color) }}
                      />
                      {l.name}
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => p.onBulkLabel(p.selected, null)} data-testid="fe-bulk-label-none">
                    No label
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {p.rights.manage && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  className="bg-white"
                  disabled={p.busy}
                  onClick={() => p.actions.onPayroll(p.selected)}
                  data-testid="fe-bulk-payroll"
                >
                  Set payroll
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1 bg-white"
                      disabled={p.busy}
                      data-testid="fe-bulk-shift"
                    >
                      Shift <ChevronDown size={13} />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => p.actions.onShift(p.selected)} data-testid="fe-bulk-shift-assign">
                      Assign a shift
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => p.actions.onShiftRemove(p.selected)}
                      data-testid="fe-bulk-shift-remove"
                    >
                      Take off their shift
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
            {p.rights.setStatus && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1 bg-white"
                    disabled={p.busy}
                    data-testid="fe-bulk-status"
                  >
                    Status <ChevronDown size={13} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() => p.actions.onStatus(p.selected, "active")}
                    data-testid="fe-bulk-status-active"
                  >
                    Mark active
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => p.actions.onStatus(p.selected, "inactive")}
                    data-testid="fe-bulk-status-inactive"
                  >
                    Mark inactive
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {p.rights.manage && (
              <Button
                size="sm"
                variant="outline"
                className="bg-white text-red-700"
                disabled={p.busy}
                onClick={() => p.actions.onRemove(p.selected)}
                data-testid="fe-bulk-remove"
              >
                Remove from Factory Employees
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={p.onClearSelection} data-testid="fe-bulk-clear">
              Clear selection
            </Button>
          </div>
        </div>
      )}

      {p.loading ? (
        <ListSkeleton />
      ) : p.failed ? (
        <LoadError what="the factory employees" onRetry={p.onRetry} />
      ) : p.rows.length === 0 ? (
        <EmptyState
          info={p.empty}
          onClear={p.onClearFilters}
          onAllLabels={() => p.onLabelTab(ALL)}
          addButtons={p.addButtons}
        />
      ) : (
        <>
          <EmployeeList
            rows={p.paged.rows}
            allRows={p.rows}
            selection={p.selection}
            onToggle={p.onToggle}
            onToggleAll={p.onToggleAll}
            labels={p.labels}
            rights={p.rights}
            actions={p.actions}
            busy={p.busy}
            stale={p.stale}
          />
          <DataPagination
            page={p.paged.page}
            totalPages={p.paged.totalPages}
            totalItems={p.paged.total}
            pageSize={PAGE_SIZE}
            onPageChange={p.onPage}
          />
        </>
      )}
    </div>
  );
}
