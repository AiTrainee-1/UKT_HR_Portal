import { useMemo, useState } from "react";
import { ScrollText } from "lucide-react";
import {
  GATE_ADMIN_API,
  GATE_RECORD_TYPE_LABEL,
  useGateAdminRecords,
  type GateRecord,
  type ManagedGate,
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
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatusChip,
  WhenCell,
  type DataColumn,
  type GateFilters,
} from "../kit";
import { RESULT_OPTIONS, TYPE_OPTIONS, errorText, recordsQuery, recordsSummary } from "./logic";

/** The address keys of Manage Gates (module-level: useGateFilters needs a stable object). `gate` / `gq` / `gstatus` are
 *  the page's own (which gate is open, the gate list's search and status) and never reach the records API. */
export const GATE_PAGE_DEFAULTS = {
  gate: "",
  gq: "",
  gstatus: "",
  range: "month",
  from: "",
  to: "",
  type: "",
  result: "",
  q: "",
  gateId: "",
  pageSize: "25",
};
export type GatePageFilters = GateFilters<typeof GATE_PAGE_DEFAULTS>;

const typeChip = (type: GateRecord["type"]) => (
  <span className="inline-flex rounded-md bg-slate-100 px-1.5 py-0.5 text-xs font-medium text-slate-700">
    {GATE_RECORD_TYPE_LABEL[type] ?? type}
  </span>
);

const resultChip = (row: GateRecord) =>
  row.result === "allowed" ? (
    <StatusChip tone="teal">Allowed</StatusChip>
  ) : (
    <StatusChip tone="rose" title={row.reasonLabel ?? undefined}>
      {row.reasonLabel ? `Denied · ${row.reasonLabel}` : "Denied"}
    </StatusChip>
  );

const detailText = (row: GateRecord): string =>
  [row.destination, row.message].filter((part) => !!part && part.trim()).join(" · ") || NONE;

/**
 * "Records from this gate" (or from every gate): the date filter, type, result, a gate filter when every gate is shown,
 * the search, Export of exactly these rows, then the table (one line a row, the details in a drawer).
 */
