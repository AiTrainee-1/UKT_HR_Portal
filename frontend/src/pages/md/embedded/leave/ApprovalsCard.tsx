import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import { QueryError, refreshingClass } from "./cards";
import { daysText } from "./logic";
import type { Drill, LvApprovals } from "./types";

/** What became of the leave requests of the period: the reasons approvers gave for rejecting (required since 21 Nov
 *  2026), the rejection rate by the reason employees picked, and what still waits. Each part opens its requests. */
export default function ApprovalsCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<LvApprovals>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const c = data?.cohort;
  const reasons = data?.rejectReasons;
  return (
    <SectionCard
      title="Approvals"
      subtitle="The leave requests applied for in the period, why some were rejected, and what still waits"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-leave-approvals"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && c && (c.applied > 0 || data.pending.count > 0) ? (
        <div className="space-y-4">
          <p className="text-[13px] text-md-ink" data-testid="md-leave-approvals-line">
            <b>{num(c.applied)}</b> applied: {num(c.approved)} approved, {num(c.rejected)} rejected
            {c.rejectionPct != null ? ` (${pct(c.rejectionPct)})` : ""}, {num(c.pending)} still waiting.
            {data.decisionTime.medianHours != null
              ? ` A typical decision took ${num(data.decisionTime.medianHours, 1)} hours.`
              : ""}
          </p>
          {reasons && reasons.rows.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Reasons for rejecting</h4>
              <BarList
                testId="md-leave-reject-reasons"
                items={reasons.rows.map((r) => ({
                  key: r.key,
                  label: `"${r.reason}"`,
                  value: r.count,
                  color: CHART.bad,
                  sub: `${pct(r.sharePct)} of the reasons`,
                }))}
                format={(v) => num(v)}
                onSelect={() =>
                  onDrill({ title: "Rejected leave requests", params: { what: "requests", status: "rejected" } })
                }
              />
              {reasons.withoutReason > 0 && (
                <p className="md-analytics-note">
                  {num(reasons.withoutReason)} rejected before reasons were required carry none.
                </p>
              )}
            </div>
          )}
          {data.rejectionByReason.some((r) => r.applied > 0) && (
            <div>
              <h4 className="md-analytics-subhead">By the reason employees picked</h4>
              <BarList
                testId="md-leave-reason-picked"
                items={data.rejectionByReason.map((r) => ({
                  key: r.label,
                  label: r.label,
                  value: r.applied,
                  color: CHART.leave,
                  sub: `${num(r.rejected)} rejected${r.rejectionPct != null ? ` (${pct(r.rejectionPct)})` : ""}`,
                }))}
                format={(v) => num(v)}
              />
            </div>
          )}
          {data.pending.count > 0 && (
            <button
              type="button"
              className="md-btn inline-flex h-9 items-center rounded-lg px-3 text-xs font-semibold"
              onClick={() =>
                onDrill({
                  title: "Leave requests waiting",
                  subtitle: "Oldest first, whatever date they are for",
                  params: { what: "requests", status: "pending" },
                })
              }
              data-testid="md-leave-approvals-waiting"
            >
              {num(data.pending.count)} waiting now · oldest {daysText(data.pending.oldestDays)}
            </button>
          )}
        </div>
      ) : data ? (
        <EmptyBlock title="No leave requests in this period" testId="md-leave-approvals-empty">
          Nobody applied for leave in this period and nothing is waiting.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
