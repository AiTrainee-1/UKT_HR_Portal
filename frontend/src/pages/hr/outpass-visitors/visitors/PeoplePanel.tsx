import { useMemo } from "react";
import { UsersRound } from "lucide-react";
import { useVisitorPeople, type VisitorPerson } from "@/lib/api-client/custom-hooks";
import {
  ClearFilters,
  DataTable,
  FilterBar,
  NONE,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatusChip,
  WhenCell,
  fmtCount,
  type DataColumn,
  type GateFilters,
} from "../kit";
import { VISIT_FILTER_DEFAULTS, errorText, peopleQuery } from "./logic";

type Filters = GateFilters<typeof VISIT_FILTER_DEFAULTS>;

/**
 * The People view: everyone who has visited (this branch), most recent first, with how often they came, when they were
 * last here, whom they met last and whether they are inside now. A row opens their last visit and its history.
 */
export function PeoplePanel({
  filters: f,
  isBranchScoped,
  branches,
  selectedVisitId,
  onOpen,
}: {
  filters: Filters;
  isBranchScoped: boolean;
  branches: { id: number; name: string }[] | undefined;
  selectedVisitId: number | null;
  onOpen: (visitId: number) => void;
}) {
  const people = useVisitorPeople(peopleQuery(f.params));
  const now = new Date();
  const branchOptions = useMemo(
    () => (branches ?? []).map((b) => ({ value: String(b.id), label: b.name })),
    [branches],
  );

  const columns: DataColumn<VisitorPerson>[] = [
    {
      key: "name",
      header: "Visitor",
      cell: (p) => <PersonCell name={p.name} sub={p.lastCompany} size={30} />,
      text: (p) => [p.name, p.lastCompany].filter(Boolean).join(" · "),
      minWidth: 160,
      maxWidth: 240,
    },
    {
      key: "phone",
      header: "Phone",
      cell: (p) => <span className="font-mono text-[12px] text-slate-700">{p.phoneMasked || NONE}</span>,
    },
    { key: "visits", header: "Visits", align: "right", cell: (p) => fmtCount(p.visitCount) },
    {
      key: "last",
      header: "Last visit",
      truncate: false,
      cell: (p) => (p.lastVisitAt ? <WhenCell value={p.lastVisitAt} now={now} /> : NONE),
    },
    {
      key: "host",
      header: "Last met",
      cell: (p) => p.lastHost ?? NONE,
      text: (p) => p.lastHost,
      maxWidth: 200,
      hideOnPhone: true,
    },
    {
      key: "inside",
      header: "Now",
      truncate: false,
      cell: (p) =>
        p.insideNow ? <StatusChip tone="amber">Inside now</StatusChip> : <span className="text-slate-400">{NONE}</span>,
    },
  ];

  const total = people.data?.total ?? 0;
  return (
    <div className="space-y-3">
      <FilterBar label="People filters" testId="visitors-people-filters">
        {!isBranchScoped && (
          <SelectFilter
            label="Branch"
            value={f.filters.branchId}
            onChange={(branchId) => f.set({ branchId })}
            options={branchOptions}
            allLabel="All branches"
            testId="visitors-people-branch"
          />
        )}
        <SearchFilter
          value={f.filters.q}
          onChange={(q) => f.set({ q })}
          placeholder="Name or phone"
          label="Search people"
          testId="visitors-people-search"
        />
        {/* only this view's two filters (the visit filters stay for the Visits view) */}
        <ClearFilters
          count={(f.filters.q ? 1 : 0) + (!isBranchScoped && f.filters.branchId ? 1 : 0)}
          onClear={() => f.set({ q: "", branchId: "" })}
          testId="visitors-people-clear"
        />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={people.data?.items}
        rowKey={(p) => p.id}
        onRowClick={(p) => p.lastVisitId !== null && onOpen(p.lastVisitId)}
        rowLabel={(p) => `Open the visits of ${p.name}`}
        selectedKey={people.data?.items.find((p) => p.lastVisitId === selectedVisitId)?.id ?? null}
        loading={people.isLoading || people.isPlaceholderData}
        error={people.isError ? errorText(people.error, "Check the connection and try again.") : null}
        onRetry={() => people.refetch()}
        summary={
          people.data ? (
            <span>
              {fmtCount(total)} {total === 1 ? "person" : "people"}
            </span>
          ) : null
        }
        caption="Visitors"
        testId="visitors-people"
        empty={{ icon: UsersRound, title: "Nobody found", hint: "Try another name or number." }}
        pagination={
          people.data
            ? {
                page: f.page,
                pageSize: f.pageSize ?? 25,
                total,
                onPageChange: f.setPage,
                onPageSizeChange: (size) => f.set({ pageSize: String(size) }),
              }
            : undefined
        }
      />
    </div>
  );
}
