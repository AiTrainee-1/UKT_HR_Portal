import { useMemo, useState } from "react";
import {
  FileSpreadsheet,
  History,
  Info,
  LayoutList,
  ListChecks,
  MinusCircle,
  PlusCircle,
  RefreshCw,
  Scale,
  Users,
  Wallet,
} from "lucide-react";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { plural } from "@/components/payroll/kit/format";
import { EmptyNote, KpiTile, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { ViewSwitch, type ViewOption } from "@/components/payroll/kit/ViewSwitch";
import { Button } from "@/components/ui/button";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import { useListDepartments } from "@/lib/api-client";
import { usePayrollExcess, type ExcessKind, type PayrollScope } from "@/lib/api-client/custom-hooks";
import { inCategory } from "@/lib/departments";
import { cn } from "@/lib/utils";
import { BreakdownFilterBar, BreakdownList, SelectionBar } from "./BreakdownView";
import { AddEntryDialog, ChangeEntryDialog, RemoveEntriesDialog } from "./EntryDialogs";
import { exportExcessBreakdown } from "./export";
import { HistoryView } from "./HistoryView";
import {
  EXCESS_URL_DEFAULTS,
  breakdownFiltersFromUrl,
  breakdownFiltersToUrl,
  departmentFilterOptions,
  entriesByIds,
  entryIdsOf,
  excessPermissionKey,
  excessView,
  filterBreakdown,
  hasBreakdownFilters,
  historyUiFromUrl,
  historyUiToUrl,
  keepExisting,
  periodNoun,
  rowsOf,
  rupees,
  scopeKey,
  scopeLabel,
  signedRupees,
  type BreakdownFilters,
  type EntryWithRow,
  type ExcessView,
  type HistoryUi,
} from "./logic";
import { LockedNote, errorText } from "./parts";

/**
 * The Excess tab (owner 2026-11-20) of Staff Payroll (one month, `scope.kind` "staff") and of a Production Payroll cycle
 * page (one pay period, "production"): amounts HR adds to an employee's earned salary ("Excess") or takes off it
 * ("Detection"), each by hand with a mandatory remark. The period's summary, a department-wise breakdown (before -> after
 * earned salary and the payroll's NET), add / change / remove (one or many) and the full history. A month / period
 * finalized with Payroll Done is locked: nothing can change. Staff is indigo, production amber (the pages' own accents).
 */
export function ExcessPanel({ scope }: { scope: PayrollScope }) {
  const { user } = useAuth();
  const [url, setUrl] = useUrlParams(EXCESS_URL_DEFAULTS);
  const query = usePayrollExcess(scope);
  const data = query.data;
  const kind = scope.kind;
  const noun = periodNoun(kind);
  const accent = accentOf(kind);
  const ui = ACCENT_UI[accent];
  const periodLabel = data?.periodLabel || scopeLabel(scope);

  // Edit = the server says so AND the role's key is at Edit (a View-only role sees everything, changes nothing)
  const mayEdit = !!data?.canEdit && permissionLevel(user, excessPermissionKey(kind)) === "edit";
  const locked = !!data?.locked;
  const editable = mayEdit && !locked;
  const lockedMessage =
    data?.lockedMessage ??
    `${periodLabel} is finalized (Payroll Done): no excess or detection can be added, changed or removed.`;

  const view: ExcessView = excessView(url.exview);
  const filters = useMemo(() => breakdownFiltersFromUrl(url), [url]);
  const historyUi = useMemo(() => historyUiFromUrl(url), [url]);
  const setFilters = (patch: Partial<BreakdownFilters>) => setUrl(breakdownFiltersToUrl(patch));
  const setHistoryUi = (patch: Partial<HistoryUi>) => setUrl(historyUiToUrl(patch));

  const departments = useMemo(() => data?.departments ?? [], [data]);
  const shown = useMemo(() => filterBreakdown(departments, filters), [departments, filters]);
  const allRows = useMemo(() => rowsOf(departments), [departments]);
  const shownCount = useMemo(() => rowsOf(shown).length, [shown]);
  const inPayrollCount = allRows.filter((r) => r.inPayroll).length;
  const deptOptions = useMemo(() => departmentFilterOptions(departments), [departments]);
  // the history's department filter: every department of the page's category (staff / production)
  const allDepartments = useListDepartments();
  const historyDepartments = useMemo(
    () =>
      inCategory<{ id: number; name: string; category?: string | null }>(allDepartments.data, kind)
        .map((d) => ({ id: d.id, name: d.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allDepartments.data, kind],
  );

  // What is picked in the breakdown (only while changes are allowed): employees for a bulk add, entries for a bulk
  // remove. A new month / period, or losing the right to change, starts with nothing picked.
  const [pickedEmployeesRaw, setPickedEmployees] = useState<number[]>([]);
  const [pickedEntriesRaw, setPickedEntries] = useState<number[]>([]);
  const pickKey = `${scopeKey(scope)}|${editable}`;
  const [seenPickKey, setSeenPickKey] = useState(pickKey);
  if (seenPickKey !== pickKey) {
    setSeenPickKey(pickKey);
    setPickedEmployees([]);
    setPickedEntries([]);
  }
  const pickedEmployees = editable ? pickedEmployeesRaw : [];
  const pickedEntries = useMemo(
    () => (editable ? keepExisting(pickedEntriesRaw, entryIdsOf(departments)) : []),
    [editable, pickedEntriesRaw, departments],
  );

  const [adding, setAdding] = useState<{ ids: number[]; kind: ExcessKind } | null>(null);
  const [changing, setChanging] = useState<EntryWithRow | null>(null);
  const [removing, setRemoving] = useState<EntryWithRow[] | null>(null);

  const exportItems: ExportItem[] = [
    {
      key: "excess-xlsx",
      label: "Breakdown (Excel)",
      hint: hasBreakdownFilters(filters)
        ? `The ${plural(shownCount, "employee")} shown for ${periodLabel}, department by department, with every entry and remark`
        : `Every employee with an excess or detection in ${periodLabel}, department by department, with every entry and remark`,
      icon: FileSpreadsheet,
      disabled: shownCount === 0,
      run: () =>
        exportExcessBreakdown(
          shown,
          periodLabel,
          hasBreakdownFilters(filters) ? `Filtered: ${plural(shownCount, "employee")} of ${allRows.length}` : undefined,
          kind,
        ),
    },
  ];

  const addButton = mayEdit && (
    <span title={locked ? lockedMessage : undefined}>
      <Button
        className={cn("h-9 gap-2", ui.solid)}
        disabled={locked || !data}
        onClick={() => setAdding({ ids: [], kind: "excess" })}
        data-testid="excess-add-open"
      >
        <PlusCircle size={14} /> Add excess or detection
      </Button>
    </span>
  );

  const views: ViewOption<ExcessView>[] = [
    {
      value: "breakdown",
      label: "Breakdown",
      icon: LayoutList,
      count: query.isLoading ? null : (data?.summary.employees ?? 0),
      testId: "excess-view-breakdown",
    },
    { value: "history", label: "History", icon: History, testId: "excess-view-history" },
  ];

  const summary = data?.summary;
  return (
    <div className="min-w-0 space-y-5" data-testid="excess-tab" data-kind={kind}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900" data-testid="excess-title">
            Excess &amp; Detection · {periodLabel}
          </p>
          <p className="max-w-2xl text-xs text-muted-foreground">
            Amounts HR adds to (Excess) or takes off (Detection) an employee&apos;s earned salary for the {noun}, each
            with a remark.{" "}
            {kind === "production"
              ? "Earned salary on the payroll = shifts × rate + Excess − Detection."
              : "Earned salary on the payroll = earned + OT + Excess − Detection."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportMenu
            items={exportItems}
            label="Export"
            heading={`Export ${periodLabel}: Excess & Detection`}
            disabled={!data}
            testId="excess-export"
          />
          {addButton}
        </div>
      </div>

      {locked && <LockedNote testId="excess-locked-note">{lockedMessage}</LockedNote>}
      {data && !data.payrollGenerated && (
        <p
          className="flex items-start gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
          data-testid="excess-not-generated-note"
        >
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            The payroll for {periodLabel} is not generated yet: the amounts are added when the payroll is generated (and
            kept when it is generated again).
          </span>
        </p>
      )}

      {query.isLoading ? (
        <SkeletonKpis count={5} className="xl:grid-cols-5" />
      ) : (
        summary && (
          <div
            className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-5"
            data-testid="excess-summary"
          >
            <KpiTile
              label="Total excess"
              value={rupees(summary.excessTotal)}
              sub="Added to earned salaries"
              icon={PlusCircle}
              tone="bg-emerald-50 text-emerald-800"
              testId="excess-kpi-excess"
            />
            <KpiTile
              label="Total detection"
              value={rupees(summary.detectionTotal)}
              sub="Taken off earned salaries"
              icon={MinusCircle}
              tone="bg-rose-50 text-rose-800"
              testId="excess-kpi-detection"
            />
            <KpiTile
              label="Net effect"
              value={signedRupees(summary.net)}
              sub="Excess minus detection"
              icon={Scale}
              tone={ui.tile}
              testId="excess-kpi-net"
            />
            <KpiTile
              label="Employees affected"
              value={summary.employees}
              sub={data.payrollGenerated ? `${inPayrollCount} in payroll` : "Payroll not generated yet"}
              icon={Users}
              tone="bg-sky-50 text-sky-800"
              testId="excess-kpi-employees"
            />
            <KpiTile
              label="Entries"
              value={summary.entries}
              sub={`Active this ${noun}`}
              icon={ListChecks}
              tone="bg-slate-50 text-slate-700"
              testId="excess-kpi-entries"
              className="min-[480px]:col-span-2 md:col-span-1"
            />
          </div>
        )
      )}

      <ViewSwitch
        options={views}
        value={view}
        onChange={(v) => setUrl({ exview: v })}
        accent={accent}
        ariaLabel="Excess views"
      />

      {view === "history" ? (
        <HistoryView
          scope={scope}
          periodLabel={periodLabel}
          departments={historyDepartments}
          employees={data?.employeeOptions ?? []}
          ui={historyUi}
          onUi={setHistoryUi}
        />
      ) : query.isLoading ? (
        <SkeletonRows rows={5} />
      ) : query.isError || !data ? (
        <EmptyNote
          icon={RefreshCw}
          title={`The excess and detection of ${periodLabel} could not be loaded`}
          hint={errorText(query.error) ?? "Check the connection and try again."}
          testId="excess-error"
          action={
            <Button variant="outline" className="mt-2" onClick={() => void query.refetch()} data-testid="excess-retry">
              Try again
            </Button>
          }
        />
      ) : data.summary.entries === 0 && allRows.length === 0 ? (
        <EmptyNote
          icon={Wallet}
          title={`No excess or detection for ${periodLabel}`}
          hint={
            locked
              ? lockedMessage
              : mayEdit
                ? "Add an amount to an employee's earned salary (Excess) or take one off it (Detection), with a remark."
                : `Nothing was added to or taken off an earned salary this ${noun}.`
          }
          testId="excess-empty"
          action={
            editable ? (
              <Button
                className={cn("mt-2 gap-2", ui.solid)}
                onClick={() => setAdding({ ids: [], kind: "excess" })}
                data-testid="excess-empty-add"
              >
                <PlusCircle size={14} /> Add one
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="space-y-3">
          <BreakdownFilterBar
            value={filters}
            onChange={setFilters}
            departments={deptOptions}
            shown={shownCount}
            total={allRows.length}
            accent={accent}
          />
          <BreakdownList
            departments={shown}
            kind={kind}
            editable={editable}
            options={data.employeeOptions}
            pickedEmployees={pickedEmployees}
            onPickEmployees={setPickedEmployees}
            pickedEntries={pickedEntries}
            onPickEntries={setPickedEntries}
            onChangeEntry={setChanging}
            onRemoveEntries={setRemoving}
            onAddFor={(ids) => setAdding({ ids, kind: "excess" })}
            onClearFilters={() => setFilters({ q: "", dept: "", kind: "", inPayrollOnly: false })}
          />
          {editable && (
            <SelectionBar
              employees={pickedEmployees.length}
              entries={pickedEntries.length}
              onAdd={() => setAdding({ ids: pickedEmployees, kind: "excess" })}
              onRemove={() => setRemoving(entriesByIds(departments, pickedEntries))}
              onClearEmployees={() => setPickedEmployees([])}
              onClearEntries={() => setPickedEntries([])}
              accent={accent}
            />
          )}
        </div>
      )}

      {mayEdit && data && (
        <>
          <AddEntryDialog
            open={!!adding && !locked}
            onClose={() => setAdding(null)}
            // a bulk add from the breakdown is done: the picked employees are let go
            onSaved={() => {
              if (adding?.ids.length) setPickedEmployees([]);
            }}
            scope={scope}
            periodLabel={periodLabel}
            options={data.employeeOptions}
            initialEmployeeIds={adding?.ids}
            initialKind={adding?.kind}
          />
          <ChangeEntryDialog
            target={locked ? null : changing}
            kind={kind}
            periodLabel={periodLabel}
            onClose={() => setChanging(null)}
          />
          <RemoveEntriesDialog
            targets={locked ? null : removing}
            kind={kind}
            onClose={() => setRemoving(null)}
            onRemoved={(ids) => setPickedEntries((list) => list.filter((id) => !ids.includes(id)))}
          />
        </>
      )}
    </div>
  );
}
