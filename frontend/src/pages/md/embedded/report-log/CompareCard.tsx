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
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                <th className="py-1.5 pr-3 font-bold">Figure</th>
                <th className="px-3 py-1.5 text-right font-bold">This period</th>
                <th className="px-3 py-1.5 text-right font-bold">Previous</th>
                <th className="py-1.5 pl-3 text-right font-bold">Change</th>
              </tr>
            </thead>
            <tbody>
              {compareRows(summary).map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-[#006496]/10"
                  data-testid={`md-reportlog-compare-${row.id}`}
                >
                  <td className="py-2 pr-3 text-[#1a3a4a]">{row.label}</td>
                  <td className="px-3 py-2 text-right font-bold tabular-nums text-[#1a3a4a]">{row.current}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-[#006496]/70">{row.previous}</td>
                  <td className="py-2 pl-3 text-right">{row.delta ? <DeltaChip {...row.delta} /> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </SectionCard>
  );
}
