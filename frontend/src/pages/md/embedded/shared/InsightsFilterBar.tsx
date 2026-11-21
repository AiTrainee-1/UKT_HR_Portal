import type { ReactNode } from "react";
import { CalendarDays, CalendarRange } from "lucide-react";
import { FilterBar, PeriodBar, ScopeBar } from "@/components/md/kit/FilterBar";
import { MonthPicker, thisMonthKey } from "@/components/md/kit/MonthPicker";
import type { MdOrg } from "@/lib/md/types";
import type { PeriodPreset, ScopeChoice } from "@/lib/md/period";
import type { InsightsFilters, InsightsWhen } from "./filters";

/** The presets offered beside the month view (the month view already covers "this month" and "last month"). */
export const RANGE_PRESETS: PeriodPreset[] = ["today", "last_7_days", "last_30_days", "last_90_days", "this_fy"];

/**
 * The filter bar of an MD Insights tab: Month (month + year with arrows) or Range (presets and a custom range), then unit /
 * department / staff-production where the subject has them, then the page's own filters (children). Every figure and chart
 * on the tab follows it.
 */
export default function InsightsFilterBar({
  filters,
  onWhen,
  onScope,
  org,
  showScope = true,
  showDepartment = true,
  showType = true,
  presets = RANGE_PRESETS,
  allowRange = true,
  allowMonth = true,
  children,
  testId = "md-insights-filters",
}: {
  filters: InsightsFilters;
  onWhen: (when: InsightsWhen) => void;
  onScope?: (scope: ScopeChoice) => void;
  org?: MdOrg;
  showScope?: boolean;
  showDepartment?: boolean;
  showType?: boolean;
  presets?: PeriodPreset[];
  allowRange?: boolean;
  allowMonth?: boolean;
  children?: ReactNode;
  testId?: string;
}) {
  const { when } = filters;
  const both = allowRange && allowMonth;
  const toMonth = () => onWhen({ mode: "month", month: thisMonthKey() });
  const toRange = () => onWhen({ mode: "period", period: { preset: presets[0] ?? "last_30_days" } });

  return (
    <FilterBar className="md-insights-filters">
      <div className="flex max-w-full flex-wrap items-center gap-2.5" data-testid={testId}>
        {both && (
          <div role="tablist" aria-label="Show by" className="md-seg md-shell-seg md-shell-seg-sm shrink-0">
            <button
              type="button"
              role="tab"
              aria-selected={when.mode === "month"}
              onClick={() => when.mode !== "month" && toMonth()}
              className="md-seg-item whitespace-nowrap"
              data-testid={`${testId}-month-mode`}
            >
              <CalendarDays size={13} aria-hidden /> Month
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={when.mode === "period"}
              onClick={() => when.mode !== "period" && toRange()}
              className="md-seg-item whitespace-nowrap"
              data-testid={`${testId}-range-mode`}
            >
              <CalendarRange size={13} aria-hidden /> Range
            </button>
          </div>
        )}
        {when.mode === "month" && allowMonth && (
          <MonthPicker value={when.month} onChange={(month) => onWhen({ mode: "month", month })} />
        )}
        {when.mode === "period" && allowRange && (
          <PeriodBar
            key={when.period.preset === "custom" ? "custom" : "preset"}
            value={when.period}
            onChange={(period) => onWhen({ mode: "period", period })}
            presets={presets}
          />
        )}
      </div>
      {showScope && onScope && (
        <ScopeBar
          value={filters.scope}
          onChange={onScope}
          org={org}
          showDepartment={showDepartment}
          showType={showType}
        />
      )}
      {children}
    </FilterBar>
  );
}
