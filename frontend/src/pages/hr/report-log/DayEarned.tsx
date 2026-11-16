import type { UseQueryResult } from "@tanstack/react-query";
import { Clock3, Layers, ScanSearch } from "lucide-react";
import type { ReportLogDayDetection, ReportLogDayPunches } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";

const TONE: Record<ReportLogDayDetection["tone"], string> = {
  bad: "border-red-200 bg-red-50 text-red-700",
  warn: "border-amber-200 bg-amber-50 text-amber-800",
  good: "border-emerald-200 bg-emerald-50 text-emerald-700",
  info: "border-slate-200 bg-slate-50 text-slate-700",
};

const METHOD: Record<string, string> = {
  production_rules: "Production shift table",
  production_legacy: "Old production calculation",
  staff: "Half-Day Detection",
  manual: "Set by HR",
};

/**
 * The left side of the register's day card (owner 2026-11-16: "Earned Shift breakdown ... on the left side of the punch
 * timings", "and also show detected shift and detections"): the shift the day was judged against, how the day's shift
 * credit was earned step by step (each worked pair and what it added on a production shift-table day; Full / Half day,
 * the quarter shift, a Penalty Early Out and any later adjustment for staff) adding up to the stored credit payroll reads,
 * and what the engine detected. All from the server (report_log_day_detail.py), in the same answer as the punches.
 */
export default function DayEarned({ query }: { query: UseQueryResult<ReportLogDayPunches> }) {
  const data = query.data;
  if (!data) {
    return (
      <div className="px-3 py-2.5 text-[11px] text-gray-400" data-testid="day-earned-loading">
        {query.isError ? "The breakdown could not be loaded." : "Working out the day…"}
      </div>
    );
  }
  const { shift, earned, detections } = data;
  return (
    <div className="space-y-3 px-3 py-2.5" data-testid="day-earned">
      {/* the shift the day was judged against */}
      <section>
        <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-gray-700">
          <Clock3 size={12} className="text-gray-400" aria-hidden />
          Detected shift
        </h4>
        {shift ? (
          <div className="rounded-md bg-slate-50 px-2 py-1.5 text-[11px]" data-testid="day-shift">
            <p className="font-semibold text-gray-900">{shift.name}</p>
            <p className="tabular-nums text-gray-500">
              {shift.start ?? "—"} – {shift.end ?? "—"}
              {shift.endNextDay ? " (next day)" : ""} · {shift.graceMinutes} min grace
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-gray-400" data-testid="day-shift">
            No shift for this day
          </p>
        )}
      </section>

      {/* how the credit was earned */}
      {earned && (
        <section>
          <h4 className="mb-1 flex items-center justify-between gap-2 text-[11px] font-bold text-gray-700">
            <span className="flex items-center gap-1.5">
              <Layers size={12} className="text-gray-400" aria-hidden />
              Earned shift
            </span>
            <span className="text-[10px] font-medium text-gray-400">{METHOD[earned.method] ?? earned.method}</span>
          </h4>
          <ol className="space-y-0.5 text-[11px]" data-testid="day-earned-steps">
            {earned.steps.map((s, i) => (
              <li key={i} className="flex items-start justify-between gap-3 rounded px-1.5 py-0.5 odd:bg-slate-50">
                <span className={cn("min-w-0", s.kind === "note" ? "text-gray-500 italic" : "text-gray-700")}>
                  {s.kind === "pair" && <span className="mr-1 text-gray-400">{s.pair}.</span>}
                  {s.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-semibold tabular-nums",
                    s.kind === "minus" ? "text-red-600" : s.kind === "plus" ? "text-emerald-700" : "text-gray-900",
                    s.kind === "note" && "font-normal text-gray-500",
                  )}
                >
                  {s.kind === "pair" ? `+${s.shifts}` : s.shifts}
                </span>
              </li>
            ))}
          </ol>
          <div
            className="mt-1 flex items-center justify-between border-t border-gray-100 px-1.5 pt-1 text-[11px]"
            data-testid="day-earned-total"
          >
            <span className="font-bold text-gray-700">Shift credit</span>
            <span className="font-black tabular-nums text-gray-900">{earned.total}</span>
          </div>
          {earned.note && (
            <p className="mt-1 text-[10px] leading-snug text-gray-500" data-testid="day-earned-note">
              {earned.note}
            </p>
          )}
        </section>
      )}

      {/* what the engine flagged */}
      <section>
        <h4 className="mb-1 flex items-center gap-1.5 text-[11px] font-bold text-gray-700">
          <ScanSearch size={12} className="text-gray-400" aria-hidden />
          Detections
        </h4>
        {detections && detections.length > 0 ? (
          <ul className="space-y-1" data-testid="day-detections">
            {detections.map((d) => (
              <li
                key={d.key}
                className={cn("rounded-md border px-2 py-1 text-[11px] leading-snug", TONE[d.tone])}
                data-testid={`day-detection-${d.key}`}
              >
                <span className="font-semibold">{d.label}</span>
                {d.detail && <span className="block text-[10px] opacity-80">{d.detail}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11px] text-gray-400" data-testid="day-detections-none">
            Nothing flagged: on time, no early out, no permission.
          </p>
        )}
      </section>
    </div>
  );
}
