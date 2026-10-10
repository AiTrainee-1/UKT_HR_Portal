import type { UseQueryResult } from "@tanstack/react-query";
import { Clock, Fingerprint, Radio, Smartphone } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { clockText, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { isSilent, liveChips, liveStatus, minutesOutText, signalText } from "./logic";
import { QueryError } from "./parts";
import type { GeoLive, LiveRow } from "./types";

/** The tone of each count chip above the list (see md-theme/areas/analytics.css): who is out is information, a session left
 *  open is bad, one awaiting approval is to watch, and no signal is just a fact. */
const CHIP_TONE = {
  blue: "md-analytics-tone-info",
  red: "md-analytics-tone-bad",
  amber: "md-analytics-tone-watch",
  slate: "md-analytics-tone-neutral",
} as const;

/** The request's state, as a glass chip (the word says it; the colour agrees). */
const STATUS_CHIP = {
  good: "md-chip md-chip-success",
  warn: "md-chip md-chip-warning",
  bad: "md-chip md-chip-danger",
} as const;

/** A row only gets an accent bar when something needs a look. */
const STATUS_ACCENT = {
  good: "",
  warn: "md-analytics-row-accent md-analytics-tone-watch",
  bad: "md-analytics-row-accent md-analytics-tone-bad",
} as const;

function PersonRow({ row, silentMinutes }: { row: LiveRow; silentMinutes: number }) {
  const status = liveStatus(row);
  const silent = isSilent(row, silentMinutes);
  return (
    <li
      className={cn("md-analytics-row", STATUS_ACCENT[status.tone])}
      data-testid={`md-geo-live-${row.employeeCode}`}
      data-stale={row.stale}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-md-ink">{row.employeeName}</p>
          <p className="text-xs text-md-ink-soft">
            {[row.employeeCode, row.department, row.unit].filter(Boolean).join(" · ")}
          </p>
        </div>
        <span className={STATUS_CHIP[status.tone]}>{status.label}</span>
      </div>
      {row.destination && <p className="mt-1.5 text-[13px] text-md-ink">To {row.destination}</p>}
      <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-md-ink-soft">
        <span className="inline-flex items-center gap-1.5">
          <Clock size={12} aria-hidden="true" />
          <span>
            Out {minutesOutText(row.minutesOut)}
            {row.since ? ` since ${clockText(row.since)}` : ""}
          </span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Fingerprint size={12} aria-hidden="true" />
          <span>
            {num(row.punchesToday)} {row.punchesToday === 1 ? "punch" : "punches"} today
            {row.lastPunch ? ` (last ${row.lastPunch})` : ""}
          </span>
        </span>
        <span className={cn("inline-flex items-center gap-1.5", silent && "font-semibold text-md-danger")}>
          <Smartphone size={12} aria-hidden="true" />
          <span>Phone: {signalText(row)}</span>
        </span>
        {row.mockedPunches > 0 && <span className="font-semibold text-md-danger">Simulated GPS punch today</span>}
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
        <span className="inline-flex items-center gap-2">
          <Radio size={14} className="text-md-success" /> Who is on duty now
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
          <div className="mb-4 flex flex-wrap gap-2" data-testid="md-geo-live-chips">
            {liveChips(live).map((c) => (
              <span key={c.id} className={cn("md-chip", CHIP_TONE[c.tone])} data-testid={`md-geo-live-chip-${c.id}`}>
                {c.label}: <b>{num(c.value)}</b>
              </span>
            ))}
            {live.outPct != null && (
              <span className="md-chip md-analytics-tone-neutral">
                {pct(live.outPct, 0)} of {num(live.activeHeadcount)} employees out
              </span>
            )}
          </div>
          <ul className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            {live.rows.map((row) => (
              <PersonRow key={`${row.employeeCode}-${row.since}`} row={row} silentMinutes={live.silentMinutes} />
            ))}
          </ul>
          {live.truncated && (
            <p className="md-analytics-note">
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
