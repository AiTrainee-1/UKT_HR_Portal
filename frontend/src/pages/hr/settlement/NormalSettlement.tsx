import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  HandCoins,
  Hourglass,
  Inbox,
  Landmark,
  Plus,
  Search,
  UserMinus,
  Wallet,
  X,
  XCircle,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { canApprove, useAuth } from "@/contexts/AuthContext";
import { kindFor } from "@/lib/hr-access";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useDeleteAdvance, useListAdvances, useUpdateAdvance, type Advance } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useCompany } from "../report-log/useCompany";
import AdvanceList from "./AdvanceList";
import BankFileDialog from "./BankFileDialog";
import { BulkBar, BulkDialog, type BulkAction } from "./bulk";
import { useLeaveCalendar } from "./LeaveCalendarButton";
import { DecisionDialog, DeleteDialog, type Decision, type DecisionRequest } from "./ConfirmDialogs";
import DetailSheet from "./DetailSheet";
import ExportDialog from "./ExportDialog";
import NewRequestDialog from "./NewRequestDialog";
import PageHeading from "./PageHeading";
import Toolbar from "./Toolbar";
import {
  DEFAULT_BASIS,
  DEFAULT_FILTER_URL,
  DEFAULT_SORT,
  NO_FILTERS,
  SETTLEMENT_URL_DEFAULTS,
  TAB_NOUN,
  TAB_TYPE,
  TYPE_LABEL,
  bankFileRows,
  bulkDecisionPayload,
  bulkResultText,
  bulkTickable,
  countOf,
  filtersActive,
  filtersFromUrl,
  filtersToUrl,
  inPeriod,
  pageView,
  parseBasis,
  parsePeriod,
  parseSort,
  periodLabel,
  periodToUrl,
  serverError,
  sortValue,
  statusCounts,
  tabOfPage,
  yearOptions,
  type BulkResult,
  type Filters,
  type MonthBasis,
  type PageState,
  type Period,
  type Sort,
  type SortKey,
  type SettlementRow,
  type SettlementUrl,
  type StatusFilter,
} from "./logic";
import { EmptyState, StatCard } from "./parts";
import type { LoanAdvancePage } from "./routes";
import { salaryAdvanceSummary, termLoanSummary, useLoanAdvanceRules } from "./rules";
import { formatMoney } from "./shared";

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

/** The line under a page's title, with the rules of Settings (owner 2026-11-27: nothing hard-coded); without numbers
 *  when this login cannot read them. */
function description(page: LoanAdvancePage, rules: ReturnType<typeof useLoanAdvanceRules>): string {
  const sa = salaryAdvanceSummary(rules?.sa);
  const tl = termLoanSummary(rules?.tl);
  const raise = "HR may raise a request for an employee under the same rules.";
  if (page === "general") return `Deducted once, in full, from the month's salary: ${sa}. ${raise}`;
  if (page === "term") return `Repaid in monthly EMIs: ${tl}. Employees apply from the mobile app on any day. ${raise}`;
  return `Salary Advances and Term Loans together. Salary Advance: ${sa}, deducted once. Term Loan: ${tl}. ${raise}`;
}

/**
 * Loan & Advance, Normal Method (renamed from Settlement 2026-11-27): Term Loans (repaid in monthly EMIs) and Salary
 * Advances (deducted once): raise one under the employee rules, approve or reject it with a remark, follow what payroll
 * has recovered, export a report (Excel or PDF, filters and columns of HR's choosing) and pay the month's approved ones
 * through the bank file. One page per address (the sidebar's sub-items): the Overview lists both kinds, Salary Advance
 * and Term Loan their own. Each opens on the current month, the requests raised in it (owner 2026-11-26), and each
 * request shows its leave check.
 */
