import { useId, useState, type CSSProperties } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  RANGE_PRESETS,
  canStepForward,
  chooseDays,
  chooseMonth,
  choosePreset,
  istDay,
  monthLabel,
  monthOf,
  rangeDays,
  rangeLabel,
  shownMonth,
  stepMonth,
  type DateRangeValue,
} from "@/lib/date-range";
import { cn } from "@/lib/utils";

/** 44 px on a phone (a finger), 36 px from the tablet width up: the height of the gate kit's and Requests' controls. */
const CONTROL_H = "h-11 sm:h-9";
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The month picker never goes further back than this (the HRMS holds nothing older). */
const FIRST_YEAR = 2015;

/**
 * The date filter of the HR portal's record pages (lib/date-range): Today / Yesterday / This Month / Custom, a
 * ‹ November 2026 › stepper for earlier months (the month name opens a month picker), the From / To days of Custom (To
 * left empty is one day), and the days in words. Nothing after today can be picked. It holds no state of its own: the
 * page keeps the value in its address (useDateRange, or the gate kit's useGateFilters) and gets every change in
 * `onChange`. Bare (no card): each page puts it in its own toolbar, in its own accent.
 */
export function DateRangeBar({
  value,
  onChange,
  accent,
  now,
  showLabel = true,
  testId = "date-range",
  className,
}: {
  value: DateRangeValue;
  onChange: (next: DateRangeValue) => void;
  /** The page's accent for the chosen preset (a CSS colour); the theme's primary colour when left out. */
  accent?: string;
  /** Today (tests). */
  now?: Date;
  /** The days in words ("Showing November 2026"). */
  showLabel?: boolean;
  testId?: string;
  className?: string;
}) {
  const id = useId();
  const at = now ?? new Date();
  const today = istDay(at);
  const days = rangeDays(value, at);
  const month = shownMonth(value, at);
  const forward = canStepForward(value, at);
  const pressed: CSSProperties | undefined = accent ? { backgroundColor: accent, color: "#fff" } : undefined;

  return (
    <div
      role="group"
      aria-label="Dates"
      className={cn("flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto", className)}
      data-testid={testId}
      data-range={value.range}
      data-from={days.from}
      data-to={days.to}
    >
      <div className="grid w-full grid-cols-4 overflow-hidden rounded-lg border border-slate-200 sm:inline-flex sm:w-auto">
        {RANGE_PRESETS.map((p, i) => {
          const on = value.range === p.value && (p.value !== "month" || value.month === "");
          return (
            <button
              key={p.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(choosePreset(p.value, value, at))}
              className={cn(
                CONTROL_H,
                "min-w-0 whitespace-nowrap px-2 text-[13px] font-medium transition-colors sm:px-3 sm:text-sm",
                i > 0 && "border-l border-slate-200",
                on ? !accent && "bg-primary text-primary-foreground" : "bg-white text-slate-700 hover:bg-slate-50",
              )}
              style={on ? pressed : undefined}
              data-testid={`${testId}-${p.value}`}
            >
              {p.label}
            </button>
          );
        })}
      </div>

      <div
        className="flex w-full min-w-0 items-center overflow-hidden rounded-lg border border-slate-200 bg-white sm:w-auto"
        data-testid={`${testId}-stepper`}
      >
        <button
          type="button"
          onClick={() => onChange(stepMonth(value, -1, at))}
          disabled={month.slice(0, 4) <= String(FIRST_YEAR) && month.endsWith("-01")}
          aria-label="Previous month"
          className={cn(CONTROL_H, "grid w-11 shrink-0 place-items-center text-slate-600 hover:bg-slate-50 sm:w-9")}
          data-testid={`${testId}-prev`}
        >
          <ChevronLeft size={16} aria-hidden />
        </button>
        <MonthPicker
          month={month}
          active={value.range === "month"}
          today={today}
          onPick={(m) => onChange(chooseMonth(m, at))}
          testId={testId}
        />
        <button
          type="button"
          onClick={() => onChange(stepMonth(value, 1, at))}
          disabled={!forward}
          aria-label="Next month"
          className={cn(
            CONTROL_H,
            "grid w-11 shrink-0 place-items-center text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-white sm:w-9",
          )}
          data-testid={`${testId}-next`}
        >
          <ChevronRight size={16} aria-hidden />
        </button>
      </div>

      {value.range === "custom" && (
        <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto" data-testid={`${testId}-custom`}>
          <label htmlFor={`${id}-from`} className="shrink-0 text-xs text-slate-500">
            From
          </label>
          <input
            id={`${id}-from`}
            type="date"
            value={days.from}
            max={today}
            onChange={(e) => e.target.value && onChange(chooseDays(e.target.value, days.to, at))}
            className={cn(
              CONTROL_H,
              "min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-sm tabular-nums text-slate-900 sm:w-[9.5rem] sm:flex-none",
            )}
            data-testid={`${testId}-from`}
          />
          <label htmlFor={`${id}-to`} className="shrink-0 text-xs text-slate-500">
            To
          </label>
          <input
            id={`${id}-to`}
            type="date"
            value={days.to === days.from ? "" : days.to}
            min={days.from}
            max={today}
            onChange={(e) => onChange(chooseDays(days.from, e.target.value, at))}
            title="Leave empty for one day"
            className={cn(
              CONTROL_H,
              "min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-sm tabular-nums text-slate-900 sm:w-[9.5rem] sm:flex-none",
            )}
            data-testid={`${testId}-to`}
          />
        </div>
      )}

      {showLabel && (
        <p
          className="flex min-w-0 items-center gap-1.5 text-xs text-slate-500"
          aria-live="polite"
          data-testid={`${testId}-label`}
        >
          <CalendarDays size={13} aria-hidden className="shrink-0 text-slate-400" />
          <span className="truncate">
            Showing <b className="font-semibold text-slate-800">{rangeLabel(value, at)}</b>
          </span>
        </p>
      )}
    </div>
  );
}

