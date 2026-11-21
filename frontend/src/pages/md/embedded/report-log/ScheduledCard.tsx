import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayLong, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { DetailList, DetailRow } from "../shared/DetailSheet";
import { QueryError, refreshingClass } from "./parts";
import { channelText, nothingScheduled, scheduledFigures } from "./scheduled-logic";
import type { RlScheduled } from "./types";

const TONE = { bad: "md-analytics-tone-bad", good: "md-analytics-tone-good" } as const;

/**
 * The attendance reports HR scheduled in Attendance Notify (2026-11-17): how many went out, to how many recipients, by
 * WhatsApp, Gmail or Chat, and the runs that did not reach everyone with the reason the server recorded. This is the one
 * place where "was the report sent?" has an answer.
 */
export default function ScheduledCard({ query, ask }: { query: UseQueryResult<RlScheduled>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="Scheduled attendance reports"
      subtitle="Reports HR set to go out by WhatsApp, Gmail or Chat (Attendance Notify), and whether they reached everyone"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-scheduled"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && nothingScheduled(data) ? (
        <EmptyBlock title="No report is scheduled" testId="md-reportlog-scheduled-empty">
          HR has not set up an automatic attendance report yet (Attendance Notify), so nothing is sent on a schedule.
        </EmptyBlock>
      ) : data ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 @3xl:grid-cols-4" data-testid="md-reportlog-scheduled-figures">
            {scheduledFigures(data).map((f) => (
              <div
                key={f.id}
                className={cn("md-analytics-stat", f.tone && TONE[f.tone])}
                data-testid={`md-reportlog-scheduled-${f.id}`}
              >
                <p className="md-analytics-stat-value">{f.value}</p>
                <p className="md-analytics-stat-label">{f.label}</p>
                <p className="mt-0.5 text-[11px] text-md-ink-soft">{f.sub}</p>
              </div>
            ))}
          </div>
          <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-2">
            <div>
              <h4 className="md-analytics-subhead">
                By channel · {num(data.automations.active)} of {num(data.automations.total)} automations on
              </h4>
              {data.byChannel.length === 0 ? (
                <p className="md-analytics-note">Nothing went out in this period.</p>
              ) : (
                <DetailList testId="md-reportlog-scheduled-channels">
                  {data.byChannel.map((c) => (
                    <DetailRow
                      key={c.channel}
                      primary={c.label}
                      secondary={channelText(c)}
                      value={num(c.sent + c.queued)}
                    />
                  ))}
                </DetailList>
              )}
            </div>
            <div>
              <h4 className="md-analytics-subhead">Did not reach everyone</h4>
              {data.failures.length === 0 ? (
                <p className="md-analytics-note" data-testid="md-reportlog-scheduled-no-failures">
                  Every report in this period reached all its recipients.
                </p>
              ) : (
                <DetailList testId="md-reportlog-scheduled-failures">
                  {data.failures.map((f) => (
                    <DetailRow
                      key={f.id}
                      testId={`md-reportlog-failure-${f.id}`}
                      primary={`${f.automation} · ${dayLong(f.date)}${f.slot ? ` ${f.slot}` : ""}`}
                      secondary={f.error || `${num(f.failedDeliveries)} recipients not reached`}
                      value={f.status === "partial" ? "Partly sent" : "Failed"}
                      tone="md-analytics-tone-bad"
                    />
                  ))}
                </DetailList>
              )}
            </div>
          </div>
          {data.lastRun && (
            <p className="md-analytics-note" data-testid="md-reportlog-scheduled-last">
              Last run: {data.lastRun.automation} ({data.lastRun.channel}) on {dayLong(data.lastRun.date)}
              {data.lastRun.slot ? ` at ${data.lastRun.slot}` : ""}, {data.lastRun.status}.
            </p>
          )}
        </div>
      ) : null}
    </SectionCard>
  );
}
