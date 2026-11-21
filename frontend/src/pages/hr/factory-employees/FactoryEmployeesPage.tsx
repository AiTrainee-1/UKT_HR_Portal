import { useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { AlertTriangle, Clock, HardHat, Info, Plus, Tags, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useAuth } from "@/contexts/AuthContext";
import { useDebounced } from "@/hooks/use-debounced";
import { useToast } from "@/hooks/use-toast";
import {
  getListBranchesQueryKey,
  useFactoryEmployees,
  useFactoryShifts,
  useListBranches,
  useRemoveFactoryEmployees,
  useRemoveFactoryShift,
  useSetFactoryEmployeeStatus,
  useSetFactoryLabel,
  useSetFactoryPayroll,
  type FactoryEmployee,
  type FactoryPayCycle,
} from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { moveConflict } from "../production-employees/logic";
import { AddExistingDialog } from "./AddExistingDialog";
import { AssignShiftDialog, type ShiftTarget } from "./AssignShiftDialog";
import { CycleReasonDialog, LabelConfirmDialog, RemoveDialog, ShiftRemoveDialog, StatusDialog } from "./ConfirmDialogs";
import { CreateEmployeeDialog } from "./CreateEmployeeDialog";
import { EditEmployeeSheet } from "./EditEmployeeSheet";
import type { RowActions } from "./EmployeeList";
import { EmployeesSection } from "./EmployeesSection";
import { LabelsSection } from "./LabelsSection";
import {
  ALL,
  NO_FILTERS,
  NO_SELECTION,
  PAY_CYCLE_LABEL,
  SECTIONS,
  SECTION_LABEL,
  deselectRows,
  emptyInfo,
  employees,
  errorText,
  figures,
  filtersActive,
  hiddenSelected,
  isSection,
  labelTabs,
  listSelection,
  matchesAttention,
  matchesLabel,
  movedLines,
  paginate,
  payrollToast,
  requestFilters,
  rightsFor,
  sectionFromSearch,
  selectRows,
  selectedRows,
  shiftRemoveToast,
  toggleRow,
  validLabelTab,
  type Attention,
  type Filters,
  type Section,
  type Selection,
} from "./logic";
import { Lines, StatButton } from "./parts";
import { ProfileSheet } from "./ProfileSheet";
import { SetPayrollDialog } from "./SetPayrollDialog";
import { ShiftsSection } from "./ShiftsSection";

// Employees -> Factory Employees (owner 2026-11-20): drivers, housekeeping, chefs, security and other factory support
// staff in one place, organised by LABEL (the page's categories). They are ordinary employees (attendance, payroll and All
// Employees treat them like everyone else). Here: labels, the list, personal details, payroll (Staff Payroll monthly, or
// Production Payroll on a Weekly / BiWeekly / Monthly frequency) and putting people on existing shifts or taking them off;
// shifts themselves are configured on Manage Shifts. The page's own actions take employees.factory (edit); editing
// personal details and the status keep their own keys. Backend: api/factory_employee_views.py.

const SEARCH_DELAY_MS = 250;

export default function FactoryEmployeesPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const level = useLevel();
  const [location, navigate] = useLocation();
  const searchString = useSearch();

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const search = useDebounced(filters.search, SEARCH_DELAY_MS);
  const [labelTabAsked, setLabelTab] = useState<string>(ALL);
  const [attention, setAttention] = useState<Attention>("all");
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<Selection>(NO_SELECTION);

  const [createOpen, setCreateOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [profile, setProfile] = useState<FactoryEmployee | null>(null);
  const [editing, setEditing] = useState<{ row: FactoryEmployee; focus: "salary" | null } | null>(null);
  const [removing, setRemoving] = useState<FactoryEmployee[] | null>(null);
  const [statusTarget, setStatusTarget] = useState<{ rows: FactoryEmployee[]; status: "active" | "inactive" } | null>(
    null,
  );
  const [shiftTarget, setShiftTarget] = useState<ShiftTarget | null>(null);
  const [shiftRemoving, setShiftRemoving] = useState<{ id: number; name: string }[] | null>(null);
  const [payrollTarget, setPayrollTarget] = useState<FactoryEmployee[] | null>(null);
  const [labelTarget, setLabelTarget] = useState<{ rows: FactoryEmployee[]; labelId: number | null } | null>(null);
  const [cycleReason, setCycleReason] = useState<{
    row: FactoryEmployee;
    cycle: FactoryPayCycle;
    message: string | null;
  } | null>(null);

  const list = useFactoryEmployees(requestFilters(filters, search));
  const rights = rightsFor(level, list.data?.canEdit);
  const section = sectionFromSearch(searchString);
  const needsBranch = !user?.branchId;

  const branchesQuery = useListBranches({
    queryKey: getListBranchesQueryKey(),
    enabled: needsBranch && level("employees.branches") !== "hidden",
  });
  const shiftsQuery = useFactoryShifts();
  const branches = branchesQuery.data ?? [];
  const shifts = useMemo(() => shiftsQuery.data?.shifts ?? [], [shiftsQuery.data]);

  const setLabel = useSetFactoryLabel();
  const remove = useRemoveFactoryEmployees();
  const status = useSetFactoryEmployeeStatus();
  const payroll = useSetFactoryPayroll();
  const removeShift = useRemoveFactoryShift();
  const busy = setLabel.isPending || remove.isPending || status.isPending || payroll.isPending || removeShift.isPending;

  const labels = useMemo(() => list.data?.labels ?? [], [list.data]);
  const counts = list.data?.counts;
  const labelTab = list.data ? validLabelTab(labelTabAsked, labels) : labelTabAsked;
  const allRows = useMemo(() => list.data?.employees ?? [], [list.data]);
  const rows = useMemo(
    () => allRows.filter((r) => matchesLabel(r, labelTab) && matchesAttention(r, attention)),
    [allRows, labelTab, attention],
  );
  const paged = useMemo(() => paginate(rows, page), [rows, page]);
  const chosen = useMemo(() => selectedRows(selection, rows), [selection, rows]);
  const listState = listSelection(selection, rows);
  const hidden = hiddenSelected(selection, rows);
  const figs = figures(allRows, counts);
  const tabs = labelTabs(labels, counts);
  const filtered = filtersActive(filters);
  const labelName = labels.find((l) => String(l.id) === labelTab)?.name ?? null;
  const defaultLabelId = labelTab !== ALL && labelTab !== "none" ? labelTab : "";

  const openSection = (s: Section) => {
    navigate(s === "employees" ? location : `${location}?tab=${s}`);
  };
  const patchFilters = (p: Partial<Filters>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };
  const clearFilters = () => {
    setFilters(NO_FILTERS);
    setAttention("all");
    setPage(1);
  };
  const pickLabelTab = (tab: string) => {
    setLabelTab(tab);
    setPage(1);
  };
  const pickAttention = (a: Attention) => {
    setAttention(a);
    setPage(1);
    if (section !== "employees") openSection("employees");
  };

  // ── the actions ──

  const runLabel = async (targets: FactoryEmployee[], labelId: number | null) => {
    if (!targets.length) return;
    const name = labels.find((l) => l.id === labelId)?.name;
    try {
      const result = await setLabel.mutateAsync({ employeeIds: targets.map((r) => r.id), labelId });
      const moved = movedLines(result.moved);
      toast({
        title: name
          ? `${employees(result.updated)} labelled ${name}`
          : `Label removed from ${employees(result.updated)}`,
        description: moved.length ? <Lines lines={moved} /> : undefined,
      });
      setSelection((s) => deselectRows(s, targets));
    } catch (e) {
      toast({ title: "The label was not changed", description: errorText(e), variant: "destructive" });
    }
  };

  const runRemove = async () => {
    if (!removing) return;
    const targets = removing;
    try {
      const result = await remove.mutateAsync({ employeeIds: targets.map((r) => r.id) });
      setRemoving(null);
      setSelection((s) => deselectRows(s, targets));
      toast({
        title: `${employees(result.updated)} removed from Factory Employees`,
        description: "They are still employees, in All Employees.",
      });
    } catch (e) {
      setRemoving(null);
      toast({ title: "Nobody was removed", description: errorText(e), variant: "destructive" });
    }
  };

  const askStatus = (targets: FactoryEmployee[], next: "active" | "inactive") => {
    const changing = targets.filter((r) => (r.status === "active" ? "active" : "inactive") !== next);
    if (!changing.length) {
      toast({ title: `Already ${next}`, description: `Everyone chosen is ${next} already.` });
      return;
    }
    setStatusTarget({ rows: changing, status: next });
  };

  const runStatus = async () => {
    if (!statusTarget) return;
    const { rows: targets, status: next } = statusTarget;
    const result = await status.mutateAsync({ ids: targets.map((r) => r.id), status: next });
    setStatusTarget(null);
    setSelection((s) => deselectRows(s, targets));
    toast({
      title: result.updated ? `${employees(result.updated)} marked ${next}` : `Nobody was marked ${next}`,
      description: result.failed.length
        ? `${employees(result.failed.length)} could not be changed: ${errorText(result.failed[0].error)}`
        : undefined,
      variant: result.failed.length ? "destructive" : undefined,
    });
  };

  const askShiftRemove = (targets: { id: number; name: string; shift?: unknown }[]) => {
    const on = targets.filter((r) => !("shift" in r) || r.shift);
    if (!on.length) {
      toast({ title: "Nobody is on a shift", description: "None of the chosen employees has a shift to end." });
      return;
    }
    setShiftRemoving(on.map((r) => ({ id: r.id, name: r.name })));
  };

  const runShiftRemove = async (lastDay: string) => {
    if (!shiftRemoving) return;
    const targets = shiftRemoving;
    try {
      const result = await removeShift.mutateAsync({ employeeIds: targets.map((r) => r.id), lastDay });
      setShiftRemoving(null);
      setSelection((s) => deselectRows(s, targets));
      toast({ title: shiftRemoveToast(result, lastDay) });
    } catch (e) {
      setShiftRemoving(null);
      toast({ title: "Nobody was taken off a shift", description: errorText(e), variant: "destructive" });
    }
  };

  /** The "No pay cycle" quick fix: Production Payroll on the chosen frequency (a paid worker's move needs a reason). */
  const runCycle = async (row: FactoryEmployee, cycle: FactoryPayCycle, reason?: string) => {
    const form = { category: "production" as const, payCycle: cycle };
    try {
      const result = await payroll.mutateAsync({
        employeeIds: [row.id],
        category: "production",
        payCycle: cycle,
        ...(reason ? { confirm: true, reason } : {}),
      });
      setCycleReason(null);
      const words = payrollToast(result, form);
      toast({
        title: result.updated.length ? `${row.name} is paid ${PAY_CYCLE_LABEL[cycle]}` : words.title,
        description: words.lines.length ? <Lines lines={words.lines} /> : undefined,
        variant: words.failed ? "destructive" : undefined,
      });
    } catch (e) {
      const facts = moveConflict(e);
      if (facts && !reason) {
        setCycleReason({ row, cycle, message: facts[0]?.message ?? null });
        return;
      }
      setCycleReason(null);
      toast({
        title: `Could not set ${PAY_CYCLE_LABEL[cycle]} for ${row.name}`,
        description: errorText(e),
        variant: "destructive",
      });
    }
  };

  const actions: RowActions = {
    onProfile: (row) => setProfile(row),
    onEdit: (row, focus) => {
      setProfile(null);
      setEditing({ row, focus: focus ?? null });
    },
    onShift: (targets) => setShiftTarget({ rows: targets }),
    onShiftRemove: (targets) => askShiftRemove(targets),
    onPayroll: (targets) => setPayrollTarget(targets),
    onLabel: (targets, labelId) => void runLabel(targets, labelId),
    onRemove: (targets) => setRemoving(targets),
    onStatus: askStatus,
    onCycle: (row, cycle) => void runCycle(row, cycle),
  };

  const addButtons = rights.manage ? (
    <div className="flex flex-col gap-2 sm:flex-row">
      <Button variant="outline" className="gap-1.5" onClick={() => setAddOpen(true)} data-testid="fe-add-existing">
        <UserPlus size={15} /> Add existing employees
      </Button>
      <Button className="gap-1.5" onClick={() => setCreateOpen(true)} data-testid="fe-new">
        <Plus size={15} /> New factory employee
      </Button>
    </div>
  ) : null;

  const dash = (n: number) => (list.data ? n : "—");
  const loaded = !!list.data;

  return (
    <div className="space-y-5" data-testid="factory-employees-page">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
            <HardHat size={22} className="text-teal-600" /> Factory Employees
          </h2>
          <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
            Drivers, housekeeping, chefs, security and other factory support staff, organised by label. They are
            ordinary employees: attendance, payroll and All Employees treat them like everyone else.
          </p>
        </div>
        {addButtons}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatButton
          testId="fe-stat-total"
          label="Factory employees"
          value={dash(figs.total)}
          sub={loaded ? `${figs.active} active · ${figs.inactive} inactive` : undefined}
          icon={HardHat}
          tone="bg-teal-50 text-teal-900"
          ring="#0d9488"
          selected={section === "employees" && attention === "all" && labelTab === ALL}
          onClick={() => {
            pickLabelTab(ALL);
            pickAttention("all");
          }}
        />
        <StatButton
          testId="fe-stat-labels"
          label="Labels"
          value={dash(labels.length)}
          sub={loaded ? `${counts?.unlabeled ?? 0} without a label` : undefined}
          icon={Tags}
          tone="bg-violet-50 text-violet-900"
          ring="#7c3aed"
          selected={section === "labels"}
          onClick={() => openSection("labels")}
        />
        <StatButton
          testId="fe-stat-payroll"
          label="Payroll skips them"
          value={dash(figs.payroll)}
          sub={
            loaded
              ? figs.payroll > 0
                ? "Active, missing a salary or frequency"
                : "Everyone is payroll-ready"
              : undefined
          }
          icon={AlertTriangle}
          tone={figs.payroll > 0 ? "bg-amber-50 text-amber-900" : "bg-gray-100 text-gray-700"}
          ring="#d97706"
          selected={section === "employees" && attention === "payroll"}
          onClick={() => pickAttention(attention === "payroll" ? "all" : "payroll")}
        />
        <StatButton
          testId="fe-stat-noshift"
          label="No shift"
          value={dash(figs.noShift)}
          sub={loaded ? (figs.noShift > 0 ? "Active, not on any shift" : "Everyone has a shift") : undefined}
          icon={Clock}
          tone={figs.noShift > 0 ? "bg-orange-50 text-orange-900" : "bg-gray-100 text-gray-700"}
          ring="#ea580c"
          selected={section === "employees" && attention === "shift"}
          onClick={() => pickAttention(attention === "shift" ? "all" : "shift")}
        />
      </div>

      <div className="max-w-full overflow-x-auto">
        <PillTabs
          size="sm"
          items={SECTIONS.map((s) => ({
            value: s,
            label: <span data-testid={`fe-section-${s}`}>{SECTION_LABEL[s]}</span>,
          }))}
          value={section}
          onChange={(v) => isSection(v) && openSection(v)}
        />
      </div>

      {section === "employees" && (
        <>
          <EmployeesSection
            filters={filters}
            onFilters={patchFilters}
            onClearFilters={clearFilters}
            filtered={filtered}
            tabs={tabs}
            labelTab={labelTab}
            onLabelTab={pickLabelTab}
            onManageLabels={() => openSection("labels")}
            attention={attention}
            onAttention={pickAttention}
            loading={list.isLoading}
            failed={list.isError && !list.data}
            onRetry={() => void list.refetch()}
            stale={list.isPlaceholderData}
            rows={rows}
            paged={paged}
            onPage={setPage}
            selection={selection}
            selected={chosen}
            listState={listState}
            hidden={hidden}
            onToggle={(row) => setSelection((s) => toggleRow(s, row))}
            onToggleAll={() => setSelection((s) => (listState === "all" ? deselectRows(s, rows) : selectRows(s, rows)))}
            onClearSelection={() => setSelection(NO_SELECTION)}
            labels={labels}
            rights={rights}
            actions={actions}
            onBulkLabel={(targets, labelId) => {
              if (targets.length) setLabelTarget({ rows: targets, labelId });
            }}
            busy={busy}
            empty={emptyInfo({
              total: counts?.total ?? 0,
              filtered,
              labelTab,
              labelName,
              attention,
              manage: rights.manage,
            })}
            addButtons={addButtons}
          />
          <Card className="border-0 bg-gray-50">
            <CardContent className="p-4" data-testid="fe-how-it-works">
              <div className="flex items-start gap-2">
                <Info size={14} className="mt-0.5 shrink-0 text-teal-600" />
                <div className="space-y-1 text-xs text-gray-600">
                  <p className="font-bold text-gray-800">How it works</p>
                  <p>
                    Staff Payroll pays a monthly salary every month. Production Payroll pays per shift on the frequency
                    chosen (Weekly, BiWeekly or Monthly), on that frequency&apos;s Production Payroll page.
                  </p>
                  <p>
                    Labels say what people do (Driver, Housekeeping, Chef, Security...), and a label is also the
                    employee&apos;s department and designation (e.g. DRIVER) across the HRMS. Removing someone from
                    Factory Employees only takes them off this page: they stay an employee with the same attendance and
                    payroll.
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {section === "labels" && (
        <LabelsSection
          labels={labels}
          loading={list.isLoading}
          canManage={rights.manage}
          onShowEmployees={(id) => {
            pickLabelTab(String(id));
            pickAttention("all");
          }}
        />
      )}

      {section === "shifts" && (
        <ShiftsSection
          data={shiftsQuery.data}
          loading={shiftsQuery.isLoading}
          failed={shiftsQuery.isError && !shiftsQuery.data}
          onRetry={() => void shiftsQuery.refetch()}
          canManage={rights.manage && shiftsQuery.data?.canEdit !== false}
          onAssign={(targets, shiftId) => setShiftTarget({ rows: targets, shiftId })}
          onRemove={(people) => askShiftRemove(people)}
        />
      )}

      {createOpen && (
        <CreateEmployeeDialog
          labels={labels}
          branches={branches}
          shifts={shifts}
          needsBranch={needsBranch}
          defaultLabelId={defaultLabelId}
          onClose={() => setCreateOpen(false)}
          onOpenProfile={(row) => {
            setCreateOpen(false);
            setProfile(row);
          }}
        />
      )}
      {addOpen && (
        <AddExistingDialog labels={labels} defaultLabelId={defaultLabelId} onClose={() => setAddOpen(false)} />
      )}
      {shiftTarget && <AssignShiftDialog target={shiftTarget} shifts={shifts} onClose={() => setShiftTarget(null)} />}
      {payrollTarget && <SetPayrollDialog rows={payrollTarget} onClose={() => setPayrollTarget(null)} />}

      <ProfileSheet
        row={profile ? (allRows.find((r) => r.id === profile.id) ?? profile) : null}
        canEdit={rights.editEmployee || rights.manage}
        canPayroll={rights.manage}
        onEdit={actions.onEdit}
        onClose={() => setProfile(null)}
      />
      <EditEmployeeSheet
        row={editing ? (allRows.find((r) => r.id === editing.row.id) ?? editing.row) : null}
        focus={editing?.focus ?? null}
        branches={branches}
        needsBranch={needsBranch}
        rights={rights}
        onClose={() => setEditing(null)}
      />
      <RemoveDialog
        rows={removing}
        busy={remove.isPending}
        onConfirm={() => void runRemove()}
        onClose={() => setRemoving(null)}
      />
      <StatusDialog
        target={statusTarget}
        busy={status.isPending}
        onConfirm={() => void runStatus()}
        onClose={() => setStatusTarget(null)}
      />
      <ShiftRemoveDialog
        people={shiftRemoving}
        busy={removeShift.isPending}
        onConfirm={(lastDay) => void runShiftRemove(lastDay)}
        onClose={() => setShiftRemoving(null)}
      />
      <LabelConfirmDialog
        target={
          labelTarget
            ? { count: labelTarget.rows.length, label: labels.find((l) => l.id === labelTarget.labelId) ?? null }
            : null
        }
        busy={setLabel.isPending}
        onConfirm={() => {
          if (!labelTarget) return;
          const { rows: targets, labelId } = labelTarget;
          setLabelTarget(null);
          void runLabel(targets, labelId);
        }}
        onClose={() => setLabelTarget(null)}
      />
      <CycleReasonDialog
        target={cycleReason}
        busy={payroll.isPending}
        onConfirm={(reason) => cycleReason && void runCycle(cycleReason.row, cycleReason.cycle, reason)}
        onClose={() => setCycleReason(null)}
      />
    </div>
  );
}
