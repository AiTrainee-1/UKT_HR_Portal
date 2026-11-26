import { useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Banknote,
  ChevronDown,
  FileSpreadsheet,
  FileText,
  HandCoins,
  Hourglass,
  Landmark,
  LayoutGrid,
  Plus,
  Search,
  UserMinus,
  Wallet,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { ExportMenu } from "@/components/payroll/kit/ExportMenu";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { canApprove, useAuth } from "@/contexts/AuthContext";
import { kindFor } from "@/lib/hr-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateAdvance,
  useDeleteAdvance,
  useListAdvances,
  useListEmployeesLite,
  useUpdateAdvance,
} from "@/lib/api-client";
import { useCompany } from "./report-log/useCompany";
import AdvanceList from "./settlement/AdvanceList";
import { DecisionDialog, DeleteDialog, type Decision, type DecisionRequest } from "./settlement/ConfirmDialogs";
import CreateDialog from "./settlement/CreateDialog";
import DetailSheet from "./settlement/DetailSheet";
import Toolbar from "./settlement/Toolbar";
import {
  DEFAULT_FILTER_URL,
  DEFAULT_SORT,
  EXPORT_STATUS_OPTIONS,
  NO_FILTERS,
  SETTLEMENT_TABS,
  SETTLEMENT_URL_DEFAULTS,
  TAB_NOUN,
  TAB_TYPE,
  TYPE_LABEL,
  buildExport,
  countOf,
  exportState,
  exportStatusLabel,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  inPeriod,
  pageView,
  parseBasis,
  parsePeriod,
  parseSort,
  parseTab,
  periodLabel,
  pickFilterUrl,
  rowsOfTab,
  serverError,
  sortValue,
  statusCounts,
  tabLabel,
  tabOfType,
  yearOptions,
  type FilterUrl,
  type Filters,
  type MonthBasis,
  type PageState,
  type Period,
  type Sort,
  type SortKey,
  type SettlementRow,
  type SettlementTab,
  type SettlementUrl,
  type StatusFilter,
} from "./settlement/logic";
import { EmptyState, StatCard, TabBar } from "./settlement/parts";
import { formatMoney } from "./settlement/shared";

/** A column opens in the direction people expect for it: A to Z, earliest first, biggest or newest first. */
const FIRST_DIRECTION: Record<SortKey, Sort["dir"]> = {
  created: "desc",
  employee: "asc",
  amount: "desc",
  outstanding: "desc",
  recovery: "desc",
  start: "asc",
  status: "asc",
};

const TAB_ICON: Record<SettlementTab, typeof LayoutGrid> = { overview: LayoutGrid, loan: Landmark, advance: Banknote };

/** Settlement: Term Loans (repaid in monthly EMIs) and Salary Advances (deducted once; renamed from "Term Advance"
 *  2026-11-26): raise one, approve or reject it with a remark, follow what payroll has recovered, and export any tab,
 *  month, filter and status as Excel or PDF. */
