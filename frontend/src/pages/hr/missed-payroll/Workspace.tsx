import { useMemo, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  BadgeCheck,
  CalendarX2,
  CheckCircle2,
  CircleDashed,
  Hand,
  Info,
  Lock,
  UserPlus,
  UserX,
  Wallet,
  WalletCards,
  type LucideIcon,
} from "lucide-react";
import { RefreshButton } from "@/components/PageRefreshBar";
import { inr } from "@/components/payroll/kit/format";
import { KpiTile } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { PillTabs } from "@/components/ui/pill-tabs";
import { canApprove, canEdit, isRouteViewOnly, useAuth } from "@/contexts/AuthContext";
import {
  useMissedPayrollList,
  type MissedKind,
  type MissedRow,
  type MissedStatusAction,
} from "@/lib/api-client/custom-hooks/missed-payroll";
import { moduleForPath } from "@/lib/permission-modules";
import { cn } from "@/lib/utils";
import { ProgressPanel } from "../salary-slip-center/JobPanels";
import {
  NO_SELECTION,
  PAGE_SIZE,
  deselectRows,
  hiddenSelected,
  listSelection,
  monthLabel,
  paginate,
  resolvePeriod,
  selectRows,
  shiftMonth,
  toggleId,
  type Selection,
} from "../salary-slip-center/logic";
import { PeriodPicker } from "../salary-slip-center/PeriodPicker";
import { ACCENT, ListSkeleton } from "../salary-slip-center/parts";
import { DoneDialog, PaidDialog, RemoveDialog } from "./ActionDialogs";
import { AttendanceSheet } from "./AttendanceSheet";
import { BulkBar, ExportMenu } from "./BulkBar";
import { EntrySheet } from "./EntrySheet";
import {
  KINDS,
  KIND_LABEL,
  MAIN_PAYROLL,
  MISSED_PAYROLL_MODULE,
  MISSED_PAYROLL_PATH,
  NO_FILTERS,
  categoryCounts,
  categoryLabels,
  departmentOptions,
  eligible,
  emptyInfo,
  errorText,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  isKind,
  selectable,
  stateFromUrl,
  statusCounts,
  unitOptions,
  viewCounts,
  visibleRows,
  type CategoryPill,
  type MissedAction,
  type MissedFilters,
  type MissedView,
  type Rights,
  type StatusPill,
} from "./logic";
import { BankReviewPanel, EmptyState, ResultPanel } from "./parts";
import { RowList } from "./RowList";
import { Toolbar } from "./Toolbar";
import { useMissedJobs } from "./useMissedJobs";

const NO_ROWS: MissedRow[] = [];

type Props = {
  url: Record<string, string>;
  setUrl: (patch: Record<string, string>) => void;
};

