import type { UseQueryResult } from "@tanstack/react-query";
import { Clock, Fingerprint, Radio, Smartphone } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { clockText, num, pct } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { isSilent, liveChips, liveStatus, minutesOutText, signalText } from "./logic";
import { trackLine, trackStateTone } from "./tracking-logic";
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

const TRACK_TONE = {
  good: "text-md-success",
  warn: "text-md-warning-600",
  bad: "font-semibold text-md-danger",
} as const;

function PersonRow({
  row,
  silentMinutes,
  onPerson,
}: {
  row: LiveRow;
  silentMinutes: number;
  onPerson?: (employeeId: number) => void;
}) {
  const status = liveStatus(row);
  const silent = row.trackState ? trackStateTone(row.trackState) === "bad" : isSilent(row, silentMinutes);
  const tracking = trackLine(row);
  const trackTone = trackStateTone(row.trackState);
  return (
    <li
      className={cn("md-analytics-row", STATUS_ACCENT[status.tone])}
      data-testid={`md-geo-live-${row.employeeCode}`}
      data-stale={row.stale}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {onPerson && row.employeeId != null ? (
            <button
              type="button"
              className="truncate text-left text-sm font-bold text-md-ink underline decoration-md-line underline-offset-2 hover:decoration-md-wine"
              onClick={() => onPerson(row.employeeId as number)}
              data-testid={`md-geo-live-open-${row.employeeCode}`}
            >
              {row.employeeName}
            </button>
          ) : (
            <p className="truncate text-sm font-bold text-md-ink">{row.employeeName}</p>
          )}
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
      {tracking && trackTone && (
        <p
          className={cn("mt-1.5 text-xs", TRACK_TONE[trackTone])}
          data-testid={`md-geo-live-track-${row.employeeCode}`}
        >
          Tracking: {tracking}
        </p>
      )}
    </li>
  );
}

/** The live picture, with no map: who is out right now, how long, whether the request is approved yet, their punches so
 *  far today and when their phone last reported a location. Refreshes by itself every minute. */
export default function LiveCard({
  query,
  ask,
  onPerson,
}: {
  query: UseQueryResult<GeoLive>;
  ask: string;
  onPerson?: (employeeId: number) => void;
}) {
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
            {(live.openAlerts ?? 0) > 0 && (
              <span className="md-chip md-analytics-tone-bad" data-testid="md-geo-live-chip-alerts">
                Open alerts: <b>{num(live.openAlerts)}</b>
              </span>
            )}
            {live.outPct != null && (
              <span className="md-chip md-analytics-tone-neutral">
                {pct(live.outPct, 0)} of {num(live.activeHeadcount)} employees out
              </span>
            )}
          </div>
          <ul className="grid grid-cols-1 gap-3 @3xl:grid-cols-2">
            {live.rows.map((row) => (
              <PersonRow
                key={`${row.employeeCode}-${row.since}`}
                row={row}
                silentMinutes={live.silentMinutes}
                onPerson={onPerson}
              />
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
