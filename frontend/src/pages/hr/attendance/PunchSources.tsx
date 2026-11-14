import { memo, useMemo } from "react";
import { Layers } from "lucide-react";
import type { AttendanceDailyRecord } from "@/lib/api-client/custom-hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { PUNCH_KIND_META, punchKind, shortDate, type PunchKind } from "./logic";

const ORDER: PunchKind[] = [
  "biometric",
  "geo",
  "on_duty",
  "missing_punch",
  "hr_entry",
  "auto",
  "held",
  "rejected",
  "uncounted",
];

export function punchSources(rows: readonly AttendanceDailyRecord[]) {
  const by = new Map<PunchKind, { punches: number; people: Set<number> }>();
  let total = 0;
  for (const r of rows) {
    for (const p of r.punches ?? []) {
      const kind = punchKind(p);
      const slot = by.get(kind) ?? { punches: 0, people: new Set<number>() };
      slot.punches += 1;
      slot.people.add(r.employeeId);
      by.set(kind, slot);
      total += 1;
    }
  }
  return {
    total,
    people: rows.filter((r) => (r.punches ?? []).length > 0).length,
    kinds: ORDER.filter((k) => by.has(k)).map((k) => ({
      kind: k,
      punches: by.get(k)!.punches,
      people: by.get(k)!.people.size,
    })),
  };
}

/** Where the day's punches came from: device, phone, On-Duty, Missing Punch, HR; and what is still waiting for HR. */
export const PunchSources = memo(function PunchSources({
  rows,
  loading,
  date,
}: {
  rows: AttendanceDailyRecord[];
  loading: boolean;
  date: string;
}) {
  const data = useMemo(() => punchSources(rows), [rows]);
  const max = Math.max(1, ...data.kinds.map((k) => k.punches));
  return (
    <section
      className="clay-card min-w-0 rounded-2xl border border-slate-100 bg-white p-3.5 sm:p-5"
      aria-labelledby="sources-title"
      data-testid="attendance-sources"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 rounded-lg bg-slate-50 p-1.5 text-slate-600 ring-1 ring-slate-100">
          <Layers size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <h3 id="sources-title" className="text-sm font-bold text-slate-900">
            Punch sources, {shortDate(date)}
          </h3>
          <p className="text-xs text-slate-500">
            {loading
              ? "Loading"
              : data.total === 0
                ? "No punches on this day"
                : `${data.total} punches from ${data.people} ${data.people === 1 ? "person" : "people"}`}
          </p>
        </div>
      </div>
      {loading ? (
        <div className="mt-4 space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </div>
      ) : data.total === 0 ? null : (
        <ul className="mt-4 space-y-3" data-testid="sources-list">
          {data.kinds.map(({ kind, punches, people }) => (
            <li key={kind} data-kind={kind}>
              <div className="flex items-baseline justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-semibold text-slate-700">
                  <span className={cn("h-2 w-2 rounded-full", PUNCH_KIND_META[kind].dot)} aria-hidden="true" />
                  {PUNCH_KIND_META[kind].label}
                </span>
                <span className="tabular-nums text-slate-500">
                  <strong className="font-bold text-slate-900">{punches}</strong> from {people}
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden="true">
                <div
                  className={cn("h-full rounded-full", PUNCH_KIND_META[kind].dot)}
                  style={{ width: `${(punches * 100) / max}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
});
