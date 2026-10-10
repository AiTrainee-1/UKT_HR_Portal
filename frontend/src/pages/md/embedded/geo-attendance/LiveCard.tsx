import type { UseQueryResult } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { clockText, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { isSilent, liveChips, liveStatus, minutesOutText, signalText } from "./logic";
import { QueryError } from "./parts";
import type { GeoLive, LiveRow } from "./types";

const CHIP_TONE = {
  blue: "bg-blue-50 text-blue-800",
  red: "bg-red-50 text-red-800",
  amber: "bg-amber-50 text-amber-800",
  slate: "bg-slate-100 text-slate-700",
} as const;

const STATUS_TONE = {
  good: "bg-green-100 text-green-800",
  warn: "bg-amber-100 text-amber-800",
  bad: "bg-red-100 text-red-800",
} as const;

function PersonRow({ row, silentMinutes }: { row: LiveRow; silentMinutes: number }) {
  const status = liveStatus(row);
  const silent = isSilent(row, silentMinutes);
  return (
    <li
      className="rounded-xl border border-[#006496]/10 bg-white p-3"
      data-testid={`md-geo-live-${row.employeeCode}`}
      data-stale={row.stale}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-bold text-gray-900">{row.employeeName}</p>
          <p className="text-[11px] text-[#006496]/60">
            {[row.employeeCode, row.department, row.unit].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-[10.5px] font-bold", STATUS_TONE[status.tone])}>
          {status.label}
        </span>
      </div>
      {row.destination && <p className="mt-1 text-xs text-gray-700">To {row.destination}</p>}
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-[#006496]/70">
        <span>
          Out {minutesOutText(row.minutesOut)}
          {row.since ? ` since ${clockText(row.since)}` : ""}
        </span>
        <span>
          {num(row.punchesToday)} {row.punchesToday === 1 ? "punch" : "punches"} today
          {row.lastPunch ? ` (last ${row.lastPunch})` : ""}
        </span>
        <span className={cn(silent && "font-semibold text-red-700")}>Phone: {signalText(row)}</span>
        {row.mockedPunches > 0 && <span className="font-semibold text-red-700">Simulated GPS punch today</span>}
      </p>
    </li>
  );
}

/** The live picture, with no map: who is out right now, how long, whether the request is approved yet, their punches so
 *  far today and when their phone last reported a location. Refreshes by itself every minute. */
export default function LiveCard({ query, ask }: { query: UseQueryResult<GeoLive>; ask: string }) {
  const live = query.data;
  return (
    <SectionCard
      title={
        <span className="inline-flex items-center gap-1.5">
          <Radio size={14} className="text-green-600" /> Who is on duty now
        </span>
      }
      subtitle={
        live ? `As of ${clockText(live.asOf)} · refreshes every minute · for the chosen unit and type` : undefined
      }
      loading={query.isPending}
      provenance={live?.provenance}
      actions={<AskAiButton question={ask} />}
      testId="md-geo-live"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : live && live.rows.length > 0 ? (
        <>
          <div className="mb-3 flex flex-wrap gap-2" data-testid="md-geo-live-chips">
            {liveChips(live).map((c) => (
              <span
                key={c.id}
                className={cn("rounded-full px-2.5 py-1 text-[11px] font-semibold", CHIP_TONE[c.tone])}
                data-testid={`md-geo-live-chip-${c.id}`}
              >
                {c.label}: <b>{num(c.value)}</b>
              </span>
            ))}
            {live.outPct != null && (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700">
                {pct(live.outPct, 0)} of {num(live.activeHeadcount)} employees out
              </span>
            )}
          </div>
          <ul className="grid grid-cols-1 gap-2 @3xl:grid-cols-2">
            {live.rows.map((row) => (
              <PersonRow key={`${row.employeeCode}-${row.since}`} row={row} silentMinutes={live.silentMinutes} />
            ))}
          </ul>
          {live.truncated && (
            <p className="mt-2 text-[11px] text-[#006496]/55">
              Showing the first {num(live.rows.length)} of {num(live.total)} open sessions.
            </p>
          )}
        </>
      ) : live ? (
        <EmptyBlock title="Nobody is on duty right now" testId="md-geo-live-empty">
          No on-duty session is open for this selection.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
