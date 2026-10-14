import { CalendarClock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CyclePeriod, ProductionPeriods } from "@/lib/api-client/custom-hooks";
import { periodFromValue, periodOptionLabel, periodValue } from "./logic";

/**
 * The pay period every tab of a cycle page (but the Payslip one) is about: the next one due is offered first, recent ones
 * can be opened, and any older one by typing a date that falls inside it. Read-only controls: the lock for a View Only
 * role never needs to touch them.
 */
export function PeriodPicker({
  periods,
  period,
  onChange,
  onPickDate,
  loading,
}: {
  periods: ProductionPeriods | undefined;
  period: CyclePeriod | null;
  onChange: (period: CyclePeriod) => void;
  /** Called with a date (YYYY-MM-DD) when the user asks for the period that holds it. */
  onPickDate: (date: string) => void;
  loading: boolean;
}) {
  const rows = periods?.periods ?? [];
  const roster = periods?.roster ?? 0;
  return (
    <div
      className="clay-card flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-slate-100 px-4 py-3"
      data-testid="pcp-period-bar"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="rounded-xl bg-amber-50 p-2 text-amber-600">
          <CalendarClock size={15} />
        </span>
        <span className="text-xs font-semibold text-gray-600">Pay period</span>
        <Select
          value={period ? periodValue(period) : ""}
          onValueChange={(v) => {
            const next = periodFromValue(v);
            if (next) onChange(next);
          }}
          disabled={loading || rows.length === 0}
        >
          <SelectTrigger
            className="h-9 min-w-[19rem] max-w-full text-sm"
            aria-label="Pay period"
            data-testid="pcp-period"
          >
            <SelectValue placeholder={loading ? "Loading periods..." : "Choose a period"} />
          </SelectTrigger>
          <SelectContent>
            {rows.map((row) => (
              <SelectItem key={periodValue(row)} value={periodValue(row)}>
                {periodOptionLabel(row, roster)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-gray-500">
        or the period holding
        <Input
          type="date"
          className="h-9 w-40 text-sm"
          aria-label="Open the pay period that holds this date"
          data-testid="pcp-period-date"
          disabled={loading}
          onChange={(e) => {
            if (e.target.value) onPickDate(e.target.value);
          }}
        />
      </label>
    </div>
  );
}
