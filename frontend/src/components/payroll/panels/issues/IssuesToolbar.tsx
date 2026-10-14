import type { ReactNode } from "react";
import { CalendarDays, Tags, Users } from "lucide-react";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { GROUP_BY_OPTIONS, normalizeGroupBy, type IssueFilterState, type IssueGroupBy } from "./issues-logic";
import { ACCENT, FilterSelect, ResetButton, SearchField, type FilterOption, type PanelAccent } from "./panel-kit";

const GROUP_ICON: Record<IssueGroupBy, ReactNode> = {
  date: <CalendarDays size={12} />,
  employee: <Users size={12} />,
  type: <Tags size={12} />,
};

/**
 * The filter row of the Issues panel: search, severity, type, department, the day range the issue was detected in, how to
 * group the list, Reset (with how many filters are on) and the export. Everything here only changes what is shown.
 */
export function IssuesToolbar({
  state,
  patch,
  activeCount,
  onReset,
  severityOptions,
  typeOptions,
  departmentOptions,
  bounds,
  exportItems,
  accent,
}: {
  /** The filters as they are applied (already sanitised). */
  state: IssueFilterState;
  patch: (patch: Partial<IssueFilterState>) => void;
  activeCount: number;
  onReset: () => void;
  severityOptions: FilterOption[];
  typeOptions: FilterOption[];
  departmentOptions: FilterOption[];
  /** The first and last day of the period: the range the date pickers offer. */
  bounds?: { start: string; end: string };
  exportItems: ExportItem[];
  accent: PanelAccent;
}) {
  return (
    <div
      className="clay-card space-y-3 rounded-2xl border border-slate-100 p-3"
      role="search"
      aria-label="Filter issues"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <SearchField
          value={state.q}
          onChange={(q) => patch({ q })}
          placeholder="Search by employee, code, title or detail"
          label="Search issues"
          testId="issues-search"
          className="lg:flex-1"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:flex">
          <FilterSelect
            value={state.severity}
            onChange={(severity) => patch({ severity })}
            options={severityOptions}
            allLabel="All severities"
            label="Filter by severity"
            testId="issues-severity"
            className="lg:w-44"
          />
          <FilterSelect
            value={state.code}
            onChange={(code) => patch({ code })}
            options={typeOptions}
            allLabel="All types"
            label="Filter by type"
            testId="issues-type"
            className="lg:w-52"
          />
          <FilterSelect
            value={state.dept}
            onChange={(dept) => patch({ dept })}
            options={departmentOptions}
            allLabel="All departments"
            label="Filter by department"
            testId="issues-dept"
            className="lg:w-48"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="grid grid-cols-2 gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-muted-foreground">
            Detected from
            <Input
              type="date"
              value={state.from}
              min={bounds?.start}
              max={state.to || bounds?.end}
              onChange={(e) => {
                // typing a start after the current end moves the end with it, so the range never flips under the typist
                const from = e.target.value;
                patch(from && state.to && from > state.to ? { from, to: from } : { from });
              }}
              className="h-10 w-full sm:w-40"
              data-testid="issues-from"
            />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-[11px] font-semibold text-muted-foreground">
            Detected to
            <Input
              type="date"
              value={state.to}
              min={state.from || bounds?.start}
              max={bounds?.end}
              onChange={(e) => {
                const to = e.target.value;
                patch(to && state.from && to < state.from ? { from: to, to } : { to });
              }}
              className="h-10 w-full sm:w-40"
              data-testid="issues-to"
            />
          </label>
        </div>

        <div className="flex max-w-full items-center gap-2">
          <span className="text-[11px] font-semibold text-muted-foreground">Group by</span>
          <div className="max-w-full overflow-x-auto">
            <PillTabs
              size="sm"
              baseColor={ACCENT[accent].fill}
              items={GROUP_BY_OPTIONS.map((o) => ({ value: o.value, label: o.label, icon: GROUP_ICON[o.value] }))}
              value={normalizeGroupBy(state.groupBy)}
              onChange={(groupBy) => patch({ groupBy })}
            />
          </div>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {activeCount > 0 && <ResetButton count={activeCount} onClick={onReset} testId="issues-reset" />}
          <ExportMenu
            items={exportItems}
            testId="issues-export"
            heading="Export the issues shown (every page)"
            className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
          />
        </div>
      </div>
    </div>
  );
}
