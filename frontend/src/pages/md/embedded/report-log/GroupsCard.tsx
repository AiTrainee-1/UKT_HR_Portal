import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { num, pct } from "@/lib/md/format";
import { deltaChip, markShares } from "./logic";
import { QueryError, SmallSample, refreshingClass } from "./parts";
import type { RlBreakdown, RlGroupRow } from "./types";

/** One row's absences as a bar: green Informed, red Not informed, amber not yet marked. */
function MarksBar({ row }: { row: RlGroupRow }) {
  const s = markShares(row);
  return (
    <div className="min-w-[8rem]" data-testid={`md-reportlog-marks-${row.key}`}>
      <div className="flex h-2 overflow-hidden rounded-full bg-[#006496]/[0.07]">
        <i className="h-full bg-green-500" style={{ width: `${s.informed}%` }} />
        <i className="h-full bg-red-500" style={{ width: `${s.notInformed}%` }} />
        <i className="h-full bg-amber-400" style={{ width: `${s.unmarked}%` }} />
      </div>
      <p className="mt-0.5 text-[10.5px] text-[#006496]/60">
        {num(row.informed)} informed · {num(row.notInformed)} not · {num(row.unmarked)} unmarked
      </p>
    </div>
  );
}

function LabelCell({ row }: { row: RlGroupRow }) {
  return (
    <div className="min-w-[7rem]">
      <p className="font-semibold text-[#1a3a4a]">
        {row.label}
        {row.lowSample && <SmallSample />}
      </p>
      {row.headcount > 0 && (
        <p className="text-[11px] text-[#006496]/60">
          {num(row.headcount)} {row.headcount === 1 ? "employee" : "employees"}
        </p>
      )}
    </div>
  );
}

function AbsencesCell({ row }: { row: RlGroupRow }) {
  const chip = deltaChip(row.change.absences, "pct", "down");
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-bold tabular-nums text-[#1a3a4a]">{num(row.absences)}</span>
      {chip && <DeltaChip {...chip} />}
    </div>
  );
}

function FollowedCell({ row }: { row: RlGroupRow }) {
  if (row.reviewedPct == null) return <span className="text-muted-foreground">—</span>;
  const chip = deltaChip(row.change.reviewedPct, "pts", "up");
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-bold tabular-nums text-[#1a3a4a]">{pct(row.reviewedPct, 1)}</span>
      {chip && <DeltaChip {...chip} />}
    </div>
  );
}

const COLUMNS: Column<RlGroupRow>[] = [
  { key: "label", header: "Group", sortValue: (r) => r.label.toLowerCase(), cell: (r) => <LabelCell row={r} /> },
  {
    key: "absences",
    header: "Absences",
    align: "right",
    sortValue: (r) => r.absences,
    cell: (r) => <AbsencesCell row={r} />,
  },
  { key: "marks", header: "How they were marked", sortValue: (r) => r.unmarked, cell: (r) => <MarksBar row={r} /> },
  {
    key: "followed",
    header: "Followed up",
    align: "right",
    sortValue: (r) => r.reviewedPct,
    cell: (r) => <FollowedCell row={r} />,
  },
  {
    key: "notInformed",
    header: "Not informed",
    align: "right",
    sortValue: (r) => r.notInformed,
    cell: (r) => (r.notInformed === 0 ? "—" : num(r.notInformed)),
  },
];

/** Where absences are not followed up, by department, unit or staff-vs-production: each row's absences as a bar of how they
 *  were marked, the followed-up share with its change against the previous period, and the Not-informed count. Ranked by
 *  absences nobody has marked. A click on a row narrows the whole tab to that group (`onFocus`). */
export default function GroupsCard({
  query,
  ask,
  tabs,
  nameHeader,
  onFocus,
}: {
  query: UseQueryResult<RlBreakdown>;
  ask: string;
  tabs: ReactNode;
  nameHeader: string;
  onFocus?: (row: RlGroupRow) => void;
}) {
  const data = query.data;
  const columns = COLUMNS.map((c) => (c.key === "label" ? { ...c, header: nameHeader } : c));
  return (
    <SectionCard
      title="Where absences are not followed up"
      subtitle="Ranked by absences nobody has marked, against the previous period"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-reportlog-groups"
    >
      <div className="mb-3 overflow-x-auto" data-testid="md-reportlog-group-tabs">
        {tabs}
      </div>
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <>
          {data.average.absences > 0 && (
            <p className="mb-2 text-xs text-[#006496]/70">
              Overall: {num(data.average.absences)} absences, {pct(data.average.reviewedPct, 1)} followed up,{" "}
              {num(data.average.unmarked)} not yet marked.
            </p>
          )}
          <DataTable
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.key}
            initialSort={{ key: "marks", dir: "desc" }}
            pageSize={6}
            empty="No absences for this selection, so there is nothing to compare."
            onRowClick={onFocus}
            testId="md-reportlog-groups-table"
          />
          {onFocus && data.rows.length > 0 && (
            <p className="mt-2 text-[11px] text-[#006496]/55">Click a row to focus the whole tab on it.</p>
          )}
          {data.truncated && (
            <p className="mt-1 text-[11px] text-[#006496]/55">
              Showing the {num(data.rows.length)} with the most unmarked absences, of {num(data.total)}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
