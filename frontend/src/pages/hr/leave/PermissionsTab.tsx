import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle, CheckCircle2, Clock, Hourglass, Plus, Search, ShieldAlert, Trash2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { ApprovalTrailLine, PipelineNote, WaitingChip } from "@/components/ApprovalTrail";
import { explainsWaiting, hrCanAct, hrCanReject } from "@/lib/approval-workflow";
import { useToast } from "@/hooks/use-toast";
import {
  useApprovalSummary,
  useCreatePermission,
  useDeletePermission,
  useListEmployeesLite,
  useListPermissions,
  usePayrollSettings,
  useUpdatePermissionStatus,
  type PermissionItem,
  type PermissionType,
} from "@/lib/api-client";
import {
  PERMISSION_MINUTES,
  PERMISSION_TYPES,
  permissionOutcome,
  permissionTypeKey,
  permissionTypeLabel,
  permissionTypeWire,
} from "@/lib/late-detection";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { exportSheet } from "./export";
import {
  ALL,
  MONTHS_SHORT,
  NO_PERMISSION_FILTERS,
  branchOptions,
  departmentOptions,
  filterPermissions,
  longDate,
  permissionFiltersActive,
  type PermissionFilters,
  type PermissionRow,
} from "./logic";
import {
  AddPermissionDialog,
  PermissionDetailDialog,
  emptyPermissionForm,
  type PermissionForm,
} from "./PermissionDialogs";
import {
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
  useVisibleCount,
} from "./parts";
import { ConfirmDialog } from "./ConfirmDialog";

type PermissionFull = PermissionItem & {
  departmentId?: number | null;
  branchId?: number | null;
  branch?: string | null;
  employmentType?: string | null;
};

const STATUS_PILLS = [
  { value: "all", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "excess", label: "Overdue / Excess" },
  { value: "rejected", label: "Not Allowed" },
];

const STRIPE: Record<string, string> = {
  pending: "border-l-amber-400",
  approved: "border-l-emerald-500",
  rejected: "border-l-red-400",
};

