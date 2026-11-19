import { useMemo, useState } from "react";
import { AlertTriangle, DoorOpen, LogIn, LogOut, Timer, UserX } from "lucide-react";
import {
  IN_OUT_API,
  getListBranchesQueryKey,
  useInOut,
  useInOutOptions,
  useInOutSummary,
  useListBranches,
  type InOutRow,
  type InOutStatus,
} from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import {
  ClearFilters,
  DataTable,
  DateRangeFilter,
  ExportButton,
  FilterBar,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatRow,
  StatTile,
  StatusChip,
  fmtCount,
  fmtMinutes,
  fmtRangeLabel,
  toneOf,
  useGateFilters,
  type DataColumn,
} from "../kit";
import { EmployeeFilter } from "./EmployeeFilter";
import { InOutDrawer } from "./InOutDrawer";
import { STATUS_OPTIONS, TimeAtGate, TimeOut, statusTitle } from "./inout-cells";

/** The filters of In/Out, in the address (`?range=week&gateId=2&status=out`). The API reads the same names. */
export const IN_OUT_DEFAULTS = {
  range: "today",
  from: "",
  to: "",
  gateId: "",
  departmentId: "",
  employeeId: "",
  status: "",
  q: "",
  branchId: "",
  pageSize: "25",
};

const PAGE_SIZES = [25, 50, 100];

const COLUMNS: DataColumn<InOutRow>[] = [
  {
    key: "employee",
    header: "Employee",
    cell: (r) => <PersonCell name={r.employee.name} code={r.employee.employeeCode} photoUrl={r.employee.photoUrl} />,
    text: (r) => `${r.employee.name} (${r.employee.employeeCode})`,
    minWidth: 190,
    maxWidth: 260,
  },
  {
    key: "department",
    header: "Department",
    cell: (r) => r.employee.department ?? "—",
    text: (r) => r.employee.department,
    hideOnPhone: true,
    maxWidth: 160,
  },
  {
    key: "passType",
    header: "Pass type",
    cell: (r) => r.passTypeLabel ?? "—",
    hideOnPhone: true,
    maxWidth: 130,
  },
  {
    key: "destination",
    header: "Destination",
    cell: (r) => r.destination,
    text: (r) => (r.reason && r.reason !== r.destination ? `${r.destination}: ${r.reason}` : r.destination),
    maxWidth: 220,
  },
  {
    key: "out",
    header: "Out",
    cell: (r) => <TimeAtGate at={r.exitedAt} gate={r.exitGateName} />,
    text: (r) => (r.exitGateName ? `Out through ${r.exitGateName}` : null),
    maxWidth: 200,
  },
  {
    key: "back",
    header: "Back",
    cell: (r) => <TimeAtGate at={r.enteredAt} gate={r.entryGateName} />,
    text: (r) => (r.entryGateName ? `Back through ${r.entryGateName}` : null),
    maxWidth: 200,
  },
  {
    key: "time",
    header: "Time out",
    cell: (r) => <TimeOut row={r} />,
    truncate: false,
    minWidth: 150,
  },
  {
    key: "status",
    header: "Status",
    cell: (r) => (
      <StatusChip tone={toneOf(r.status)} title={statusTitle(r)}>
        {r.statusLabel}
      </StatusChip>
    ),
    truncate: false,
  },
];

const errorText = (e: unknown) => (e instanceof Error && e.message ? e.message : "Try again in a minute.");

/**
 * In/Out: every pass that went out through a gate in the chosen days, whether it came back and how long it was out, all
 * worked out by the server (/api/outpass/in-out, the In/Out permission of its own). The tiles count the whole range and
 * filter the list when clicked; the filters live in the address; a row opens the pass with its approval and every scan,
 * the refused ones included; Export gives the same rows as Excel or PDF.
 */