export default function Settlement() {
  const { toast } = useToast();
  // approving an advance is a right of its own (HR Manager / HR Assistant categories); unchanged for everyone else
  // Salary Advances and Term Loans are separate switches: each row's Approve / Reject asks about its own type.
  const { user } = useAuth();
  const canDecide = (row: Pick<SettlementRow, "advanceType">) =>
    canApprove(user, kindFor("advance", { advanceType: row.advanceType }));
  const queryClient = useQueryClient();
  const company = useCompany();
  const [showCreate, setShowCreate] = useState(false);
  const [createType, setCreateType] = useState<SettlementRow["advanceType"]>("general");
  // the status the Export menu writes: the page's status filter until HR picks another one (for that filter)
  const [exportChoice, setExportChoice] = useState<{ page: StatusFilter; status: StatusFilter } | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SettlementRow | null>(null);
  const [decision, setDecision] = useState<DecisionRequest | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  // the tab, the month and the tab's filters live in the address (a reload or a shared link opens the same list)
  const [url, setUrl] = useUrlParams<SettlementUrl>(SETTLEMENT_URL_DEFAULTS);
  const state: PageState = useMemo(
    () => ({
      tab: parseTab(url.tab),
      period: parsePeriod(url.month, url.year),
      basis: parseBasis(url.basis),
      filters: filtersFromUrl(url),
      sort: parseSort(url.sort),
    }),
    [url],
  );
  const { tab, period, basis, sort } = state;
  // each tab keeps its own filters: leaving a tab remembers them, coming back puts them back (the month is the page's)
  const remembered = useRef<Partial<Record<SettlementTab, FilterUrl>>>({});

  const { data: advances, isLoading, isError, refetch } = useListAdvances();
  const { data: employees } = useListEmployeesLite({ status: "active" });
  const createMutation = useCreateAdvance();
  const updateMutation = useUpdateAdvance();
  const deleteMutation = useDeleteAdvance();

  const all = useMemo(() => (advances ?? []) as SettlementRow[], [advances]);
  const view = useMemo(() => pageView(all, state), [all, state]);
  const { summary, shown } = view;
  const years = useMemo(() => yearOptions(all, period), [all, period]);
  const tabs = useMemo(
    () =>
      SETTLEMENT_TABS.map((t) => ({
        ...t,
        icon: TAB_ICON[t.value],
        pending: rowsOfTab(all, t.value).filter((a) => a.status === "pending").length,
      })),
    [all],
  );

  const setFilters = (next: Filters) => setUrl(filtersToUrl(next, sort));
  const setSort = (next: Sort) => setUrl({ sort: sortValue(next) });
  const setPeriod = (next: Period) =>
    setUrl(next ? { month: String(next.month), year: String(next.year) } : { month: "", year: "", basis: "any" });
  const setBasis = (next: MonthBasis) => setUrl({ basis: next });
  const clearAll = () => setUrl({ ...filtersToUrl(NO_FILTERS, DEFAULT_SORT), month: "", year: "", basis: "any" });

  const switchTab = (next: SettlementTab) => {
    if (next === tab) return;
    remembered.current[tab] = pickFilterUrl(url);
    setUrl({ tab: next, ...(remembered.current[next] ?? DEFAULT_FILTER_URL) });
  };

  const refreshLists = () => queryClient.invalidateQueries({ queryKey: ["/api/advances"] });

  // The dialog stays open while this saves; a refusal (no remark, an amount above the one asked for ...) is thrown back
  // to it, so HR reads the server's own words there and can put it right.
  const decide = async ({ row, status, payload }: Decision) => {
    setBusyId(row.id);
    try {
      await updateMutation.mutateAsync({ id: row.id, data: payload });
      setDecision(null);
      toast({
        title: `Advance ${status}`,
        description:
          status === "rejected"
            ? `${row.employeeName} sees your reason in the app.`
            : payload.status === "approved" &&
                payload.amount != null &&
                payload.amount < (row.requestedAmount ?? row.amount)
              ? `${formatMoney(payload.amount)} approved for ${row.employeeName}.`
              : undefined,
      });
      refreshLists();
      queryClient.invalidateQueries({ queryKey: ["advance-detail", row.id] });
    } finally {
      setBusyId(null);
    }
  };

  const createAdvance = async (payload: Parameters<typeof createMutation.mutateAsync>[0]) => {
    const created = (await createMutation.mutateAsync(payload)) as SettlementRow | undefined;
    toast({ title: "Advance created" });
    refreshLists();
    // show the new one: it starts as pending, on the tab of its kind and in a month it belongs to
    const target = tab === "overview" ? tab : tabOfType(payload.advanceType === "term" ? "term" : "general");
    if (target !== tab) remembered.current[tab] = pickFilterUrl(url);
    const keepMonth = !period || !created || inPeriod(created, period, basis);
    setUrl({ tab: target, ...DEFAULT_FILTER_URL, ...(keepMonth ? {} : { month: "", year: "", basis: "any" }) });
  };

  // only a waiting advance can be deleted: the server answers 409 not_pending once it is decided (someone else may have
  // approved it meanwhile), and the list is refreshed so it shows what it is now
  const removeAdvance = async (row: SettlementRow) => {
    try {
      await deleteMutation.mutateAsync(row.id);
      toast({ title: "Advance deleted" });
      refreshLists();
    } catch (err) {
      const said = serverError(err, "The advance could not be deleted.");
      toast({
        title: said.code === "not_pending" ? "This advance can no longer be deleted" : "Failed to delete advance",
        description: said.text,
        variant: "destructive",
      });
      if (said.code === "not_pending") refreshLists();
    } finally {
      setDeleteTarget(null);
    }
  };

  const onHeadSort = (key: SortKey) =>
    setSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIRECTION[key] });

  // the list as shown (this tab, this month, every filter, the search and the sort) in the status chosen in the menu
  const exportStatus: StatusFilter =
    exportChoice && exportChoice.page === view.filters.status ? exportChoice.status : view.filters.status;
  const exportPage = useMemo(() => exportState(state, exportStatus), [state, exportStatus]);
  const exportView = useMemo(() => pageView(all, exportPage), [all, exportPage]);
  const exportCounts = useMemo(() => statusCounts(view.periodRows, view.filters), [view]);
  const exportInput = () => ({
    ...company.excel,
    table: buildExport(exportView.shown, exportPage, exportView.periodRows.length),
    now: new Date(),
  });
  const openCreate = (type: SettlementRow["advanceType"]) => {
    setCreateType(type);
    setShowCreate(true);
  };

  const statsLoading = isLoading || isError;
  const noneAtAll = !isLoading && !isError && all.length === 0;
  const noneInTab = !isLoading && !isError && !noneAtAll && view.tabRows.length === 0;
  const noun = TAB_NOUN[tab];
  const narrowed = period !== null || filtersActive({ ...view.filters, status: "all" });
  const newType = TAB_TYPE[tab] ?? "general";

  return (
    <HrLayout>
      <div className="min-w-0 space-y-5" data-ui-area="payroll">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-2xl font-black text-gray-900">Settlement</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Term Loans are repaid in monthly EMIs; Salary Advances are deducted once, at most 50% of the salary earned
              from the 1st to the 20th. Employees can also apply from the mobile app: Salary Advance on the 21st and
              22nd, Term Loan after 6 months of service.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ExportMenu
              testId="settlement-export"
              label="Export"
              size="default"
              className="h-10 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
              heading={`${tabLabel(tab)} · ${periodLabel(period)} · ${exportStatusLabel(exportStatus)}: ${countOf(
                exportView.shown.length,
                tab,
              )}`}
              disabled={isLoading || exportCounts.all === 0}
              leading={
                <>
                  <DropdownMenuLabel className="pb-1 pt-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Status in the file
                  </DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={exportStatus}
                    onValueChange={(v) => setExportChoice({ page: view.filters.status, status: v as StatusFilter })}
                  >
                    {EXPORT_STATUS_OPTIONS.map((o) => (
                      <DropdownMenuRadioItem
                        key={o.value}
                        value={o.value}
                        onSelect={(e) => e.preventDefault()}
                        className="py-1.5 text-sm"
                        data-testid={`settlement-export-status-${o.value}`}
                      >
                        <span className="flex-1">
                          {o.label}
                          {o.hint && <span className="text-[11px] text-muted-foreground"> ({o.hint})</span>}
                        </span>
                        <span className="ml-3 text-xs tabular-nums text-muted-foreground">{exportCounts[o.value]}</span>
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </>
              }
              items={[
                {
                  key: "xlsx",
                  label: "Excel (.xlsx)",
                  hint: `${countOf(exportView.shown.length, tab)}: requested, salary earned 1st–20th and approved, with the totals`,
                  icon: FileSpreadsheet,
                  disabled: exportView.shown.length === 0,
                  run: async () => (await import("./settlement/export")).downloadSettlementExcel(exportInput()),
                },
                {
                  key: "pdf",
                  label: "PDF",
                  hint: "A4 landscape, for printing, with the totals",
                  icon: FileText,
                  disabled: exportView.shown.length === 0,
                  run: async () => (await import("./settlement/export")).downloadSettlementPdf(exportInput()),
                },
              ]}
            />
            {tab === "overview" ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="h-10 gap-2" data-testid="new-advance">
                    <Plus size={15} /> New
                    <ChevronDown size={13} className="opacity-70" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuItem onSelect={() => openCreate("general")} data-testid="new-advance-general">
                    <Banknote size={14} /> New {TYPE_LABEL.general}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => openCreate("term")} data-testid="new-advance-term">
                    <Landmark size={14} /> New {TYPE_LABEL.term}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : (
              <Button className="h-10 gap-2" onClick={() => openCreate(newType)} data-testid="new-advance">
                <Plus size={15} /> New {TYPE_LABEL[newType]}
              </Button>
            )}
          </div>
        </div>

        <TabBar items={tabs} value={tab} onChange={switchTab} />

        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              testId="stat-pending"
              label="Pending approval"
              value={statsLoading ? "-" : summary.pendingCount}
              sub={statsLoading ? undefined : `${formatMoney(summary.pendingAmount)} requested`}
              icon={Hourglass}
              tone="bg-amber-50 text-amber-800"
            />
            <StatCard
              testId="stat-active"
              label={`Active ${noun.many}`}
              value={statsLoading ? "-" : summary.activeCount}
              sub={statsLoading ? undefined : `${formatMoney(summary.outstanding)} still to recover`}
              icon={Wallet}
              tone="bg-blue-50 text-blue-800"
            />
            <StatCard
              testId="stat-recovered"
              label="Recovered so far"
              value={statsLoading ? "-" : formatMoney(summary.recovered)}
              sub={
                statsLoading
                  ? undefined
                  : tab === "advance"
                    ? `${summary.completedCount} completed`
                    : `${summary.completedCount} completed · ${formatMoney(summary.monthlyEmi)}/month in ${
                        tab === "loan" ? "EMIs" : "Term Loan EMIs"
                      }`
              }
              icon={HandCoins}
              tone="bg-green-50 text-green-800"
            />
            <StatCard
              testId="stat-left"
              label="Owed by employees who left"
              value={statsLoading ? "-" : formatMoney(summary.leftOutstanding)}
              sub={
                statsLoading
                  ? undefined
                  : summary.leftCount > 0
                    ? `${countOf(summary.leftCount, tab)}: for the final settlement`
                    : "nothing outstanding"
              }
              icon={UserMinus}
              tone="bg-slate-100 text-slate-800"
            />
          </div>
          {narrowed && !statsLoading && (
            <p className="text-xs text-gray-500" data-testid="settlement-figures-scope">
              {period
                ? `Figures for ${periodLabel(period)}${basis !== "any" ? ` (${basisWord(basis)})` : ""}, as filtered below`
                : "Figures as filtered below"}
              , every status.
            </p>
          )}
        </div>

        {!noneAtAll && !noneInTab && (
          <Toolbar
            tab={tab}
            rows={view.periodRows}
            filters={view.filters}
            onFilters={setFilters}
            sort={sort}
            onSort={setSort}
            period={period}
            basis={basis}
            years={years}
            onPeriod={setPeriod}
            onBasis={setBasis}
            onClear={clearAll}
            shown={shown.length}
          />
        )}

        <Card className="overflow-hidden rounded-2xl">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-3 p-4" data-testid="advances-loading">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-16 w-full rounded-xl" />
                ))}
              </div>
            ) : isError ? (
              <EmptyState
                icon={AlertTriangle}
                tone="bg-red-50 text-red-600"
                title="The advances could not be loaded"
                text="Check your connection and try again."
                testId="advances-error"
              >
                <Button variant="outline" onClick={() => refetch()}>
                  Retry
                </Button>
              </EmptyState>
            ) : noneAtAll || noneInTab ? (
              <EmptyState
                icon={HandCoins}
                title={`No ${noun.many} yet`}
                text={
                  tab === "loan"
                    ? "Record a Term Loan for an employee. Once approved, payroll deducts the monthly EMI automatically."
                    : tab === "advance"
                      ? "Record a Salary Advance for an employee. Once approved, payroll deducts it once, in the month you choose."
                      : "Record a Term Loan or a Salary Advance for an employee. Once approved, payroll deducts it automatically."
                }
                testId="advances-empty"
              >
                <Button onClick={() => openCreate(newType)} className="gap-1.5">
                  <Plus size={15} /> Create the first {tab === "overview" ? noun.one : TYPE_LABEL[newType]}
                </Button>
              </EmptyState>
            ) : shown.length === 0 ? (
              <EmptyState
                icon={Search}
                tone="bg-gray-100 text-gray-500"
                title={`No ${noun.one} matches`}
                text={`Try fewer words, another status${period ? " or month" : ""}, or clear the filters.`}
                testId="advances-no-match"
              >
                <Button variant="outline" onClick={clearAll}>
                  Clear filters
                </Button>
              </EmptyState>
            ) : (
              <AdvanceList
                rows={shown}
                sort={sort}
                onSort={onHeadSort}
                onOpen={(row) => setSelectedId(row.id)}
                onApprove={(row) => setDecision({ row, status: "approved" })}
                onReject={(row) => setDecision({ row, status: "rejected" })}
                onDelete={setDeleteTarget}
                busyId={busyId}
                canDecide={canDecide}
              />
            )}
          </CardContent>
        </Card>

        <CreateDialog
          open={showCreate}
          onClose={() => setShowCreate(false)}
          employees={employees}
          onSubmit={createAdvance}
          defaultType={createType}
        />

        <DecisionDialog decision={decision} onConfirm={decide} onCancel={() => setDecision(null)} />

        <DeleteDialog
          row={deleteTarget}
          busy={deleteMutation.isPending}
          onConfirm={removeAdvance}
          onCancel={() => setDeleteTarget(null)}
        />

        <DetailSheet
          advanceId={selectedId}
          canDecide={canDecide}
          onClose={() => setSelectedId(null)}
          onApprove={(row) => {
            setSelectedId(null);
            setDecision({ row, status: "approved" });
          }}
          onReject={(row) => {
            setSelectedId(null);
            setDecision({ row, status: "rejected" });
          }}
          onDelete={(row) => {
            setSelectedId(null);
            setDeleteTarget(row);
          }}
        />
      </div>
    </HrLayout>
  );
}

const basisWord = (basis: MonthBasis): string =>
  basis === "applied" ? "applied" : basis === "decided" ? "approved or rejected" : "deducted";
