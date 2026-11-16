import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import {
  Briefcase,
  Building2,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleOff,
  Download,
  Factory,
  FolderTree,
  List,
  Plus,
  Search,
  UserX,
  Users,
  X,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { EmployeeAssignmentLookup } from "@/components/EmployeeAssignmentLookup";
import { useUrlParams } from "@/components/payroll/kit/url-state";
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
import { isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { useAssignOrg } from "@/lib/api-client";
import { ORG_CATEGORY_LABEL, orgCategoryOf, type OrgCategory } from "@/lib/departments";
import { useDeleteDesignation } from "@/lib/api-client/custom-hooks";
import { moduleForPath } from "@/lib/permission-modules";
import { ViewOnlyTabNote, pickVisible, useLevel, useViewOnlyLock, visibleItems } from "@/lib/tab-access";
import AssignDialog from "./org-structure/AssignDialog";
import DesignationDialog from "./org-structure/DesignationDialog";
import DesignationList from "./org-structure/DesignationList";
import DesignationTree from "./org-structure/DesignationTree";
import PeopleDrawer from "./org-structure/PeopleDrawer";
import {
  errorMessage,
  useDesignationPeople,
  useDesignationsTree,
  useRefreshOrg,
  type DesignationRow,
  type Person,
} from "./org-structure/api";
import { downloadSheet } from "./org-structure/exportSheet";
import {
  DESIG_SORTS,
  LEVELS,
  NONE,
  NO_DESIG_FILTERS,
  ORG_URL_DEFAULTS,
  allNodeKeys,
  buildTree,
  countByCategory,
  designationDeleteImpact,
  designationSheet,
  desigFiltersActive,
  filterDesignations,
  parseOrgCategory,
  plural,
  sortDesignations,
  summarizeDesignations,
  treeOfCategory,
  type DesigFilters,
  type DesigSort,
} from "./org-structure/logic";
import {
  BranchChip,
  CategorySwitch,
  EmptyState,
  LevelChip,
  LoadError,
  OrgCategoryContext,
  StatCard,
} from "./org-structure/parts";

type Tab = "structure" | "find";
const TABS: readonly Tab[] = ["structure", "find"];
// Each tab's own key (Account Management -> Roles & Permissions -> Employees -> Designations); the Find tab's two
// sub-tabs are keyed inside EmployeeAssignmentLookup.
const TAB_KEY: Record<Tab, string> = {
  structure: "employees.designations.structure",
  find: "employees.designations.find",
};
const FIND_SUB_TAB_KEYS = {
  search: "employees.designations.find.search",
  unassigned: "employees.designations.find.unassigned",
};

export default function Designations() {
  const { user } = useAuth();
  const [location] = useLocation();
  const { toast } = useToast();
  const refresh = useRefreshOrg();
  const treeQuery = useDesignationsTree();
  // Staff and production have designations of their own (each a department's): the switch at the top
  // (?category= in the address) decides which kind the whole page shows.
  const [urlState, setUrlState] = useUrlParams(ORG_URL_DEFAULTS);
  const category: OrgCategory = parseOrgCategory(urlState.category);
  const fullTree = treeQuery.data;
  const tree = useMemo(() => (fullTree ? treeOfCategory(fullTree, category) : undefined), [fullTree, category]);
  const designations = useMemo(() => tree?.designations ?? [], [tree]);
  const departments = useMemo(() => tree?.departments ?? [], [tree]);
  const branches = useMemo(() => tree?.branches ?? [], [tree]);
  const summary = useMemo(() => (tree ? summarizeDesignations(tree, category) : null), [tree, category]);
  const kindCounts = useMemo(() => countByCategory(fullTree?.designations ?? []), [fullTree]);
  const kind = ORG_CATEGORY_LABEL[category];
  const people = category === "production" ? "production employees" : "staff";

  const level = useLevel();
  // Only the tabs this role may see: a hidden tab is never shown (or mounted).
  const visibleTabs = visibleItems(TABS, (t) => TAB_KEY[t], level);
  const [askedTab, setTab] = useState<Tab>("structure");
  const tab = pickVisible(askedTab, visibleTabs);
  // A tab this role may only VIEW on a page it may edit: lock that tab's change buttons (HrLayout locks a View-only page).
  const viewOnlyTab =
    visibleTabs.length > 0 &&
    !isRouteViewOnly(user, location, moduleForPath(location)) &&
    level(TAB_KEY[tab]) === "view";
  useViewOnlyLock(viewOnlyTab, tab);
  const [view, setView] = useState<"tree" | "list">("tree");
  const [filters, setFilters] = useState<DesigFilters>(NO_DESIG_FILTERS);
  const [sort, setSort] = useState<DesigSort>("title-asc");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [dialog, setDialog] = useState<{ designation: DesignationRow | null; departmentId?: number | null } | null>(
    null,
  );
  const [confirm, setConfirm] = useState<DesignationRow | null>(null);
  const [drawerId, setDrawerId] = useState<number | null>(null);
  const [assignFor, setAssignFor] = useState<DesignationRow | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);

  const drawerPeople = useDesignationPeople(drawerId);
  const assignMutation = useAssignOrg();
  const deleteMutation = useDeleteDesignation();

  // A branch login must file a designation under one of its departments.
  const requireDepartment = !!user?.branchId;

  const set = (patch: Partial<DesigFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };
  const clear = () => {
    setFilters(NO_DESIG_FILTERS);
    setPage(1);
  };
  const switchCategory = (c: OrgCategory) => {
    if (c === category) return;
    setUrlState({ category: c });
    // the department filter names a department of the other kind now
    setFilters((f) => ({ ...f, department: "all" }));
    setPage(1);
    setDrawerId(null);
  };

  const filtered = useMemo(() => filterDesignations(designations, filters), [designations, filters]);
  const nodes = useMemo(() => (tree ? buildTree(tree, filtered, filters) : []), [tree, filtered, filters]);
  const sorted = useMemo(() => sortDesignations(filtered, sort), [filtered, sort]);
  const active = desigFiltersActive(filters);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = sorted.slice((safePage - 1) * pageSize, safePage * pageSize);

  // The department list follows the branch chosen above it.
  const departmentOptions = useMemo(
    () =>
      departments.filter((d) =>
        filters.branch === "all"
          ? true
          : filters.branch === NONE
            ? d.branchId == null
            : String(d.branchId) === filters.branch,
      ),
    [departments, filters.branch],
  );
  const hasLoose = designations.some((d) => d.departmentId == null);
  const hasBranchless = departments.some((d) => d.branchId == null) || hasLoose;

  const drawerDesig = fullTree?.designations.find((d) => d.id === drawerId) ?? null;

  const removePerson = async (p: Person) => {
    setRemovingId(p.id);
    try {
      await assignMutation.mutateAsync({ employeeId: p.id, designationId: null });
      await refresh();
      toast({ title: `${p.name} no longer holds the designation` });
    } catch (e) {
      toast({ title: "Failed to remove designation", description: errorMessage(e), variant: "destructive" });
    } finally {
      setRemovingId(null);
    }
  };

  const runDelete = async () => {
    const d = confirm;
    setConfirm(null);
    if (!d) return;
    try {
      await deleteMutation.mutateAsync(d.id);
    } catch (e) {
      toast({ title: "Failed to delete designation", description: errorMessage(e), variant: "destructive" });
      return;
    }
    if (drawerId === d.id) setDrawerId(null);
    await refresh();
    toast({ title: `Designation ${d.title} deleted` });
  };

  const exportList = async () => {
    try {
      await downloadSheet(
        `${kind} designations`,
        `${category}_designations`,
        designationSheet(sortDesignations(filtered, "department")),
      );
    } catch {
      toast({ title: "Could not create the Excel file", variant: "destructive" });
    }
  };

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const loading = treeQuery.isLoading;
  const dash = (n: number | undefined) => (loading || n == null ? "—" : n);
  const allOpen = collapsed.size === 0;

  return (
    <HrLayout>
      <OrgCategoryContext.Provider value={category}>
        <div className="space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-2xl font-black text-gray-900">Designations</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Staff and production employees have job titles of their own, under their department and branch. Click
                one to see who holds it.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                className="gap-1.5"
                onClick={exportList}
                disabled={loading || filtered.length === 0}
                data-testid="export-designations"
              >
                <Download size={15} /> Export
              </Button>
              <Button
                onClick={() => setDialog({ designation: null })}
                className="gap-1.5"
                data-testid="new-designation"
              >
                <Plus size={16} /> New {kind} Designation
              </Button>
            </div>
          </div>

          <CategorySwitch
            value={category}
            onChange={switchCategory}
            counts={treeQuery.isLoading ? undefined : kindCounts}
            noun="designations"
          />

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard
              testId="stat-designations"
              label={`${kind} designations`}
              value={dash(summary?.designations)}
              sub={summary ? `in ${plural(summary.departments, "department")}` : undefined}
              icon={category === "production" ? Factory : Briefcase}
              tone={category === "production" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"}
            />
            <StatCard
              testId="stat-employees"
              label="Active holders"
              value={dash(summary?.active)}
              sub={summary ? (summary.inactive ? `+${summary.inactive} inactive` : "none inactive") : undefined}
              icon={Users}
              tone="bg-green-50 text-green-800"
            />
            <StatCard
              testId="stat-unassigned"
              label="With no designation"
              value={dash(summary?.unassigned)}
              sub="active, with no job title"
              icon={UserX}
              tone="bg-rose-50 text-rose-800"
            />
            <StatCard
              testId="stat-departments"
              label={`${kind} departments`}
              value={dash(tree ? departments.length : undefined)}
              sub="their job titles are below"
              icon={Building2}
              tone="bg-indigo-50 text-indigo-800"
            />
            <StatCard
              testId="stat-empty"
              label="Nobody holds"
              value={dash(summary?.empty)}
              sub="designations with no active employee"
              icon={CircleOff}
              tone="bg-gray-100 text-gray-700"
            />
          </div>

          {visibleTabs.length > 0 && (
            <PillTabs
              items={visibleItems(
                [
                  {
                    value: "structure",
                    label: "Structure",
                    icon: <FolderTree size={14} />,
                    count: designations.length,
                  },
                  { value: "find", label: "Find & assign employees", icon: <Users size={14} /> },
                ],
                (t) => TAB_KEY[t.value as Tab],
                level,
              )}
              value={tab}
              onChange={(v) => setTab(v as Tab)}
            />
          )}

          <ViewOnlyTabNote show={viewOnlyTab} />

          {visibleTabs.length === 0 ? (
            <p
              className="rounded-2xl border bg-white p-6 text-center text-sm text-muted-foreground"
              data-testid="designations-nothing-open"
            >
              Nothing on this page is open to your role.
            </p>
          ) : tab === "find" ? (
            <EmployeeAssignmentLookup
              key={category}
              kind="designation"
              employmentType={category}
              options={designations.map((d) => ({
                id: d.id,
                label: d.departmentName ? `${d.title} (${d.departmentName})` : d.title,
              }))}
              subTabKeys={FIND_SUB_TAB_KEYS}
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
                      placeholder={`Search ${kind.toLowerCase()} designations, departments or branches`}
                      aria-label="Search designations"
                      className="h-10 pl-9 pr-9"
                      data-testid="desig-search"
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
                    {(branches.length > 1 || hasBranchless) && (
                      <Select value={filters.branch} onValueChange={(v) => set({ branch: v, department: "all" })}>
                        <SelectTrigger
                          className="h-10 lg:w-40"
                          aria-label="Filter by branch"
                          data-testid="filter-branch"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All branches</SelectItem>
                          {hasBranchless && <SelectItem value={NONE}>No branch</SelectItem>}
                          {branches.map((b) => (
                            <SelectItem key={b.id} value={String(b.id)}>
                              {b.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <Select value={filters.department} onValueChange={(v) => set({ department: v })}>
                      <SelectTrigger
                        className="h-10 lg:w-44"
                        aria-label="Filter by department"
                        data-testid="filter-department"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All {kind.toLowerCase()} departments</SelectItem>
                        {hasLoose && <SelectItem value={NONE}>No department</SelectItem>}
                        {departmentOptions.map((d) => (
                          <SelectItem key={d.id} value={String(d.id)}>
                            {d.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={filters.level} onValueChange={(v) => set({ level: v })}>
                      <SelectTrigger className="h-10 lg:w-36" aria-label="Filter by level" data-testid="filter-level">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All levels</SelectItem>
                        {LEVELS.map((l) => (
                          <SelectItem key={l.value} value={l.value}>
                            {l.label}
                          </SelectItem>
                        ))}
                        <SelectItem value={NONE}>Not set</SelectItem>
                      </SelectContent>
                    </Select>
                    {view === "list" && (
                      <Select value={sort} onValueChange={(v) => setSort(v as DesigSort)}>
                        <SelectTrigger
                          className="h-10 lg:w-44"
                          aria-label="Sort designations"
                          data-testid="sort-designations"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DESIG_SORTS.map((s) => (
                            <SelectItem key={s.value} value={s.value}>
                              {s.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <PillTabs
                      size="sm"
                      items={[
                        { value: "tree", label: "Tree", icon: <FolderTree size={13} /> },
                        { value: "list", label: "List", icon: <List size={13} /> },
                      ]}
                      value={view}
                      onChange={(v) => {
                        setView(v as "tree" | "list");
                        setPage(1);
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant={filters.empty ? "default" : "outline"}
                      className="h-8 gap-1.5 rounded-full text-xs"
                      aria-pressed={filters.empty}
                      onClick={() => set({ empty: !filters.empty })}
                      data-testid="filter-empty"
                    >
                      <CircleOff size={13} /> No employees
                    </Button>
                    {view === "tree" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-8 gap-1.5 text-xs"
                        onClick={() => setCollapsed(allOpen ? new Set(allNodeKeys(nodes)) : new Set())}
                        disabled={active || nodes.length === 0}
                        title={active ? "Groups with a match are always shown open" : undefined}
                        data-testid="toggle-all"
                      >
                        {allOpen ? <ChevronsDownUp size={14} /> : <ChevronsUpDown size={14} />}
                        {allOpen ? "Collapse all" : "Expand all"}
                      </Button>
                    )}
                  </div>
                  <p className="text-xs text-gray-500" data-testid="desig-count">
                    Showing <b>{filtered.length}</b> of {designations.length}
                    {active && (
                      <button
                        type="button"
                        onClick={clear}
                        className="ml-2 font-semibold text-blue-600 hover:underline"
                        data-testid="desig-clear-filters"
                      >
                        Clear filters
                      </button>
                    )}
                  </p>
                </div>
              </div>

              {loading ? (
                <div className="space-y-3 rounded-2xl border bg-white p-4" data-testid="designations-loading">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-10 w-10 rounded-xl" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-32" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : treeQuery.isError ? (
                <LoadError what="the designations" onRetry={() => treeQuery.refetch()} />
              ) : nodes.length === 0 && filtered.length === 0 ? (
                <EmptyState
                  testId={designations.length === 0 ? "designations-empty" : "designations-no-match"}
                  filtered={designations.length > 0}
                  icon={Briefcase}
                  title={`No ${kind} designations yet`}
                  hint={`Create the first ${kind.toLowerCase()} designation, then assign ${people} to it.`}
                  onClear={clear}
                  action={
                    <Button onClick={() => setDialog({ designation: null })} className="gap-1.5">
                      <Plus size={15} /> Create the first {kind.toLowerCase()} designation
                    </Button>
                  }
                />
              ) : view === "tree" ? (
                <DesignationTree
                  nodes={nodes}
                  collapsed={collapsed}
                  forceOpen={active}
                  onToggle={toggle}
                  onOpen={(d) => setDrawerId(d.id)}
                  onEdit={(d) => setDialog({ designation: d })}
                  onDelete={setConfirm}
                  onAdd={(departmentId) => setDialog({ designation: null, departmentId })}
                />
              ) : (
                <>
                  <DesignationList
                    rows={paged}
                    onOpen={(d) => setDrawerId(d.id)}
                    onEdit={(d) => setDialog({ designation: d })}
                    onDelete={setConfirm}
                  />
                  <DataPagination
                    page={safePage}
                    totalPages={totalPages}
                    totalItems={sorted.length}
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
            title={drawerDesig?.title ?? drawerPeople.data?.designation.title ?? "Designation"}
            category={drawerDesig ? orgCategoryOf(drawerDesig) : category}
            subtitle={
              <>
                <LevelChip level={drawerDesig?.level ?? drawerPeople.data?.designation.level} />
                <span className="text-gray-600">
                  {drawerDesig?.departmentName ?? drawerPeople.data?.designation.departmentName ?? "No department"}
                </span>
                {drawerDesig?.branchName && <BranchChip name={drawerDesig.branchName} />}
              </>
            }
            kind="designation"
            people={drawerPeople.data?.employees}
            loading={drawerPeople.isLoading}
            failed={drawerPeople.isError}
            onRetry={() => drawerPeople.refetch()}
            showOther="department"
            onAssign={() => drawerDesig && setAssignFor(drawerDesig)}
            onRemove={removePerson}
            removingId={removingId}
          />
        )}

        {assignFor && (
          <AssignDialog
            target={{
              kind: "designation",
              id: assignFor.id,
              name: assignFor.title,
              category: orgCategoryOf(assignFor),
            }}
            onClose={() => setAssignFor(null)}
          />
        )}

        {dialog && (
          <DesignationDialog
            key={dialog.designation?.id ?? `new-${dialog.departmentId ?? "none"}`}
            designation={dialog.designation}
            departments={fullTree?.departments ?? []}
            designations={fullTree?.designations ?? []}
            defaultDepartmentId={dialog.departmentId}
            requireDepartment={requireDepartment}
            category={category}
            onClose={() => setDialog(null)}
          />
        )}

        <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
          <AlertDialogContent data-testid="confirm-delete">
            <AlertDialogHeader>
              <AlertDialogTitle>Delete designation "{confirm?.title}"?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-sm text-muted-foreground">
                  <p>This cannot be undone. Here is what happens:</p>
                  <ul className="list-disc space-y-1 pl-5">
                    {confirm && designationDeleteImpact(confirm).map((line) => <li key={line}>{line}</li>)}
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
      </OrgCategoryContext.Provider>
    </HrLayout>
  );
}
