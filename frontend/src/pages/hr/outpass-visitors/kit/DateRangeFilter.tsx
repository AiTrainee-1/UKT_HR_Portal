import { useId } from "react";
import { cn } from "@/lib/utils";
import { CONTROL_H } from "./FilterBar";
import { DATE_PRESETS, istDateKey, resolveDateRange, type DatePreset, type DateRangeKind } from "./fmt";

/** What the date filter writes (straight into `useGateFilters().set`): a preset clears the two days, a typed day is "custom". */
export type DateRangePatch = { range: DateRangeKind; from: string; to: string };

/**
 * The date filter: Today / This week / This month (worked out in India time, a week from Monday), optionally All dates,
 * and two native day pickers that always show the days the filter covers. Picking a day makes the range "custom".
 */
export function DateRangeFilter({
  range,
  from,
  to,
  onChange,
  presets = DATE_PRESETS.map((p) => p.value),
  allowAll = false,
  now,
  testId = "date-range",
  className,
}: {
  /** "today" | "week" | "month" | "custom" | "all" (the address's `range`). */
  range: string;
  from: string;
  to: string;
  onChange: (patch: DateRangePatch) => void;
  presets?: readonly DatePreset[];
  /** Offer "All dates" (no limit). */
  allowAll?: boolean;
  /** Today (tests). */
  now?: Date;
  testId?: string;
  className?: string;
}) {
  const id = useId();
  const shown = resolveDateRange({ range, from, to }, now);
  const today = istDateKey(now ?? new Date());
  const choices = [
    ...DATE_PRESETS.filter((p) => presets.includes(p.value)),
    ...(allowAll ? [{ value: "all" as const, label: "All dates" }] : []),
  ];
  const pick = (value: DatePreset | "all") => onChange({ range: value, from: "", to: "" });
  const type = (which: "from" | "to", day: string) =>
    onChange({ range: "custom", from: which === "from" ? day : shown.from, to: which === "to" ? day : shown.to });

  return (
    <div
      role="group"
      aria-label="Dates"
      className={cn("flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto", className)}
      data-testid={testId}
    >
      <div className="flex w-full overflow-hidden rounded-lg border border-slate-200 sm:w-auto">
        {choices.map((c, i) => {
          const on = range === c.value;
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={on}
              onClick={() => pick(c.value)}
              className={cn(
                CONTROL_H,
                "flex-1 whitespace-nowrap px-3 text-sm font-medium transition-colors sm:flex-none",
                i > 0 && "border-l border-slate-200",
                on ? "bg-primary text-primary-foreground" : "bg-white text-slate-700 hover:bg-slate-50",
              )}
              data-testid={`${testId}-${c.value}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
        <label htmlFor={`${id}-from`} className="shrink-0 text-xs text-slate-500">
          From
        </label>
        <input
          id={`${id}-from`}
          type="date"
          value={shown.from}
          max={shown.to || today}
          onChange={(e) => e.target.value && type("from", e.target.value)}
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
          value={shown.to}
          min={shown.from || undefined}
          max={today}
          onChange={(e) => e.target.value && type("to", e.target.value)}
          className={cn(
            CONTROL_H,
            "min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 text-sm tabular-nums text-slate-900 sm:w-[9.5rem] sm:flex-none",
          )}
          data-testid={`${testId}-to`}
        />
      </div>
    </div>
  );
}
