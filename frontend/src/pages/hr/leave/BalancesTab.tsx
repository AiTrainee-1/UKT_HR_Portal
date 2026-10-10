import { useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight, Pencil, Plus, Scale, Search, Users, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useListEmployeesLite } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import {
  useAllocateLeave,
  useCreateLeaveType,
  useLeaveBalances,
  useLeaveTypes,
  type AllocateInput,
  type LeaveTypeInput,
} from "./api";
import { AllocateDialog, LeaveTypeDialog } from "./BalanceDialogs";
import { exportSheet } from "./export";
import {
  ALL,
  BALANCE_EXPORT_HEADERS,
  NO_BALANCE_FILTERS,
  balanceExportRows,
  balanceFiltersActive,
  branchOptions,
  departmentOptions,
  entitlementOf,
  filterBalances,
  fmtDays,
  joinBalances,
  summarizeBalances,
  usedPercent,
  type BalanceFilters,
  type BalanceFlag,
  type BalanceView,
  type PersonFields,
} from "./logic";
import {
  Chip,
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

const FLAG_CHIP: Record<BalanceFlag, { label: string; className: string } | null> = {
  ok: null,
  low: { label: "Low balance", className: "border-amber-200 bg-amber-50 text-amber-700" },
  exhausted: { label: "Exhausted", className: "border-red-200 bg-red-50 text-red-700" },
};

const BAR: Record<BalanceFlag, string> = { ok: "bg-emerald-500", low: "bg-amber-500", exhausted: "bg-red-500" };

function UsageBar({ b }: { b: BalanceView }) {
  return (
    <div className="h-1.5 w-full min-w-[4rem] overflow-hidden rounded-full bg-gray-100" aria-hidden>
      <div className={cn("h-full rounded-full", BAR[b.flag])} style={{ width: `${usedPercent(b)}%` }} />
    </div>
  );
}

export default function BalancesTab() {
  const { toast } = useToast();
  const [year, setYear] = useState(new Date().getFullYear());
  const [filters, setFilters] = useState<BalanceFilters>(NO_BALANCE_FILTERS);
  const set = (patch: Partial<BalanceFilters>) => setFilters((f) => ({ ...f, ...patch }));
  const visible = useVisibleCount();
  const [allocating, setAllocating] = useState<{ editing: BalanceView | null } | null>(null);
  const [addingType, setAddingType] = useState(false);

  const balances = useLeaveBalances(year);
  const types = useLeaveTypes();
  const employees = useListEmployeesLite();
  const allocate = useAllocateLeave();
  const createType = useCreateLeaveType();

  const activeEmployees = useMemo(() => (employees.data ?? []).filter((e) => e.status === "active"), [employees.data]);
  const people = useMemo(() => {
    const map = new Map<number, PersonFields>();
    for (const e of employees.data ?? []) {
      if (e.status !== "active") continue;
      map.set(e.id, {
        employeeId: e.id,
        employeeName: `${e.firstName} ${e.lastName}`.trim(),
        employeeCode: e.employeeCode,
        department: e.departmentName ?? null,
        designation: e.designationTitle ?? null,
        departmentId: e.departmentId ?? null,
        branchId: e.branchId ?? null,
        branch: e.branchName ?? null,
        employmentType: e.employmentType ?? null,
      });
    }
    return map;
  }, [employees.data]);

  const rows = useMemo(() => joinBalances(balances.data ?? [], people), [balances.data, people]);
  const shown = useMemo(() => filterBalances(rows, filters), [rows, filters]);
  const summary = useMemo(() => summarizeBalances(rows), [rows]);
  const branches = useMemo(() => branchOptions(rows), [rows]);
  const departments = useMemo(() => departmentOptions(rows), [rows]);
  const active = balanceFiltersActive(filters);
  const clear = () => setFilters(NO_BALANCE_FILTERS);
  const typeList = types.data ?? [];
  const loading = balances.isLoading || employees.isLoading || types.isLoading;
  const failed = balances.isError || employees.isError || types.isError;
  const retry = () => {
    void balances.refetch();
    void employees.refetch();
    void types.refetch();
  };

  const saveAllocation = async (input: AllocateInput) => {
    try {
      await allocate.mutateAsync(input);
    } catch (err) {
      toast({
        title: "Failed to save the allocation",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: allocating?.editing ? "Allocation saved" : "Leave allocated" });
    setAllocating(null);
  };

  const saveType = async (input: LeaveTypeInput) => {
    try {
      await createType.mutateAsync(input);
    } catch (err) {
      toast({
        title: "Failed to add the leave type",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      return;
    }
    toast({ title: `${input.name} added` });
    setAddingType(false);
  };

  const openAllocate = (editing: BalanceView | null) => {
    if (typeList.length === 0) {
      toast({
        title: "Add a leave type first",
        description: "Balances are days of a leave type.",
        variant: "destructive",
      });
      return;
    }
    setAllocating({ editing });
  };

  return (
    <div className="space-y-4 pt-4" data-testid="tab-balances">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Employees with a balance"
          value={summary.people}
          sub={`${summary.rows} balances in ${year}`}
          icon={Users}
          tone="bg-blue-50 text-blue-800"
          testId="bal-stat-people"
        />
        <StatCard
          label="Low balance"
          value={summary.low}
          sub="a fifth or less left"
          icon={AlertTriangle}
          tone="bg-amber-50 text-amber-800"
          testId="bal-stat-low"
          onClick={() => set({ flag: filters.flag === "low" ? ALL : "low" })}
          active={filters.flag === "low"}
        />
        <StatCard
          label="Exhausted"
          value={summary.exhausted}
          sub="nothing left to take"
          icon={Scale}
          tone="bg-red-50 text-red-800"
          testId="bal-stat-exhausted"
          onClick={() => set({ flag: filters.flag === "exhausted" ? ALL : "exhausted" })}
          active={filters.flag === "exhausted"}
        />
        <StatCard
          label="Days left"
          value={fmtDays(summary.daysLeft)}
          sub="across everyone shown"
          icon={Wallet}
          tone="bg-emerald-50 text-emerald-800"
          testId="bal-stat-left"
        />
      </div>

      <Card className="rounded-2xl" data-testid="leave-types">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold text-gray-900">Leave types</p>
              <p className="text-xs text-gray-500">The kinds of leave an employee can be given days of.</p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setAddingType(true)}
              data-testid="add-leave-type"
            >
              <Plus size={14} /> Add Leave Type
            </Button>
          </div>
          {types.isLoading ? (
            <p className="text-xs text-gray-400">Loading…</p>
          ) : typeList.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="no-leave-types">
              No leave types yet. Add one, then allocate its days to employees.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {typeList.map((t) => (
                <div key={t.id} className="rounded-xl border bg-gray-50 px-3 py-2" data-testid={`leave-type-${t.id}`}>
                  <p className="text-sm font-bold text-gray-900">
                    {t.name} <span className="font-mono text-xs font-semibold text-gray-400">{t.code}</span>
                  </p>
                  <p className="text-xs text-gray-500">
                    {t.maxDaysPerYear} days a year · {t.isPaid ? "Paid" : "Unpaid"}
                    {t.carryForward ? ` · carries up to ${t.maxCarryForwardDays}` : ""}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <FilterPanel>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setYear(year - 1)}
              aria-label="Previous year"
            >
              <ChevronLeft size={16} />
            </Button>
            <span className="min-w-[4rem] text-center text-sm font-bold text-gray-900" data-testid="bal-year">
              {year}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-9 w-9"
              onClick={() => setYear(year + 1)}
              aria-label="Next year"
            >
              <ChevronRight size={16} />
            </Button>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <ExportButton
              disabled={shown.length === 0}
              testId="bal-export"
              onClick={() => exportSheet(`Leave balances ${year}`, BALANCE_EXPORT_HEADERS, balanceExportRows(shown))}
            />
            <Button className="h-10 gap-1.5" onClick={() => openAllocate(null)} data-testid="bal-allocate">
              <Plus size={15} /> Add Allocation
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
          <SearchBox
            value={filters.query}
            onChange={(query) => set({ query })}
            placeholder="Search by name, employee code, department or branch"
            label="Search balances"
            testId="bal-search"
          />
          <div className="grid grid-cols-2 gap-2 lg:flex">
            <FilterSelect
              value={filters.leaveType}
              onChange={(leaveType) => set({ leaveType })}
              label="Filter by leave type"
              allLabel="All leave types"
              options={typeList.map((t) => ({ value: String(t.id), label: t.name }))}
              testId="bal-filter-type"
            />
            <FilterSelect
              value={filters.branch}
              onChange={(branch) => set({ branch })}
              label="Filter by branch"
              allLabel="All branches"
              options={branches}
              testId="bal-filter-branch"
            />
            <FilterSelect
              value={filters.department}
              onChange={(department) => set({ department })}
              label="Filter by department"
              allLabel="All departments"
              options={departments}
              testId="bal-filter-department"
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
              testId="bal-filter-employee-type"
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <PillTabs
            size="sm"
            items={[
              { value: "all", label: "All" },
              { value: "low", label: "Low or exhausted", count: summary.low + summary.exhausted },
              { value: "exhausted", label: "Exhausted", count: summary.exhausted },
            ]}
            value={filters.flag}
            onChange={(flag) => set({ flag })}
          />
          <ResultLine
            shown={shown.length}
            total={rows.length}
            noun="balances"
            active={active}
            onClear={clear}
            testId="bal-count"
          />
        </div>
      </FilterPanel>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {loading ? (
            <ListSkeleton testId="bal-loading" />
          ) : failed ? (
            <ErrorState what="leave balances" onRetry={retry} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Scale}
              title={`No balances for ${year}`}
              text={
                typeList.length === 0
                  ? "Add a leave type first, then allocate its days to employees."
                  : "Allocate days of a leave type to an employee to start their balance for the year."
              }
              testId="bal-empty"
              action={
                <Button onClick={() => openAllocate(null)} className="gap-1.5">
                  <Plus size={15} /> Add Allocation
                </Button>
              }
            />
          ) : shown.length === 0 ? (
            <EmptyState
              icon={Search}
              title="No balance matches"
              text="Try fewer words, or clear the filters."
              tone="bg-gray-100 text-gray-500"
              testId="bal-no-match"
              action={
                <Button variant="outline" onClick={clear}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <div className="hidden md:block">
                <Table data-testid="balances-table">
                  <TableHeader>
                    <TableRow>
                      {["Employee", "Leave type", "Allocated", "Used", "Remaining", "Usage", ""].map((h) => (
                        <TableHead
                          key={h || "actions"}
                          className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60"
                        >
                          {h}
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {shown.slice(0, visible.count).map((b) => {
                      const flag = FLAG_CHIP[b.flag];
                      return (
                        <TableRow key={b.id} data-testid={`balance-${b.id}`} data-flag={b.flag}>
                          <TableCell>
                            <PersonCell
                              id={b.employeeId}
                              name={b.employeeName}
                              code={b.employeeCode}
                              sub={[b.department, b.branch].filter(Boolean).join(" · ") || null}
                            />
                          </TableCell>
                          <TableCell className="text-sm text-gray-700">{b.leaveTypeName ?? "-"}</TableCell>
                          <TableCell className="text-sm font-semibold">
                            {fmtDays(b.allocated)}
                            {b.carriedForward > 0 && (
                              <span className="ml-1 text-xs font-normal text-gray-400">
                                +{fmtDays(b.carriedForward)} carried
                              </span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">{fmtDays(b.used)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-bold">{fmtDays(b.remaining)}</span>
                              {flag && <Chip className={flag.className}>{flag.label}</Chip>}
                            </div>
                          </TableCell>
                          <TableCell className="w-32">
                            <UsageBar b={b} />
                            <p className="mt-0.5 text-[10px] text-gray-400">
                              {fmtDays(b.used)} of {fmtDays(entitlementOf(b))}
                            </p>
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => openAllocate(b)}
                              aria-label={`Edit ${b.employeeName ?? "employee"}'s ${b.leaveTypeName ?? "leave"} allocation`}
                              className="h-8 w-8 text-gray-500"
                            >
                              <Pencil size={14} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="divide-y md:hidden" data-testid="balances-cards">
                {shown.slice(0, visible.count).map((b) => {
                  const flag = FLAG_CHIP[b.flag];
                  return (
                    <div key={b.id} className="space-y-2 p-4" data-testid={`balance-card-${b.id}`}>
                      <div className="flex items-start justify-between gap-2">
                        <PersonCell id={b.employeeId} name={b.employeeName} code={b.employeeCode} sub={b.department} />
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openAllocate(b)}
                          aria-label={`Edit ${b.employeeName ?? "employee"}'s ${b.leaveTypeName ?? "leave"} allocation`}
                          className="h-8 w-8 shrink-0 text-gray-500"
                        >
                          <Pencil size={14} />
                        </Button>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-gray-600">
                        <span className="font-semibold">{b.leaveTypeName}</span>
                        <span>
                          {fmtDays(b.remaining)} left of {fmtDays(entitlementOf(b))}
                        </span>
                        {flag && <Chip className={flag.className}>{flag.label}</Chip>}
                      </div>
                      <UsageBar b={b} />
                    </div>
                  );
                })}
              </div>
              <MoreRows shown={Math.min(visible.count, shown.length)} total={shown.length} onMore={visible.more} />
            </>
          )}
        </CardContent>
      </Card>

      <AllocateDialog
        open={allocating !== null}
        editing={allocating?.editing ?? null}
        employees={activeEmployees}
        types={typeList}
        year={year}
        saving={allocate.isPending}
        onClose={() => setAllocating(null)}
        onSave={saveAllocation}
      />
      <LeaveTypeDialog
        open={addingType}
        saving={createType.isPending}
        onClose={() => setAddingType(false)}
        onSave={saveType}
      />
    </div>
  );
}