/** The month name of the stepper, a button that opens the months of a year (later months than now cannot be picked). */
function MonthPicker({
  month,
  active,
  today,
  onPick,
  testId,
}: {
  month: string;
  /** The filter is This Month (of this month): the name reads as chosen. */
  active: boolean;
  today: string;
  onPick: (month: string) => void;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const [year, setYear] = useState(() => Number(month.slice(0, 4)));
  const current = monthOf(today);
  const thisYear = Number(current.slice(0, 4));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setYear(Number(month.slice(0, 4)));
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            CONTROL_H,
            "min-w-0 flex-1 truncate border-x border-slate-200 px-3 text-sm tabular-nums transition-colors hover:bg-slate-50 sm:min-w-[9.5rem] sm:flex-none",
            active ? "font-semibold text-slate-900" : "text-slate-600",
          )}
          aria-label={`${monthLabel(month)}: pick a month`}
          data-testid={`${testId}-month-name`}
        >
          {monthLabel(month)}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-3" data-testid={`${testId}-months`}>
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setYear((y) => Math.max(FIRST_YEAR, y - 1))}
            disabled={year <= FIRST_YEAR}
            aria-label="Previous year"
            className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100 disabled:text-slate-300"
            data-testid={`${testId}-year-prev`}
          >
            <ChevronLeft size={15} aria-hidden />
          </button>
          <span className="text-sm font-semibold tabular-nums text-slate-900" data-testid={`${testId}-year`}>
            {year}
          </span>
          <button
            type="button"
            onClick={() => setYear((y) => Math.min(thisYear, y + 1))}
            disabled={year >= thisYear}
            aria-label="Next year"
            className="grid h-8 w-8 place-items-center rounded-md text-slate-600 hover:bg-slate-100 disabled:text-slate-300"
            data-testid={`${testId}-year-next`}
          >
            <ChevronRight size={15} aria-hidden />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-1.5">
          {MONTH_SHORT.map((name, i) => {
            const key = `${year}-${String(i + 1).padStart(2, "0")}`;
            const later = key > current;
            const chosen = active && key === month;
            return (
              <button
                key={key}
                type="button"
                disabled={later}
                aria-pressed={chosen}
                onClick={() => {
                  onPick(key);
                  setOpen(false);
                }}
                className={cn(
                  "h-9 rounded-md text-sm transition-colors",
                  chosen ? "bg-primary font-semibold text-primary-foreground" : "text-slate-700 hover:bg-slate-100",
                  later && "cursor-not-allowed text-slate-300 hover:bg-transparent",
                )}
                data-testid={`${testId}-pick-${key}`}
              >
                {name}
              </button>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
