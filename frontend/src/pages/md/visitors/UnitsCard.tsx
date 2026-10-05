import type { UseQueryResult } from "@tanstack/react-query";
import AskAiButton from "@/components/md/kit/AskAiButton";
import DataTable, { type Column } from "@/components/md/kit/DataTable";
import SectionCard from "@/components/md/kit/SectionCard";
import { ErrorBanner } from "@/components/md/kit/states";
import { describeMdError } from "@/lib/api-client/custom-hooks/md";
import { minutesText, num } from "@/lib/md/format";
import { periodPhrase } from "./logic";
import { PersonCell } from "./parts";
import type { UnitRow, UnitsResponse } from "./types";

const numberOrDash = (n: number | null) => (n == null ? "—" : num(n, Number.isInteger(n) ? 0 : 1));

const columns: Column<UnitRow>[] = [
  {
    key: "unit",
    header: "Unit",
    cell: (u) => <PersonCell name={u.unit} sub={staffText(u)} />,
    sortValue: (u) => u.unit,
  },
  { key: "visits", header: "Visits", align: "right", cell: (u) => num(u.visits), sortValue: (u) => u.visits },
  {
    key: "after",
    header: "After hours",
    align: "right",
    cell: (u) => num(u.afterHours),
    sortValue: (u) => u.afterHours,
  },
  {
    key: "requests",
    header: "Outpass requests",
    align: "right",
    cell: (u) => num(u.requests),
    sortValue: (u) => u.requests,
  },
  {
    key: "per100",
    header: "Per 100 staff",
    align: "right",
    cell: (u) => numberOrDash(u.requestsPer100),
    sortValue: (u) => u.requestsPer100,
  },
  {
    key: "time",
    header: "Time out",
    align: "right",
    cell: (u) => (u.minutesOut == null ? "—" : minutesText(u.minutesOut)),
    sortValue: (u) => u.minutesOut,
  },
  {
    key: "never",
    header: "Never returned",
    align: "right",
    cell: (u) => (
      <span className={u.notReturned > 0 ? "font-semibold text-red-700" : undefined}>{num(u.notReturned)}</span>
    ),
    sortValue: (u) => u.notReturned,
  },
];

function staffText(u: UnitRow): string | undefined {
  return u.headcount == null ? undefined : `${num(u.headcount)} active staff`;
}

/** The same measures unit by unit. Only worth a card when there is more than one unit to compare. */
export default function UnitsCard({ query }: { query: UseQueryResult<UnitsResponse> }) {
  const d = query.isError ? undefined : query.data;
  const rows = d?.units ?? [];
  if (!query.isPending && !query.isError && rows.length < 2) return null;
  return (
    <SectionCard
      title="Unit by unit"
      subtitle="Visits come from each unit's gate; outpasses from the employee's own unit"
      loading={query.isPending}
      provenance={d?.provenance}
      provenanceIds={["units"]}
      actions={
        <AskAiButton
          question={`Compare the units on visitors and outpasses ${periodPhrase(d?.period)}. Which unit loses the most time?`}
        />
      }
      testId="md-visitors-units"
    >
      {query.isError ? (
        <ErrorBanner message={describeMdError(query.error)} onRetry={() => query.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(u) => u.unitId ?? "none"}
          pageSize={10}
          testId="md-units-table"
        />
      )}
    </SectionCard>
  );
}
