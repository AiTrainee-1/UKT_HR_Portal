import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { TONE, type Tone } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { sparkPoints } from "./logic";

// Small controls the details page repeats: a native select (the right thing on a phone), a two-way toggle, a chip
// that can be pressed, and a sparkline. Kept here so each section reads as content, not as markup.

/** A native <select> in the portal's input look, with its own chevron. */
export function FilterSelect({
  value,
  onChange,
  label,
  children,
  testId,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  /** The accessible name (there is no visible label). */
  label: string;
  children: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        data-testid={testId}
        className="h-9 w-full appearance-none rounded-xl border border-slate-200 bg-white pl-3 pr-8 text-xs font-medium text-slate-700 outline-none transition-colors hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-slate-300"
      >
        {children}
      </select>
      <ChevronDown
        size={13}
        className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400"
      />
    </span>
  );
}

/** Two or three choices side by side: the selected one is filled. */
export function SegmentedToggle<V extends string>({
  items,
  value,
  onChange,
  label,
  activeClass = "bg-slate-800 text-white",
  testId,
  className,
}: {
  items: { value: V; label: ReactNode; testId?: string }[];
  value: V;
  onChange: (value: V) => void;
  label: string;
  activeClass?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      className={cn("inline-flex rounded-xl border border-slate-200 bg-slate-50 p-0.5", className)}
    >
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          data-testid={item.testId}
          onClick={() => onChange(item.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-xs font-semibold transition-colors",
            item.value === value ? activeClass : "text-slate-600 hover:bg-white",
          )}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** A chip that is switched on and off: a filter ("Critical 1"), a legend entry, a source of rules. */
export function ToggleChip({
  pressed,
  onClick,
  tone = "neutral",
  children,
  testId,
  title,
  disabled,
  className,
}: {
  pressed: boolean;
  onClick: () => void;
  tone?: Tone;
  children: ReactNode;
  testId?: string;
  title?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50",
        pressed
          ? cn(TONE[tone], "ring-2 ring-slate-400 ring-offset-1")
          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** A tiny line chart of a few values; the last point (the payroll being looked at) is a dot. */
export function Sparkline({
  values,
  width = 120,
  height = 36,
  label,
  stroke = "#64748b",
  dot = "#4f46e5",
  testId,
}: {
  values: number[];
  width?: number;
  height?: number;
  label: string;
  stroke?: string;
  dot?: string;
  testId?: string;
}) {
  const { points, last } = sparkPoints(values, width, height);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={label}
      data-testid={testId}
      className="shrink-0 overflow-visible"
    >
      {values.length > 1 && (
        <polyline
          points={points}
          fill="none"
          stroke={stroke}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {last && <circle cx={last.x} cy={last.y} r={3} fill={dot} />}
    </svg>
  );
}
