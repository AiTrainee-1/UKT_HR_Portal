import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Calendar, CalendarDays, CalendarRange, Factory, Search, UserX, X } from "lucide-react";
import HrLayout from "@/components/HrLayout";
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
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments } from "@/lib/api-client";
import {
  PAY_CYCLES,
  PAY_CYCLE_INFO,
  isPayCycle,
  useAssignProductionCycle,
  useProductionCycles,
  useProductionEmployees,
  type PayCycle,
  type ProductionEmployeeRow,
} from "@/lib/api-client/custom-hooks";
import { EmployeeList } from "./production-employees/EmployeeList";
import { useDebounced } from "./production-employees/hooks";
import {
  ALL_DEPARTMENTS,
  NO_FILTERS,
  NO_SELECTION,
  PAGE_SIZE,
  TABS,
  assignmentToast,
  chooseDefaultTab,
  confirmWording,
  deselectRows,
  emptyInfo,
  errorText,
  filtersActive,
  hiddenSelected,
  isStatusFilter,
  isTab,
  listSelection,
  matchesTab,
  nameMap,
  needsConfirmation,
  paginate,
  planAssignment,
  requestFilters,
  selectRows,
  selectedRows,
  selectionText,
  showingText,
  tabCount,
  tabLabel,
  toggleRow,
  type Filters,
  type Plan,
  type Selection,
  type Tab,
} from "./production-employees/logic";
import {
  CYCLE_STYLE,
  ConfigHint,
  EmptyState,
  HowItWorks,
  Lines,
  ListSkeleton,
  LoadError,
  StatButton,
  UNASSIGNED_FILL,
} from "./production-employees/parts";

// Production Employees: who is paid on which pay cycle (Weekly / BiWeekly / Monthly) and who is on none yet. Each
// cycle's Production Payroll page generates payroll only for the employees assigned to it, so this is where a new
// production employee is put on a cycle. Backend: api/production_employee_views.py.

const SEARCH_DELAY_MS = 250;

const CYCLE_ICON: Record<PayCycle, ComponentType<{ size?: number; className?: string }>> = {
  weekly: Calendar,
  biweekly: CalendarRange,
  monthly: CalendarDays,
};

