import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import BarList from "@/components/md/kit/BarList";
import SectionCard from "@/components/md/kit/SectionCard";
import { CHART } from "@/components/md/kit/chartTheme";
import { EmptyBlock } from "@/components/md/kit/states";
import { num, pct } from "@/lib/md/format";
import { QueryError, refreshingClass } from "./cards";
import type { Drill, RqRejections } from "./types";

/** Why requests are rejected (a reason is required since 21 Nov 2026): the reasons approvers gave, most common first, and
 *  the rejections by kind. A reason or a kind opens the rejected requests behind it. */
export default function RejectionsCard({
  query,
  ask,
  onDrill,
}: {
  query: UseQueryResult<RqRejections>;
  ask: string;
  onDrill: (d: Drill) => void;
}) {
  const data = query.data;
  const n = data?.rejected.value ?? 0;
  return (
    <SectionCard
      title="Why requests are rejected"
      subtitle="The reasons approvers gave in the period (a reason is required for every rejection since 21 Nov 2026)"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-requests-rejections"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data && n > 0 ? (
        <div className="space-y-5">
          <p className="text-[13px] text-md-ink" data-testid="md-requests-rejections-line">
            <b>{num(n)}</b> rejected ({num(data.rejected.previous)} in the period before); {num(data.withReason)} with a
            reason{data.withoutReason ? `, ${num(data.withoutReason)} from before reasons were required` : ""}.
          </p>
          {data.reasons.length > 0 && (
            <div>
              <h4 className="md-analytics-subhead">Reasons given</h4>
              <BarList
                testId="md-requests-reasons"
                items={data.reasons.map((r) => ({
                  key: r.key,
                  label: `"${r.reason}"`,
                  value: r.count,
                  color: CHART.bad,
                  sub: `${pct(r.sharePct)} of the reasons · ${r.kinds.map((k) => k.label).join(", ")}`,
                }))}
                format={(v) => num(v)}
                onSelect={(item) =>
                  onDrill({
                    title: `Rejected: ${String(item.label)}`,
                    subtitle: "The requests rejected for this reason",
                    params: { status: "rejected", reason: item.key },
                  })
                }
              />
            </div>
          )}
          <div>
            <h4 className="md-analytics-subhead">By kind</h4>
            <BarList
              testId="md-requests-rejected-kinds"
              items={data.byKind.map((k) => ({
                key: k.key,
                label: k.label,
                value: k.rejected,
                color: CHART.sky,
                sub: `${pct(k.rejectionPct)} of ${num(k.decided)} decided${k.lowSample ? " · small sample" : ""}`,
              }))}
              format={(v) => num(v)}
              onSelect={(item) =>
                onDrill({ title: `${String(item.label)}: rejected`, params: { status: "rejected", kind: item.key } })
              }
            />
          </div>
        </div>
      ) : data ? (
        <EmptyBlock title="Nothing was rejected" testId="md-requests-rejections-empty">
          No request was rejected in this period for this selection.
        </EmptyBlock>
      ) : null}
    </SectionCard>
  );
}
