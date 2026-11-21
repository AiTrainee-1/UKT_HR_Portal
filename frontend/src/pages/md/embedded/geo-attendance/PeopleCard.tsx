import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { dayShort, num } from "@/lib/md/format";
import { QueryError, refreshingClass } from "./parts";
import type { GeoPeople, GeoPerson } from "./types";

const columns = (onPerson?: (employeeId: number) => void): Column<GeoPerson>[] => [
  {
    key: "name",
    header: "Employee",
    sortValue: (r) => r.employeeName.toLowerCase(),
    cell: (r) => (
      <div className="min-w-[8rem]">
        <p className="font-semibold text-md-ink">
          {onPerson && r.employeeId != null ? (
            <button
              type="button"
              className="text-left font-semibold text-md-ink underline decoration-md-line underline-offset-2 hover:decoration-md-wine"
              onClick={() => onPerson(r.employeeId as number)}
              data-testid={`md-geo-people-open-${r.employeeCode}`}
            >
              {r.employeeName}
            </button>
          ) : (
            r.employeeName
          )}
          {r.frequent && (
            <span className="md-chip md-chip-wine md-analytics-chip-sm ml-1.5 align-middle">frequent</span>
          )}
        </p>
        <p className="text-[11px] text-md-ink-soft">
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
 *  anything unusual about them. Names are shown because the MD acts on this list; a name opens the person's month. */
export default function PeopleCard({
  query,
  ask,
  onPerson,
}: {
  query: UseQueryResult<GeoPeople>;
  ask: string;
  /** Opens a person's on-duty month (their sessions, journeys and alerts). */
  onPerson?: (employeeId: number) => void;
}) {
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
            columns={columns(onPerson)}
            rows={data.rows}
            rowKey={(r) => r.employeeCode}
            initialSort={{ key: "sessions", dir: "desc" }}
            pageSize={6}
            empty="Nobody went on duty in this period."
            testId="md-geo-people-table"
          />
          {data.truncated && (
            <p className="md-analytics-note">
              Showing the {num(data.rows.length)} who went out most, of {num(data.total)}.
            </p>
          )}
        </>
      ) : null}
    </SectionCard>
  );
}
