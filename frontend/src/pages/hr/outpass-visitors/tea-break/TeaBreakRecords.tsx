import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, ArrowDown, ArrowUp, Coffee, Gauge, Timer, UserX, Users } from "lucide-react";
import { DateRangeBar } from "@/components/date-range";
import { useAuth } from "@/contexts/AuthContext";
import {
  TEA_BREAK_ADMIN_API,
  useTeaBreakAdminRecords,
  useTeaBreakEmployees,
  useTeaBreakOptions,
  useTeaBreakRecordsSummary,
  type TeaBreakAdminRecord,
  type TeaBreakEmployeeRow,
  type TeaBreakStatus,
} from "@/lib/api-client/custom-hooks";
import { rangeLabel, rangeParams, readDateRange } from "@/lib/date-range";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import {
  ClearFilters,
  DataTable,
  ExportButton,
  FilterBar,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatRow,
  StatTile,
  StatusChip,
  TimeBar,
  fmtCount,
  fmtDate,
  fmtMinutes,
  fmtTime,
  isTodayIst,
  NONE,
  useGateFilters,
  type DataColumn,
  type DataTablePagination,
} from "../kit";
import { EmployeePicker } from "./EmployeePicker";
import { TeaBreakDrawer } from "./TeaBreakDrawer";
import {
  FLAG_NOTE,
  STATUS_LABEL,
  STATUS_OPTIONS,
  STATUS_TONE,
  TEA_DEFAULTS,
  TEA_KEEP,
  TEA_PAGE_SIZES,
  isOpen,
  liveMinutes,
  liveStatus,
  nextSort,
  readSort,
  teaExportQuery,
  teaQuery,
  teaView,
  type TeaView,
} from "./teaBreak";

/** A clock for the open breaks' running minutes: ticks every 30 seconds. */
function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

/**
 * Tea Break -> Records: the period's figures (tiles), one filter row (dates, branch, department, employee, status, gate,
 * search, Export), then the breaks one by one or added up per employee (`?view=employees`). Every filter lives in the
 * address and is applied by the server; the tiles leave the status out so they stay the period's overview (a tile that
 * filters is a status shortcut). A row opens the break's details; an employee row lists that employee's breaks.
 */
