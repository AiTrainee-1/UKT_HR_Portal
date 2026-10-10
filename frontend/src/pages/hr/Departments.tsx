import { useMemo, useState } from "react";
import { Briefcase, Building2, CircleOff, Download, Factory, Plus, Search, Users, X } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { EmployeeAssignmentLookup } from "@/components/EmployeeAssignmentLookup";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useAssignEmployee, useDeleteDepartment } from "@/lib/api-client";
import AssignDialog from "./org-structure/AssignDialog";
import DepartmentDialog from "./org-structure/DepartmentDialog";
import DepartmentList from "./org-structure/DepartmentList";
import PeopleDrawer from "./org-structure/PeopleDrawer";
import {
  errorMessage,
  useDepartmentPeople,
  useDepartmentsOverview,
  useRefreshOrg,
  type DepartmentRow,
  type Person,
} from "./org-structure/api";
import { downloadSheet } from "./org-structure/exportSheet";
import {
  DEPT_SORTS,
  NONE,
  NO_DEPT_FILTERS,
  departmentDeleteImpact,
  departmentSheet,
  deptFiltersActive,
  filterDepartments,
  plural,
  sortDepartments,
  summarizeDepartments,
  type DeptFilters,
  type DeptSort,
} from "./org-structure/logic";
import { BranchChip, EmptyState, LoadError, StatCard } from "./org-structure/parts";