export function InOutSection({ isBranchScoped }: { isBranchScoped: boolean }) {
  const f = useGateFilters(IN_OUT_DEFAULTS);
  const { filters, set } = f;
  const level = useLevel();
  // the Employee filter searches the Employees module: a role that may not see employees gets the search box instead
  const canSearchEmployees = level("employees") !== "hidden";
  const [open, setOpen] = useState<InOutRow | null>(null);
  const [picked, setPicked] = useState<{ id: string; name: string } | null>(null);

  // the tiles count every status of the range (they are the status chips), so they leave the status filter out
  const tilesQuery = useMemo(() => {
    const p = new URLSearchParams(f.exportQuery);
    p.delete("status");
    return p.toString();
  }, [f.exportQuery]);

  const list = useInOut(f.queryKey);
  const summary = useInOutSummary(tilesQuery);
  const { data: options } = useInOutOptions();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });

  const rows = list.data?.items;
  const total = list.data?.total ?? 0;
  const s = summary.data;
  const tilesLoading = summary.isLoading && !s;

  const employeeName =
    (picked && picked.id === filters.employeeId ? picked.name : null) ??
    rows?.find((r) => String(r.employee.id) === filters.employeeId)?.employee.name ??
    null;

  const gateOptions = (options?.gates ?? []).map((g) => ({
    value: String(g.id),
    label: g.isActive === false ? `${g.name} (switched off)` : g.name,
  }));
  const departmentOptions = (options?.departments ?? []).map((d) => ({ value: String(d.id), label: d.name }));
  const branchOptions = (branches ?? []).map((b) => ({ value: String(b.id), label: b.name }));

  // a tile is a status chip: it filters the list to its status, and a second click (or Went out) shows every status again
  const statusTile = (status: InOutStatus | "") => ({
    onClick: () => set({ status: filters.status === status ? "" : status }),
    active: status !== "" && filters.status === status,
  });

  const rangeText = fmtRangeLabel(f.dateRange.from, f.dateRange.to);
  const summaryLine = list.data ? (
    <span data-testid="inout-summary-line">
      <strong className="font-semibold text-slate-900">
        {fmtCount(total)} {total === 1 ? "pass" : "passes"}
      </strong>
      <span className="text-slate-500"> · {rangeText}</span>
      {!filters.status && s && (
        <>
          {` · ${fmtCount(s.cameBack)} back · ${fmtCount(s.stillOut)} still out`}
          {s.overdue > 0 && <span className="text-rose-700">{` · ${fmtCount(s.overdue)} overdue`}</span>}
          {s.notReturned > 0 && <span className="text-rose-700">{` · ${fmtCount(s.notReturned)} not returned`}</span>}
        </>
      )}
      {filters.status && (
        <span className="text-slate-500">
          {` · ${STATUS_OPTIONS.find((o) => o.value === filters.status)?.label ?? filters.status}`}
        </span>
      )}
    </span>
  ) : null;

  return (
    <div className="space-y-4" data-testid="outpass-in-out">
      <StatRow testId="inout-tiles">
        <StatTile
          label="Went out"
          value={s?.wentOut}
          icon={LogOut}
          loading={tilesLoading}
          testId="inout-tile-went-out"
          title="Show every pass that went out"
          {...statusTile("")}
        />
        <StatTile
          label="Came back"
          value={s?.cameBack}
          icon={LogIn}
          tone="teal"
          loading={tilesLoading}
          testId="inout-tile-back"
          title="Show the passes that came back"
          {...statusTile("back")}
        />
        <StatTile
          label="Still out"
          value={s?.stillOut}
          icon={DoorOpen}
          tone="amber"
          emphasis={(s?.stillOut ?? 0) > 0}
          loading={tilesLoading}
          testId="inout-tile-out"
          title="Show everyone still out today (overdue included)"
          {...statusTile("out")}
        />
        <StatTile
          label="Overdue"
          value={s?.overdue}
          icon={AlertTriangle}
          tone="rose"
          emphasis={(s?.overdue ?? 0) > 0}
          loading={tilesLoading}
          testId="inout-tile-overdue"
          title="Show the passes still out after their expected return"
          {...statusTile("overdue")}
        />
        <StatTile
          label="Not returned"
          value={s?.notReturned}
          icon={UserX}
          tone="rose"
          emphasis={(s?.notReturned ?? 0) > 0}
          loading={tilesLoading}
          testId="inout-tile-not-returned"
          title="Show the passes that went out on an earlier day and never came back"
          {...statusTile("not_returned")}
        />
        <StatTile
          label="Average time out"
          value={s ? (s.avgMinutesOut === null ? null : fmtMinutes(s.avgMinutesOut)) : undefined}
          hint={s?.longestMinutesOut ? `longest ${fmtMinutes(s.longestMinutesOut)}` : undefined}
          icon={Timer}
          tone="slate"
          loading={tilesLoading}
          testId="inout-tile-average"
          title="Exit scan to return scan, over the passes that came back"
        />
      </StatRow>

      <FilterBar
        label="In/Out filters"
        testId="inout-filters"
        actions={
          <ExportButton
            title="Gate pass in out"
            path={IN_OUT_API.export}
            query={f.exportQuery}
            disabled={total === 0}
            hints={{ xlsx: "Every matching pass, up to 30,000", pdf: "Every matching pass, up to 5,000" }}
            testId="inout-export"
          />
        }
      >
        <DateRangeFilter
          range={filters.range}
          from={filters.from}
          to={filters.to}
          onChange={(patch) => set(patch)}
          testId="inout-dates"
        />
        <SelectFilter
          label="Gate"
          value={filters.gateId}
          onChange={(gateId) => set({ gateId })}
          options={gateOptions}
          allLabel="All gates"
          testId="inout-gate"
        />
        <SelectFilter
          label="Department"
          value={filters.departmentId}
          onChange={(departmentId) => set({ departmentId })}
          options={departmentOptions}
          allLabel="All departments"
          testId="inout-department"
        />
        {!isBranchScoped && branchOptions.length > 1 && (
          <SelectFilter
            label="Branch"
            value={filters.branchId}
            onChange={(branchId) => set({ branchId })}
            options={branchOptions}
            allLabel="All branches"
            testId="inout-branch"
          />
        )}
        <SelectFilter
          label="Status"
          value={filters.status}
          onChange={(status) => set({ status })}
          options={STATUS_OPTIONS}
          allLabel="Any status"
          testId="inout-status"
        />
        {canSearchEmployees && (
          <EmployeeFilter
            value={filters.employeeId}
            name={employeeName}
            onChange={(employeeId, name) => {
              setPicked(employeeId ? { id: employeeId, name: name ?? "" } : null);
              set({ employeeId });
            }}
          />
        )}
        <SearchFilter
          value={filters.q}
          onChange={(q) => set({ q })}
          placeholder="Name, code, destination or reason"
          label="Search by name, code, destination or reason"
          testId="inout-search"
        />
        <ClearFilters count={f.activeCount} onClear={f.clear} testId="inout-clear" />
      </FilterBar>

      <DataTable
        columns={COLUMNS}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={setOpen}
        rowLabel={(r) => `Open the gate pass of ${r.employee.name}`}
        selectedKey={open?.id ?? null}
        loading={list.isFetching && (!list.data || list.isPlaceholderData)}
        error={list.error ? errorText(list.error) : null}
        onRetry={() => void list.refetch()}
        summary={summaryLine}
        empty={{
          icon: DoorOpen,
          title: f.activeCount > 0 ? "No pass matches these filters" : "No one went out through a gate on these days",
          hint:
            f.activeCount > 0 ? "Try other dates, or clear the filters." : "Pick other dates to see earlier passes.",
        }}
        pagination={{
          page: f.page,
          pageSize: f.pageSize ?? 25,
          total,
          onPageChange: f.setPage,
          onPageSizeChange: (size) => set({ pageSize: String(size) }),
          pageSizes: PAGE_SIZES,
        }}
        caption="Gate passes that went out"
        testId="inout-table"
      />

      <InOutDrawer row={open} onClose={() => setOpen(null)} />
    </div>
  );
}
