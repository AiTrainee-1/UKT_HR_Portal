import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import {
  RECEPTION_ADMIN_API,
  RECEPTION_RECORD_TYPE_LABEL,
  useReceptionRecords,
  type ManagedDesk,
  type ReceptionRecord,
} from "@/lib/api-client/custom-hooks";
import {
  ClearFilters,
  DataTable,
  DateRangeFilter,
  DetailDrawer,
  DrawerFields,
  DrawerSection,
  ExportButton,
  FilterBar,
  fmtDateTime,
  fmtMinutes,
  NONE,
  SearchFilter,
  SelectFilter,
  StatusChip,
  toneOf,
  WhenCell,
  type DataColumn,
} from "../../kit";
import { TYPE_OPTIONS, errorText, recordFilterCount, recordsQuery, recordsSummary, type DeskPageValues } from "./logic";

const typeChip = (row: ReceptionRecord) => (
  <StatusChip tone={row.type === "check_in" ? "amber" : "teal"}>
    {RECEPTION_RECORD_TYPE_LABEL[row.type] ?? row.typeLabel}
  </StatusChip>
);

const visitorText = (r: ReceptionRecord): string =>
  r.visit ? [r.visit.visitorName, r.visit.company].filter(Boolean).join(" · ") : "Visit removed";
const hostText = (r: ReceptionRecord): string =>
  r.visit ? [r.visit.host, r.visit.hostDepartment].filter(Boolean).join(" · ") || NONE : NONE;

/**
 * "Records from this desk" (or from every desk): the visitors a desk login checked in (walk-ins registered at the desk) and
 * the visitors it checked out. The date filter, the type, a desk filter when every desk is shown, the search, Export of
 * exactly these rows, then the table (one line a row, the details in a drawer).
 */
