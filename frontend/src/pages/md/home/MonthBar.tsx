import { lazy, Suspense } from "react";
import { CalendarRange, RotateCcw } from "lucide-react";
import { addMonths, MONTHS_BACK, monthName } from "./home-logic";

// The shared month control (kit/MonthPicker: arrows and month / year selects) brings the select menus with it: it is
// fetched after the first paint, and a placeholder of its size stands in until then.
const MonthPicker = lazy(() => import("@/components/md/kit/MonthPicker").then((m) => ({ default: m.MonthPicker })));

function PickerPlaceholder() {
  return <div className="md-dashboard-skeleton h-9 w-[16.5rem] max-w-full rounded-xl" aria-hidden />;
}

/**
 * The Dashboard's month (owner 2026-11-21: filters and monthly views everywhere): it sets the month the attendance and
 * payroll figures are for; the employees and the requests waiting are always now. The running month is the default and
 * keeps today's live figures; "This month" goes back to it.
 */
export default function MonthBar({
  month,
  running,
  onChange,
}: {
  /** The chosen month ("2026-10"), or null for the running one. */
  month: string | null;
  /** The running month by the server's clock. */
  running: string;
  onChange: (next: string | null) => void;
}) {
  const value = month ?? running;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2"
      data-testid="md-home-month"
      data-month={value}
    >
      <p className="flex min-w-0 items-center gap-2 text-sm font-semibold text-md-ink">
        <CalendarRange size={16} className="shrink-0 text-md-wine" aria-hidden />
        <span className="min-w-0">
          {month ? (
            <>
              Attendance and payroll for <b className="font-extrabold">{monthName(month)}</b>
            </>
          ) : (
            <>
              Today and <b className="font-extrabold">{monthName(running)}</b> so far
            </>
          )}
          <span className="hidden text-md-ink-soft @2xl:inline"> · employees and requests are as of now</span>
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {month && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="md-btn md-btn-soft md-btn-sm"
            data-testid="md-home-month-reset"
          >
            <RotateCcw size={12} aria-hidden /> This month
          </button>
        )}
        <Suspense fallback={<PickerPlaceholder />}>
          <MonthPicker
            value={value}
            max={running}
            min={addMonths(running, -MONTHS_BACK)}
            label="Dashboard month"
            onChange={(next) => onChange(next === running ? null : next)}
          />
        </Suspense>
      </div>
    </div>
  );
}
