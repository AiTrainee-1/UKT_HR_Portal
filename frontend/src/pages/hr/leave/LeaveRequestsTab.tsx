import { useMemo, useState } from "react";
import {
  CalendarDays,
  CheckCircle,
  CheckCircle2,
  Hourglass,
  Search,
  Sunrise,
  Trash2,
  UserMinus,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { ApprovalTrailLine, PipelineNote } from "@/components/ApprovalTrail";
import { hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import {
  ALL,
  NO_LEAVE_FILTERS,
  branchOptions,
  decidedByLine,
  departmentOptions,
  fmtDays,
  filterLeaves,
  leaveDays,
  leaveExportRows,
  leaveFiltersActive,
  leaveTypesOf,
  LEAVE_EXPORT_HEADERS,
  longDate,
  shortDate,
  sortLeaves,
  summarizeLeaves,
  type LeaveFilters,
  type LeaveRow,
} from "./logic";
import { exportSheet } from "./export";
import {
  Chip,
  DateField,
  EmptyState,
  ErrorState,
  ExportButton,
  FilterPanel,
  FilterSelect,
  ListSkeleton,
  MoreRows,
  PersonCell,
  ResultLine,
  SearchBox,
  StatCard,
  StatusChip,
  useVisibleCount,
} from "./parts";

type Props = {
  /** Full-day requests ("leave") or half-day requests ("half"). */
  mode: "leave" | "half";
  rows: LeaveRow[];
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  today: string;
  busy: boolean;
  onOpen: (leave: LeaveRow) => void;
  onDecide: (leave: LeaveRow, status: "approved" | "rejected") => void;
  onDelete: (leave: LeaveRow) => void;
};

const STATUS_PILLS = ["all", "pending", "approved", "rejected"] as const;

export default function LeaveRequestsTab({
  mode,
  rows,
  loading,
  failed,
  onRetry,
  today,
  busy,
  onOpen,
  onDecide,
  onDelete,
}: Props) {
  const half = mode === "half";
  const [filters, setFilters] = useState<LeaveFilters>(NO_LEAVE_FILTERS);
  const set = (patch: Partial<LeaveFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const visible = useVisibleCount();

  const summary = useMemo(() => summarizeLeaves(rows, today), [rows, today]);
  const shown = useMemo(() => sortLeaves(filterLeaves(rows, filters)), [rows, filters]);
  const active = leaveFiltersActive(filters);
  const branches = useMemo(() => branchOptions(rows), [rows]);
  const departments = useMemo(() => departmentOptions(rows), [rows]);
  const types = useMemo(() => leaveTypesOf(rows), [rows]);
  const noun = half ? "half-day requests" : "leave requests";
  const counts: Record<string, number> = {
    all: rows.length,
    pending: summary.pending,
    approved: summary.approved,
    rejected: summary.rejected,
  };

  const clear = () => setFilters(NO_LEAVE_FILTERS);

  return (
    <div className="space-y-4 pt-4" data-testid={half ? "tab-half-day" : "tab-leaves"}>
      <PipelineNote workflow="leave" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Waiting for a decision"
          value={summary.pending}
          sub={summary.pending ? "Oldest first in the list" : "Nothing waiting"}
          icon={Hourglass}
          tone="bg-amber-50 text-amber-800"
          testId={`${mode}-stat-pending`}
          onClick={() => set({ status: filters.status === "pending" ? ALL : "pending" })}
          active={filters.status === "pending"}
        />
        <StatCard
          label="Approved"
          value={summary.approved}
          sub={half ? "half days" : `${fmtDays(summary.approvedDays)} days of leave`}
          icon={CheckCircle2}
          tone="bg-emerald-50 text-emerald-800"
          testId={`${mode}-stat-approved`}
          onClick={() => set({ status: filters.status === "approved" ? ALL : "approved" })}
          active={filters.status === "approved"}
        />
        <StatCard
          label="Rejected"
          value={summary.rejected}
          icon={XCircle}
          tone="bg-red-50 text-red-800"
          testId={`${mode}-stat-rejected`}
          onClick={() => set({ status: filters.status === "rejected" ? ALL : "rejected" })}
          active={filters.status === "rejected"}
        />
        <StatCard
          label={half ? "All requests" : "Away today"}
          value={half ? summary.total : summary.onLeaveToday}
          sub={half ? undefined : "approved leave covering today"}
          icon={half ? Sunrise : UserMinus}
          tone="bg-blue-50 text-blue-800"
          testId={`${mode}-stat-extra`}
        />
      </div>

      <FilterPanel>
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => set({ query })}
            placeholder="Search by name, employee code, department or branch"
            label={`Search ${noun}`}
            testId={`${mode}-search`}
          />
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => set({ branch })}
              label="Filter by branch"
              allLabel="All branches"
              options={branches}
              testId={`${mode}-filter-branch`}
            />
            <FilterSelect
              value={filters.department}
              onChange={(department) => set({ department })}
              label="Filter by department"
              allLabel="All departments"
              options={departments}
              testId={`${mode}-filter-department`}
            />
            <FilterSelect
              value={filters.employeeType}
              onChange={(employeeType) => set({ employeeType })}
              label="Filter by employee type"
              allLabel="Staff and production"
              options={[
                { value: "staff", label: "Staff" },
                { value: "production", label: "Production" },
              ]}
              testId={`${mode}-filter-employee-type`}
            />
            {!half && (
              <FilterSelect
                value={filters.type}
                onChange={(type) => set({ type })}
                label="Filter by leave type"
                allLabel="All leave types"
                options={types.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
                testId="leave-filter-type"
              />
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <DateField label="From" value={filters.from} onChange={(from) => set({ from })} testId={`${mode}-from`} />
          <DateField label="To" value={filters.to} onChange={(to) => set({ to })} testId={`${mode}-to`} />
          <div className="ml-auto">
            <ExportButton
              disabled={shown.length === 0}
              testId={`${mode}-export`}
              onClick={() =>
                exportSheet(half ? "Half-day leave" : "Leave requests", LEAVE_EXPORT_HEADERS, leaveExportRows(shown))
              }
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs
            size="sm"
            items={STATUS_PILLS.map((s) => ({
              value: s,
              label: s.charAt(0).toUpperCase() + s.slice(1),
              count: counts[s],
            }))}
            value={filters.status}
            onChange={(status) => set({ status })}
          />
          <ResultLine
            shown={shown.length}
            total={rows.length}
            noun={noun}
            active={active}
            onClear={clear}
            testId={`${mode}-count`}
          />
        </div>
      </FilterPanel>

      <div className="space-y-3">
        {loading ? (
          <Card className="rounded-2xl">
            <ListSkeleton testId={`${mode}-loading`} />
          </Card>
        ) : failed ? (
          <Card className="rounded-2xl">
            <ErrorState what={noun} onRetry={onRetry} />
          </Card>
        ) : rows.length === 0 ? (
          <Card className="rounded-2xl">
            <EmptyState
              icon={half ? Sunrise : CalendarDays}
              title={half ? "No half-day requests yet" : "No leave requests yet"}
              text="Requests arrive from the employee app. They appear here as soon as someone sends one."
              testId={`${mode}-empty`}
            />
          </Card>
        ) : shown.length === 0 ? (
          <Card className="rounded-2xl">
            <EmptyState
              icon={Search}
              title={`No ${noun} match`}
              text="Try fewer words, a wider date range, or clear the filters."
              tone="bg-gray-100 text-gray-500"
              testId={`${mode}-no-match`}
              action={
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {shown.slice(0, visible.count).map((leave) => (
              <LeaveCard
                key={leave.id}
                leave={leave}
                half={half}
                busy={busy}
                onOpen={onOpen}
                onDecide={onDecide}
                onDelete={onDelete}
              />
            ))}
            <MoreRows shown={Math.min(visible.count, shown.length)} total={shown.length} onMore={visible.more} />
          </>
        )}
      </div>
    </div>
  );
}

const STRIPE: Record<string, string> = {
  pending: "border-l-amber-400",
  approved: "border-l-emerald-500",
  rejected: "border-l-red-400",
};

function LeaveCard({
  leave,
  half,
  busy,
  onOpen,
  onDecide,
  onDelete,
}: {
  leave: LeaveRow;
  half: boolean;
  busy: boolean;
  onOpen: (leave: LeaveRow) => void;
  onDecide: (leave: LeaveRow, status: "approved" | "rejected") => void;
  onDelete: (leave: LeaveRow) => void;
}) {
  const pending = leave.status === "pending";
  const days = leaveDays(leave);
  const single = leave.startDate === leave.endDate;
  const by = decidedByLine(leave);
  const where = [leave.department, leave.branch].filter(Boolean).join(" · ");
  return (
    <Card
      data-testid={`leave-${leave.id}`}
      className={cn(
        "cursor-pointer rounded-2xl border border-l-4 transition-shadow hover:shadow-md",
        STRIPE[leave.status],
      )}
      onClick={() => onOpen(leave)}
    >
      <CardContent className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1 space-y-1.5">
            <PersonCell id={leave.employeeId} name={leave.employeeName} code={leave.employeeCode} sub={where || null} />
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusChip status={leave.status} approval={leave.approval} />
              {half ? (
                <Chip className={TONE.info}>
                  <Sunrise size={11} /> {leave.halfDaySlot === "afternoon" ? "Afternoon" : "Morning"}
                </Chip>
              ) : (
                <Chip className="border-gray-200 bg-white capitalize text-gray-700">{leave.type}</Chip>
              )}
              {leave.employmentType === "production" && (
                <Chip className="border-orange-200 bg-orange-50 text-orange-700">Production</Chip>
              )}
            </div>
            <p className="text-xs text-gray-600">
              {single || half ? (
                longDate(leave.startDate)
              ) : (
                <>
                  {shortDate(leave.startDate)} to {shortDate(leave.endDate)}
                </>
              )}
              <span className="text-gray-400"> · </span>
              {half ? "Half day" : `${fmtDays(days)} day${days === 1 ? "" : "s"}`}
            </p>
            {leave.reason && <p className="truncate text-xs text-gray-400">{leave.reason}</p>}
            <ApprovalTrailLine approval={leave.approval} />
            {by && <p className="text-[11px] text-gray-400">{by}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
            {pending && hrCanAct(leave.approval, true) && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 border-green-200 text-green-700 hover:bg-green-50"
                onClick={() => onDecide(leave, "approved")}
                disabled={busy}
              >
                <CheckCircle size={13} /> Approve
              </Button>
            )}
            {pending && hrCanReject(leave.approval, true) && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1 border-red-200 text-red-600 hover:bg-red-50"
                onClick={() => onDecide(leave, "rejected")}
                disabled={busy}
              >
                <XCircle size={13} /> Reject
              </Button>
            )}
            {/* icon only on purpose: the View Only lock hides a bare bin, but would only grey out a labelled one */}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-red-400 hover:text-red-600"
              onClick={() => onDelete(leave)}
              disabled={busy}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
