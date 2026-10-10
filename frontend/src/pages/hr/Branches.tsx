import { useMemo, useState } from "react";
import {
  AlertTriangle,
  Building2,
  Download,
  LayoutGrid,
  List,
  MapPin,
  Navigation,
  Plus,
  RefreshCw,
  Search,
  Users,
  X,
  Layers,
} from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
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
import {
  getListBranchesQueryKey,
  useCreateBranch,
  useDeleteBranch,
  useListBranches,
  useUpdateBranch,
  type Branch,
} from "@/lib/api-client/custom-hooks";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { StatCard } from "./account-management/parts";
import { useBranchSummary } from "./branches/api";
import BranchDialog from "./branches/BranchDialog";
import BranchDrawer from "./branches/BranchDrawer";
import { BranchCard, BranchTable, peopleLabel } from "./branches/BranchViews";
import { exportBranchesXlsx } from "./branches/export";
import {
  NO_FILTERS,
  SORT_LABELS,
  filterBranches,
  filtersActive,
  headcount,
  hasGeofence,
  sortBranches,
  summaryMap,
  toCreatePayload,
  toUpdatePayload,
  totalsOf,
  type BranchFilters,
  type BranchForm,
  type BranchSort,
  type GeoFilter,
} from "./branches/logic";

type ViewMode = "grid" | "list";
const VIEW_KEY = "uk_branches_view";