export default function NormalSettlement({ page }: { page: LoanAdvancePage }) {
  const { toast } = useToast();
  // approving an advance is a right of its own (HR Manager / HR Assistant categories); unchanged for everyone else
  // Salary Advances and Term Loans are separate switches: each row's Approve / Reject asks about its own type.
  const { user } = useAuth();
  const rules = useLoanAdvanceRules();
  const canDecide = (row: Pick<SettlementRow, "advanceType">) =>
    canApprove(user, kindFor("advance", { advanceType: row.advanceType }));
  const queryClient = useQueryClient();
  const company = useCompany();
  const [showNew, setShowNew] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showBank, setShowBank] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SettlementRow | null>(null);
  const [decision, setDecision] = useState<DecisionRequest | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  // several requests at once (owner 2026-11-27): the ticked ones, the step asked for, its progress and its result
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [bulkProgress, setBulkProgress] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const leave = useLeaveCalendar();

  // the page is the address (Overview / Salary Advance / Term Loan); the month and the filters live in its query, so a
  // reload or a shared link opens the same list
  const tab = tabOfPage(page);
  const [url, setUrl] = useUrlParams<SettlementUrl>(SETTLEMENT_URL_DEFAULTS);
  const state: PageState = useMemo(
    () => ({
      tab,
      period: parsePeriod(url.month, url.year),
      basis: parseBasis(url.basis),
      filters: filtersFromUrl(url),
      sort: parseSort(url.sort),
    }),
    [tab, url],
  );
  const { period, basis, sort } = state;

  const { data: advances, isLoading, isError, refetch } = useListAdvances();
  const updateMutation = useUpdateAdvance();
  const deleteMutation = useDeleteAdvance();

  const all = useMemo(() => (advances ?? []) as SettlementRow[], [advances]);
  const view = useMemo(() => pageView(all, state), [all, state]);
  const { summary, shown } = view;
  const years = useMemo(() => yearOptions(all, period), [all, period]);

  const setFilters = (next: Filters) => setUrl(filtersToUrl(next, sort));
  const setSort = (next: Sort) => setUrl({ sort: sortValue(next) });
  // the month: "" in the address is the current month (the default), "all" All months
  const setPeriod = (next: Period) => setUrl(periodToUrl(next));
  const setBasis = (next: MonthBasis) => setUrl({ basis: next });
  const setStatus = (status: StatusFilter) => setFilters({ ...view.filters, status });
  const clearAll = () =>
    setUrl({ ...filtersToUrl(NO_FILTERS, DEFAULT_SORT), month: "", year: "", basis: DEFAULT_BASIS });

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

  // a new request is pending and raised now: show the waiting ones, in this month when the month shown does not hold it
  const showCreated = (created: Advance) => {
    const keepMonth = !period || inPeriod(created as SettlementRow, period, basis);
    setUrl({ ...DEFAULT_FILTER_URL, ...(keepMonth ? {} : { month: "", year: "", basis: DEFAULT_BASIS }) });
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

  // ── Several requests at once: one PUT per ticked waiting request, one after the other, with the progress shown and a
  // summary of what went through (approve = the full amount asked for; reject = one reason for all) ──
  const tickable = (row: SettlementRow) => bulkTickable(row, canDecide(row));
  const tickedRows = shown.filter((r) => selected.has(r.id) && tickable(r));
  const tickableShown = shown.filter(tickable);
  const toggle = (id: number, on: boolean) =>
    setSelected((old) => {
      const next = new Set(old);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const toggleAll = (on: boolean) => setSelected(on ? new Set(tickableShown.map((r) => r.id)) : new Set());

  const runBulk = async (remark: string) => {
    if (!bulk) return;
    const action = bulk;
    const rows = tickedRows;
    const failures: BulkResult["failures"] = [];
    let done = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      setBulkProgress(
        `${action === "approve" ? "Approving" : "Rejecting"} ${i + 1} of ${rows.length}: ${row.employeeName}…`,
      );
      try {
        await updateMutation.mutateAsync({ id: row.id, data: bulkDecisionPayload(row, action, remark) });
        done += 1;
      } catch (err) {
        failures.push({
          id: row.id,
          name: row.employeeName,
          text: serverError(err, "It could not be saved.").text,
        });
      }
    }
    setBulkProgress(null);
    setBulk(null);
    setSelected(new Set());
    refreshLists();
    const result: BulkResult = { action, done, failures };
    setBulkResult(result);
    toast({
      title: `${done} of ${rows.length} ${action === "approve" ? "approved" : "rejected"}`,
      description: bulkResultText(result),
      variant: failures.length > 0 && done === 0 ? "destructive" : undefined,
    });
  };

  const onHeadSort = (key: SortKey) =>
    setSort(sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: FIRST_DIRECTION[key] });

  // the month's counts (this page's kind, every filter but the status pill): received = pending + approved + rejected
  const counts = useMemo(() => statusCounts(view.periodRows, view.filters), [view]);
  // the bank file: the month's approved (active or completed) advances of this page and filters, whatever the status pill
  const bankRows = useMemo(() => bankFileRows(all, state), [all, state]);

  const statsLoading = isLoading || isError;
  const noneAtAll = !isLoading && !isError && all.length === 0;
  const noneInTab = !isLoading && !isError && !noneAtAll && view.tabRows.length === 0;
  const noun = TAB_NOUN[tab];
  const narrowed = period !== null || filtersActive({ ...view.filters, status: "all" });
  const fixedType = TAB_TYPE[tab];
  const bankBlocked =
    isLoading || isError
      ? "The advances are still loading."
      : bankRows.length === 0
        ? `No approved ${noun.many} in ${periodLabel(period)}${
            filtersActive({ ...view.filters, status: "all" }) ? " with these filters" : ""
          } to pay.`
        : null;
  const inMonth = period ? `in ${periodLabel(period)}` : "in all months";

  return (
    <HrLayout>
      <div className="min-w-0 space-y-5" data-ui-area="payroll" data-testid="settlement-normal" data-page={page}>
        <PageHeading
          page={page}
          actions={
            <>
              <span data-view-safe className="contents">
                <Button
                  variant="outline"
                  className="h-10 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                  onClick={() => setShowExport(true)}
                  disabled={isLoading || all.length === 0}
                  data-testid="settlement-export"
                >
                  <Download size={14} /> Export
                </Button>
                <span title={bankBlocked ?? undefined} className="inline-flex">
                  <Button
                    variant="outline"
                    className="h-10 gap-2 border-sky-200 text-sky-800 hover:bg-sky-50"
                    onClick={() => setShowBank(true)}
                    disabled={!!bankBlocked}
                    aria-describedby={bankBlocked ? "settlement-bank-file-why" : undefined}
                    data-testid="settlement-bank-file"
                  >
                    <Landmark size={14} /> Export Bank File
                  </Button>
                </span>
                {bankBlocked && (
                  <span id="settlement-bank-file-why" className="sr-only" data-testid="settlement-bank-file-why">
                    {bankBlocked}
                  </span>
                )}
              </span>
              <Button className="h-10 gap-2" onClick={() => setShowNew(true)} data-testid="new-advance">
                <Plus size={15} /> New request
              </Button>
            </>
          }
        >
          <span data-testid="loan-advance-description">{description(page, rules)}</span>
        </PageHeading>

        <div className="space-y-3">
          {/* the month's requests (this page's kind, every filter but the status pill): they always add up */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="settlement-counts">
            <StatCard
              testId="count-received"
              label="Requests received"
              value={statsLoading ? "-" : counts.all}
              sub={statsLoading ? undefined : `${countOf(counts.all, tab)} ${inMonth}`}
              icon={Inbox}
              tone="bg-slate-100 text-slate-800"
              onClick={() => setStatus("all")}
              active={view.filters.status === "all"}
              title="Show them all"
            />
            <StatCard
              testId="count-approved"
              label="Approved"
              value={statsLoading ? "-" : counts.approved_all}
              sub={statsLoading ? undefined : `${counts.approved} active · ${counts.closed} completed`}
              icon={CheckCircle2}
              tone="bg-green-50 text-green-800"
              onClick={() => setStatus("approved_all")}
              active={view.filters.status === "approved_all"}
              title="Show the approved ones (active and completed)"
            />
            <StatCard
              testId="count-rejected"
              label="Rejected"
              value={statsLoading ? "-" : counts.rejected}
              icon={XCircle}
              tone="bg-red-50 text-red-800"
              onClick={() => setStatus("rejected")}
              active={view.filters.status === "rejected"}
              title="Show the rejected ones"
            />
            <StatCard
              testId="count-pending"
              label="Pending"
              value={statsLoading ? "-" : counts.pending}
              sub={statsLoading ? undefined : "waiting for approval"}
              icon={Hourglass}
              tone="bg-amber-50 text-amber-800"
              onClick={() => setStatus("pending")}
              active={view.filters.status === "pending"}
              title="Show the ones waiting for approval"
            />
          </div>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard
              testId="stat-pending"
              label="Pending amount"
              value={statsLoading ? "-" : formatMoney(summary.pendingAmount)}
              sub={statsLoading ? undefined : `requested by ${countOf(summary.pendingCount, tab)}`}
              icon={HandCoins}
              tone="bg-amber-50/60 text-amber-900"
            />
            <StatCard
              testId="stat-active"
              label="Active outstanding"
              value={statsLoading ? "-" : formatMoney(summary.outstanding)}
              sub={statsLoading ? undefined : `still to recover on ${summary.activeCount} active ${noun.many}`}
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
                ? `Figures for ${periodLabel(period)} (${basisWord(basis)}), as filtered below`
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

        {bulkResult && (
          <div
            className={cn(
              "flex items-start justify-between gap-3 rounded-xl border p-3 text-[13px]",
              bulkResult.failures.length > 0
                ? "border-amber-200 bg-amber-50 text-amber-900"
                : "border-green-200 bg-green-50 text-green-900",
            )}
            role="status"
            data-testid="advance-bulk-result"
          >
            <p>{bulkResultText(bulkResult)}</p>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 px-2"
              onClick={() => setBulkResult(null)}
              aria-label="Dismiss"
              data-testid="advance-bulk-result-close"
            >
              <X size={13} />
            </Button>
          </div>
        )}

        <Card className="overflow-hidden rounded-2xl">
          <CardContent className="p-0">
            {!isLoading && !isError && shown.length > 0 && (
              <BulkBar
                ticked={tickedRows.length}
                total={tickableShown.length}
                onSelectAll={() => toggleAll(true)}
                onClear={() => toggleAll(false)}
                onApprove={() => setBulk("approve")}
                onReject={() => setBulk("reject")}
                busy={bulkProgress !== null}
                note="Approve = the full amount asked for; Reject = one reason for all. Each is saved one after the other."
                testId="advance-bulk"
              />
            )}
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
                    ? "Raise a Term Loan request for an employee. Once approved, payroll deducts the monthly EMI automatically."
                    : tab === "advance"
                      ? "Raise a Salary Advance request for an employee. Once approved, payroll deducts it once, from that month's salary."
                      : "Raise a Term Loan or Salary Advance request for an employee. Once approved, payroll deducts it automatically."
                }
                testId="advances-empty"
              >
                <Button onClick={() => setShowNew(true)} className="gap-1.5">
                  <Plus size={15} /> New {fixedType ? `${TYPE_LABEL[fixedType]} ` : ""}request
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
                showType={tab === "overview"}
                selected={selected}
                selectable={tickable}
                onToggle={toggle}
                onToggleAll={toggleAll}
                onLeave={(row) => leave.show(row.id, row.employeeName)}
              />
            )}
          </CardContent>
        </Card>

        <NewRequestDialog
          open={showNew}
          onClose={() => setShowNew(false)}
          fixedType={fixedType}
          onCreated={showCreated}
        />

        <DecisionDialog decision={decision} onConfirm={decide} onCancel={() => setDecision(null)} />

        <BulkDialog
          action={bulk}
          count={tickedRows.length}
          title={
            bulk === "approve"
              ? `Approve ${countOf(tickedRows.length, tab)}?`
              : `Reject ${countOf(tickedRows.length, tab)}?`
          }
          description={
            <>
              <p>
                {bulk === "approve"
                  ? "Each one is approved for the full amount asked for, with its deductions as asked."
                  : "Each one is rejected with this reason; the employees see it in the app."}{" "}
                They are saved one after the other; one the server refuses is left as it is and listed afterwards.
              </p>
              <ul className="max-h-32 list-disc overflow-y-auto pl-5 text-xs" data-testid="advance-bulk-list">
                {tickedRows.map((r) => (
                  <li key={r.id}>
                    {r.employeeName} ({r.employeeCode}) · {TYPE_LABEL[r.advanceType]} ·{" "}
                    {formatMoney(r.requestedAmount ?? r.amount)}
                  </li>
                ))}
              </ul>
            </>
          }
          onConfirm={runBulk}
          onCancel={() => setBulk(null)}
          progress={bulkProgress}
          testId="advance-bulk-dialog"
        />
        {leave.dialog}

        {showExport && (
          <ExportDialog
            open={showExport}
            onClose={() => setShowExport(false)}
            all={all}
            page={state}
            company={company.excel}
          />
        )}

        <BankFileDialog rows={bankRows} state={state} open={showBank} onClose={() => setShowBank(false)} />

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
  basis === "applied"
    ? "raised in it"
    : basis === "decided"
      ? "approved or rejected in it"
      : basis === "deducted"
        ? "deducted in it"
        : "any activity in it";
