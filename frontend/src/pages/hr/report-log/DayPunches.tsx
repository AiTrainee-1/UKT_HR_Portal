import type { UseQueryResult } from "@tanstack/react-query";
import { Fingerprint, Moon, RefreshCw } from "lucide-react";
import type { ReportLogDayPunches } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

/** "08:31:40" -> "08:31" with the seconds apart (they tell two quick punches apart). */
function splitTime(time: string): { hm: string; s: string | null } {
  const [h = "", m = "", s] = time.split(":");
  return { hm: `${h}:${m}`, s: s && s !== "00" ? s : null };
}

/**
 * Every punch of one employee's day, in the register's day card (owner 2026-11-16: "all the punches recorded by that
 * employee for the selected day, including the total number of punches and the individual punch timings"). Asked from
 * the server when the card opens (the month grid carries only the first and last punch); numbered, IN / OUT by order,
 * where each came from, and a night shift's after-midnight punch marked "next day". The card asks for them
 * (useReportLogDayPunches, the register's own address) and hands the answer in.
 */
export default function DayPunches({ query }: { query: UseQueryResult<ReportLogDayPunches> }) {
  const punches = query.data?.punches ?? [];

  return (
    <div className="border-t border-gray-100 sm:border-t-0" data-testid="day-punches">
      <div className="flex items-center justify-between gap-3 px-3 pt-2 pb-1">
        <span className="flex items-center gap-1.5 text-[11px] font-bold text-gray-700">
          <Fingerprint size={12} className="text-gray-400" aria-hidden />
          Punches
        </span>
        {query.data && (
          <span
            className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-bold tabular-nums text-slate-700"
            data-testid="day-punches-count"
          >
            {query.data.count} {query.data.count === 1 ? "punch" : "punches"}
          </span>
        )}
      </div>
      <div className="px-3 pb-2.5">
        {query.isPending ? (
          <p className="py-1 text-[11px] text-gray-400" data-testid="day-punches-loading">
            Loading the punches…
          </p>
        ) : query.isError ? (
          <p className="flex items-center gap-2 py-1 text-[11px] text-red-600" data-testid="day-punches-error">
            The punches could not be loaded.
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="inline-flex items-center gap-1 font-semibold text-sky-700 hover:underline"
            >
              <RefreshCw size={11} aria-hidden /> Try again
            </button>
          </p>
        ) : punches.length === 0 ? (
          <p className="py-1 text-[11px] text-gray-400" data-testid="day-punches-empty">
            No punch was recorded on this day.
          </p>
        ) : (
          <ol className="max-h-56 space-y-0.5 overflow-y-auto pr-0.5" data-testid="day-punches-list">
            {punches.map((p, i) => {
              const t = splitTime(p.time);
              return (
                <li
                  key={`${p.time}-${i}`}
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[11px] odd:bg-slate-50"
                  data-testid={`day-punch-${i}`}
                >
                  <span className="w-4 shrink-0 text-right tabular-nums text-gray-400">{i + 1}</span>
                  <span
                    className={cn(
                      "w-9 shrink-0 rounded px-1 py-px text-center text-[9px] font-bold",
                      p.type === "IN" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700",
                    )}
                  >
                    {p.type}
                  </span>
                  <span className="font-semibold tabular-nums text-gray-900">
                    {t.hm}
                    {t.s && <span className="text-[10px] font-normal text-gray-400">:{t.s}</span>}
                  </span>
                  {p.nextDay && (
                    <span className="inline-flex items-center gap-0.5 text-[9px] font-semibold text-indigo-600">
                      <Moon size={9} aria-hidden /> next day
                    </span>
                  )}
                  <span className="ml-auto truncate text-[10px] text-gray-400" title={p.sourceLabel}>
                    {p.sourceLabel}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
