import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BadgeIndianRupee, Hand, Info, ReceiptText, Users, Wallet } from "lucide-react";
import { RefreshButton } from "@/components/PageRefreshBar";
import { inr } from "@/components/payroll/kit/format";
import { KpiTile } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { canEdit, isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import {
  DEFAULT_SLIP_OPTIONS,
  useSalarySlipCenterList,
  type SlipCenterEmployee,
  type SlipOptions,
} from "@/lib/api-client/custom-hooks/salary-slip-center";
import { moduleForPath } from "@/lib/permission-modules";
import { BulkBar } from "./BulkBar";
import { EmployeeList } from "./EmployeeList";
import { HoldDialog, ReleaseDialog } from "./HoldDialogs";
import { BankReviewPanel, ProgressPanel, SkippedPanel } from "./JobPanels";
import { OptionSwitches } from "./OptionsBar";
import { PeriodPicker } from "./PeriodPicker";
import { PreviewSheet } from "./PreviewSheet";
import { Toolbar } from "./Toolbar";
import {
  NO_FILTERS,
  NO_SELECTION,
  PAGE_SIZE,
  SALARY_SLIP_MODULE,
  SALARY_SLIP_PATH,
  changeCategory,
  departmentOptions,
  designationOptions,
  emptyInfo,
  errorText,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  hiddenSelected,
  isSlipTab,
  listSelection,
  monthLabel,
  paginate,
  resolvePeriod,
  selectRows,
  deselectRows,
  selectedEmployees,
  shiftMonth,
  summarize,
  tabCounts,
  toggleId,
  unitOptions,
  visibleRows,
  type CategoryFilter,
  type Selection,
  type SlipFilters,
  type SlipTab,
} from "./logic";
import { EmptyState, ListSkeleton } from "./parts";
import { useSlipJobs } from "./useSlipJobs";

const NO_EMPLOYEES: SlipCenterEmployee[] = [];

type Props = {
  url: Record<string, string>;
  setUrl: (patch: Record<string, string>) => void;
};

/**
 * The Salary Slip page under its title: the month, the figures, the deduction switches, the filters and tabs, the list
 * with its ticks and row actions, the bulk bar with progress, the bank check, the preview sheet and the Hold dialogs.
 */
export function SlipWorkspace({ url, setUrl }: Props) {
  const { user } = useAuth();
  const { month, year } = useMemo(() => resolvePeriod({ month: url.month, year: url.year }), [url.month, url.year]);
  const list = useSalarySlipCenterList(month, year);
  const data = list.data;
  const period = data?.periodLabel || monthLabel(month, year);
  const moduleKey = moduleForPath(SALARY_SLIP_PATH) ?? SALARY_SLIP_MODULE;
  // Generate and Hold / Release need the page's Edit right, as the server says it for this login and as the role says it
  const mayEdit = data?.canEdit === true && canEdit(user, moduleKey);
  // the layout already shows its View Only banner for a view-only role; this page's own note is for anything else
  const layoutViewOnly = isRouteViewOnly(user, SALARY_SLIP_PATH, moduleKey);

  const tab: SlipTab = isSlipTab(url.tab) ? url.tab : "active";
  const filters = useMemo(() => filtersFromUrl(url), [url]);
  const employees = data?.employees ?? NO_EMPLOYEES;
  const rows = useMemo(() => visibleRows(employees, tab, filters), [employees, tab, filters]);
  const counts = useMemo(() => (data ? tabCounts(employees, filters) : null), [data, employees, filters]);
  const paged = paginate(rows, Number(url.page));
  const summary = useMemo(() => summarize(employees), [employees]);
  const departments = useMemo(
    () => departmentOptions(data?.departments ?? [], filters.category),
    [data, filters.category],
  );
  const designations = useMemo(
    () => designationOptions(data?.designations ?? [], filters.category),
    [data, filters.category],
  );
  const units = useMemo(() => unitOptions(data?.units ?? []), [data]);
  const filtered = filtersActive(filters);

  // The deductions switches start from the server's defaults (all on), once per visit.
  const [options, setOptions] = useState<SlipOptions>(DEFAULT_SLIP_OPTIONS);
  const seeded = useRef(false);
  useEffect(() => {
    if (data && !seeded.current) {
      seeded.current = true;
      if (data.defaultOptions) setOptions(data.defaultOptions);
    }
  }, [data]);

  // The ticks belong to one month: another month is another list, so nothing stays ticked.
  const periodKey = `${year}-${month}`;
  const [ticks, setTicks] = useState<{ key: string; ids: Selection }>({ key: periodKey, ids: NO_SELECTION });
  const selection = ticks.key === periodKey ? ticks.ids : NO_SELECTION;
  const setSelection = (next: (s: Selection) => Selection) =>
    setTicks((t) => ({ key: periodKey, ids: next(t.key === periodKey ? t.ids : NO_SELECTION) }));
  const chosen = useMemo(() => selectedEmployees(selection, employees), [selection, employees]);
  const hidden = hiddenSelected(new Set(chosen.map((r) => r.id)), rows);

  const [previewId, setPreviewId] = useState<number | null>(null);
  // from the list, so the sheet follows a Generate or a Hold made while it is open
  const previewRow = previewId === null ? null : (employees.find((e) => e.id === previewId) ?? null);
  const [holdRows, setHoldRows] = useState<SlipCenterEmployee[] | null>(null);
  const [releaseRows, setReleaseRows] = useState<SlipCenterEmployee[] | null>(null);

  const jobs = useSlipJobs({ month, year, period, canEdit: mayEdit, options, employees });

  const changePeriod = (m: number, y: number) => {
    setPreviewId(null);
    jobs.closeBank();
    jobs.closeReport();
    setUrl({ month: String(m), year: String(y), page: "1" });
  };
  const patchFilters = (patch: Partial<SlipFilters>) => setUrl(filtersToUrl(patch));
  const pickCategory = (category: CategoryFilter) =>
    setUrl(filtersToUrl(changeCategory(filters, category, data?.departments ?? [], data?.designations ?? [])));
  const clearFilters = () => setUrl(filtersToUrl(NO_FILTERS));
  const selectTab = (next: SlipTab) => setUrl({ tab: next, page: "1" });
  const toggleAll = () =>
    setSelection((s) => (listSelection(s, rows) === "all" ? deselectRows(s, rows) : selectRows(s, rows)));

  const toggleHold = (row: SlipCenterEmployee) => (row.onHold ? setReleaseRows([row]) : setHoldRows([row]));
  const confirmHold = async (reason: string) => {
    if (!holdRows) return;
    if (await jobs.setHold(holdRows, true, reason)) setHoldRows(null);
  };
  const confirmRelease = async () => {
    if (!releaseRows) return;
    if (await jobs.setHold(releaseRows, false)) setReleaseRows(null);
  };
  const downloadOne = (row: SlipCenterEmployee) => void jobs.download([row], { kind: "slips", layout: "single" });

  const failed = list.isError && !data;
  const empty = emptyInfo(tab, filtered, employees.length, period);
  const showing =
    rows.length > 0 ? `Showing ${paged.from}-${paged.to} of ${paged.total}` : data ? "Showing 0 employees" : null;

  return (
    <div className="space-y-5" data-testid="salary-slip-page">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
            <ReceiptText size={22} className="text-indigo-600" /> Salary Slip
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Salary slips for any employee (active, inactive, on hold or new) from their current details, attendance and
            salary, with the salary statement and the bank file. Separate from Staff and Production Payroll: nothing
            here changes a payroll.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker month={month} year={year} onChange={changePeriod} disabled={jobs.busy} />
          <RefreshButton className="h-10 rounded-2xl" />
        </div>
      </div>

      {data?.inProgress && (
        <p
          className="flex items-start gap-2 rounded-xl bg-amber-50 px-3.5 py-2.5 text-sm text-amber-900"
          data-testid="ssc-in-progress"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {period} is not over yet: slips are counted up to today, and each slip says so.
        </p>
      )}
      {data && !mayEdit && !layoutViewOnly && (
        <p className="flex items-start gap-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm text-slate-700">
          <Info size={15} className="mt-0.5 shrink-0" />
          You can preview and download slips. Generating slips and Hold / Release need edit rights on this page.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5" data-testid="ssc-kpis">
        <KpiTile
          label="Employees"
          value={summary.total}
          sub={`${summary.newJoiners} new joiner${summary.newJoiners === 1 ? "" : "s"} this month`}
          icon={Users}
          tone="bg-slate-100 text-slate-800"
          loading={list.isLoading}
          testId="ssc-kpi-total"
        />
        <KpiTile
          label="Slips generated"
          value={`${summary.generated} of ${summary.total}`}
          sub={`${summary.total - summary.generated} not generated yet`}
          icon={ReceiptText}
          tone="bg-indigo-50 text-indigo-900"
          loading={list.isLoading}
          testId="ssc-kpi-generated"
        />
        <KpiTile
          label="Net of the saved slips"
          value={inr(summary.net)}
          sub={`${period}`}
          icon={BadgeIndianRupee}
          tone="bg-emerald-50 text-emerald-900"
          loading={list.isLoading}
          testId="ssc-kpi-net"
        />
        <KpiTile
          label="On hold"
          value={summary.onHold}
          sub="Left out of the bank file"
          icon={Hand}
          tone="bg-orange-50 text-orange-900"
          loading={list.isLoading}
          onClick={() => selectTab("on_hold")}
          active={tab === "on_hold"}
          testId="ssc-kpi-hold"
        />
        <KpiTile
          label="Need attention"
          value={summary.payIssues + summary.bankIssues}
          sub={`${summary.payIssues} no salary · ${summary.bankIssues} bank details missing`}
          icon={Wallet}
          tone={summary.payIssues + summary.bankIssues > 0 ? "bg-amber-50 text-amber-900" : "bg-gray-50 text-gray-700"}
          loading={list.isLoading}
          className="col-span-2 md:col-span-1"
          testId="ssc-kpi-attention"
        />
      </div>

      <div
        className="flex flex-col gap-2 rounded-2xl border bg-white px-4 py-3 md:flex-row md:items-center md:justify-between"
        data-testid="ssc-options"
      >
        <div className="min-w-0">
          <p className="text-sm font-bold text-gray-900">Deductions on the slips</p>
          <p className="text-xs text-muted-foreground">
            Generate and the live preview take these. No OT pay and no bonus; advances are only read, never marked
            recovered.
          </p>
        </div>
        <OptionSwitches options={options} onChange={setOptions} disabled={jobs.busy} idPrefix="ssc-opt" />
      </div>

      <Toolbar
        filters={filters}
        onChange={patchFilters}
        onCategory={pickCategory}
        departments={departments}
        designations={designations}
        units={units}
        tab={tab}
        onTab={selectTab}
        counts={counts}
        showing={showing}
        filtered={filtered}
        onClear={clearFilters}
      />

      {(chosen.length > 0 || jobs.progress) && (
        <div className="sticky top-0 z-20 space-y-2">
          {chosen.length > 0 && (
            <BulkBar
              rows={chosen}
              hidden={hidden}
              canEdit={mayEdit}
              busy={jobs.busy}
              onGenerate={() => void jobs.generate(chosen)}
              onDownload={(request) => void jobs.download(chosen, request)}
              onBankFile={() => void jobs.startBankFile(chosen)}
              onHold={setHoldRows}
              onRelease={setReleaseRows}
              onClear={() => setSelection(() => NO_SELECTION)}
            />
          )}
          {jobs.progress && <ProgressPanel progress={jobs.progress} />}
        </div>
      )}

      {jobs.report && <SkippedPanel report={jobs.report} onClose={jobs.closeReport} />}
      {jobs.bank && (
        <BankReviewPanel
          review={jobs.bank}
          period={period}
          busy={jobs.busy}
          onConfirm={() => void jobs.confirmBankFile()}
          onCancel={jobs.closeBank}
        />
      )}

      {list.isLoading ? (
        <ListSkeleton />
      ) : failed ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4"
          data-testid="ssc-load-error"
        >
          <p className="text-sm text-red-800">
            <b>Could not load the employees for {period}.</b> {errorText(list.error)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          info={empty}
          onClear={clearFilters}
          onAll={() => selectTab("all")}
          onPrevious={() => {
            const prev = shiftMonth({ month, year }, -1);
            changePeriod(prev.month, prev.year);
          }}
        />
      ) : (
        <>
          <EmployeeList
            rows={paged.rows}
            allRows={rows}
            selection={selection}
            onToggle={(row) => setSelection((s) => toggleId(s, row.id))}
            onToggleAll={toggleAll}
            onPreview={(row) => setPreviewId(row.id)}
            onDownload={downloadOne}
            onHold={mayEdit ? toggleHold : undefined}
            canEdit={mayEdit}
            showUnit={units.length > 1}
            busy={jobs.busy}
          />
          <DataPagination
            page={paged.page}
            totalPages={paged.totalPages}
            totalItems={paged.total}
            pageSize={PAGE_SIZE}
            onPageChange={(p) => setUrl({ page: String(p) })}
          />
        </>
      )}

      <PreviewSheet
        employee={previewRow}
        month={month}
        year={year}
        options={options}
        onOptions={setOptions}
        canEdit={mayEdit}
        busy={jobs.busy}
        onGenerate={(row) => void jobs.generate([row])}
        onDownload={downloadOne}
        onClose={() => setPreviewId(null)}
      />
      <HoldDialog
        rows={holdRows}
        period={period}
        pending={jobs.holding}
        onConfirm={(reason) => void confirmHold(reason)}
        onClose={() => setHoldRows(null)}
      />
      <ReleaseDialog
        rows={releaseRows}
        period={period}
        pending={jobs.holding}
        onConfirm={() => void confirmRelease()}
        onClose={() => setReleaseRows(null)}
      />
    </div>
  );
}