export function TeaBreakRecords() {
  const { user } = useAuth();
  const level = useLevel();
  const filters = useGateFilters(TEA_DEFAULTS, { keep: TEA_KEEP });
  const { filters: values, set, params } = filters;
  // the HR portal's date filter (This Month by default): the days it stands for are in `params` as from / to
  const dates = readDateRange(values);
  const datesText = rangeLabel(dates);
  const view = teaView(values.view);
  const now = useNow();
  const scoped = !!user?.branchId;

  const options = useTeaBreakOptions(scoped ? "" : values.branchId);
  const summary = useTeaBreakRecordsSummary(teaQuery(params, "summary"));
  const breaks = useTeaBreakAdminRecords(teaQuery(params, "breaks"), { enabled: view === "breaks" });
  const employees = useTeaBreakEmployees(teaQuery(params, "employees"), { enabled: view === "employees" });
  const allowed = summary.data?.allowedMinutes ?? breaks.data?.allowedMinutes ?? options.data?.allowedMinutes ?? null;
  const allowedText = allowed !== null ? `${allowed} min` : "the rule";

  // the drawer: the last break opened stays while it slides shut, so focus can go back to its row
  const [drawerRow, setDrawerRow] = useState<TeaBreakAdminRecord | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // the picked employee's name (the address only has the id)
  const [employeeName, setEmployeeName] = useState<{ id: string; label: string } | null>(null);

  const openBreak = (row: TeaBreakAdminRecord) => {
    setDrawerRow(row);
    setDrawerOpen(true);
  };
  const showEmployee = (id: number, label: string) => {
    setEmployeeName({ id: String(id), label });
    set({ employeeId: String(id), view: "breaks" });
  };

  const employeeLabel = useMemo(() => {
    if (!values.employeeId) return null;
    if (employeeName?.id === values.employeeId) return employeeName.label;
    const seen =
      breaks.data?.items.find((r) => String(r.employee.id) === values.employeeId)?.employee ??
      employees.data?.items.find((r) => String(r.employee.id) === values.employeeId)?.employee;
    return seen ? `${seen.name} · ${seen.employeeCode}` : null;
  }, [values.employeeId, employeeName, breaks.data, employees.data]);

  const toggleStatus = (status: TeaBreakStatus) => set({ status: values.status === status ? "" : status });
  const s = summary.data;
  const branches = options.data?.branches ?? [];
  const canSearchPeople = level("employees") !== "hidden";

  return (
    <div className="space-y-4" data-testid="tea-break-records">
      <StatRow testId="tea-break-tiles">
        <StatTile
          label="Breaks"
          value={s?.breaks}
          hint={s ? `${fmtCount(s.completed)} back` : undefined}
          icon={Coffee}
          loading={!s}
          testId="tea-tile-breaks"
        />
        <StatTile
          label="On break now"
          value={s?.onBreakNow}
          icon={Timer}
          tone="amber"
          emphasis={(s?.onBreakNow ?? 0) > 0}
          loading={!s}
          onClick={() => toggleStatus("on_break")}
          active={values.status === "on_break"}
          title="Show only the breaks going on now"
          testId="tea-tile-on-break"
        />
        <StatTile
          label={`Over ${allowedText}`}
          value={s?.overtime}
          hint={s && s.overMinutesTotal > 0 ? `${fmtMinutes(s.overMinutesTotal)} over` : undefined}
          icon={AlertTriangle}
          tone="rose"
          emphasis={(s?.overtime ?? 0) > 0}
          loading={!s}
          onClick={() => toggleStatus("overtime")}
          active={values.status === "overtime"}
          title="Show only the breaks that went over the allowed time"
          testId="tea-tile-overtime"
        />
        <StatTile
          label="Not returned"
          value={s?.notReturned}
          hint={s ? "out over 1 h" : undefined}
          icon={UserX}
          tone="rose"
          emphasis={(s?.notReturned ?? 0) > 0}
          loading={!s}
          onClick={() => toggleStatus("not_returned")}
          active={values.status === "not_returned"}
          title="Show only the breaks not scanned back within an hour"
          testId="tea-tile-not-returned"
        />
        <StatTile
          label="Average break"
          value={s ? fmtMinutes(s.avgMinutes) : null}
          hint={s?.longestMinutes ? `longest ${fmtMinutes(s.longestMinutes)}` : undefined}
          icon={Gauge}
          tone="teal"
          loading={!s}
          testId="tea-tile-average"
        />
        <StatTile
          label="Employees"
          value={s?.employees}
          icon={Users}
          tone="slate"
          loading={!s}
          testId="tea-tile-employees"
        />
      </StatRow>

      <FilterBar
        label="Tea break filters"
        testId="tea-break-filters"
        actions={
          <ExportButton
            title={view === "employees" ? "Tea breaks by employee" : "Tea breaks"}
            path={TEA_BREAK_ADMIN_API.export}
            query={teaExportQuery(params, view)}
            hints={{
              xlsx: view === "employees" ? "One row per employee, every match" : "Every matching break",
              pdf: "Up to 5,000 rows",
            }}
            testId="tea-break-export"
          />
        }
      >
        <DateRangeBar value={dates} onChange={(next) => set(rangeParams(next))} testId="tea-dates" />
        {!scoped && branches.length > 1 && (
          <SelectFilter
            label="Branch"
            value={values.branchId}
            onChange={(branchId) => set({ branchId, departmentId: "", gateId: "" })}
            options={branches.map((b) => ({ value: String(b.id), label: b.name }))}
            allLabel="All branches"
            testId="tea-branch"
          />
        )}
        <SelectFilter
          label="Department"
          value={values.departmentId}
          onChange={(departmentId) => set({ departmentId })}
          options={(options.data?.departments ?? []).map((d) => ({ value: String(d.id), label: d.name }))}
          allLabel="All departments"
          testId="tea-department"
        />
        <EmployeePicker
          value={values.employeeId}
          label={employeeLabel}
          canSearch={canSearchPeople}
          onChange={(id, label) => {
            setEmployeeName(id ? { id, label: label ?? "" } : null);
            set({ employeeId: id });
          }}
          testId="tea-employee"
        />
        <SelectFilter
          label="Status"
          value={values.status}
          onChange={(status) => set({ status })}
          options={STATUS_OPTIONS}
          allLabel="Any status"
          testId="tea-status"
        />
        <SelectFilter
          label="Gate"
          value={values.gateId}
          onChange={(gateId) => set({ gateId })}
          options={(options.data?.gates ?? []).map((g) => ({ value: String(g.id), label: g.name }))}
          allLabel="All gates"
          testId="tea-gate"
        />
        <SearchFilter
          value={values.q}
          onChange={(q) => set({ q })}
          placeholder="Name or code"
          label="Search by employee name or code"
          testId="tea-search"
        />
        <ClearFilters count={filters.activeCount} onClear={filters.clear} testId="tea-clear" />
      </FilterBar>

      {view === "breaks" ? (
        <BreaksTable
          rows={breaks.data?.items}
          total={breaks.data?.total ?? 0}
          loading={breaks.isFetching}
          error={breaks.isError ? errorText(breaks.error) : null}
          onRetry={() => void breaks.refetch()}
          now={now}
          allowedFallback={allowed ?? 15}
          summaryLine={
            <span data-testid="tea-break-count">
              {fmtCount(breaks.data?.total ?? 0)} {breaks.data?.total === 1 ? "break" : "breaks"}
              {values.status ? ` · ${STATUS_LABEL[values.status as TeaBreakStatus] ?? values.status}` : ""} ·{" "}
              {datesText}
            </span>
          }
          toolbar={<ViewSwitch view={view} onChange={(v) => set({ view: v })} />}
          pagination={{
            page: filters.page,
            pageSize: filters.pageSize ?? 20,
            total: breaks.data?.total ?? 0,
            onPageChange: filters.setPage,
            onPageSizeChange: (size) => set({ pageSize: String(size) }),
            pageSizes: TEA_PAGE_SIZES,
          }}
          selectedKey={drawerOpen ? (drawerRow?.id ?? null) : null}
          onOpen={openBreak}
        />
      ) : (
        <EmployeesTable
          rows={employees.data?.items}
          loading={employees.isFetching}
          error={employees.isError ? errorText(employees.error) : null}
          onRetry={() => void employees.refetch()}
          sort={values.sort}
          onSort={(key) => set({ sort: nextSort(values.sort, key) })}
          summaryLine={
            <span data-testid="tea-break-count">
              {fmtCount(employees.data?.total ?? 0)} {employees.data?.total === 1 ? "employee" : "employees"}
              {s ? ` · ${fmtCount(s.breaks)} breaks` : ""} · {datesText}
            </span>
          }
          toolbar={<ViewSwitch view={view} onChange={(v) => set({ view: v })} />}
          pagination={{
            page: filters.page,
            pageSize: filters.pageSize ?? 20,
            total: employees.data?.total ?? 0,
            onPageChange: filters.setPage,
            onPageSizeChange: (size) => set({ pageSize: String(size) }),
            pageSizes: TEA_PAGE_SIZES,
          }}
          onOpen={(row) => showEmployee(row.employee.id, `${row.employee.name} · ${row.employee.employeeCode}`)}
        />
      )}

      <TeaBreakDrawer
        row={drawerRow}
        open={drawerOpen}
        now={now}
        onClose={() => setDrawerOpen(false)}
        onOpenBreak={openBreak}
        onShowEmployee={(row) => {
          setDrawerOpen(false);
          showEmployee(row.employee.id, `${row.employee.name} · ${row.employee.employeeCode}`);
        }}
      />
    </div>
  );
}