// A convenience only: the page works the same when the browser refuses storage.
const savedView = (): ViewMode => {
  try {
    return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
};

/** Manage Branch: the company's locations, who works in each, and where employees may punch in from. */
export default function Branches() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, refetch, isFetching } = useListBranches();
  const { data: summary, isLoading: summaryLoading } = useBranchSummary();
  const createMutation = useCreateBranch();
  const updateMutation = useUpdateBranch();
  const deleteMutation = useDeleteBranch();

  const branches = useMemo(() => data ?? [], [data]);
  const figures = useMemo(() => summaryMap(summary), [summary]);
  const totals = useMemo(() => totalsOf(branches, summary), [branches, summary]);

  const [filters, setFilters] = useState<BranchFilters>(NO_FILTERS);
  const [sort, setSort] = useState<BranchSort>("name");
  const [view, setViewState] = useState<ViewMode>(savedView);
  const [dialog, setDialog] = useState<{ branch: Branch | null } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [confirm, setConfirm] = useState<Branch | null>(null);
  const [exporting, setExporting] = useState(false);

  const setView = (next: ViewMode) => {
    setViewState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // not remembered, still applied
    }
  };

  const shown = useMemo(
    () => sortBranches(filterBranches(branches, filters), sort, figures),
    [branches, filters, sort, figures],
  );
  const geoCounts = useMemo(() => {
    const withGeo = branches.filter(hasGeofence).length;
    return { all: branches.length, set: withGeo, unset: branches.length - withGeo };
  }, [branches]);
  const active = filtersActive(filters);
  const set = (patch: Partial<BranchFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const opened = branches.find((b) => b.id === openId) ?? null;
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const refreshLists = () => queryClient.invalidateQueries({ queryKey: getListBranchesQueryKey() });

  async function handleSave(form: BranchForm) {
    const editing = dialog?.branch ?? null;
    try {
      if (editing) await updateMutation.mutateAsync({ id: editing.id, data: toUpdatePayload(form) });
      else await createMutation.mutateAsync(toCreatePayload(form));
    } catch (e: unknown) {
      toast({
        title: editing ? "Failed to update branch" : "Failed to create branch",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: editing ? "Branch updated" : "Branch created" });
    setDialog(null);
    refreshLists();
  }

  async function runDelete() {
    const target = confirm;
    setConfirm(null);
    if (!target) return;
    try {
      await deleteMutation.mutateAsync(target.id);
    } catch (e: unknown) {
      toast({
        title: "Failed to delete branch",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: `Branch ${target.name} deleted` });
    if (openId === target.id) setOpenId(null);
    refreshLists();
  }

  async function handleExport() {
    setExporting(true);
    try {
      await exportBranchesXlsx(shown, figures);
    } catch (e: unknown) {
      toast({
        title: "Failed to export branches",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  }

  const handlers = {
    onOpen: (b: Branch) => setOpenId(b.id),
    onEdit: (b: Branch) => setDialog({ branch: b }),
    onDelete: (b: Branch) => setConfirm(b),
  };
  const confirmRow = confirm ? figures.get(confirm.id) : undefined;

  return (
    <HrLayout>
      <div className="space-y-5">
        {/* Header */}
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Manage Branch</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Manage company locations and branch offices</p>
          </div>
          <div className="flex items-center gap-2 self-start sm:self-auto">
            <Button
              variant="outline"
              onClick={handleExport}
              disabled={exporting || shown.length === 0}
              className="gap-2"
              data-testid="branches-export"
            >
              <Download size={15} /> {exporting ? "Preparing..." : "Export"}
            </Button>
            <Button onClick={() => setDialog({ branch: null })} className="gap-2" data-testid="branch-add">
              <Plus size={16} /> Add Branch
            </Button>
          </div>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            testId="stat-branches"
            label="Branches"
            value={isLoading ? "-" : totals.branches}
            sub={
              isLoading
                ? undefined
                : totals.headOffice
                  ? `Head Office: ${totals.headOffice.name}`
                  : "No Head Office marked"
            }
            icon={Building2}
            tone="bg-teal-50 text-teal-800"
          />
          <StatCard
            testId="stat-people"
            label="Active people"
            value={summaryLoading || !summary ? "-" : totals.people}
            sub={
              summary
                ? `${totals.staff} staff · ${totals.production} production${
                    totals.unassigned > 0 ? ` · ${totals.unassigned} in no branch` : ""
                  }`
                : undefined
            }
            icon={Users}
            tone="bg-blue-50 text-blue-800"
          />
          <StatCard
            testId="stat-geofence"
            label="Attendance location"
            value={isLoading ? "-" : `${totals.withGeofence} of ${totals.branches}`}
            sub={
              isLoading
                ? undefined
                : totals.withoutGeofence === 0
                  ? "every branch has a geofence"
                  : `${totals.withoutGeofence} without a geofence`
            }
            icon={Navigation}
            tone={totals.withoutGeofence > 0 ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-800"}
          />
          <StatCard
            testId="stat-departments"
            label="Departments"
            value={summaryLoading || !summary ? "-" : totals.departments}
            sub={
              summary
                ? totals.emptyBranches > 0
                  ? `${totals.emptyBranches} ${totals.emptyBranches === 1 ? "branch has" : "branches have"} none`
                  : "across all branches"
                : undefined
            }
            icon={Layers}
            tone="bg-slate-100 text-slate-800"
          />
        </div>

        {/* Search and filters */}
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
                placeholder="Search by name, code, location, address or phone"
                aria-label="Search branches"
                className="h-10 pl-9 pr-9"
                data-testid="branch-search"
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
            <div className="flex items-center gap-2">
              <Select value={sort} onValueChange={(v) => setSort(v as BranchSort)}>
                <SelectTrigger
                  className="h-10 flex-1 lg:w-48 lg:flex-none"
                  aria-label="Sort branches"
                  data-testid="branch-sort"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SORT_LABELS) as BranchSort[]).map((k) => (
                    <SelectItem key={k} value={k}>
                      {SORT_LABELS[k]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="hidden rounded-lg border p-0.5 md:flex" role="group" aria-label="Layout">
                {(
                  [
                    ["grid", LayoutGrid, "Cards"],
                    ["list", List, "Table"],
                  ] as const
                ).map(([mode, Icon, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setView(mode)}
                    aria-pressed={view === mode}
                    aria-label={`${label} layout`}
                    title={`${label} layout`}
                    data-testid={`view-${mode}`}
                    className={cn(
                      "rounded-md p-2 text-gray-500 hover:text-gray-900",
                      view === mode && "bg-gray-900 text-white hover:text-white",
                    )}
                  >
                    <Icon size={15} />
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <PillTabs
                size="sm"
                items={[
                  { value: "all", label: "All", count: geoCounts.all },
                  { value: "set", label: "Geofence set", count: geoCounts.set },
                  { value: "unset", label: "No geofence", count: geoCounts.unset },
                ]}
                value={filters.geo}
                onChange={(v) => set({ geo: v as GeoFilter })}
              />
              <button
                type="button"
                onClick={() => set({ headOfficeOnly: !filters.headOfficeOnly })}
                aria-pressed={filters.headOfficeOnly}
                data-testid="filter-head-office"
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-semibold",
                  filters.headOfficeOnly
                    ? "border-amber-300 bg-amber-100 text-amber-800"
                    : "border-gray-200 text-gray-600 hover:bg-gray-50",
                )}
              >
                <Building2 size={12} /> Head Office
              </button>
            </div>
            <p className="text-xs text-gray-500" data-testid="branch-count">
              Showing <b>{shown.length}</b> of {branches.length}
              {active && (
                <button
                  type="button"
                  onClick={() => setFilters(NO_FILTERS)}
                  className="ml-2 font-semibold text-blue-600 hover:underline"
                  data-testid="branch-clear-filters"
                >
                  Clear filters
                </button>
              )}
            </p>
          </div>
        </div>

        {/* List */}
        {isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="branches-loading">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="space-y-3 rounded-2xl border bg-white p-4">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-64 max-w-full" />
                <Skeleton className="h-4 w-32" />
              </div>
            ))}
          </div>
        ) : isError ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border bg-white px-6 py-12 text-center"
            data-testid="branches-error"
          >
            <div className="rounded-2xl bg-red-50 p-4 text-red-600">
              <AlertTriangle size={26} />
            </div>
            <div>
              <p className="font-bold text-gray-900">The branches could not be loaded</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Check the connection and try again.</p>
            </div>
            <Button variant="outline" onClick={() => refetch()} disabled={isFetching} className="gap-1.5">
              <RefreshCw size={14} /> Retry
            </Button>
          </div>
        ) : branches.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border bg-white px-6 py-14 text-center"
            data-testid="branches-empty"
          >
            <div className="rounded-2xl bg-teal-50 p-4 text-teal-600">
              <MapPin size={26} />
            </div>
            <div>
              <p className="font-bold text-gray-900">No branches yet</p>
              <p className="mt-0.5 max-w-sm text-sm text-muted-foreground">
                Add your first branch: a location with its own departments, employees and attendance area.
              </p>
            </div>
            <Button onClick={() => setDialog({ branch: null })} className="gap-1.5">
              <Plus size={15} /> Add the first branch
            </Button>
          </div>
        ) : shown.length === 0 ? (
          <div
            className="flex flex-col items-center gap-3 rounded-2xl border bg-white px-6 py-14 text-center"
            data-testid="branches-no-match"
          >
            <div className="rounded-2xl bg-gray-100 p-4 text-gray-500">
              <Search size={26} />
            </div>
            <div>
              <p className="font-bold text-gray-900">No branch matches</p>
              <p className="mt-0.5 text-sm text-muted-foreground">Try fewer words, or clear the filters.</p>
            </div>
            <Button variant="outline" onClick={() => setFilters(NO_FILTERS)}>
              Clear filters
            </Button>
          </div>
        ) : (
          <>
            {view === "list" && (
              <div className="hidden md:block">
                <BranchTable branches={shown} figures={figures} {...handlers} />
              </div>
            )}
            <div
              className={cn("grid gap-3 md:grid-cols-2 xl:grid-cols-3", view === "list" && "md:hidden")}
              data-testid="branches-cards"
            >
              {shown.map((b) => (
                <BranchCard key={b.id} branch={b} row={figures.get(b.id)} {...handlers} />
              ))}
            </div>
          </>
        )}
      </div>

      <BranchDrawer
        branch={opened}
        row={opened ? figures.get(opened.id) : undefined}
        figuresLoading={summaryLoading}
        onClose={() => setOpenId(null)}
        onEdit={(b) => {
          setOpenId(null);
          setDialog({ branch: b });
        }}
        onDelete={(b) => {
          setOpenId(null);
          setConfirm(b);
        }}
      />

      {dialog && (
        <BranchDialog
          key={dialog.branch?.id ?? "new"}
          branch={dialog.branch}
          branches={branches}
          saving={isSaving}
          onSave={handleSave}
          onClose={() => setDialog(null)}
        />
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent data-testid="confirm-delete">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete branch?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove <strong>{confirm?.name}</strong> from the branch lists.
              {confirmRow && headcount(confirmRow) > 0 && (
                <> {peopleLabel(confirmRow)} work there; their records and its departments are not deleted.</>
              )}
              {confirm?.isHeadOffice &&
                " It is the Head Office, so no branch will be marked as Head Office afterwards."}
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
