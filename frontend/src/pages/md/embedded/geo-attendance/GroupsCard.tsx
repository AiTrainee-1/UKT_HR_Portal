import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { DeltaChip } from "@/components/md/kit/StatCard";
import { num, pct } from "@/lib/md/format";
import { deltaChip, participationText } from "./logic";
import { QueryError, SmallSample, refreshingClass } from "./parts";
import type { GeoBreakdown, GeoGroupRow } from "./types";

function LabelCell({ row }: { row: GeoGroupRow }) {
  const detail = participationText(row);
  return (
    <div className="min-w-[8rem]">
      <p className="font-semibold text-md-ink">
        {row.label}
        {row.lowSample && row.sessions > 0 && <SmallSample />}
      </p>
      {detail && <p className="text-[11px] text-md-ink-soft">{detail}</p>}
    </div>
  );
}

function SessionsCell({ row }: { row: GeoGroupRow }) {
  const chip = deltaChip(row.change.sessions, "pct", "none");
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-bold tabular-nums text-md-ink">{num(row.sessions)}</span>
      {row.shareOfSessionsPct != null && (
        <span className="text-[11px] text-md-ink-soft">{pct(row.shareOfSessionsPct, 0)} of all</span>
      )}
      {chip && <DeltaChip {...chip} />}
    </div>
  );
}

const COLUMNS: Column<GeoGroupRow>[] = [
  { key: "label", header: "Group", sortValue: (r) => r.label.toLowerCase(), cell: (r) => <LabelCell row={r} /> },
  {
    key: "sessions",
    header: "Sessions",
    align: "right",
    sortValue: (r) => r.sessions,
    cell: (r) => <SessionsCell row={r} />,
  },
  { key: "people", header: "People", align: "right", sortValue: (r) => r.people, cell: (r) => num(r.people) },
  { key: "punches", header: "Punches", align: "right", sortValue: (r) => r.punches, cell: (r) => num(r.punches) },
  {
    key: "rejected",
    header: "Rejected",
    align: "right",
    sortValue: (r) => r.rejectedSessions + r.rejectedPunches,
    cell: (r) => (r.rejectedSessions + r.rejectedPunches === 0 ? "—" : num(r.rejectedSessions + r.rejectedPunches)),
  },
  {
    key: "flags",
    header: "Simulated / far",
    align: "right",
    sortValue: (r) => r.mockedPunches + r.farPunches,
    cell: (r) => (r.mockedPunches + r.farPunches === 0 ? "—" : `${num(r.mockedPunches)} / ${num(r.farPunches)}`),
  },
];

/** Who goes out, by department, unit or staff-vs-production: sessions with their share of all and their change against
 *  the previous period, how many people and what share of the group went out, rejections and unusual punches. A click on a
 *  row narrows the whole tab to that group (`onFocus`). */
export default function GroupsCard({
  query,
  ask,
  tabs,
  nameHeader,
  onFocus,
}: {
  query: UseQueryResult<GeoBreakdown>;
  ask: string;
  tabs: ReactNode;
  nameHeader: string;
  onFocus?: (row: GeoGroupRow) => void;
}) {
  const data = query.data;
  const columns = COLUMNS.map((c) => (c.key === "label" ? { ...c, header: nameHeader } : c));
  return (
    <SectionCard
      title="Who goes out"
      subtitle="Ranked by on-duty sessions, against the previous period"
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-groups"
    >
      <div className="mb-4" data-testid="md-geo-group-tabs">
        {tabs}
      </div>
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <>
          {data.average.sessions > 0 && (
            <p className="mb-3 text-xs text-md-ink-soft">
              Overall: {num(data.average.sessions)} sessions by {num(data.average.people)} people
              {data.average.participationPct != null ? ` (${pct(data.average.participationPct, 0)} of employees)` : ""}
              {data.average.sessionsPerPerson != null ? `, ${num(data.average.sessionsPerPerson, 1)} each` : ""}.
            </p>
          )}
          <DataTable
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.key}
            initialSort={{ key: "sessions", dir: "desc" }}
            pageSize={6}
            empty="Nobody went on duty in this period, so there is nothing to compare."
            onRowClick={onFocus}
            testId="md-geo-groups-table"
          />
          {onFocus && data.rows.length > 0 && (
            <p className="md-analytics-note">Click a row to focus the whole tab on it.</p>
          )}
          {data.truncated && (
            <p className="md-analytics-note">
              Showing the {num(data.rows.length)} biggest of {num(data.total)}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
