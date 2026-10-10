import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { dayShort, num } from "@/lib/md/format";
import { QueryError, refreshingClass } from "./parts";
import type { GeoPeople, GeoPerson } from "./types";

const COLUMNS: Column<GeoPerson>[] = [
  {
    key: "name",
    header: "Employee",
    sortValue: (r) => r.employeeName.toLowerCase(),
    cell: (r) => (
      <div className="min-w-[8rem]">
        <p className="font-semibold text-[#1a3a4a]">
          {r.employeeName}
          {r.frequent && (
            <span className="ml-1.5 rounded-full bg-blue-100 px-1.5 py-0.5 align-middle text-[9.5px] font-semibold text-blue-800">
              frequent
            </span>
          )}
        </p>
        <p className="text-[11px] text-[#006496]/60">
          {[r.employeeCode, r.department, r.unit].filter(Boolean).join(" · ")}
        </p>
      </div>
    ),
  },
  { key: "sessions", header: "Sessions", align: "right", sortValue: (r) => r.sessions, cell: (r) => num(r.sessions) },
  { key: "days", header: "Days out", align: "right", sortValue: (r) => r.daysOut, cell: (r) => num(r.daysOut) },
  { key: "punches", header: "Punches", align: "right", sortValue: (r) => r.punches, cell: (r) => num(r.punches) },
  {
    key: "flags",
    header: "Rejected · simulated · far · odd",
    align: "right",
    sortValue: (r) => r.rejectedPunches + r.rejectedSessions + r.mockedPunches + r.farPunches + r.oddPunches,
    cell: (r) =>
      r.rejectedPunches + r.rejectedSessions + r.mockedPunches + r.farPunches + r.oddPunches === 0
        ? "—"
        : `${num(r.rejectedSessions + r.rejectedPunches)} · ${num(r.mockedPunches)} · ${num(r.farPunches)} · ${num(r.oddPunches)}`,
  },
  {
    key: "last",
    header: "Last",
    align: "right",
    sortValue: (r) => r.lastDate,
    cell: (r) => (r.lastDate ? dayShort(r.lastDate) : "—"),
  },
];

/** Who works outside the premises and how often: the people who went on duty most in the period, with their punches and
 *  anything unusual about them. Names are shown because the MD acts on this list. */
export default function PeopleCard({ query, ask }: { query: UseQueryResult<GeoPeople>; ask: string }) {
  const data = query.data;
  return (
    <SectionCard
      title="Who goes out most often"
      subtitle={
        data
          ? `${num(data.total)} ${data.total === 1 ? "person" : "people"} went on duty · ${num(data.frequent)} frequently (${data.frequentMin}+ sessions)`
          : "The people who went on duty most in the period"
      }
      loading={query.isPending}
      provenance={data?.provenance}
      actions={<AskAiButton question={ask} />}
      bodyClassName={refreshingClass(query)}
      testId="md-geo-people"
    >
      {query.isError ? (
        <QueryError query={query} />
      ) : data ? (
        <>
          <DataTable
            columns={COLUMNS}
            rows={data.rows}
            rowKey={(r) => r.employeeCode}
            initialSort={{ key: "sessions", dir: "desc" }}
            pageSize={6}
            empty="Nobody went on duty in this period."
            testId="md-geo-people-table"
          />
          {data.truncated && (
            <p className="mt-1 text-[11px] text-[#006496]/55">
              Showing the {num(data.rows.length)} who went out most, of {num(data.total)}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