export default function PermissionsTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const now = new Date();
  const [month, setMonth] = useState<string>(ALL);
  const [year, setYear] = useState(now.getFullYear());
  const [filters, setFilters] = useState<PermissionFilters>(NO_PERMISSION_FILTERS);
  const set = (patch: Partial<PermissionFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const visible = useVisibleCount();

  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<PermissionForm>(emptyPermissionForm);
  const [selected, setSelected] = useState<PermissionFull | null>(null);
  // The type HR has picked in the details dialog ("" = the request has none yet and none is picked).
  const [typeDraft, setTypeDraft] = useState<PermissionType | "">("");
  const [toDelete, setToDelete] = useState<PermissionFull | null>(null);

  // Polled: a mobile HOD approval writes straight to the DB and nothing tells an HR user parked on this page.
  const query = useListPermissions({ ...(month !== ALL ? { month: Number(month) } : {}), year }, {
    refetchInterval: 30_000,
  } as any);
  const rows = useMemo(() => (query.data ?? []) as PermissionFull[], [query.data]);
  const { data: employees } = useListEmployeesLite();
  const { data: payrollSettings } = usePayrollSettings();
  const cap = payrollSettings?.permissionMonthlyCap ?? 3;
  const createMutation = useCreatePermission();
  const updateMutation = useUpdatePermissionStatus();
  const deleteMutation = useDeletePermission();
  // Re-typing a permission that is already decided is a revision, which the server only allows when HR is in its pipeline.
  const { data: pipelines } = useApprovalSummary();
  const hrRevises = pipelines?.permission ? pipelines.permission.steps.some((s) => s.roles.includes("hr")) : true;

  // "Allowed" is the server's word for approved-within-the-cap; a backend that does not report the cap (no capStatus on any
  // approved request) just has "Approved", counted as such.
  const capReported = rows.some((p) => p.capStatus != null);
  const stats = useMemo(
    () => ({
      pending: rows.filter((p) => p.status === "pending").length,
      approved: rows.filter((p) => p.status === "approved").length,
      allowed: rows.filter((p) => p.status === "approved" && p.capStatus === "within_cap").length,
      excess: rows.filter((p) => p.status === "approved" && p.capStatus === "excess").length,
      rejected: rows.filter((p) => p.status === "rejected").length,
    }),
    [rows],
  );
  const shown = useMemo(() => filterPermissions(rows as PermissionRow[], filters) as PermissionFull[], [rows, filters]);
  const branches = useMemo(() => branchOptions(rows), [rows]);
  const departments = useMemo(() => departmentOptions(rows), [rows]);
  const active = permissionFiltersActive(filters) || month !== ALL;
  const clear = () => {
    setFilters(NO_PERMISSION_FILTERS);
    setMonth(ALL);
  };

  // Every permission list, whatever its filters: deciding one request can flip a later one that month between Allowed and
  // Overdue / Excess (the cap counts earliest date first), so a single filtered key is not enough.
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/permissions"] });
  const selectedKey = selected ? permissionTypeKey(selected) : null;

  const open = (p: PermissionFull) => {
    setSelected(p);
    setTypeDraft(permissionTypeKey(p) ?? "");
  };

  const add = async () => {
    if (!form.employeeId || !form.date) {
      toast({ title: "Please select an employee and date", variant: "destructive" });
      return;
    }
    if (!form.type) {
      toast({ title: "Please choose the permission type", variant: "destructive" });
      return;
    }
    let created: PermissionItem;
    try {
      created = await createMutation.mutateAsync({
        employeeId: Number(form.employeeId),
        date: form.date,
        type: permissionTypeWire(form.type),
        permissionTime: form.permissionTime || undefined,
        reason: form.reason || undefined,
      });
    } catch (err: any) {
      toast({ title: err?.message || "Failed to add permission", variant: "destructive" });
      return;
    }
    toast({
      title: `${permissionTypeLabel(created) ?? "Permission"} added`,
      description:
        created.monthlyUsed != null
          ? `${created.monthlyUsed} pending or approved permission${created.monthlyUsed === 1 ? "" : "s"} this month. Only the first ${created.monthlyLimit} approved are Allowed.`
          : undefined,
    });
    setForm(emptyPermissionForm());
    setShowAdd(false);
    refresh();
  };

  // `type` classifies the request as it is decided (HR can set it on an untyped one, or correct a mis-picked one).
  const decide = async (p: PermissionItem, status: "approved" | "rejected", type?: PermissionType) => {
    try {
      await updateMutation.mutateAsync({
        id: p.id,
        data: { status, ...(type ? { type: permissionTypeWire(type) } : {}) },
      });
    } catch (err) {
      toast({
        title: "Failed to update permission",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: `Permission ${status}` });
    refresh();
  };

  // Re-classify a request without deciding it (the detail dialog's "Save type").
  const saveType = async (p: PermissionItem, type: PermissionType) => {
    let updated: PermissionItem;
    try {
      updated = await updateMutation.mutateAsync({ id: p.id, data: { type: permissionTypeWire(type) } });
    } catch (err) {
      toast({
        title: "Failed to update permission type",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      return;
    }
    setSelected((prev) => (prev ? { ...prev, ...updated } : prev));
    setTypeDraft(permissionTypeKey(updated) ?? "");
    refresh();
    // An older backend ignores the type on update: say so instead of announcing a change that did not happen.
    if (permissionTypeKey(updated) !== type) {
      toast({ title: "The server did not change the permission type", variant: "destructive" });
      return;
    }
    toast({ title: "Permission type updated" });
  };

  const remove = async (p: PermissionItem) => {
    try {
      await deleteMutation.mutateAsync(p.id);
    } catch {
      toast({ title: "Failed to delete permission", variant: "destructive" });
      return;
    }
    toast({ title: "Permission deleted" });
    refresh();
  };

  const years = Array.from({ length: 7 }, (_, i) => now.getFullYear() - 5 + i);
  if (!years.includes(year)) years.push(year);

  return (
    <div className="space-y-4 pt-4" data-testid="tab-permissions">
      <PipelineNote workflow="permission" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Pending"
          value={stats.pending}
          icon={Hourglass}
          tone="bg-amber-50 text-amber-800"
          testId="perm-stat-pending"
          onClick={() => set({ status: filters.status === "pending" ? ALL : "pending" })}
          active={filters.status === "pending"}
        />
        <StatCard
          label={capReported ? "Allowed" : "Approved"}
          value={capReported ? stats.allowed : stats.approved}
          sub={capReported ? `within the monthly cap of ${cap}` : undefined}
          icon={CheckCircle2}
          tone="bg-emerald-50 text-emerald-800"
          testId="perm-stat-allowed"
          onClick={() => set({ status: filters.status === "approved" ? ALL : "approved" })}
          active={filters.status === "approved"}
        />
        <StatCard
          label="Overdue / Excess"
          value={stats.excess}
          sub="approved beyond the cap"
          icon={ShieldAlert}
          tone="bg-orange-50 text-orange-800"
          testId="perm-stat-excess"
          onClick={() => set({ status: filters.status === "excess" ? ALL : "excess" })}
          active={filters.status === "excess"}
        />
        <StatCard
          label="Not Allowed"
          value={stats.rejected}
          icon={XCircle}
          tone="bg-red-50 text-red-800"
          testId="perm-stat-rejected"
          onClick={() => set({ status: filters.status === "rejected" ? ALL : "rejected" })}
          active={filters.status === "rejected"}
        />
      </div>

      <FilterPanel>
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => set({ query })}
            placeholder="Search by name, employee code, department or branch"
            label="Search permissions"
            testId="perm-search"
          />
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => set({ branch })}
              label="Filter by branch"
              allLabel="All branches"
              options={branches}
              testId="perm-filter-branch"
            />
            <FilterSelect
              value={filters.department}
              onChange={(department) => set({ department })}
              label="Filter by department"
              allLabel="All departments"
              options={departments}
              testId="perm-filter-department"
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
              testId="perm-filter-employee-type"
            />
            <FilterSelect
              value={filters.type}
              onChange={(type) => set({ type })}
              label="Filter by permission type"
              allLabel="All types"
              options={[
                ...PERMISSION_TYPES.map((t) => ({ value: t.key, label: t.label })),
                { value: "none", label: "Type not set" },
              ]}
              testId="perm-filter-type"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
            Month
            <select
              value={month}
              onChange={(e) => setMonth(e.target.value)}
              aria-label="Month"
              className="h-10 rounded-md border bg-background px-2 text-sm"
              data-testid="perm-month"
            >
              <option value={ALL}>All months</option>
              {MONTHS_SHORT.map((m, i) => (
                <option key={m} value={i + 1}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs font-medium text-gray-500">
            Year
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              aria-label="Year"
              className="h-10 rounded-md border bg-background px-2 text-sm"
              data-testid="perm-year"
            >
              {years
                .sort((a, b) => a - b)
                .map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
            </select>
          </label>
          <DateField label="From" value={filters.from} onChange={(from) => set({ from })} testId="perm-from" />
          <DateField label="To" value={filters.to} onChange={(to) => set({ to })} testId="perm-to" />
          <div className="ml-auto flex items-center gap-2">
            <ExportButton
              disabled={shown.length === 0}
              testId="perm-export"
              onClick={() =>
                exportSheet(
                  "Permissions",
                  [
                    "Employee code",
                    "Employee",
                    "Branch",
                    "Department",
                    "Date",
                    "Time",
                    "Type",
                    "Outcome",
                    "Decided by",
                    "Reason",
                  ],
                  shown.map((p) => [
                    p.employeeCode,
                    p.employeeName,
                    p.branch ?? "",
                    p.department ?? "",
                    p.date,
                    p.permissionTime ?? "",
                    permissionTypeLabel(p) ?? "Not set",
                    permissionOutcome(p).label,
                    p.approvedBy ?? "",
                    p.reason ?? "",
                  ]),
                )
              }
            />
            <Button onClick={() => setShowAdd(true)} className="h-10 gap-1.5">
              <Plus size={15} /> Add Permission
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs size="sm" items={STATUS_PILLS} value={filters.status} onChange={(status) => set({ status })} />
          <ResultLine
            shown={shown.length}
            total={rows.length}
            noun="permissions"
            active={active}
            onClear={clear}
            testId="perm-count"
          />
        </div>
      </FilterPanel>

      <div className="space-y-3">
        {query.isLoading ? (
          <Card className="rounded-2xl">
            <ListSkeleton testId="perm-loading" />
          </Card>
        ) : query.isError ? (
          <Card className="rounded-2xl">
            <ErrorState what="permissions" onRetry={() => query.refetch()} />
          </Card>
        ) : rows.length === 0 ? (
          <Card className="rounded-2xl">
            <EmptyState
              icon={Clock}
              title={
                month === ALL
                  ? `No permissions in ${year}`
                  : `No permissions in ${MONTHS_SHORT[Number(month) - 1]} ${year}`
              }
              text="Permissions are requested from the employee app, or added here for someone."
              testId="perm-empty"
              action={
                <Button onClick={() => setShowAdd(true)} className="gap-1.5">
                  <Plus size={15} /> Add Permission
                </Button>
              }
            />
          </Card>
        ) : shown.length === 0 ? (
          <Card className="rounded-2xl">
            <EmptyState
              icon={Search}
              title="No permission matches"
              text="Try fewer words, a wider date range, or clear the filters."
              tone="bg-gray-100 text-gray-500"
              testId="perm-no-match"
              action={
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          </Card>
        ) : (
          <>
            {shown.slice(0, visible.count).map((p) => {
              const outcome = permissionOutcome(p);
              const typeLabel = permissionTypeLabel(p);
              const typed = permissionTypeKey(p) != null;
              const where = [p.department, p.branch].filter(Boolean).join(" · ");
              return (
                <Card
                  key={p.id}
                  data-testid={`permission-${p.id}`}
                  className={cn(
                    "cursor-pointer rounded-2xl border border-l-4 transition-shadow hover:shadow-md",
                    STRIPE[p.status],
                  )}
                  onClick={() => open(p)}
                >
                  <CardContent className="p-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0 flex-1 space-y-1.5">
                        <PersonCell id={p.employeeId} name={p.employeeName} code={p.employeeCode} sub={where || null} />
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            className={`border text-xs ${outcome.className}`}
                            title={outcome.explanation || undefined}
                          >
                            {outcome.label}
                          </Badge>
                          {p.status === "pending" && explainsWaiting(p.approval) && (
                            <WaitingChip approval={p.approval} className="text-xs" />
                          )}
                          {typeLabel ? (
                            <Badge variant="outline" className="text-xs">
                              {typeLabel}
                            </Badge>
                          ) : (
                            <Badge
                              className={`border text-xs ${TONE.warning}`}
                              title="This request has no type, so approving it cannot move a shift boundary until HR sets one."
                            >
                              Type not set
                            </Badge>
                          )}
                          <span className="text-xs text-gray-400">{p.durationMinutes ?? PERMISSION_MINUTES} min</span>
                        </div>
                        <p className="text-xs text-gray-600">
                          {longDate(p.date)}
                          {p.permissionTime && <span className="ml-2">at {p.permissionTime}</span>}
                        </p>
                        {p.status !== "rejected" && outcome.explanation && (
                          <p
                            className={`text-[11px] ${p.capStatus === "excess" ? "text-orange-700" : "text-gray-500"}`}
                          >
                            {outcome.explanation}
                          </p>
                        )}
                        {p.reason && <p className="truncate text-xs text-gray-400">{p.reason}</p>}
                        {p.hrComment && <p className="text-xs italic text-blue-600">HR: {p.hrComment}</p>}
                        <ApprovalTrailLine approval={p.approval} />
                        {p.approvedBy && (
                          <p className="text-[11px] text-gray-400">
                            {p.status === "rejected" ? "Rejected By" : "Approved By"}: {p.approvedBy}
                            {p.approverRole === "dept_head" ? " (Dept Head)" : " (HR)"}
                          </p>
                        )}
                        {p.monthlyUsed != null && (
                          <div className="flex items-center gap-2 pt-1">
                            <div className="flex gap-0.5">
                              {Array.from({ length: p.monthlyLimit }).map((_, i) => (
                                <div
                                  key={i}
                                  className={`h-1.5 w-4 rounded-full ${i < p.monthlyUsed! ? "bg-amber-400" : "bg-gray-200"}`}
                                />
                              ))}
                            </div>
                            <span className="text-xs text-gray-400">
                              {p.monthlyUsed}/{p.monthlyLimit} this month
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {p.status === "pending" && hrCanAct(p.approval, true) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 border-green-200 text-green-700 hover:bg-green-50"
                            // A request with no type at all (not merely no typeKey: an older backend sends the type only
                            // in the legacy field) cannot move any boundary, so it opens the details where HR can pick
                            // one, and still approve without.
                            onClick={() => (typed ? decide(p, "approved") : open(p))}
                            disabled={updateMutation.isPending}
                          >
                            <CheckCircle size={13} /> {typed ? "Approve" : "Set type & approve"}
                          </Button>
                        )}
                        {p.status === "pending" && hrCanReject(p.approval, true) && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-8 gap-1 border-red-200 text-red-600 hover:bg-red-50"
                            onClick={() => decide(p, "rejected")}
                            disabled={updateMutation.isPending}
                          >
                            <XCircle size={13} /> Reject
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-red-400 hover:text-red-600"
                          onClick={() => setToDelete(p)}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            <MoreRows shown={Math.min(visible.count, shown.length)} total={shown.length} onMore={visible.more} />
          </>
        )}
      </div>

      <AddPermissionDialog
        open={showAdd}
        onOpenChange={setShowAdd}
        form={form}
        setForm={setForm}
        employees={employees?.filter((e) => e.status === "active")}
        cap={cap}
        saving={createMutation.isPending}
        onSave={add}
      />
      <PermissionDetailDialog
        permission={selected}
        onClose={() => setSelected(null)}
        typeDraft={typeDraft}
        setTypeDraft={setTypeDraft}
        selectedKey={selectedKey}
        canRevise={hrRevises}
        saving={updateMutation.isPending}
        onDecide={decide}
        onSaveType={saveType}
      />
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete this permission?"
        description={
          toDelete
            ? `${toDelete.employeeName}'s permission on ${longDate(toDelete.date)} will be removed. This cannot be undone.`
            : ""
        }
        confirmLabel="Delete"
        onCancel={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) void remove(toDelete);
          setToDelete(null);
        }}
        testId="confirm-delete-permission"
      />
    </div>
  );
}
