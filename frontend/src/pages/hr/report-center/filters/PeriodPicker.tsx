import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { shiftPeriod } from "@/lib/report-center";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Month + year picker that emits "YYYY-MM" (the exact string the backend expects), with prev/next arrows. */
export function PeriodPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  const now = new Date();
  const year = m ? Number(m[1]) : now.getFullYear();
  const month = m ? Number(m[2]) : now.getMonth() + 1;
  const years: number[] = [];
  for (let y = now.getFullYear() + 1; y >= 2020; y--) years.push(y);
  if (!years.includes(year)) years.push(year);
  const set = (y: number, mo: number) => onChange(`${y}-${String(mo).padStart(2, "0")}`);

  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Previous month"
        onClick={() => onChange(shiftPeriod(`${year}-${String(month).padStart(2, "0")}`, -1))}
      >
        <ChevronLeft size={16} />
      </Button>
      <Select value={String(month)} onValueChange={(v) => set(year, Number(v))}>
        <SelectTrigger className="h-9 min-w-[7.5rem] flex-1" aria-label="Month">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MONTHS.map((name, i) => (
            <SelectItem key={name} value={String(i + 1)}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={String(year)} onValueChange={(v) => set(Number(v), month)}>
        <SelectTrigger className="h-9 w-[5.5rem] shrink-0" aria-label="Year">
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
        type="button"
        variant="outline"
        size="icon"
        className="h-9 w-9 shrink-0"
        aria-label="Next month"
        onClick={() => onChange(shiftPeriod(`${year}-${String(month).padStart(2, "0")}`, 1))}
      >
        <ChevronRight size={16} />
      </Button>
    </div>
  );
}
