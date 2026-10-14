import { AlertTriangle, RotateCcw, Search, X } from "lucide-react";
import { BusyIcon } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// The few small controls the Issues, Skipped Employees and Rules panels share. Each panel could draw its own; they live
// here so a search box, a filter select, "Reset (2)" and the error card look and behave the same in all three (and so the
// lead can lift them into the kit when the pages are wired together).

/** Staff Payroll is indigo, Production Payroll amber (the colour of their tabs); a panel takes the accent of its page. */
export type PanelAccent = "indigo" | "amber";

// Tailwind only sees whole class strings, so every accent is written out.
export const ACCENT: Record<
  PanelAccent,
  { fill: string; text: string; link: string; solid: string; soft: string; spinner: string }
> = {
  indigo: {
    fill: "#4f46e5",
    text: "text-indigo-700",
    link: "text-indigo-700 hover:text-indigo-900",
    solid: "border-indigo-600 bg-indigo-600 text-white",
    soft: "border-indigo-200 bg-indigo-50 text-indigo-800",
    spinner: "text-indigo-600",
  },
  amber: {
    fill: "#d97706",
    text: "text-amber-700",
    link: "text-amber-700 hover:text-amber-900",
    solid: "border-amber-600 bg-amber-600 text-white",
    soft: "border-amber-200 bg-amber-50 text-amber-800",
    spinner: "text-amber-600",
  },
};

/** The text a panel's Excel / CSV is titled with when the company's name has not loaded (yet). */
export const FALLBACK_COMPANY = "UK Textiles";

export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  testId,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** What the box is for, read out by a screen reader ("Search issues"). */
  label: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="h-10 pl-9 pr-9"
        data-testid={testId}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** Radix cannot have an item whose value is empty, so "everything" is this value on its way in and out. */
export const ALL_VALUE = "__all__";

export type FilterOption = { value: string; label: string };

/** A dropdown filter: "" means no filter (the first item, named `allLabel`). A value the options do not know is still shown. */
export function FilterSelect({
  value,
  onChange,
  options,
  allLabel,
  label,
  testId,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: FilterOption[];
  allLabel: string;
  label: string;
  testId?: string;
  className?: string;
}) {
  const known = value === "" || options.some((o) => o.value === value);
  const list = known ? options : [...options, { value, label: value }];
  return (
    <Select value={value === "" ? ALL_VALUE : value} onValueChange={(v) => onChange(v === ALL_VALUE ? "" : v)}>
      <SelectTrigger className={cn("h-10", className)} aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_VALUE}>{allLabel}</SelectItem>
        {list.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** "Reset (2)": clears the filters, and says how many are on. */
export function ResetButton({ count, onClick, testId }: { count: number; onClick: () => void; testId?: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={onClick}
      className="h-9 gap-1.5"
      data-testid={testId}
      aria-label={`Reset ${count} ${count === 1 ? "filter" : "filters"}`}
    >
      <RotateCcw size={13} />
      Reset
      <span className="rounded-full bg-slate-200 px-1.5 text-[11px] font-bold tabular-nums text-slate-700">
        {count}
      </span>
    </Button>
  );
}

/** "Could not load the issues" with a Retry button (a spinner while it retries). */
export function LoadError({
  what,
  detail,
  onRetry,
  retrying,
  testId,
}: {
  what: string;
  /** A second line; the default is the usual "check your connection". */
  detail?: string;
  onRetry?: () => void;
  retrying?: boolean;
  testId?: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-2xl border border-red-100 bg-red-50/40 px-6 py-12 text-center"
      data-testid={testId}
    >
      <div className="rounded-2xl bg-red-50 p-4 text-red-600">
        <AlertTriangle size={26} />
      </div>
      <div>
        <p className="font-bold text-gray-900">Could not load {what}</p>
        <p className="mx-auto mt-0.5 max-w-md break-words text-sm text-muted-foreground">
          {detail || "Check your connection, then try again."}
        </p>
      </div>
      <Button variant="outline" onClick={onRetry} disabled={!onRetry || retrying} className="gap-1.5">
        <BusyIcon busy={!!retrying} icon={RotateCcw} />
        Retry
      </Button>
    </div>
  );
}
