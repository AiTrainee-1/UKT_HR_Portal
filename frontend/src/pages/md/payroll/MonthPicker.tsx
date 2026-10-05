import { CalendarDays } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { monthText } from "@/lib/md/format";
import { LATEST, STATE_STYLE, monthOptions } from "./logic";
import type { PayrollStatus } from "./types";

/**
 * Payroll is monthly, so the page has a month picker instead of a free-form period. "Latest closed month" (the default)
 * is the most recent month that has ended and has slips: a month still running understates pay, so it is never the
 * default, only a choice.
 */
export default function MonthPicker({
  value,
  onChange,
  status,
}: {
  /** "YYYY-MM", or "" for the latest closed month. */
  value: string;
  onChange: (month: string) => void;
  status: PayrollStatus | undefined;
}) {
  const options = monthOptions(status, value);
  const latest = status?.defaultMonth ? ` (${monthText(status.defaultMonth)})` : "";
  return (
    <div className="flex items-center gap-2" data-testid="md-payroll-month-picker">
      <CalendarDays size={15} className="text-[#006496]/60" aria-hidden />
      <Select value={value || LATEST} onValueChange={(v) => onChange(v === LATEST ? "" : v)}>
        <SelectTrigger
          className="h-8 w-[15rem] max-w-full text-xs"
          aria-label="Payroll month"
          data-testid="md-payroll-month"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LATEST}>Latest closed month{latest}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
              {o.state ? ` · ${STATE_STYLE[o.state].label}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
