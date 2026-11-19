import { useMemo } from "react";
import { LogOut, Mail, MessageCircle, UserPlus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  VISITOR_ADMIN_API,
  useVisitorFilterOptions,
  useVisitorVisits,
  type VisitorDashboardSummary,
  type VisitorVisit,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  ClearFilters,
  DataTable,
  DateRangeFilter,
  ExportButton,
  FilterBar,
  NONE,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatusChip,
  WhenCell,
  fmtCount,
  fmtDateTime,
  fmtMinutes,
  toneOf,
  type DataColumn,
  type GateFilters,
} from "../kit";
import {
  SOURCE_OPTIONS,
  STATUS_OPTIONS,
  VISIT_FILTER_DEFAULTS,
  apiQuery,
  canCheckOut,
  errorText,
  hostName,
  isLongStay,
  maskPhone,
} from "./logic";

type Filters = GateFilters<typeof VISIT_FILTER_DEFAULTS>;

/**
 * The Visits view: one filter row (dates, status, host, the host's department, how the visitor was checked in, the branch
 * for an account not bound to one, search, Clear, Export) and the table of visits. A row opens the visit; an inside
 * visitor's row has a Check out button (edit roles).
 */
export function VisitsPanel({
  filters: f,
  isBranchScoped,
  branches,
  canEdit,
  summary,
  selectedId,
  onOpen,
  onCheckOut,
  onRegister,
}: {
  filters: Filters;
  isBranchScoped: boolean;
  branches: { id: number; name: string }[] | undefined;
  canEdit: boolean;
  summary: VisitorDashboardSummary | undefined;
  selectedId: number | null;
  onOpen: (visit: VisitorVisit) => void;
  onCheckOut: (visit: VisitorVisit) => void;
  onRegister: () => void;
}) {
  const query = apiQuery(f.params);
  const list = useVisitorVisits(query);
  const options = useVisitorFilterOptions(isBranchScoped ? "" : f.filters.branchId);
  const now = new Date();

  const hostOptions = useMemo(
    () =>
      (options.data?.hosts ?? []).map((h) => ({
        value: String(h.id),
        label: h.department ? `${h.name} (${h.department})` : h.name,
      })),
    [options.data],
  );
  const departmentOptions = useMemo(
    () => (options.data?.departments ?? []).map((d) => ({ value: String(d.id), label: d.name })),
    [options.data],
  );
  const branchOptions = useMemo(
    () => (branches ?? []).map((b) => ({ value: String(b.id), label: b.name })),
    [branches],
  );

  const columns: DataColumn<VisitorVisit>[] = [
    {
      key: "visitor",
      header: "Visitor",
      cell: (v) => <PersonCell name={v.name} sub={v.company} size={30} />,
      text: (v) => [v.name, v.company].filter(Boolean).join(" · "),
      minWidth: 160,
      maxWidth: 220,
    },
    {
      key: "phone",
      header: "Phone",
      cell: (v) => <span className="font-mono text-[12px] text-slate-700">{maskPhone(v.phone)}</span>,
      hideOnPhone: true,
    },
    {
      key: "host",
      header: "Meeting",
      cell: (v) => (
        <span className="block min-w-0">
          <span className="block truncate font-medium text-slate-900">{hostName(v)}</span>
          {v.meetingEmployee?.department && (
            <span className="block truncate text-[11px] text-slate-500">{v.meetingEmployee.department}</span>
          )}
        </span>
      ),
      text: (v) => [hostName(v), v.meetingEmployee?.department].filter(Boolean).join(" · "),
      maxWidth: 200,
    },
    {
      key: "purpose",
      header: "Purpose",
      cell: (v) => v.purpose,
      text: (v) => v.purpose,
      maxWidth: 200,
      hideOnPhone: true,
    },
    { key: "in", header: "In", cell: (v) => <WhenCell value={v.visitedAt} now={now} />, truncate: false },
    {
      key: "out",
      header: "Out",
      truncate: false,
      cell: (v) =>
        v.checkedOutAt ? (
          <WhenCell value={v.checkedOutAt} now={now} />
        ) : canCheckOut(v) && canEdit ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-1 px-2.5 text-xs sm:h-8"
            onClick={() => onCheckOut(v)}
            aria-label={`Check out ${v.name}`}
            data-testid={`check-out-${v.id}`}
          >
            <LogOut size={13} aria-hidden="true" /> Check out
          </Button>
        ) : (
          <span className="text-slate-400">{NONE}</span>
        ),
    },
    {
      key: "time",
      header: "Time inside",
      align: "right",
      hideOnPhone: true,
      cell: (v) => (
        <span className={cn("tabular-nums", isLongStay(v) ? "font-semibold text-rose-700" : "text-slate-700")}>
          {v.minutesInside === null ? NONE : fmtMinutes(v.minutesInside)}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      truncate: false,
      cell: (v) => <StatusChip tone={toneOf(v.status)}>{v.statusLabel}</StatusChip>,
    },
    {
      key: "notified",
      header: "Host told",
      truncate: false,
      hideOnPhone: true,
      cell: (v) =>
        v.meetingEmployee ? (
          <span className="flex items-center gap-1">
            <Told icon={Mail} label="Email" at={v.notifiedEmailAt} />
            <Told icon={MessageCircle} label="WhatsApp" at={v.notifiedWhatsappAt} />
          </span>
        ) : (
          <span className="text-slate-400">{NONE}</span>
        ),
    },
    ...(isBranchScoped
      ? []
      : [
          {
            key: "branch",
            header: "Branch",
            cell: (v: VisitorVisit) => v.branchName ?? NONE,
            text: (v: VisitorVisit) => v.branchName,
            hideOnPhone: true,
          },
        ]),
  ];

  const total = list.data?.total ?? 0;
  const inRange = summary?.inRange;
  const summaryLine = list.data ? (
    <span data-testid="visitors-summary-line">
      {fmtCount(total)} {total === 1 ? "visit" : "visits"}
      {inRange && inRange.visits === total && (
        <>
          {" · "}
          {fmtCount(inRange.checkedOut)} checked out
          {inRange.avgMinutes !== null && <> · {fmtMinutes(inRange.avgMinutes)} on average</>}
        </>
      )}
    </span>
  ) : null;

  return (
    <div className="space-y-3">
      <FilterBar
        label="Visit filters"
        testId="visitors-filters"
        actions={
          <ExportButton
            title="Visitors"
            path={VISITOR_ADMIN_API.export}
            query={new URLSearchParams(apiQuery(f.exportQuery))}
            hints={{ xlsx: "Every matching visit", pdf: "Up to 5,000 visits" }}
            testId="visitors-export"
          />
        }
      >
        <DateRangeFilter
          range={f.filters.range}
          from={f.filters.from}
          to={f.filters.to}
          onChange={(patch) => f.set(patch)}
          testId="visitors-dates"
        />
        <SelectFilter
          label="Status"
          value={f.filters.status}
          onChange={(status) => f.set({ status })}
          options={STATUS_OPTIONS}
          allLabel="All statuses"
          testId="visitors-status"
        />
        <SelectFilter
          label="Meeting"
          value={f.filters.hostEmployeeId}
          onChange={(hostEmployeeId) => f.set({ hostEmployeeId })}
          options={hostOptions}
          allLabel="Anyone they met"
          testId="visitors-host"
        />
        <SelectFilter
          label="Department"
          value={f.filters.departmentId}
          onChange={(departmentId) => f.set({ departmentId })}
          options={departmentOptions}
          allLabel="All departments"
          testId="visitors-department"
        />
        <SelectFilter
          label="Checked in by"
          value={f.filters.source}
          onChange={(source) => f.set({ source })}
          options={SOURCE_OPTIONS}
          allLabel="Any check-in"
          testId="visitors-source"
        />
        {!isBranchScoped && (
          <SelectFilter
            label="Branch"
            value={f.filters.branchId}
            onChange={(branchId) => f.set({ branchId, hostEmployeeId: "", departmentId: "" })}
            options={branchOptions}
            allLabel="All branches"
            testId="visitors-branch"
          />
        )}
        <SearchFilter
          value={f.filters.q}
          onChange={(q) => f.set({ q })}
          placeholder="Name, phone, company, purpose"
          label="Search visits"
          testId="visitors-search"
        />
        <ClearFilters count={f.activeCount} onClear={f.clear} testId="visitors-clear" />
      </FilterBar>

      <DataTable
        columns={columns}
        rows={list.data?.items}
        rowKey={(v) => v.id}
        onRowClick={onOpen}
        rowLabel={(v) => `Open the visit of ${v.name}, ${fmtDateTime(v.visitedAt)}`}
        selectedKey={selectedId}
        loading={list.isLoading || list.isPlaceholderData}
        error={list.isError ? errorText(list.error, "Check the connection and try again.") : null}
        onRetry={() => list.refetch()}
        summary={summaryLine}
        caption="Visits"
        testId="visitors-list"
        empty={{
          icon: UsersRound,
          title: "No visitors for these filters",
          hint: "Try other dates, or clear the filters.",
          action: canEdit ? (
            <Button type="button" size="sm" className="gap-1.5" onClick={onRegister}>
              <UserPlus size={14} aria-hidden="true" /> Register visitor
            </Button>
          ) : undefined,
        }}
        pagination={
          list.data
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

function Told({ icon: Icon, label, at }: { icon: typeof Mail; label: string; at: string | null }) {
  return (
    <span
      className={cn(
        "inline-flex size-7 items-center justify-center rounded-full border",
        at ? "border-teal-200 bg-teal-50 text-teal-700" : "border-slate-200 bg-slate-50 text-slate-400",
      )}
      title={at ? `${label} sent ${fmtDateTime(at)}` : `${label} not sent`}
    >
      <Icon size={13} aria-hidden="true" />
      <span className="sr-only">{at ? `${label} sent` : `${label} not sent`}</span>
    </span>
  );
}
