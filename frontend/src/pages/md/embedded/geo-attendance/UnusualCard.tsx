import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { dayShort, num } from "@/lib/md/format";
import { cn } from "@/lib/utils";
import { REASON_STYLE, SEVERITY_BAR } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { GeoUnusual } from "./types";

/** The sessions that look unusual, each with the reasons (simulated GPS, far from the unit, odd hours, open too long, a
 *  rejected punch), worst first, and the people with repeated rejections. A reason to look, not a finding. */
export default function UnusualCard({ query, ask }: { query: UseQueryResult<GeoUnusual>; ask: string }) {
  const data = query.data;
  const nothing = data ? data.rows.length === 0 && data.repeatRejected.length === 0 : false;
  return (
    <SectionCard
      title="Sessions that look unusual"
      subtitle={
        data
          ? `${num(data.counts.sessionsFlagged)} ${data.counts.sessionsFlagged === 1 ? "session" : "sessions"} flagged · a reason to look, not proof of anything`
          : "A reason to look, not proof of anything"
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-unusual"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && !nothing ? (
        <div className="space-y-4">
          {data.rows.length > 0 && (
            <ul className="space-y-2" data-testid="md-geo-unusual-list">
              {data.rows.map((row) => (
                <li
                  key={row.sessionId}
                  className={cn("md-analytics-row md-analytics-row-accent", SEVERITY_BAR[row.severity])}
                  data-testid={`md-geo-unusual-${row.sessionId}`}
                  data-severity={row.severity}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-x-2">
                    <p className="text-sm font-bold text-md-ink">{row.employeeName}</p>
                    <p className="text-xs text-md-ink-soft">
                      {[row.employeeCode, row.department, row.unit].filter(Boolean).join(" · ")}
                      {row.date ? ` · ${dayShort(row.date)}` : ""}
                    </p>
                  </div>
                  {row.destination && <p className="mt-1 text-[13px] text-md-ink">To {row.destination}</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {row.reasons.map((r) => (
                      <span key={r.code} className={cn("md-chip md-analytics-chip-sm", REASON_STYLE[r.code])}>
                        {r.label}
                      </span>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {data.truncated && (
            <p className="md-analytics-note">
              Showing the {num(data.rows.length)} most serious of {num(data.counts.sessionsFlagged)}.
            </p>
          )}
          {data.repeatRejected.length > 0 && (
            <div data-testid="md-geo-repeat-rejected">
              <p className="md-analytics-subhead">
                Repeated rejections ({data.thresholds.repeatMinRejections}+ in the period)
              </p>
              <ul className="space-y-2">
                {data.repeatRejected.map((r) => (
                  <li
                    key={r.employeeCode}
                    className="md-analytics-row md-analytics-tone-mauve flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 md-analytics-row-compact text-xs"
                  >
                    <span className="font-semibold text-md-ink">
                      {r.employeeName}{" "}
                      <span className="font-normal text-md-ink-soft">
                        {[r.employeeCode, r.department].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="font-medium text-md-mauve-700">
                      {num(r.rejectedSessions)} {r.rejectedSessions === 1 ? "request" : "requests"} and{" "}
                      {num(r.rejectedPunches)} {r.rejectedPunches === 1 ? "punch" : "punches"} rejected
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : data ? (
        <EmptyBlock title="Nothing unusual found" testId="md-geo-unusual-empty">
          No simulated locations, far or odd-hour punches, sessions left open or repeated rejections in this period.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