function Banner({
  tone,
  icon: Icon,
  children,
  testId,
}: {
  tone: "amber" | "slate" | "indigo" | "red";
  icon: LucideIcon;
  children: ReactNode;
  testId: string;
}) {
  const toneClass = {
    amber: "bg-amber-50 text-amber-900",
    slate: "bg-slate-50 text-slate-700",
    indigo: "bg-indigo-50 text-indigo-900",
    red: "bg-red-50 text-red-900",
  }[tone];
  return (
    <p className={cn("flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-sm", toneClass)} data-testid={testId}>
      <Icon size={15} className="mt-0.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * The Missed Payroll page under its title: the month and the Staff / Production tabs, the month's banners, the figures, the
 * views with their pills and filters, the list with its ticks and row actions, the bulk bar with progress, the refusals,
 * the bank check, the figures and attendance sheets and the Done / Paid / Remove dialogs.
 */
export function Workspace({ url, setUrl }: Props) {
  const { user } = useAuth();
  const { month, year } = useMemo(() => resolvePeriod({ month: url.month, year: url.year }), [url.month, url.year]);
  const { kind, view, category, status } = stateFromUrl(url);
  const list = useMissedPayrollList(kind, month, year);
  const data = list.data;
  const period = data?.periodLabel || monthLabel(month, year);
  const moduleKey = moduleForPath(MISSED_PAYROLL_PATH) ?? MISSED_PAYROLL_MODULE;
  // Generate and every status change need the page's Edit right, as the server says it for this login and as the role says it
  const mayEdit = data?.canEdit === true && canEdit(user, moduleKey);
  const layoutViewOnly = isRouteViewOnly(user, MISSED_PAYROLL_PATH, moduleKey);
  const rights: Rights = {
    canEdit: mayEdit,
    wholeCompany: data?.wholeCompany ?? false,
    mayClear: canApprove(user, "payroll_mark_cleared"),
    mayDone: canApprove(user, "payroll_finalize"),
    mayPay: canApprove(user, "payroll_mark_paid"),
  };

  const filters = useMemo(() => filtersFromUrl(url), [url]);
  const employees = data?.employees ?? NO_ROWS;
  const labels = useMemo(() => categoryLabels(data?.categories), [data]);
  const rows = useMemo(
    () => visibleRows(employees, view, category, status, filters),
    [employees, view, category, status, filters],
  );
  const counts = useMemo(() => (data ? viewCounts(employees, filters) : null), [data, employees, filters]);
  const catCounts = useMemo(() => (data ? categoryCounts(employees, filters) : null), [data, employees, filters]);
  const stCounts = useMemo(() => (data ? statusCounts(employees, filters) : null), [data, employees, filters]);
  const paged = paginate(rows, Number(url.page));
  const departments = useMemo(() => departmentOptions(data?.departments ?? []), [data]);
  const units = useMemo(() => unitOptions(data?.units ?? []), [data]);
  const filtered = filtersActive(filters);
  const ticks = selectable(view);

  // The ticks belong to one tab and month: another is another list, so nothing stays ticked.
  const listKey = `${kind}-${year}-${month}`;
  const [tickState, setTicks] = useState<{ key: string; ids: Selection }>({ key: listKey, ids: NO_SELECTION });
  const selection = tickState.key === listKey ? tickState.ids : NO_SELECTION;
  const setSelection = (next: (s: Selection) => Selection) =>
    setTicks((t) => ({ key: listKey, ids: next(t.key === listKey ? t.ids : NO_SELECTION) }));
  // fresh from the list (a row that dropped out is no longer ticked), and only rows that can be ticked
  const chosen = useMemo(
    () => employees.filter((e) => selection.has(e.id) && e.category !== "not_cleared"),
    [employees, selection],
  );
  const hidden = hiddenSelected(new Set(chosen.map((r) => r.id)), rows);

  const [figuresId, setFiguresId] = useState<number | null>(null);
  const [attendanceId, setAttendanceId] = useState<number | null>(null);
  // from the list, so a sheet follows a Generate made while it is open
  const figuresRow = figuresId === null ? null : (employees.find((e) => e.id === figuresId && e.entry) ?? null);
  const attendanceRow = attendanceId === null ? null : (employees.find((e) => e.id === attendanceId) ?? null);
  const [doneRows, setDoneRows] = useState<MissedRow[] | null>(null);
  const [paidRows, setPaidRows] = useState<MissedRow[] | null>(null);
  const [removeRows, setRemoveRows] = useState<MissedRow[] | null>(null);

  const jobs = useMissedJobs({ kind, month, year, period });

  const closeEverything = () => {
    setFiguresId(null);
    setAttendanceId(null);
    jobs.closeBank();
    jobs.closeReport();
  };
  const changePeriod = (m: number, y: number) => {
    closeEverything();
    setUrl({ month: String(m), year: String(y), page: "1" });
  };
  const selectKind = (next: MissedKind) => {
    closeEverything();
    setUrl({ tab: next, cat: "all", st: "all", dept: "all", unit: "all", page: "1" });
  };
  const selectView = (next: MissedView) => setUrl({ view: next, page: "1" });
  const pickCategory = (next: CategoryPill) => setUrl({ cat: next, page: "1" });
  const pickStatus = (next: StatusPill) => setUrl({ st: next, page: "1" });
  const patchFilters = (patch: Partial<MissedFilters>) => setUrl(filtersToUrl(patch));
  const clearFilters = () => setUrl(filtersToUrl(NO_FILTERS));
  const toggleAll = () =>
    setSelection((s) => (listSelection(s, rows) === "all" ? deselectRows(s, rows) : selectRows(s, rows)));
  const unselect = (done: readonly MissedRow[]) => setSelection((s) => deselectRows(s, done));

  const runStatus = (action: MissedStatusAction, target: MissedRow[], paidOn?: string) =>
    jobs.change(action, target, paidOn);
  const onAction = (action: MissedAction) => {
    if (action === "generate") {
      void jobs.generate(chosen);
      return;
    }
    const target = eligible(chosen, action);
    if (target.length === 0) return;
    if (action === "done") setDoneRows(target);
    else if (action === "paid") setPaidRows(target);
    else if (action === "discard") setRemoveRows(target);
    else void runStatus(action, target);
  };
  const confirmDone = async () => {
    if (!doneRows) return;
    await runStatus("done", doneRows);
    setDoneRows(null);
  };
  const confirmPaid = async (paidOn: string) => {
    if (!paidRows) return;
    if (await runStatus("paid", paidRows, paidOn)) unselect(paidRows);
    setPaidRows(null);
  };
  const confirmRemove = async () => {
    if (!removeRows) return;
    await runStatus("discard", removeRows);
    setRemoveRows(null);
  };

  const failed = list.isError && !data;
  const empty = emptyInfo(view, filtered, employees.length, period, kind);
  const showing =
    rows.length > 0 ? `Showing ${paged.from}-${paged.to} of ${paged.total}` : data ? "Showing 0 employees" : null;
  const summary = data?.summary;
  const s = summary?.byCategory;
  const st = summary?.byStatus;
  const net = summary?.netByStatus;
  const main = MAIN_PAYROLL[kind];
  const loading = list.isLoading;

  const categoryTile = (
    cat: keyof NonNullable<typeof s>,
    label: string,
    icon: LucideIcon,
    tone: string,
    to: MissedView,
  ) => (
    <KpiTile
      label={label}
      value={s ? s[cat] : 0}
      icon={icon}
      tone={tone}
      loading={loading}
      onClick={() => setUrl({ view: to, cat: to === "missed" ? cat : "all", page: "1" })}
      active={view === to && (to !== "missed" || category === cat)}
      testId={`mp-kpi-${cat}`}
    />
  );

  return (
    <div className="space-y-5" data-testid="missed-payroll-page">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-2xl font-black text-gray-900">
            <CalendarX2 size={22} className="text-indigo-600" /> Missed Payroll
          </h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted-foreground">
            Employees the Staff or Production Payroll missed for a month: work their pay out here, Clear it, then Done
            adds them to the month&apos;s payroll and Paid closes it. Separate from the payroll pages.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <PeriodPicker month={month} year={year} onChange={changePeriod} disabled={jobs.busy} />
          <RefreshButton className="h-10 rounded-2xl" />
        </div>
      </div>

      <div className="max-w-full overflow-x-auto" data-testid="mp-kind-tabs">
        <PillTabs
          baseColor={ACCENT}
          items={KINDS.map((k) => ({
            value: k,
            label: <span data-testid={`mp-tab-${k}`}>{KIND_LABEL[k]}</span>,
          }))}
          value={kind}
          onChange={(v) => !jobs.busy && isKind(v) && selectKind(v)}
        />
      </div>

      {data && (
        <div className="space-y-2" data-testid="mp-banners">
          {!data.monthStarted && (
            <Banner tone="slate" icon={Info} testId="mp-banner-not-started">
              {period} has not started yet: nothing can be generated for it.
            </Banner>
          )}
          {data.monthStarted && !data.monthEnded && kind === "production" && (
            <Banner tone="amber" icon={AlertTriangle} testId="mp-banner-not-ended">
              {period} is not over yet: production pay is worked out only once the month has ended. You can check the
              list now and generate from the day after the last day of the month.
            </Banner>
          )}
          {data.monthStarted && !data.monthEnded && kind === "staff" && (
            <Banner tone="slate" icon={Info} testId="mp-banner-not-ended">
              {period} is not over yet: the list can still change while the Staff Payroll runs for the month.
            </Banner>
          )}
          {data.monthStarted && !data.mainGenerated && (
            <Banner tone="amber" icon={AlertTriangle} testId="mp-banner-main">
              The {main} has not been generated for {period} yet: generate it there first. This page is for the
              employees it missed.
            </Banner>
          )}
          {data.mainFinalized && (
            <Banner tone="indigo" icon={Lock} testId="mp-banner-finalized">
              {period} is finalized (Payroll Done){data.mainPaid ? " and marked paid" : ""}: Done here still adds to it.
            </Banner>
          )}
          {!data.wholeCompany && mayEdit && (
            <Banner tone="slate" icon={Info} testId="mp-banner-unit">
              Done and Paid change the month&apos;s payroll for the whole company: only a login for all units can do
              them. You can generate, clear and download here.
            </Banner>
          )}
          {!mayEdit && !layoutViewOnly && (
            <Banner tone="slate" icon={Info} testId="mp-banner-view-only">
              You can check the list, the figures and download the files. Generate and the status changes need edit
              rights on this page.
            </Banner>
          )}
        </div>
      )}

      <div className="space-y-3" data-testid="mp-kpis">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          {categoryTile("not_generated", "Not generated", CircleDashed, "bg-sky-50 text-sky-900", "missed")}
          {categoryTile("no_salary", "Salary not fixed", AlertTriangle, "bg-amber-50 text-amber-900", "missed")}
          {categoryTile("on_hold", "On hold", Hand, "bg-orange-50 text-orange-900", "missed")}
          {categoryTile("new_joiner", "New joiners", UserPlus, "bg-violet-50 text-violet-900", "missed")}
          {categoryTile("inactive", "Inactive", UserX, "bg-slate-100 text-slate-800", "inactive")}
          {categoryTile("not_cleared", "Not cleared", Info, "bg-gray-50 text-gray-800", "not_cleared")}
        </div>
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          {(
            [
              ["generated", "Generated", CircleDashed, "bg-indigo-50 text-indigo-900", "Waiting to be cleared"],
              ["cleared", "Cleared", CheckCircle2, "bg-fuchsia-50 text-fuchsia-900", "Ready for Done"],
              ["done", "Done", BadgeCheck, "bg-emerald-50 text-emerald-900", `In the ${period} payroll, not paid`],
              ["paid", "Paid", Wallet, "bg-teal-50 text-teal-900", "Paid from this page"],
            ] as const
          ).map(([key, label, icon, tone, sub]) => (
            <KpiTile
              key={key}
              label={label}
              value={
                <span>
                  {st ? st[key] : 0}
                  <span className="ml-2 text-sm font-bold opacity-70">{inr(net ? net[key] : 0)}</span>
                </span>
              }
              sub={sub}
              icon={key === "paid" ? WalletCards : icon}
              tone={tone}
              loading={loading}
              onClick={() => setUrl({ view: "processed", st: key, page: "1" })}
              active={view === "processed" && status === key}
              testId={`mp-kpi-${key}`}
            />
          ))}
        </div>
      </div>

      <Toolbar
        filters={filters}
        onChange={patchFilters}
        departments={departments}
        units={units}
        view={view}
        onView={selectView}
        viewCounts={counts}
        category={category}
        onCategory={pickCategory}
        categoryCounts={catCounts}
        categoryLabels={labels}
        status={status}
        onStatus={pickStatus}
        statusCounts={stCounts}
        showing={showing}
        filtered={filtered}
        onClear={clearFilters}
        files={
          view !== "not_cleared" ? (
            <ExportMenu
              rows={rows}
              busy={jobs.busy}
              label="Files of this list"
              scope="listed"
              onDownload={(request) => void jobs.download(rows, request)}
              onBankFile={() => void jobs.startBankFile(rows)}
              testId="mp-view-files"
            />
          ) : null
        }
      />

      {view === "not_cleared" && (
        <Banner tone="slate" icon={Info} testId="mp-not-cleared-note">
          These employees are in the {period} {main} but not marked Cleared. They are listed only to check: mark them
          Cleared on their Payroll Details page. Generating them here would pay them twice.
        </Banner>
      )}

      {(chosen.length > 0 || jobs.progress) && (
        <div className="sticky top-0 z-20 space-y-2">
          {chosen.length > 0 && (
            <BulkBar
              rows={chosen}
              hidden={hidden}
              rights={rights}
              busy={jobs.busy}
              onAction={onAction}
              onDownload={(request) => void jobs.download(chosen, request)}
              onBankFile={() => void jobs.startBankFile(chosen)}
              onClearSelection={() => setSelection(() => NO_SELECTION)}
            />
          )}
          {jobs.progress && <ProgressPanel progress={jobs.progress} />}
        </div>
      )}

      {jobs.report && <ResultPanel report={jobs.report} onClose={jobs.closeReport} />}
      {jobs.bank && (
        <BankReviewPanel
          review={jobs.bank}
          period={period}
          busy={jobs.busy}
          onConfirm={() => void jobs.confirmBankFile()}
          onCancel={jobs.closeBank}
        />
      )}

      {loading ? (
        <ListSkeleton />
      ) : failed ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 p-4"
          data-testid="mp-load-error"
        >
          <p className="text-sm text-red-800">
            <b>
              Could not load the {KIND_LABEL[kind].toLowerCase()} list for {period}.
            </b>{" "}
            {errorText(list.error)}
          </p>
          <Button variant="outline" size="sm" onClick={() => void list.refetch()}>
            Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          info={empty}
          onClear={clearFilters}
          onPrevious={() => {
            const prev = shiftMonth({ month, year }, -1);
            changePeriod(prev.month, prev.year);
          }}
        />
      ) : (
        <>
          <RowList
            kind={kind}
            rows={paged.rows}
            allRows={rows}
            selectable={ticks}
            selection={selection}
            onToggle={(row) => setSelection((sel) => toggleId(sel, row.id))}
            onToggleAll={toggleAll}
            onFigures={(row) => setFiguresId(row.id)}
            onAttendance={(row) => setAttendanceId(row.id)}
            onGenerate={mayEdit ? (row) => void jobs.generate([row]) : undefined}
            categoryLabels={labels}
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

      <EntrySheet
        row={figuresRow}
        kind={kind}
        period={period}
        categoryLabels={labels}
        canGenerate={mayEdit}
        busy={jobs.busy}
        onGenerate={(row) => void jobs.generate([row])}
        onAttendance={(row) => {
          setFiguresId(null);
          setAttendanceId(row.id);
        }}
        onClose={() => setFiguresId(null)}
      />
      <AttendanceSheet
        row={attendanceRow}
        kind={kind}
        month={month}
        year={year}
        period={period}
        onClose={() => setAttendanceId(null)}
      />
      <DoneDialog
        rows={doneRows}
        kind={kind}
        period={period}
        pending={jobs.busy}
        onConfirm={() => void confirmDone()}
        onClose={() => setDoneRows(null)}
      />
      <PaidDialog
        rows={paidRows}
        kind={kind}
        period={period}
        pending={jobs.busy}
        onConfirm={(paidOn) => void confirmPaid(paidOn)}
        onClose={() => setPaidRows(null)}
      />
      <RemoveDialog
        rows={removeRows}
        pending={jobs.busy}
        onConfirm={() => void confirmRemove()}
        onClose={() => setRemoveRows(null)}
      />
    </div>
  );
}