const errorText = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "The server did not answer. Try again in a minute.";

/** Breaks | By employee. */
function ViewSwitch({ view, onChange }: { view: TeaView; onChange: (view: TeaView) => void }) {
  const items: { value: TeaView; label: string }[] = [
    { value: "breaks", label: "Breaks" },
    { value: "employees", label: "By employee" },
  ];
  return (
    <div
      role="group"
      aria-label="Show"
      className="flex overflow-hidden rounded-lg border border-slate-200"
      data-testid="tea-view"
    >
      {items.map((item, i) => {
        const on = item.value === view;
        return (
          <button
            key={item.value}
            type="button"
            aria-pressed={on}
            onClick={() => !on && onChange(item.value)}
            className={cn(
              "h-11 whitespace-nowrap px-3 text-sm font-medium transition-colors sm:h-8",
              i > 0 && "border-l border-slate-200",
              on ? "bg-primary text-primary-foreground" : "bg-white text-slate-700 hover:bg-slate-50",
            )}
            data-testid={`tea-view-${item.value}`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** "10:31" and the gate under it (with the day when it is not today). */
function TimeAndGate({ at, gate, now }: { at: string; gate: string | null; now: Date }) {
  const today = isTodayIst(at, now);
  return (
    <div className="min-w-0 leading-tight">
      <p className="font-medium tabular-nums text-slate-900">
        {fmtTime(at)}
        {!today && <span className="ml-1.5 text-[11px] font-normal text-slate-500">{fmtDate(at)}</span>}
      </p>
      <p className="truncate text-[11px] text-slate-500" title={gate ?? undefined}>
        {gate ?? "Gate not known"}
      </p>
    </div>
  );
}

function StatusCell({ row, now }: { row: TeaBreakAdminRecord; now: Date }) {
  const status = liveStatus(row, now);
  const open = isOpen(row);
  return (
    <div className="flex items-center gap-1.5">
      <StatusChip tone={STATUS_TONE[status]} testId={`tea-status-${row.id}`}>
        {STATUS_LABEL[status]}
        {open ? ` · ${fmtMinutes(liveMinutes(row, now))}` : ""}
      </StatusChip>
      {row.flag && (
        <StatusChip tone="slate" title={FLAG_NOTE[row.flag]}>
          {row.flagLabel ?? (row.flag === "long" ? "Long break" : "Left open")}
        </StatusChip>
      )}
    </div>
  );
}

function BreaksTable({
  rows,
  total,
  loading,
  error,
  onRetry,
  now,
  allowedFallback,
  summaryLine,
  toolbar,
  pagination,
  selectedKey,
  onOpen,
}: {
  rows: TeaBreakAdminRecord[] | undefined;
  total: number;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  now: Date;
  allowedFallback: number;
  summaryLine: ReactNode;
  toolbar: ReactNode;
  pagination: DataTablePagination;
  selectedKey: number | null;
  onOpen: (row: TeaBreakAdminRecord) => void;
}) {
  const columns: DataColumn<TeaBreakAdminRecord>[] = [
    {
      key: "employee",
      header: "Employee",
      cell: (r) => <PersonCell name={r.employee.name} code={r.employee.employeeCode} photoUrl={r.employee.photoUrl} />,
      minWidth: 180,
      maxWidth: 260,
      truncate: false,
    },
    {
      key: "department",
      header: "Department",
      cell: (r) => r.employee.department ?? NONE,
      text: (r) => r.employee.department,
      hideOnPhone: true,
      maxWidth: 180,
    },
    {
      key: "out",
      header: "Out",
      cell: (r) => <TimeAndGate at={r.outAt} gate={r.outGateName} now={now} />,
      text: (r) => `${fmtDate(r.outAt)} ${fmtTime(r.outAt)}, ${r.outGateName ?? "gate not known"}`,
      minWidth: 96,
    },
    {
      key: "back",
      header: "Back",
      cell: (r) =>
        r.inAt ? (
          <TimeAndGate at={r.inAt} gate={r.inGateName} now={now} />
        ) : (
          <span className="text-xs font-medium text-amber-700">Still out</span>
        ),
      text: (r) =>
        r.inAt ? `${fmtDate(r.inAt)} ${fmtTime(r.inAt)}, ${r.inGateName ?? "gate not known"}` : "Still out",
      minWidth: 96,
    },
    {
      key: "duration",
      header: "Duration",
      cell: (r) => (
        <TimeBar
          minutes={liveMinutes(r, now)}
          allowed={r.allowedMinutes ?? allowedFallback}
          running={isOpen(r)}
          testId={`tea-time-${r.id}`}
        />
      ),
      truncate: false,
      minWidth: 200,
    },
    {
      key: "over",
      header: "Over by",
      align: "right",
      cell: (r) =>
        r.overMinutes ? (
          <span className="font-semibold text-rose-700">+{fmtMinutes(r.overMinutes)}</span>
        ) : (
          <span className="text-slate-400">{NONE}</span>
        ),
      minWidth: 80,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusCell row={r} now={now} />,
      truncate: false,
      minWidth: 150,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.id}
      onRowClick={onOpen}
      rowLabel={(r) => `${r.employee.name}, out at ${fmtTime(r.outAt)}: open the details`}
      selectedKey={selectedKey}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={{ icon: Coffee, title: "No tea breaks match", hint: "Try other dates, or clear the filters." }}
      summary={summaryLine}
      toolbar={toolbar}
      pagination={total > 0 ? pagination : undefined}
      caption="Tea breaks"
      testId="tea-break-list"
    />
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: string;
  sort: string;
  onSort: (key: string) => void;
}) {
  const { key, desc } = readSort(sort);
  const on = key === sortKey;
  const Arrow = desc ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(
        "inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-800",
        on && "text-slate-900",
      )}
      aria-label={`Order by ${label.toLowerCase()}${on ? (desc ? ", high to low" : ", low to high") : ""}`}
      data-testid={`tea-sort-${sortKey}`}
    >
      {label}
      {on && <Arrow size={12} aria-hidden="true" />}
    </button>
  );
}

function EmployeesTable({
  rows,
  loading,
  error,
  onRetry,
  sort,
  onSort,
  summaryLine,
  toolbar,
  pagination,
  onOpen,
}: {
  rows: TeaBreakEmployeeRow[] | undefined;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  sort: string;
  onSort: (key: string) => void;
  summaryLine: ReactNode;
  toolbar: ReactNode;
  pagination: DataTablePagination;
  onOpen: (row: TeaBreakEmployeeRow) => void;
}) {
  const header = (label: string, key: string) => <SortHeader label={label} sortKey={key} sort={sort} onSort={onSort} />;
  const columns: DataColumn<TeaBreakEmployeeRow>[] = [
    {
      key: "employee",
      header: header("Employee", "name"),
      cell: (r) => (
        <PersonCell
          name={r.employee.name}
          code={r.employee.employeeCode}
          sub={r.employee.department}
          photoUrl={r.employee.photoUrl}
        />
      ),
      truncate: false,
      minWidth: 200,
      maxWidth: 280,
    },
    { key: "breaks", header: header("Breaks", "breaks"), cell: (r) => fmtCount(r.breaks), align: "right" },
    {
      key: "total",
      header: header("Total", "total"),
      cell: (r) => fmtMinutes(r.totalMinutes),
      align: "right",
      minWidth: 80,
    },
    {
      key: "avg",
      header: header("Average", "avg"),
      cell: (r) => fmtMinutes(r.avgMinutes),
      align: "right",
      minWidth: 80,
    },
    {
      key: "longest",
      header: header("Longest", "longest"),
      cell: (r) => fmtMinutes(r.longestMinutes),
      align: "right",
      minWidth: 80,
    },
    {
      key: "overtime",
      header: header("Over time", "overtime"),
      cell: (r) =>
        r.overtime ? (
          <span className="text-rose-700">
            <span className="font-semibold">{fmtCount(r.overtime)}</span>
            <span className="ml-1 text-[11px]">({fmtMinutes(r.overMinutesTotal)})</span>
          </span>
        ) : (
          "0"
        ),
      text: (r) => (r.overtime ? `${r.overtime} breaks over, ${fmtMinutes(r.overMinutesTotal)} in all` : null),
      align: "right",
      minWidth: 100,
    },
    {
      key: "notReturned",
      header: header("Not returned", "notReturned"),
      cell: (r) =>
        r.notReturned ? <span className="font-semibold text-rose-700">{fmtCount(r.notReturned)}</span> : "0",
      align: "right",
    },
    {
      key: "onBreakNow",
      header: "On break now",
      cell: (r) =>
        r.onBreakNow ? <StatusChip tone="amber">On break</StatusChip> : <span className="text-slate-400">{NONE}</span>,
      truncate: false,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(r) => r.employee.id}
      onRowClick={onOpen}
      rowLabel={(r) => `${r.employee.name}: show their breaks`}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={{ icon: Users, title: "Nobody took a matching break", hint: "Try other dates, or clear the filters." }}
      summary={summaryLine}
      toolbar={toolbar}
      pagination={pagination && pagination.total > 0 ? pagination : undefined}
      caption="Tea breaks by employee"
      testId="tea-break-employees"
    />
  );
}
