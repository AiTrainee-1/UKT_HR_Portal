import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import DonutChart from "@/components/md/kit/DonutChart";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import { ageBars, decisionLine, hoursText, statusSlices } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { GeoVerification } from "./types";

/** Is it being verified, and how fast? Every on-duty punch waits for HR: the donut says where this period's punches stand,
 *  the bars what is waiting right now (whenever it was taken) and for how long. */
export default function VerificationCard({ query, ask }: { query: UseQueryResult<GeoVerification>; ask: string }) {
  const v = query.data;
  const nothing = v ? v.punches.captured === 0 && v.sessions.requested === 0 && v.backlog.pendingPunches === 0 : false;
  const line = v ? decisionLine(v) : null;
  const awaiting = v ? v.sessions.awaitingHod + v.sessions.awaitingHr : 0;
  return (
    <SectionCard
      title="Is it being verified?"
      subtitle="Every on-duty punch is held until HR approves it: where this period's punches stand, and what waits now"
      loading={query.isPending}
      provenance={v?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-verification"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : v && !nothing ? (
        <div className="grid grid-cols-1 gap-6 @2xl:grid-cols-2">
          <div data-testid="md-geo-status">
            <p className="md-analytics-subhead">Punches in this period</p>
            {v.punches.captured > 0 ? (
              <DonutChart
                data={statusSlices(v)}
                format={(n) => num(n)}
                testId="md-geo-status-donut"
                center={
                  <>
                    <span className="text-2xl font-black tabular-nums text-md-ink">{pct(v.verifiedPct, 0)}</span>
                    <span className="text-[11px] font-semibold text-md-ink-soft">verified</span>
                  </>
                }
              />
            ) : (
              <p className="py-6 text-sm text-muted-foreground">No on-duty punches were taken in this period.</p>
            )}
            {line && (
              <p className="md-analytics-note" data-testid="md-geo-decision-line">
                {line}
              </p>
            )}
            <p className="md-analytics-note" data-testid="md-geo-request-line">
              Requests: {num(v.sessions.requested)} made · {num(v.sessions.approved)} approved
              {awaiting > 0 ? ` · ${num(awaiting)} awaiting approval` : ""}
              {v.sessions.rejected > 0 ? ` · ${num(v.sessions.rejected)} rejected` : ""}
              {v.decisionTime.requests.medianHours != null
                ? ` · decided in ${hoursText(v.decisionTime.requests.medianHours)} (median)`
                : ""}
              .
            </p>
          </div>
          <div data-testid="md-geo-backlog">
            <p className="md-analytics-subhead">
              Waiting for HR now ({num(v.backlog.pendingPunches)} punches, {num(v.backlog.pendingSessions)} requests)
            </p>
            {v.backlog.pendingPunches + v.backlog.pendingSessions > 0 ? (
              <BarList items={ageBars(v.backlog)} testId="md-geo-age-bars" />
            ) : (
              <p className="py-6 text-sm text-muted-foreground">Nothing is waiting for HR.</p>
            )}
            {v.backlog.overduePunches + v.backlog.overdueSessions > 0 && (
              <p className="md-analytics-callout md-analytics-tone-watch">
                {num(v.backlog.overduePunches)} punches and {num(v.backlog.overdueSessions)} requests have waited more
                than {Math.round(v.backlog.overdueHours / 24)} days; the oldest punch{" "}
                {hoursText(v.backlog.oldestPunchHours)}.
              </p>
            )}
          </div>
        </div>
      ) : v ? (
        <EmptyBlock title="Nothing to verify in this period" testId="md-geo-verification-empty">
          There are no on-duty punches or requests for this selection.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
