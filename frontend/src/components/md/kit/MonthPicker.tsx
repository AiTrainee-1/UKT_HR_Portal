import { ChevronLeft, ChevronRight } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/** "YYYY-MM" of a month. */
export type MonthKey = string;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

export const monthKey = (year: number, month: number): MonthKey => `${year}-${two(month)}`;
export const thisMonthKey = (now = new Date()): MonthKey => monthKey(now.getFullYear(), now.getMonth() + 1);

export function parseMonthKey(key: MonthKey): { year: number; month: number } {
  const [y, m] = key.split("-").map(Number);
  return { year: y || new Date().getFullYear(), month: m >= 1 && m <= 12 ? m : 1 };
}

/** The month `delta` months from `key` ("2026-01", -1 -> "2025-12"). */
export function shiftMonth(key: MonthKey, delta: number): MonthKey {
  const { year, month } = parseMonthKey(key);
  const index = year * 12 + (month - 1) + delta;
  return monthKey(Math.floor(index / 12), (index % 12) + 1);
}

/** "Nov 2026". */
export function monthLabel(key: MonthKey): string {
  const { year, month } = parseMonthKey(key);
  return `${MONTHS[month - 1]} ${year}`;
}

/** First and last day ("YYYY-MM-DD") of a month, for pages that ask the server by date range. */
export function monthRange(key: MonthKey): { from: string; to: string } {
  const { year, month } = parseMonthKey(key);
  const last = new Date(year, month, 0).getDate();
  return { from: `${year}-${two(month)}-01`, to: `${year}-${two(month)}-${two(last)}` };
}

/**
 * Month + year for the MD portal (2026-11-21): the previous / next arrows step a month, the two selects jump. Months after
 * `max` (default: this month) cannot be picked; `min` limits how far back. Shared by every MD page that has a monthly view,
 * so the control looks and behaves the same everywhere.
 */
export function MonthPicker({
  value,
  onChange,
  min,
  max,
  className,
  label = "Month",
}: {
  value: MonthKey;
  onChange: (next: MonthKey) => void;
  min?: MonthKey;
  max?: MonthKey;
  className?: string;
  label?: string;
}) {
  const top = max ?? thisMonthKey();
  const { year, month } = parseMonthKey(value);
  const topYear = parseMonthKey(top).year;
  const bottomYear = min ? parseMonthKey(min).year : topYear - 5;
  const years = Array.from({ length: topYear - bottomYear + 1 }, (_, i) => topYear - i);
  const allowed = (key: MonthKey) => key <= top && (!min || key >= min);
  const prev = shiftMonth(value, -1);
  const next = shiftMonth(value, 1);
  const clamp = (key: MonthKey) => (key > top ? top : min && key < min ? min : key);
  const trigger = "md-field h-9 text-xs font-semibold";
  const arrow =
    "md-btn md-btn-icon inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-md-ink-soft disabled:opacity-40";

  return (
    <div
      role="group"
      aria-label={label}
      className={cn("flex max-w-full items-center gap-1.5", className)}
      data-testid="month-picker"
    >
      <button
        type="button"
        className={arrow}
        onClick={() => onChange(prev)}
        disabled={!allowed(prev)}
        aria-label="Previous month"
        data-testid="month-prev"
      >
        <ChevronLeft size={15} aria-hidden />
      </button>
      <Select value={String(month)} onValueChange={(m) => onChange(clamp(monthKey(year, Number(m))))}>
        <SelectTrigger className={cn(trigger, "w-[5.25rem]")} aria-label={`${label}: month`} data-testid="month-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((name, i) => (
            <SelectItem key={name} value={String(i + 1)} disabled={!allowed(monthKey(year, i + 1))}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(year)} onValueChange={(y) => onChange(clamp(monthKey(Number(y), month)))}>
        <SelectTrigger className={cn(trigger, "w-[5.5rem]")} aria-label={`${label}: year`} data-testid="year-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {years.map((y) => (
            <SelectItem key={y} value={String(y)}>
              {y}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button
        type="button"
        className={arrow}
        onClick={() => onChange(next)}
        disabled={!allowed(next)}
        aria-label="Next month"
        data-testid="month-next"
      >
        <ChevronRight size={15} aria-hidden />
      </button>
    </div>
  );
}
