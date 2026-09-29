import { useMemo } from "react";
import { Input } from "@/components/ui/input";
import { datePresets, type DateRangeValue } from "@/lib/report-center";

const QUICK = ["today", "yesterday", "week", "last7", "month", "lastMonth", "quarter", "fy"];

function dayCount(r: DateRangeValue): number | null {
  if (!r.dateFrom || !r.dateTo) return null;
  const n = Math.round((Date.parse(r.dateTo) - Date.parse(r.dateFrom)) / 86_400_000) + 1;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** From / To date inputs with quick-range chips and a live day count. */
export function DateRangeFilter({
  value,
  onChange,
  maxDays,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  maxDays?: number;
}) {
  const presets = useMemo(() => datePresets(new Date()).filter((p) => QUICK.includes(p.id)), []);
  const days = dayCount(value);
  const tooWide = maxDays !== undefined && days !== null && days > maxDays;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <Input
          type="date"
          aria-label="From date"
          value={value.dateFrom}
          max={value.dateTo || undefined}
          onChange={(e) => onChange({ ...value, dateFrom: e.target.value })}
          className="h-9"
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="date"
          aria-label="To date"
          value={value.dateTo}
          min={value.dateFrom || undefined}
          onChange={(e) => onChange({ ...value, dateTo: e.target.value })}
          className="h-9"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {presets.map((p) => {
          const active = p.range.dateFrom === value.dateFrom && p.range.dateTo === value.dateTo;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(p.range)}
              className={`h-7 rounded-full border px-2.5 text-[11px] font-semibold transition-colors ${
                active
                  ? "border-gray-900 bg-gray-900 text-white"
                  : "border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:bg-gray-50"
              }`}
            >
              {p.label}
            </button>
          );
        })}
        {days !== null && (
          <span className={`ml-auto text-[11px] ${tooWide ? "font-semibold text-red-600" : "text-muted-foreground"}`}>
            {days} day{days === 1 ? "" : "s"}
            {maxDays !== undefined ? ` (max ${maxDays})` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
