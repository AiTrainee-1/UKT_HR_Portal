import { useMemo } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MONTHS_LONG, shiftMonth, yearOptions } from "./logic";

const SELECT_CLASS =
  "h-8 rounded-lg border-0 bg-transparent px-1.5 text-sm font-semibold text-gray-900 outline-none focus-visible:ring-2 focus-visible:ring-ring";

/** The month the whole page is about: previous / next arrows and the month and year selects. */
export function PeriodPicker({
  month,
  year,
  onChange,
  disabled,
}: {
  month: number;
  year: number;
  onChange: (month: number, year: number) => void;
  /** A job is running: the month stays put until it is done. */
  disabled?: boolean;
}) {
  const years = useMemo(() => yearOptions(new Date().getFullYear(), year), [year]);
  const go = (by: number) => {
    const next = shiftMonth({ month, year }, by);
    onChange(next.month, next.year);
  };
  return (
    <div
      className="clay-card flex items-center gap-1 rounded-2xl border border-slate-100 px-1.5 py-1"
      data-testid="ssc-period"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        aria-label="Previous month"
        onClick={() => go(-1)}
        disabled={disabled}
        data-testid="ssc-period-prev"
      >
        <ChevronLeft size={16} />
      </Button>
      <CalendarDays size={15} className="text-indigo-600" aria-hidden="true" />
      <select
        value={month}
        onChange={(e) => onChange(Number(e.target.value), year)}
        aria-label="Month"
        className={SELECT_CLASS}
        disabled={disabled}
        data-testid="ssc-period-month"
      >
        {MONTHS_LONG.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <select
        value={year}
        onChange={(e) => onChange(month, Number(e.target.value))}
        aria-label="Year"
        className={SELECT_CLASS}
        disabled={disabled}
        data-testid="ssc-period-year"
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
        disabled={disabled}
        data-testid="ssc-period-next"
      >
        <ChevronRight size={16} />
      </Button>
    </div>
  );
}
