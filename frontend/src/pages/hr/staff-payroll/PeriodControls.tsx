import { useMemo } from "react";
import { CalendarDays, ChevronLeft, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MONTH_NAMES } from "@/components/payroll/BreakdownDrawer";
import { shiftMonth, yearOptions } from "./logic";

/**
 * The payroll month the whole page is about (every tab follows it): previous / next month arrows, month and year selects
 * and a Refresh that reloads every payroll figure on screen.
 */
export function PeriodControls({
  month,
  year,
  onChange,
  onRefresh,
  refreshing,
  showPeriod = true,
}: {
  month: number;
  year: number;
  onChange: (month: number, year: number) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  /** False on a tab that has its own month and year fields (Payslip): only the Refresh button is left. */
  showPeriod?: boolean;
}) {
  const years = useMemo(() => {
    const options = yearOptions(new Date().getFullYear());
    return options.includes(year) ? options : [...options, year].sort((a, b) => a - b);
  }, [year]);
  const go = (by: number) => {
    const next = shiftMonth({ month, year }, by);
    onChange(next.month, next.year);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="staff-period">
      {showPeriod && (
        <div className="clay-card flex items-center gap-1 rounded-2xl border border-slate-100 px-1.5 py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Previous month"
            onClick={() => go(-1)}
            data-testid="staff-period-prev"
          >
            <ChevronLeft size={16} />
          </Button>
          <CalendarDays size={15} className="text-indigo-600" aria-hidden="true" />
          <select
            value={month}
            onChange={(e) => onChange(Number(e.target.value), year)}
            aria-label="Month"
            className="h-8 rounded-lg border-0 bg-transparent px-1.5 text-sm font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="staff-period-month"
          >
            {MONTH_NAMES.map((m, i) => (
              <option key={m} value={i + 1}>
                {m}
              </option>
            ))}
          </select>
          <select
            value={year}
            onChange={(e) => onChange(month, Number(e.target.value))}
            aria-label="Year"
            className="h-8 rounded-lg border-0 bg-transparent px-1.5 text-sm font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="staff-period-year"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Next month"
            onClick={() => go(1)}
            data-testid="staff-period-next"
          >
            <ChevronRight size={16} />
          </Button>
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-10 w-10 rounded-2xl"
        aria-label="Reload the payroll figures"
        title="Reload the payroll figures"
        onClick={onRefresh}
        disabled={refreshing}
        data-testid="staff-refresh"
      >
        {refreshing ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
      </Button>
    </div>
  );
}
