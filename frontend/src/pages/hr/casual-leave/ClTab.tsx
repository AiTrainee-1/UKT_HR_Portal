import type { ComponentType, ReactNode } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs, type PillTabItem } from "@/components/ui/pill-tabs";
import type { Option, PersonFilters } from "../leave/logic";
import {
  EmptyState,
  ErrorState,
  ExportButton,
  FilterPanel,
  FilterSelect,
  ListSkeleton,
  MoreRows,
  ResultLine,
  SearchBox,
} from "../leave/parts";

type IconType = ComponentType<{ size?: number; className?: string }>;

/** One Casual Leave view: the search and filters, what they leave, then the list (or why there is none). The three
 *  views differ in their rows only, so the frame is shared. */
export default function ClTab({
  id,
  filters,
  onFilters,
  noFilters,
  branches,
  departments,
  showEmployeeType = true,
  searchLabel,
  pills,
  loading,
  failed,
  onRetry,
  total,
  shown,
  visible,
  onMore,
  noun,
  active,
  empty,
  onExport,
  note,
  children,
}: {
  /** "taken", "eligible", "not-eligible" or "requests": the prefix of every test id. */
  id: string;
  filters: PersonFilters;
  onFilters: (next: PersonFilters) => void;
  noFilters: PersonFilters;
  branches: Option[];
  departments: Option[];
  showEmployeeType?: boolean;
  searchLabel: string;
  pills?: { items: PillTabItem[]; value: string; onChange: (value: string) => void };
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  /** Rows before the filters / rows after them / rows drawn so far. */
  total: number;
  shown: number;
  visible: number;
  onMore: () => void;
  noun: string;
  /** Any filter on, the pills included. */
  active: boolean;
  empty: { icon: IconType; title: string; text: string };
  onExport: () => void;
  note?: ReactNode;
  children: ReactNode;
}) {
  const set = (patch: Partial<PersonFilters>) => onFilters({ ...filters, ...patch });
  const clear = () => {
    onFilters(noFilters);
    pills?.onChange("all");
  };
  return (
    <div className="space-y-4 pt-4" data-testid={`tab-${id}`}>
      {note}
      <FilterPanel>
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => set({ query })}
            placeholder="Search by name, employee code, department or branch"
            label={searchLabel}
            testId={`${id}-search`}
          />
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => set({ branch })}
              label="Filter by branch"
              allLabel="All branches"
              options={branches}
              testId={`${id}-filter-branch`}
            />
            <FilterSelect
              value={filters.department}
              onChange={(department) => set({ department })}
              label="Filter by department"
              allLabel="All departments"
              options={departments}
              testId={`${id}-filter-department`}
            />
            {showEmployeeType && (
              <FilterSelect
                value={filters.employeeType}
                onChange={(employeeType) => set({ employeeType })}
                label="Filter by employee type"
                allLabel="Staff and production"
                options={[
                  { value: "staff", label: "Staff" },
                  { value: "production", label: "Production" },
                ]}
                testId={`${id}-filter-employee-type`}
              />
            )}
          </div>
          <ExportButton disabled={shown === 0} onClick={onExport} testId={`${id}-export`} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          {pills ? <PillTabs size="sm" items={pills.items} value={pills.value} onChange={pills.onChange} /> : <span />}
          <ResultLine shown={shown} total={total} noun={noun} active={active} onClear={clear} testId={`${id}-count`} />
        </div>
      </FilterPanel>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <ListSkeleton testId={`${id}-loading`} />
          ) : failed ? (
            <ErrorState what={noun} onRetry={onRetry} testId={`${id}-error`} />
          ) : total === 0 ? (
            <EmptyState icon={empty.icon} title={empty.title} text={empty.text} testId={`${id}-empty`} />
          ) : shown === 0 ? (
            <EmptyState
              icon={Search}
              title={`No ${noun} match`}
              text="Try fewer words, or clear the filters."
              tone="bg-gray-100 text-gray-500"
              testId={`${id}-no-match`}
              action={
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              {children}
              <MoreRows shown={Math.min(visible, shown)} total={shown} onMore={onMore} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
