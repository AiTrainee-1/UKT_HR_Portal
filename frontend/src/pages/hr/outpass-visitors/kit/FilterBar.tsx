import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

/** The height of every filter control: 44 px on a phone (a finger), 36 px from the tablet width up. */
export const CONTROL_H = "h-11 sm:h-9";
const CONTROL =
  "rounded-lg border border-slate-200 bg-white px-2.5 text-sm text-slate-900 outline-none transition-colors " +
  "hover:border-slate-300 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/50";

/**
 * The one filter row above a table: the date filter, the selects, the search and Clear on the left, the page's own
 * buttons (Export) on the right. It wraps on a small screen and sticks to the top of the page from the tablet width up.
 */
export function FilterBar({
  children,
  actions,
  label = "Filters",
  sticky = true,
  testId = "filter-bar",
  className,
}: {
  children: ReactNode;
  /** Right-hand buttons (Export ...). */
  actions?: ReactNode;
  /** What a screen reader calls the group. */
  label?: string;
  sticky?: boolean;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "rounded-2xl border border-slate-200/80 bg-white p-3",
        sticky && "md:sticky md:top-0 md:z-20",
        className,
      )}
      data-testid={testId}
    >
      <div className="flex flex-wrap items-center gap-2">
        {children}
        {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export type FilterOption = { value: string; label: string };

/**
 * A native select (it opens the phone's own picker and needs no portal). The label is read by screen readers and shown
 * only with `showLabel`; the first option ("All gates") says what the select is about.
 */
export function SelectFilter({
  label,
  value,
  onChange,
  options,
  allLabel,
  showLabel = false,
  disabled,
  testId,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly FilterOption[];
  /** The "no filter" option, value "": "All gates". Leave it out when the select must always have a value. */
  allLabel?: string;
  showLabel?: boolean;
  disabled?: boolean;
  testId?: string;
  className?: string;
}) {
  const id = useId();
  const known = value === "" || options.some((o) => o.value === value);
  return (
    <div className={cn("flex w-[calc(50%-0.25rem)] min-w-0 flex-col gap-1 sm:w-auto", className)}>
      <label
        htmlFor={id}
        className={showLabel ? "text-[11px] font-semibold uppercase tracking-wide text-slate-500" : "sr-only"}
      >
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={cn(CONTROL, CONTROL_H, "w-full min-w-0 sm:min-w-[9rem] sm:max-w-[16rem]")}
        data-testid={testId}
      >
        {allLabel !== undefined && <option value="">{allLabel}</option>}
        {/* a value the options do not have yet (still loading, or from an old link) stays selected instead of jumping */}
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The search box. Typing waits 350 ms after the last key before it asks the server (Enter asks at once); a change from
 * outside (Clear filters, Back) is shown straight away.
 */
export function SearchFilter({
  value,
  onChange,
  placeholder = "Search",
  label = "Search",
  delay = 350,
  testId,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** What a screen reader calls the box: "Search by name or code". */
  label?: string;
  delay?: number;
  testId?: string;
  className?: string;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  const sent = useRef(value);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      setText(value);
    }
  }, [value]);

  useEffect(() => {
    if (text === sent.current) return;
    const timer = setTimeout(() => {
      if (text === sent.current) return; // Enter already sent it
      sent.current = text;
      onChangeRef.current(text);
    }, delay);
    return () => clearTimeout(timer);
  }, [text, delay]);

  const flush = (next: string) => {
    setText(next);
    if (next !== sent.current) {
      sent.current = next;
      onChangeRef.current(next);
    }
  };

  return (
    <div className={cn("relative w-full min-w-0 sm:w-64", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        size={15}
        className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
        aria-hidden="true"
      />
      <input
        id={id}
        type="search"
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            flush(text);
          }
        }}
        className={cn(CONTROL, CONTROL_H, "w-full pl-8 pr-9 [&::-webkit-search-cancel-button]:hidden")}
        data-testid={testId}
      />
      {text && (
        <button
          type="button"
          aria-label="Clear the search"
          onClick={() => flush("")}
          className="absolute right-0 top-1/2 flex size-11 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-700 sm:size-9"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** "Clear filters (2)": only there while a filter is on. */
export function ClearFilters({
  count,
  onClear,
  testId = "clear-filters",
}: {
  count: number;
  onClear: () => void;
  testId?: string;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClear}
      className={cn(
        CONTROL_H,
        "rounded-lg px-2.5 text-sm font-medium text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline",
      )}
      data-testid={testId}
    >
      Clear filters ({count})
    </button>
  );
}
