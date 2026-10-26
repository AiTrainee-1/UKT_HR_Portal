import type { ReactNode } from "react";
import { useListDepartments } from "@/lib/api-client";
import { ALL } from "../leave/logic";
import { DateField, FilterPanel, FilterSelect, SearchBox } from "../leave/parts";

/** What the two daily lists are narrowed by: one date (today at first), a department, and a search over code and name. They
 *  share it, so a date picked on one list is the date of the other when the tab is switched. */
export type DailyFilters = { date: string; department: string; search: string };

/** The department as the API wants it (a number), or undefined for every department. */
export const departmentParam = (department: string): number | undefined =>
  department === ALL || !department ? undefined : Number(department);

/** The date, department and search of a daily list, with the page's own buttons (the downloads, the Informed filter) at the end. */
export default function DailyFiltersBar({
  filters,
  onChange,
  actions,
  children,
  testId,
}: {
  filters: DailyFilters;
  onChange: (next: DailyFilters) => void;
  /** At the end of the first row (the downloads of a list with nothing else to set). */
  actions?: ReactNode;
  /** More controls on the second row (an Informed filter, the export buttons). */
  children?: ReactNode;
  testId: string;
}) {
  const { data: departments } = useListDepartments();
  const set = (patch: Partial<DailyFilters>) => onChange({ ...filters, ...patch });
  return (
    <div data-testid={testId}>
      <FilterPanel>
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
          <SearchBox
            value={filters.search}
            onChange={(search) => set({ search })}
            placeholder="Search by employee code or name"
            label="Search employees"
            testId="daily-search"
          />
          <div className="flex flex-wrap items-center gap-2">
            <DateField
              value={filters.date}
              onChange={(date) => date && set({ date })}
              label="Date"
              testId="daily-date"
            />
            <FilterSelect
              value={filters.department || ALL}
              onChange={(department) => set({ department })}
              label="Filter by department"
              allLabel="All Departments"
              options={(departments ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
              testId="daily-department"
            />
          </div>
          {actions}
        </div>
        {children && <div className="flex flex-wrap items-center gap-2 border-t pt-3">{children}</div>}
      </FilterPanel>
    </div>
  );
}