export function GateRecords({
  selection,
  gateName,
  gates,
  f,
}: {
  selection: number | "all";
  gateName?: string;
  gates: readonly ManagedGate[] | undefined;
  f: GatePageFilters;
}) {
  const all = selection === "all";
  const query = useMemo(() => recordsQuery(f.params, selection), [f.params, selection]);
  const exportQuery = useMemo(() => recordsQuery(f.exportQuery, selection), [f.exportQuery, selection]);
  const { data, isLoading, isFetching, isError, error, refetch } = useGateAdminRecords(query);
  const [open, setOpen] = useState<GateRecord | null>(null);

  const columns = useMemo(() => {
    const cols: DataColumn<GateRecord>[] = [
      { key: "at", header: "Time", cell: (r) => <WhenCell value={r.at} />, truncate: false, minWidth: 92 },
      {
        key: "employee",
        header: "Employee",
        cell: (r) =>
          r.employee ? (
            <PersonCell
              name={r.employee.name}
              code={r.employee.employeeCode}
              sub={r.employee.department}
              photoUrl={r.employee.photoUrl}
              size={28}
            />
          ) : (
            <span className="text-slate-500">Nobody (code not recognised)</span>
          ),
        text: (r) => (r.employee ? `${r.employee.name} (${r.employee.employeeCode})` : null),
        minWidth: 180,
        maxWidth: 260,
      },
      { key: "type", header: "Type", cell: (r) => typeChip(r.type), truncate: false },
      { key: "result", header: "Result", cell: resultChip, truncate: false },
    ];
    if (all) {
      cols.push({
        key: "gate",
        header: "Gate",
        cell: (r) => r.gateName ?? "Removed gate",
        text: (r) => r.gateName ?? "Removed gate",
        maxWidth: 160,
      });
    }
    cols.push({
      key: "details",
      header: "Destination / message",
      cell: (r) => <span className="text-slate-600">{detailText(r)}</span>,
      text: detailText,
      maxWidth: 320,
      hideOnPhone: true,
    });
    return cols;
  }, [all]);

  const gateOptions = useMemo(
    () => (gates ?? []).map((g) => ({ value: String(g.id), label: g.isActive ? g.name : `${g.name} (off)` })),
    [gates],
  );

  const rows = data?.items ?? [];
  const title = all ? "Records from every gate" : `Records from ${gateName ?? "this gate"}`;
  const exportTitle = all ? "Gate records" : `Gate records - ${gateName ?? "gate"}`;

  return (
    <section className="min-w-0 space-y-3" aria-label={title} data-testid="gate-records">
      <div className="flex flex-wrap items-end justify-between gap-2 px-1">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          <p className="text-xs text-slate-500">Every pass scan and tea break at {all ? "the gates" : "this gate"}.</p>
        </div>
      </div>

      <FilterBar
        label="Record filters"
        testId="gate-records-filters"
        actions={
          <ExportButton
            title={exportTitle}
            path={GATE_ADMIN_API.recordsExport}
            query={exportQuery}
            hints={{ xlsx: "Every matching record, up to 30,000", pdf: "Up to 5,000 records" }}
            testId="gate-records-export"
          />
        }
      >
        <DateRangeFilter
          range={f.filters.range}
          from={f.filters.from}
          to={f.filters.to}
          onChange={(patch) => f.set(patch)}
          allowAll
          testId="gate-records-dates"
        />
        <SelectFilter
          label="Type"
          value={f.filters.type}
          onChange={(type) => f.set({ type })}
          options={TYPE_OPTIONS}
          allLabel="All types"
          testId="gate-records-type"
        />
        <SelectFilter
          label="Result"
          value={f.filters.result}
          onChange={(result) => f.set({ result })}
          options={RESULT_OPTIONS}
          allLabel="All results"
          testId="gate-records-result"
        />
        {all && (
          <SelectFilter
            label="Gate"
            value={f.filters.gateId}
            onChange={(gateId) => f.set({ gateId })}
            options={gateOptions}
            allLabel="All gates"
            testId="gate-records-gate"
          />
        )}
        <SearchFilter
          value={f.filters.q}
          onChange={(q) => f.set({ q })}
          placeholder="Name, code or destination"
          label="Search records by employee name, code or destination"
          testId="gate-records-search"
        />
        <ClearFilters count={f.activeCount} onClear={f.clear} testId="gate-records-clear" />
      </FilterBar>

      <DataTable<GateRecord>
        caption={title}
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={setOpen}
        rowLabel={(r) =>
          `${GATE_RECORD_TYPE_LABEL[r.type] ?? r.type} of ${r.employee?.name ?? "an unknown code"} at ${fmtDateTime(r.at)}`
        }
        selectedKey={open?.id ?? null}
        loading={isLoading || isFetching}
        error={isError ? errorText(error, "Try again.") : null}
        onRetry={() => void refetch()}
        empty={{
          icon: ScrollText,
          title: "No records for these filters",
          hint: "Try other dates or clear the filters.",
        }}
        summary={
          data ? <span data-testid="gate-records-summary">{recordsSummary(data.total, data.counts)}</span> : null
        }
        pagination={
          data
            ? {
                page: data.page,
                pageSize: data.pageSize,
                total: data.total,
                onPageChange: f.setPage,
                onPageSizeChange: (size) => f.set({ pageSize: String(size) }),
                pageSizes: [25, 50, 100],
              }
            : undefined
        }
        maxHeight="70vh"
        testId="gate-records-table"
      />

      <DetailDrawer
        open={!!open}
        onOpenChange={(next) => !next && setOpen(null)}
        title={
          open ? `${GATE_RECORD_TYPE_LABEL[open.type] ?? open.type} · ${fmtDateTime(open.at, { year: true })}` : ""
        }
        subtitle={open?.gateName ?? (open ? "Removed gate" : undefined)}
        testId="gate-record-drawer"
      >
        {open && (
          <>
            <DrawerSection title="Employee">
              {open.employee ? (
                <PersonCell
                  name={open.employee.name}
                  code={open.employee.employeeCode}
                  sub={open.employee.department}
                  photoUrl={open.employee.photoUrl}
                  size={40}
                />
              ) : (
                <p className="text-sm text-slate-600">The scanned code did not name anyone.</p>
              )}
            </DrawerSection>
            <DrawerSection title="What happened">
              <DrawerFields
                items={[
                  { label: "When", value: fmtDateTime(open.at, { year: true }) },
                  { label: "Gate", value: open.gateName ?? "Removed gate" },
                  { label: "Type", value: GATE_RECORD_TYPE_LABEL[open.type] ?? open.type },
                  { label: "Result", value: resultChip(open) },
                  ...(open.destination ? [{ label: "Destination", value: open.destination }] : []),
                  ...(open.type === "tea_in" && open.minutes != null
                    ? [{ label: "Break", value: fmtMinutes(open.minutes) }]
                    : []),
                  { label: "Message", value: open.message || NONE, wide: true },
                ]}
              />
            </DrawerSection>
          </>
        )}
      </DetailDrawer>
    </section>
  );
}