export function DeskRecords({
  selection,
  deskName,
  desks,
  values,
  set,
  clear,
}: {
  selection: number | "all";
  deskName?: string;
  desks: readonly ManagedDesk[] | undefined;
  values: DeskPageValues;
  /** Changes record filters (and goes back to page 1 unless the patch sets recPage). */
  set: (patch: Partial<DeskPageValues>) => void;
  clear: () => void;
}) {
  const all = selection === "all";
  const query = useMemo(() => recordsQuery(values, selection), [values, selection]);
  const exportQuery = useMemo(() => recordsQuery(values, selection, { paging: false }), [values, selection]);
  const { data, isLoading, isFetching, isError, error, refetch } = useReceptionRecords(query);
  const [open, setOpen] = useState<ReceptionRecord | null>(null);

  const columns = useMemo(() => {
    const cols: DataColumn<ReceptionRecord>[] = [
      { key: "at", header: "Time", cell: (r) => <WhenCell value={r.at} />, truncate: false, minWidth: 92 },
      {
        key: "visitor",
        header: "Visitor",
        cell: (r) => (
          <span className="block min-w-0">
            <span className="block truncate font-medium text-slate-900">{r.visit?.visitorName ?? "Visit removed"}</span>
            {r.visit?.company && <span className="block truncate text-[11px] text-slate-500">{r.visit.company}</span>}
          </span>
        ),
        text: visitorText,
        minWidth: 160,
        maxWidth: 240,
      },
      { key: "type", header: "Type", cell: typeChip, truncate: false },
    ];
    if (all) {
      cols.push({
        key: "desk",
        header: "Desk",
        cell: (r) => r.desk?.name ?? "Removed desk",
        text: (r) => r.desk?.name ?? "Removed desk",
        maxWidth: 160,
      });
    }
    cols.push(
      {
        key: "host",
        header: "Meeting",
        cell: (r) => <span className="text-slate-700">{hostText(r)}</span>,
        text: hostText,
        maxWidth: 220,
      },
      {
        key: "purpose",
        header: "Purpose",
        cell: (r) => <span className="text-slate-600">{r.visit?.purpose ?? NONE}</span>,
        text: (r) => r.visit?.purpose ?? null,
        maxWidth: 240,
        hideOnPhone: true,
      },
      {
        key: "status",
        header: "Visit now",
        truncate: false,
        hideOnPhone: true,
        cell: (r) => (r.visit ? <StatusChip tone={toneOf(r.visit.status)}>{r.visit.statusLabel}</StatusChip> : NONE),
      },
    );
    return cols;
  }, [all]);

  const deskOptions = useMemo(
    () => (desks ?? []).map((d) => ({ value: String(d.id), label: d.isActive ? d.name : `${d.name} (off)` })),
    [desks],
  );

  const rows = data?.items ?? [];
  const title = all ? "Records from every desk" : `Records from ${deskName ?? "this desk"}`;
  const exportTitle = all ? "Reception records" : `Reception records - ${deskName ?? "desk"}`;
  const v = open?.visit ?? null;

  return (
    <section className="min-w-0 space-y-3" aria-label={title} data-testid="desk-records">
      <div className="flex flex-wrap items-end justify-between gap-2 px-1">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">
            The visitors {all ? "the desks" : "this desk"} checked in and checked out, from 18 Nov 2026.
          </p>
        </div>
      </div>

      <FilterBar
        label="Record filters"
        testId="desk-records-filters"
        actions={
          <ExportButton
            title={exportTitle}
            path={RECEPTION_ADMIN_API.recordsExport}
            query={exportQuery}
            hints={{ xlsx: "Every matching record, up to 30,000", pdf: "Up to 5,000 records" }}
            testId="desk-records-export"
          />
        }
      >
        <DateRangeFilter
          range={values.recRange}
          from={values.recFrom}
          to={values.recTo}
          onChange={(patch) => set({ recRange: patch.range, recFrom: patch.from, recTo: patch.to })}
          allowAll
          testId="desk-records-dates"
        />
        <SelectFilter
          label="Type"
          value={values.recType}
          onChange={(recType) => set({ recType })}
          options={TYPE_OPTIONS}
          allLabel="Check-ins and check-outs"
          testId="desk-records-type"
        />
        {all && (
          <SelectFilter
            label="Desk"
            value={values.recDesk}
            onChange={(recDesk) => set({ recDesk })}
            options={deskOptions}
            allLabel="All desks"
            testId="desk-records-desk"
          />
        )}
        <SearchFilter
          value={values.recQ}
          onChange={(recQ) => set({ recQ })}
          placeholder="Visitor, company, host or purpose"
          label="Search records by visitor, company, host or purpose"
          testId="desk-records-search"
        />
        <ClearFilters count={recordFilterCount(values)} onClear={clear} testId="desk-records-clear" />
      </FilterBar>

      <DataTable<ReceptionRecord>
        caption={title}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={setOpen}
        rowLabel={(r) =>
          `${RECEPTION_RECORD_TYPE_LABEL[r.type] ?? r.typeLabel} of ${r.visit?.visitorName ?? "a removed visit"} at ${fmtDateTime(r.at)}`
        }
        selectedKey={open?.id ?? null}
        loading={isLoading || isFetching}
        error={isError ? errorText(error, "Try again.") : null}
        onRetry={() => void refetch()}
        empty={{
          icon: ScrollText,
          title: "No records for these filters",
          hint: "A desk's records are the visitors it checks in or out. Try other dates or clear the filters.",
        }}
        summary={
          data ? <span data-testid="desk-records-summary">{recordsSummary(data.total, data.counts)}</span> : null
        }
        pagination={
          data
            ? {
                page: data.page,
                pageSize: data.pageSize,
                total: data.total,
                onPageChange: (page) => set({ recPage: String(page) }),
                onPageSizeChange: (size) => set({ recSize: String(size) }),
                pageSizes: [25, 50, 100],
              }
            : undefined
        }
        maxHeight="70vh"
        testId="desk-records-table"
      />

      <DetailDrawer
        open={!!open}
        onOpenChange={(next) => !next && setOpen(null)}
        title={
          open
            ? `${RECEPTION_RECORD_TYPE_LABEL[open.type] ?? open.typeLabel} · ${fmtDateTime(open.at, { year: true })}`
            : ""
        }
        subtitle={open?.desk?.name ?? (open ? "Removed desk" : undefined)}
        testId="desk-record-drawer"
      >
        {open && (
          <>
            <DrawerSection title="Visitor">
              {v ? (
                <DrawerFields
                  items={[
                    { label: "Name", value: v.visitorName },
                    { label: "Company", value: v.company || NONE },
                    { label: "People", value: String(v.peopleCount) },
                    { label: "Badge", value: v.badgeNumber || NONE },
                    { label: "Meeting", value: hostText(open) },
                    { label: "Purpose", value: v.purpose, wide: true },
                  ]}
                />
              ) : (
                <p className="text-sm text-slate-600">This visit is no longer on the Visitors page.</p>
              )}
            </DrawerSection>
            <DrawerSection title="The visit">
              <DrawerFields
                items={[
                  { label: "Desk", value: open.desk?.name ?? "Removed desk" },
                  { label: "Recorded", value: RECEPTION_RECORD_TYPE_LABEL[open.type] ?? open.typeLabel },
                  ...(v
                    ? [
                        { label: "Checked in", value: fmtDateTime(v.visitedAt, { year: true }) },
                        {
                          label: "Checked out",
                          value: v.checkedOutAt ? fmtDateTime(v.checkedOutAt, { year: true }) : NONE,
                        },
                        { label: "Time inside", value: v.minutesInside != null ? fmtMinutes(v.minutesInside) : NONE },
                        {
                          label: "Now",
                          value: <StatusChip tone={toneOf(v.status)}>{v.statusLabel}</StatusChip>,
                        },
                        { label: "Branch", value: v.branchName ?? NONE },
                      ]
                    : []),
                ]}
              />
            </DrawerSection>
          </>
        )}
      </DetailDrawer>
    </section>
  );
}
