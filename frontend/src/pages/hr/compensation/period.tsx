import type { ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import type { ReportPeriod } from "@/lib/api-client/custom-hooks";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import { addDays, addMonths } from "./logic";

// Today / Week / Month with a date inside the period: the control of the Birthdays list and of History & Reports. The period
// is the day itself, the Monday-to-Sunday week that holds it, or its calendar month (the server works the range out).

export const PERIODS: { value: ReportPeriod; label: string; step: string }[] = [
  { value: "today", label: "Today", step: "day" },
  { value: "week", label: "Week", step: "week" },
  { value: "month", label: "Month", step: "month" },
];

export const isPeriod = (value: string): value is ReportPeriod => PERIODS.some((p) => p.value === value);

/** The day to show after stepping one period back (-1) or forward (+1). */
export function shiftAnchor(period: ReportPeriod, date: string, direction: -1 | 1): string {
  if (period === "week") return addDays(date, 7 * direction);
  if (period === "month") return addMonths(date, direction);
  return addDays(date, direction);
}

export function PeriodBar({
  period,
  date,
  today,
  onPeriod,
  onDate,
  children,
  testId = "period-bar",
}: {
  period: ReportPeriod;
  /** The day inside the period (the page's today when none was chosen). */
  date: string;
  today: string;
  onPeriod: (period: ReportPeriod) => void;
  onDate: (date: string) => void;
  /** Extra controls on the same row (the filters). */
  children?: ReactNode;
  testId?: string;
}) {
  const info = PERIODS.find((p) => p.value === period) ?? PERIODS[0];
  return (
    <div
      className="clay-card flex flex-wrap items-center gap-2 rounded-2xl border border-slate-100 p-3"
      data-testid={testId}
      {...{ [VIEW_SAFE_ATTR]: "" }}
    >
      <div className="max-w-full overflow-x-auto">
        <PillTabs
          items={PERIODS.map((p) => ({ value: p.value, label: p.label }))}
          value={period}
          onChange={(v) => isPeriod(v) && onPeriod(v)}
          baseColor="#4f46e5"
          size="sm"
        />
      </div>
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label={`Previous ${info.step}`}
          title={`Previous ${info.step}`}
          onClick={() => onDate(shiftAnchor(period, date, -1))}
          data-testid={`${testId}-prev`}
        >
          <ChevronLeft size={15} />
        </Button>
        <Input
          type="date"
          value={date}
          aria-label="A date inside the period"
          onChange={(e) => e.target.value && onDate(e.target.value)}
          className="h-9 w-40"
          data-testid={`${testId}-date`}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-9 w-9"
          aria-label={`Next ${info.step}`}
          title={`Next ${info.step}`}
          onClick={() => onDate(shiftAnchor(period, date, 1))}
          data-testid={`${testId}-next`}
        >
          <ChevronRight size={15} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9"
          disabled={date === today}
          onClick={() => onDate(today)}
          data-testid={`${testId}-today`}
        >
          Go to today
        </Button>
      </div>
      {children}
    </div>
  );
}