export default function ProductionEmployees() {
  const { toast } = useToast();
  // null until the first load decides where the page opens (Unassigned when anyone is, else All)
  const [tab, setTab] = useState<Tab | null>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const search = useDebounced(filters.search, SEARCH_DELAY_MS);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);
  const [confirm, setConfirm] = useState<Plan | null>(null);

  const shownTab: Tab = tab ?? "all";
  const list = useProductionEmployees(requestFilters(shownTab, filters, search));
  const departments = useListDepartments();
  const cycles = useProductionCycles();
  const assign = useAssignProductionCycle();

  useEffect(() => {
    if (tab === null && list.data) setTab(chooseDefaultTab(list.data.counts));
  }, [tab, list.data]);

  const counts = list.data?.counts;
  // The server filters by tab; filtering again keeps the previous list honest while a new tab's list loads.
  const rows = useMemo(
    () => (list.data?.employees ?? []).filter((r) => matchesTab(r, shownTab)),
    [list.data, shownTab],
  );
  const paged = useMemo(() => paginate(rows, page), [rows, page]);
  const chosen = useMemo(() => selectedRows(selection, rows), [selection, rows]);
  const listState = listSelection(selection, rows);
  const hidden = hiddenSelected(selection, rows);
  const active = filtersActive(filters);
  const departmentOptions = useMemo(
    () => [...(departments.data ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [departments.data],
  );
  const isConfigured = (cycle: PayCycle) => cycles.data?.cycles.find((c) => c.cycle === cycle)?.configured !== false;

  const selectTab = (next: Tab) => {
    setTab(next);
    setPage(1);
  };
  const patch = (p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };
  const clearFilters = () => {
    setFilters(NO_FILTERS);
    setPage(1);
  };
  const toggleAll = () => setSelection((s) => (listState === "all" ? deselectRows(s, rows) : selectRows(s, rows)));

  const run = async (plan: Plan) => {
    setConfirm(null);
    try {
      const result = await assign.mutateAsync({ employeeIds: plan.ids, cycle: plan.target });
      const wording = assignmentToast(result, plan.target, nameMap(plan.rows));
      toast({
        title: wording.title,
        description: wording.lines.length > 0 ? <Lines lines={wording.lines} /> : undefined,
        variant: wording.variant,
      });
      // the people just handled leave the selection; anyone else ticked stays ticked
      setSelection((s) => deselectRows(s, plan.rows));
    } catch (e) {
      toast({
        title: plan.target
          ? `Could not assign to ${PAY_CYCLE_INFO[plan.target].label}`
          : "Could not remove from the cycle",
        description: errorText(e),
        variant: "destructive",
      });
    }
  };

  /** Moving someone between cycles, or off one, is confirmed first; adding unassigned people goes straight through. */
  const start = (targets: ProductionEmployeeRow[], cycle: PayCycle | null) => {
    const plan = planAssignment(targets, cycle);
    if (plan.ids.length === 0) return;
    if (needsConfirmation(plan)) setConfirm(plan);
    else void run(plan);
  };

  const dash = (n: number | undefined) => (n === undefined ? "—" : n);
  const countsKey = TABS.map((t) => (counts ? tabCount(counts, t) : "-")).join("|");
  const wording = confirm ? confirmWording(confirm) : null;
  const failed = list.isError && !list.data;

  return (
    <HrLayout>
      <div className="space-y-5" data-testid="production-employees-page">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
              <Factory size={22} className="text-amber-600" /> Production Employees
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Every production employee (paid per shift) and the pay cycle they are on. Payroll is generated per cycle,
              so an employee is paid only once they are assigned to Weekly, BiWeekly or Monthly.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
          <StatButton
            testId="pe-stat-total"
            label="All production employees"
            value={dash(counts?.total)}
            sub={counts ? `${counts.total - counts.unassigned} on a cycle` : undefined}
            icon={Factory}
            tone="bg-slate-100 text-slate-800"
            ring="#0f172a"
            selected={shownTab === "all"}
            onClick={() => selectTab("all")}
          />
          {PAY_CYCLES.map((cycle) => (
            <StatButton
              key={cycle}
              testId={`pe-stat-${cycle}`}
              label={PAY_CYCLE_INFO[cycle].label}
              value={dash(counts?.[cycle])}
              sub={`${PAY_CYCLE_INFO[cycle].calculation} · ${PAY_CYCLE_INFO[cycle].days}-day period`}
              icon={CYCLE_ICON[cycle]}
              tone={CYCLE_STYLE[cycle].card}
              ring={CYCLE_STYLE[cycle].fill}
              selected={shownTab === cycle}
              onClick={() => selectTab(cycle)}
              hint={isConfigured(cycle) ? undefined : <ConfigHint cycle={cycle} />}
            />
          ))}
          <StatButton
            testId="pe-stat-unassigned"
            className="col-span-2 lg:col-span-1"
            label="Unassigned"
            value={dash(counts?.unassigned)}
            sub={!counts ? undefined : counts.unassigned > 0 ? "Not in any payroll yet" : "Everyone is on a cycle"}
            icon={UserX}
            tone={counts && counts.unassigned > 0 ? "bg-amber-50 text-amber-900" : "bg-gray-100 text-gray-700"}
            ring={UNASSIGNED_FILL}
            selected={shownTab === "unassigned"}
            onClick={() => selectTab("unassigned")}
          />
        </div>

        <div className="space-y-3 rounded-2xl border bg-white p-3">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
            <div className="relative flex-1">
              <Search
                size={15}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
              />
              <Input
                value={filters.search}
                onChange={(e) => patch({ search: e.target.value })}
                placeholder="Search by name or employee code"
                aria-label="Search production employees"
                className="h-10 pl-9 pr-9"
                data-testid="pe-search"
              />
              {filters.search && (
                <button
                  type="button"
                  onClick={() => patch({ search: "" })}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-gray-400 hover:text-gray-700"
                >
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 lg:flex">
              <Select value={filters.department} onValueChange={(v) => patch({ department: v })}>
                <SelectTrigger
                  className="h-10 lg:w-52"
                  aria-label="Filter by department"
                  data-testid="pe-department-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_DEPARTMENTS}>All departments</SelectItem>
                  {departmentOptions.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filters.status} onValueChange={(v) => isStatusFilter(v) && patch({ status: v })}>
                <SelectTrigger className="h-10 lg:w-44" aria-label="Filter by status" data-testid="pe-status-filter">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                  <SelectItem value="all">Active and inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            {tab === null && !failed ? (
              // The first load decides where the page opens (Unassigned when anyone is, else All). The tab row measures
              // itself once, when it appears, so drawing it before that would leave the wrong pill highlighted.
              <Skeleton className="h-9 w-80 max-w-full rounded-full" data-testid="pe-tabs-loading" />
            ) : (
              <div className="max-w-full overflow-x-auto">
                <PillTabs
                  key={countsKey}
                  size="sm"
                  items={TABS.map((t) => ({
                    value: t,
                    label: (
                      <span data-testid={`pe-tab-${t}`}>
                        {tabLabel(t)}{" "}
                        <span className="font-semibold opacity-70">({counts ? tabCount(counts, t) : "—"})</span>
                      </span>
                    ),
                    color: t === "unassigned" ? UNASSIGNED_FILL : isPayCycle(t) ? CYCLE_STYLE[t].fill : undefined,
                  }))}
                  value={shownTab}
                  onChange={(v) => isTab(v) && selectTab(v)}
                />
              </div>
            )}
            <p className="text-xs text-gray-500">
              {rows.length > 0 && <span data-testid="pe-showing">{showingText(paged)}</span>}
              {active && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="ml-2 font-semibold text-blue-600 hover:underline"
                  data-testid="pe-clear-filters"
                >
                  Clear filters
                </button>
              )}
            </p>
          </div>
        </div>

        {selection.size > 0 && (
          <div
            className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-2xl border border-amber-200 bg-amber-50/95 px-3 py-2.5 shadow-sm backdrop-blur"
            data-testid="pe-bulk-bar"
          >
            <p className="text-sm font-semibold text-amber-900" data-testid="pe-selected-count">
              {selectionText(selection.size, listState, hidden)}
              {hidden > 0 && (
                <span className="ml-1 font-normal text-amber-700">({hidden} not shown by the current filters)</span>
              )}
            </p>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {PAY_CYCLES.map((cycle) => (
                <Button
                  key={cycle}
                  size="sm"
                  className="border-0 text-white"
                  style={{ background: CYCLE_STYLE[cycle].fill }}
                  disabled={assign.isPending}
                  onClick={() => start(chosen, cycle)}
                  data-testid={`pe-bulk-${cycle}`}
                >
                  Assign to {PAY_CYCLE_INFO[cycle].label}
                </Button>
              ))}
              <Button
                size="sm"
                variant="outline"
                className="text-red-700"
                disabled={assign.isPending}
                onClick={() => start(chosen, null)}
                data-testid="pe-bulk-none"
              >
                Remove from cycle
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelection(NO_SELECTION)} data-testid="pe-bulk-clear">
                Clear selection
              </Button>
            </div>
          </div>
        )}

        {list.isLoading ? (
          <ListSkeleton />
        ) : failed ? (
          <LoadError what="the production employees" onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            info={emptyInfo(shownTab, active, counts?.total ?? 0)}
            onClear={clearFilters}
            onOpenUnassigned={() => selectTab("unassigned")}
          />
        ) : (
          <>
            <EmployeeList
              rows={paged.rows}
              allRows={rows}
              selection={selection}
              onToggle={(row) => setSelection((s) => toggleRow(s, row))}
              onToggleAll={toggleAll}
              onAssign={(row, cycle) => start([row], cycle)}
              busy={assign.isPending}
              stale={list.isPlaceholderData}
            />
            <DataPagination
              page={paged.page}
              totalPages={paged.totalPages}
              totalItems={paged.total}
              pageSize={PAGE_SIZE}
              onPageChange={setPage}
            />
          </>
        )}

        <HowItWorks />
      </div>

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent data-testid="pe-confirm-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{wording?.title}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                {wording?.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="pe-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirm && void run(confirm)}
              className={confirm?.target === null ? "bg-red-600 text-white hover:bg-red-700" : undefined}
              data-testid="pe-confirm"
            >
              {confirm?.target === null ? "Remove" : "Move"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </HrLayout>
  );
}