export default function Departments() {
  const { user } = useAuth();
  const { toast } = useToast();
  const refresh = useRefreshOrg();
  const overview = useDepartmentsOverview();
  const rows = useMemo(() => overview.data?.departments ?? [], [overview.data]);
  const branches = useMemo(() => overview.data?.branches ?? [], [overview.data]);
  const summary = useMemo(() => summarizeDepartments(rows, overview.data?.unassigned), [rows, overview.data]);

  const [view, setView] = useState<"list" | "find">("list");
  const [filters, setFilters] = useState<DeptFilters>(NO_DEPT_FILTERS);
  const [sort, setSort] = useState<DeptSort>("name-asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [dialog, setDialog] = useState<{ department: DepartmentRow | null } | null>(null);
  const [confirm, setConfirm] = useState<DepartmentRow | null>(null);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [assignFor, setAssignFor] = useState<DepartmentRow | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const people = useDepartmentPeople(drawerId);
  const assignMutation = useAssignEmployee();
  const deleteMutation = useDeleteDepartment();

  // A branch login's own branch is implied by the server; only an unscoped login picks one.
  const needsBranch = !user?.branchId;
  const set = (patch: Partial<DeptFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const shown = useMemo(() => sortDepartments(filterDepartments(rows, filters), sort), [rows, filters, sort]);
  const active = deptFiltersActive(filters);
  // `safePage` clamps rather than resetting on every render, so a search that shrinks the list can't strand the user.
  const totalPages = Math.max(1, Math.ceil(shown.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = shown.slice((safePage - 1) * pageSize, safePage * pageSize);

  const drawerDept = rows.find((d) => d.id === drawerId) ?? null;
  const withBranchless = rows.some((d) => d.branchId == null);

  const removePerson = async (p: Person) => {
    setRemovingId(p.id);
    try {
      await assignMutation.mutateAsync({ id: p.id, departmentId: null });
      await refresh();
      toast({ title: `${p.name} removed from the department` });
    } catch (e) {
      toast({ title: "Failed to remove employee", description: errorMessage(e), variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  };

  const runDelete = async () => {
    const d = confirm;
    setConfirm(null);
    if (!d) return;
    try {
      await deleteMutation.mutateAsync({ id: d.id });
    } catch (e) {
      toast({ title: "Failed to delete department", description: errorMessage(e), variant: "destructive" });
      return;
    }
    if (drawerId === d.id) setDrawerId(null);
    await refresh();
    toast({ title: `Department ${d.name} deleted` });
  };

  const exportList = async () => {
    try {
      await downloadSheet("Departments", "departments", departmentSheet(shown));
    } catch {
      toast({ title: "Could not create the Excel file", variant: "destructive" });
    }
  };

  const loading = overview.isLoading;
  const dash = (n: number) => (loading ? "—" : n);

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Departments</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every department with its staff and production head-count. Click one to see who is in it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={exportList}
              disabled={loading || shown.length === 0}
              data-testid="export-departments"
            >
              <Download size={15} /> Export
            </Button>
            <Button onClick={() => setDialog({ department: null })} className="gap-1.5" data-testid="new-department">
              <Plus size={16} /> New Department
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatCard
            testId="stat-departments"
            label="Departments"
            value={dash(summary.departments)}
            sub={loading ? undefined : `in ${plural(summary.branches, "branch", "branches")}`}
            icon={Building2}
            tone="bg-slate-100 text-slate-800"
          />
          <StatCard
            testId="stat-employees"
            label="Active employees"
            value={dash(summary.active)}
            sub={loading ? undefined : `${summary.unassigned} with no department`}
            icon={Users}
            tone="bg-green-50 text-green-800"
          />
          <StatCard
            testId="stat-staff"
            label="Staff"
            value={dash(summary.staff)}
            sub={
              loading || !summary.active
                ? undefined
                : `${Math.round((summary.staff / summary.active) * 100)}% of employees`
            }
            icon={Briefcase}
            tone="bg-blue-50 text-blue-800"
          />
          <StatCard
            testId="stat-production"
            label="Production"
            value={dash(summary.production)}
            sub={
              loading || !summary.active
                ? undefined
                : `${Math.round((summary.production / summary.active) * 100)}% of employees`
            }
            icon={Factory}
            tone="bg-amber-50 text-amber-800"
          />
          <StatCard
            testId="stat-empty"
            label="No employees"
            value={dash(summary.empty)}
            sub="departments with nobody active"
            icon={CircleOff}
            tone="bg-gray-100 text-gray-700"
          />
        </div>

        <PillTabs
          items={[
            { value: "list", label: "Departments", icon: <Building2 size={14} />, count: rows.length },
            { value: "find", label: "Find & assign employees", icon: <Users size={14} /> },
          ]}
          value={view}
          onChange={(v) => setView(v as "list" | "find")}
        />

        {view === "find" ? (
          <EmployeeAssignmentLookup
            kind="department"
            options={rows.map((d) => ({
              id: d.id,
              label: d.branchName && branches.length > 1 ? `${d.name} (${d.branchName})` : d.name,
            }))}
          />
        ) : (
          <div className="space-y-3">
            <div className="space-y-3 rounded-2xl border bg-white p-3">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
                <div className="relative flex-1">
                  <Search
                    size={15}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <Input
                    value={filters.query}
                    onChange={(e) => set({ query: e.target.value })}
                    placeholder="Search by department, description or branch"
                    aria-label="Search departments"
                    className="h-10 pl-9 pr-9"
                    data-testid="dept-search"
                  />
                  {filters.query && (
                    <button
                      type="button"
                      onClick={() => set({ query: "" })}
                      aria-label="Clear search"
                      className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-2 lg:flex">
                  {(branches.length > 1 || withBranchless) && (
                    <Select value={filters.branch} onValueChange={(v) => set({ branch: v })}>
                      <SelectTrigger className="h-10 lg:w-44" aria-label="Filter by branch" data-testid="filter-branch">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All branches</SelectItem>
                        {withBranchless && <SelectItem value={NONE}>No branch</SelectItem>}
                        {branches.map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Select value={sort} onValueChange={(v) => setSort(v as DeptSort)}>
                    <SelectTrigger
                      className="h-10 lg:w-44"
                      aria-label="Sort departments"
                      data-testid="sort-departments"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DEPT_SORTS.map((s) => (
                        <SelectItem key={s.value} value={s.value}>
                          {s.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <PillTabs
                  size="sm"
                  items={[
                    { value: "all", label: "All", count: rows.length },
                    { value: "with", label: "With employees", count: rows.length - summary.empty },
                    { value: "empty", label: "No employees", count: summary.empty },
                  ]}
                  value={filters.show}
                  onChange={(v) => set({ show: v as DeptFilters["show"] })}
                />
                <p className="text-xs text-gray-500" data-testid="dept-count">
                  Showing <b>{shown.length}</b> of {rows.length}
                  {active && (
                    <button
                      type="button"
                      onClick={() => {
                        setFilters(NO_DEPT_FILTERS);
                        setPage(1);
                      }}
                      className="ml-2 font-semibold text-blue-600 hover:underline"
                      data-testid="dept-clear-filters"
                    >
                      Clear filters
                    </button>
                  )}
                </p>
              </div>
            </div>

            {loading ? (
              <div className="space-y-3 rounded-2xl border bg-white p-4" data-testid="departments-loading">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-xl" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-48" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="hidden h-2 w-40 sm:block" />
                  </div>
                ))}
              </div>
            ) : overview.isError ? (
              <LoadError what="the departments" onRetry={() => overview.refetch()} />
            ) : shown.length === 0 ? (
              <EmptyState
                testId={rows.length === 0 ? "departments-empty" : "departments-no-match"}
                filtered={rows.length > 0}
                title="No departments yet"
                hint="Create the first department, then assign employees to it."
                onClear={() => {
                  setFilters(NO_DEPT_FILTERS);
                  setPage(1);
                }}
                action={
                  <Button onClick={() => setDialog({ department: null })} className="gap-1.5">
                    <Plus size={15} /> Create the first department
                  </Button>
                }
              />
            ) : (
              <>
                <DepartmentList
                  rows={paged}
                  onOpen={(d) => setDrawerId(d.id)}
                  onEdit={(d) => setDialog({ department: d })}
                  onDelete={setConfirm}
                />
                <DataPagination
                  page={safePage}
                  totalPages={totalPages}
                  totalItems={shown.length}
                  pageSize={pageSize}
                  onPageChange={setPage}
                  onPageSizeChange={(n) => {
                    setPageSize(n);
                    setPage(1);
                  }}
                />
              </>
            )}
          </div>
        )}
      </div>

      {drawerId != null && (
        <PeopleDrawer
          key={drawerId}
          open
          onClose={() => setDrawerId(null)}
          title={drawerDept?.name ?? people.data?.department.name ?? "Department"}
          subtitle={
            <>
              <BranchChip name={drawerDept?.branchName ?? people.data?.department.branchName} />
              {drawerDept?.description && <span className="text-gray-500">{drawerDept.description}</span>}
            </>
          }
          kind="department"
          people={people.data?.employees}
          loading={people.isLoading}
          failed={people.isError}
          onRetry={() => people.refetch()}
          showOther="designation"
          onAssign={() => drawerDept && setAssignFor(drawerDept)}
          onRemove={removePerson}
          removingId={removingId}
        />
      )}

      {assignFor && (
        <AssignDialog
          target={{ kind: "department", id: assignFor.id, name: assignFor.name }}
          onClose={() => setAssignFor(null)}
        />
      )}

      {dialog && (
        <DepartmentDialog
          key={dialog.department?.id ?? "new"}
          department={dialog.department}
          branches={branches}
          needsBranch={needsBranch}
          existing={rows}
          defaultBranchId={filters.branch !== "all" && filters.branch !== NONE ? Number(filters.branch) : null}
          onClose={() => setDialog(null)}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent data-testid="confirm-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete department "{confirm?.name}"?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>This cannot be undone. Here is what happens:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {confirm && departmentDeleteImpact(confirm).map((line) => <li key={line}>{line}</li>)}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={runDelete}
              className="bg-red-600 text-white hover:bg-red-700"
              data-testid="confirm-delete-yes"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </HrLayout>
  );
}
