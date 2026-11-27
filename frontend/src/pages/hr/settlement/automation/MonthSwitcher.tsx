import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { currentPeriod } from "../logic";
import { MONTH_FULL } from "../shared";
import { isFutureMonth, shiftMonth, type MonthRef } from "./logic";

/** Month and year selects with previous / next; a month after this one (India time) cannot be chosen: nothing is raised
 *  in it yet. The Automation Method's pages (the Overview and each type's workflow) share it. */
export default function MonthSwitcher({ value, onChange }: { value: MonthRef; onChange: (next: MonthRef) => void }) {
  const now = currentPeriod();
  const years = Array.from({ length: 4 }, (_, i) => now.year - 3 + i);
  if (!years.includes(value.year)) years.push(value.year);
  years.sort((a, b) => a - b);
  const next = shiftMonth(value, 1);
  const isNow = value.month === now.month && value.year === now.year;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-view-safe data-testid="auto-month">
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9"
        onClick={() => onChange(shiftMonth(value, -1))}
        aria-label="Previous month"
        data-testid="auto-month-prev"
      >
        <ChevronLeft size={16} />
      </Button>
      <Select value={String(value.month)} onValueChange={(v) => onChange({ ...value, month: Number(v) })}>
        <SelectTrigger className="h-9 w-36" aria-label="Month" data-testid="auto-month-month">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTH_FULL.map((m, i) => (
            <SelectItem key={m} value={String(i + 1)} disabled={isFutureMonth({ month: i + 1, year: value.year })}>
              {m}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={String(value.year)}
        onValueChange={(v) => {
          const year = Number(v);
          onChange(isFutureMonth({ month: value.month, year }) ? now : { month: value.month, year });
        }}
      >
        <SelectTrigger className="h-9 w-24" aria-label="Year" data-testid="auto-month-year">
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
      <Button
        variant="outline"
        size="icon"
        className="h-9 w-9"
        onClick={() => onChange(next)}
        disabled={isFutureMonth(next)}
        aria-label="Next month"
        data-testid="auto-month-next"
      >
        <ChevronRight size={16} />
      </Button>
      {!isNow && (
        <Button
          variant="ghost"
          size="sm"
          className="h-9 text-indigo-700"
          onClick={() => onChange(now)}
          data-testid="auto-month-now"
        >
          This month
        </Button>
      )}
    </div>
  );
}
