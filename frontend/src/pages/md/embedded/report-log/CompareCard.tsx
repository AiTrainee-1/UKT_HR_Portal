import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { dayShort } from "@/lib/md/format";
import { compareRows } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { RlSummary } from "./types";

/** This period against the previous one, figure by figure, so the MD sees at once what moved and which way is good news. */
export default function CompareCard({ query, ask }: { query: UseQueryResult<RlSummary>; ask: string }) {
  const summary = query.data;
  return (
    <SectionCard
      title="This period against the previous"
      subtitle={
        summary
          ? `${summary.period?.label ?? "This period"} against ${dayShort(summary.previousPeriod.start)} to ${dayShort(summary.previousPeriod.end)}`
          : undefined
      }
      loading={query.isPending}
      provenance={summary?.provenance}
      provenanceIds={["reportlog-previous", "reportlog-followup", "reportlog-exports"]}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-compare-card"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : summary ? (
        <div className="overflow-x-auto">
          <table className="md-analytics-table">
            <thead>
              <tr>
                <th>Figure</th>
                <th className="md-analytics-num">This period</th>
                <th className="md-analytics-num">Previous</th>
                <th className="md-analytics-num">Change</th>
              </tr>
            </thead>
            <tbody>
              {compareRows(summary).map((row) => (
                <tr key={row.id} data-testid={`md-reportlog-compare-${row.id}`}>
                  <td className="text-md-ink">{row.label}</td>
                  <td className="md-analytics-num font-bold text-md-ink">{row.current}</td>
                  <td className="md-analytics-num text-md-ink-soft">{row.previous}</td>
                  <td className="md-analytics-num">{row.delta ? <DeltaChip {...row.delta} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SectionCard>
  );
}
