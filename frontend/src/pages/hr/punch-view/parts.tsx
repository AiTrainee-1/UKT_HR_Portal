import type { PunchDayStatusValue } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

/** YYYY-MM-DD from the viewer's LOCAL calendar date (not toISOString, which is UTC: yesterday in IST before 05:30). */
export function localISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export const todayISO = (): string => localISO(new Date());

export const STATUS_LABEL: Record<PunchDayStatusValue, string> = {
  present: "Present",
  half_shift: "Half Day",
  absent: "Absent",
  on_leave: "On leave",
  holiday: "Holiday",
};

const STATUS_TONE: Record<PunchDayStatusValue, string> = {
  present: "bg-green-50 text-green-700 border-green-200",
  half_shift: "bg-amber-50 text-amber-700 border-amber-200",
  absent: "bg-red-50 text-red-700 border-red-200",
  on_leave: "bg-blue-50 text-blue-700 border-blue-200",
  holiday: "bg-slate-100 text-slate-600 border-slate-200",
};

/** A day's status as a chip; one set by hand says so. */
export function StatusChip({
  status,
  source,
  className,
}: {
  status: PunchDayStatusValue;
  source?: "auto" | "manual" | string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
        STATUS_TONE[status] ?? "bg-slate-50 text-slate-600 border-slate-200",
        className,
      )}
    >
      {STATUS_LABEL[status] ?? status}
      {source === "manual" && <span className="font-medium opacity-70">· by hand</span>}
    </span>
  );
}
