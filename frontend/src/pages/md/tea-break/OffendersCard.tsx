import type { UseQueryResult } from "@tanstack/react-query";
import { PartyPopper } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock } from "@/components/md/kit/states";
import { minutesText, num, pct } from "@/lib/md/format";
import { offenderSub, worstCase } from "./logic";
import { QueryError, refreshingClass } from "./parts";
import type { TeaOffender, TeaOffenders } from "./types";

const COLUMNS: Column<TeaOffender>[] = [
  {
    key: "person",
    header: "Employee",
    sortValue: (r) => r.employeeName.toLowerCase(),
    cell: (r) => (
      <div className="min-w-[9rem]">
        <p className="font-semibold text-[#1a3a4a]">{r.employeeName}</p>
        <p className="text-[11px] text-[#006496]/60">{offenderSub(r)}</p>
      </div>
    ),
  },
  {
    key: "overruns",
    header: "Times over",
    align: "right",
    sortValue: (r) => r.overruns,
    cell: (r) => (
      <div className="flex flex-col items-end">
        <span className="font-bold tabular-nums text-[#1a3a4a]">{num(r.overruns)}</span>
        {r.overrunPct != null && (
          <span className="text-[11px] text-[#006496]/55">
            {pct(r.overrunPct, 0)} of {num(r.measured)} breaks
          </span>
        )}
      </div>
    ),
  },
  {
    key: "lost",
    header: "Minutes over",
    align: "right",
    sortValue: (r) => r.minutesLost,
    cell: (r) => (r.minutesLost == null ? "—" : minutesText(r.minutesLost)),
  },
  {
    key: "worst",
    header: "Worst case",
    align: "right",
    sortValue: (r) => r.worstMinutes,
    cell: (r) => (
      <div className="flex flex-col items-end">
        <span className="tabular-nums">{worstCase(r)}</span>
        {r.worstOverBy != null && <span className="text-[11px] text-[#006496]/55">{num(r.worstOverBy)} min over</span>}
      </div>
    ),
  },
];

/** People who overran again and again: how often, how much time, and their worst case. Names are shown because this
 *  is the list the MD acts on. */
export default function OffendersCard({ query, ask }: { query: UseQueryResult<TeaOffenders>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="Repeat overrunners"
      subtitle={data ? `People who ran over ${data.threshold} or more times in this period` : undefined}
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-tea-break-offenders"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        data.rows.length === 0 ? (
          <EmptyBlock icon={PartyPopper} title="No repeat overrunners" testId="md-tea-break-offenders-empty">
            Nobody ran over their break {data.threshold} or more times in this period
            {data.overrunners > 0
              ? `; ${num(data.overrunners)} ${data.overrunners === 1 ? "person ran" : "people ran"} over once or twice.`
              : "."}
          </EmptyBlock>
        ) : (
          <>
            {data.shareOfMinutesLostPct != null && (
              <p className="mb-2 text-xs text-[#006496]/70" data-testid="md-tea-break-offenders-share">
                {num(data.total)} {data.total === 1 ? "person accounts" : "people account"} for{" "}
                {pct(data.shareOfMinutesLostPct, 0)} of the minutes lost to overruns.
              </p>
            )}
            <DataTable
              columns={COLUMNS}
              rows={data.rows}
              rowKey={(r) => r.employeeCode}
              initialSort={{ key: "overruns", dir: "desc" }}
              pageSize={10}
              testId="md-tea-break-offenders-table"
            />
            {data.truncated && (
              <p className="mt-1 text-[11px] text-[#006496]/55">
                Showing the {num(data.rows.length)} worst of {num(data.total)}.
              </p>
            )}
          </>
        )
      ) : null}
    </SectionCard>
  );
}
