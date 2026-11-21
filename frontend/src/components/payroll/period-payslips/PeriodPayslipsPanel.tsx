import { useMemo, useState } from "react";
import {
  ArrowRight,
  Download,
  FileText,
  IndianRupee,
  Layers,
  Lock,
  MinusCircle,
  PlusCircle,
  RotateCcw,
  Search,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { useLocation } from "wouter";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { inr, plural } from "@/components/payroll/kit/format";
import { BusyIcon, Chip, EmptyNote, KpiTile, SkeletonRows } from "@/components/payroll/kit/parts";
import { payrollTabKey, periodNoun, scopeKey, scopeLabel } from "@/components/payroll/kit/scope";
import { openPayrollDetails } from "@/components/payroll/kit/url-state";
import { errorText } from "@/components/payroll/panels/payslips/payslips-logic";
import { pageSlice } from "@/components/payroll/panels/records/records-logic";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { usePeriodPayslips, type PayrollScope, type PayslipLayout } from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import {
  ALL,
  DEFAULT_PAYSLIP_FILTERS,
  filterPayslips,
  payslipDepartments,
  payslipFilterCount,
  payslipFiltersFromUrl,
  payslipFiltersToUrl,
  payslipTotals,
  pickedIds,
  selectionState,
  toggleAll,
  toggleOne,
  type PayslipFilters,
} from "./logic";
import { PayslipList } from "./PayslipList";
import { PayslipSheet } from "./PayslipSheet";
import { usePayslipActions } from "./use-payslip-actions";

type UrlSetter = (patch: Record<string, string>) => void;

const LAYOUT_LABEL: Record<PayslipLayout, string> = {
  single: "One payslip per page",
  double: "Two per page (landscape)",
};

/**
 * The Payslip tab (owner 2026-11-20) of Staff Payroll (one month) and of a Production Payroll cycle page (one pay
 * period): the payslips of the employees IN the generated payroll (the Records list), the figures, a searchable list with
 * checkboxes, each payslip's full breakdown in a side sheet, its PDF (preview / download), email and WhatsApp, and one PDF
 * of the payslips picked or listed (one or two to a page). The month / period is the page's; the filters live in the
 * address (`url` / `setUrl`, the pl* keys).
 */
export function PeriodPayslipsPanel({
  scope,
  url,
  setUrl,
  testId,
}: {
  scope: PayrollScope;
  url: Record<string, string>;
  setUrl: UrlSetter;
  /** The root's test id (default "staff-payslips-tab" / "pcp-payslip-tab"). */
  testId?: string;
}) {
  const [, navigate] = useLocation();
  const level = useLevel();
  const kind = scope.kind;
  const production = kind === "production";
  const ui = ACCENT_UI[accentOf(kind)];
  const noun = periodNoun(kind);
  // a payslip-only role has no Payroll tab: no link to it, nor to a payroll's details page
  const canOpenPayroll = level(payrollTabKey(kind)) !== "hidden";
  const query = usePeriodPayslips(scope);
  const { data, isLoading, isError, error, isFetching, refetch } = query;
  const rows = useMemo(() => data?.rows ?? [], [data]);
  const periodName = data?.periodLabel || scopeLabel(scope);
  const actions = usePayslipActions(scope);

  // ── what is shown ──
  const filters = useMemo(() => payslipFiltersFromUrl(url), [url]);
  const setFilters = (patch: Partial<PayslipFilters>) => setUrl(payslipFiltersToUrl(patch) as Record<string, string>);
  const clearFilters = () => setFilters(DEFAULT_PAYSLIP_FILTERS);
  const filterCount = payslipFilterCount(filters);
  const shown = useMemo(() => filterPayslips(rows, filters), [rows, filters]);
  const shownTotals = useMemo(() => payslipTotals(shown), [shown]);
  const departments = useMemo(() => payslipDepartments(rows), [rows]);
  const summary = data?.summary;

  // ── the selection and the open payslip: both belong to one month / period ──
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [openId, setOpenId] = useState<number | null>(null);
  const [layout, setLayout] = useState<PayslipLayout>("single");
  const periodKey = scopeKey(scope);
  const [seenPeriod, setSeenPeriod] = useState(periodKey);
  if (seenPeriod !== periodKey) {
    setSeenPeriod(periodKey);
    setSelected(new Set());
    setOpenId(null);
  }
  const picked = useMemo(() => {
    const ids = new Set(pickedIds(selected, rows));
    return rows.filter((r) => ids.has(r.payrollId));
  }, [selected, rows]);
  const shownIds = useMemo(() => shown.map((r) => r.payrollId), [shown]);
  const allState = selectionState(selected, shownIds);
  const openRow = rows.find((r) => r.payrollId === openId) ?? null;

  // ── pages ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const resetKey = `${periodKey}|${JSON.stringify(filters)}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setPage(1);
  }
  const view = useMemo(() => pageSlice(shown, page, pageSize), [shown, page, pageSize]);

  const selectClass = "h-10 w-full sm:w-44";
  const allLabel = filterCount > 0 ? "Download listed" : "Download all";

  return (
    <div
      className="min-w-0 space-y-4"
      data-testid={testId ?? (production ? "pcp-payslip-tab" : "staff-payslips-tab")}
      data-kind={kind}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900" data-testid="ps-heading">
            {isLoading || !data ? periodName : `${periodName} · ${plural(rows.length, "payslip")}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {production
              ? "The workers in the period's payroll. Workers waiting in New Joiners get a payslip once they are added to the payroll."
              : "The employees in the month's payroll. Held salaries, new joiners not added and salaries paid separately are under Payroll → Skipped."}
          </p>
        </div>
        {data?.locked && (
          <Chip tone="accent" icon={Lock} title={`Payroll Done was pressed: the ${noun}'s figures cannot change`}>
            Finalized: locked
          </Chip>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2 lg:grid-cols-3" data-testid="ps-kpis">
        <KpiTile
          testId="ps-kpi-employees"
          label="Employees"
          icon={Users}
          tone={ui.tile}
          loading={isLoading}
          value={summary?.employees ?? 0}
          sub={`in the payroll of ${periodName}`}
        />
        <KpiTile
          testId="ps-kpi-earned"
          label="Earned"
          icon={TrendingUp}
          tone="bg-blue-50 text-blue-800"
          loading={isLoading}
          value={inr(summary?.earned ?? 0)}
          sub={production ? "shifts × rate per shift" : "worked out from attendance"}
        />
        <KpiTile
          testId="ps-kpi-excess"
          label="Excess"
          icon={PlusCircle}
          tone="bg-emerald-50 text-emerald-800"
          loading={isLoading}
          value={inr(summary?.excess ?? 0)}
          sub="added by HR"
        />
        <KpiTile
          testId="ps-kpi-detection"
          label="Detection"
          icon={MinusCircle}
          tone="bg-rose-50 text-rose-800"
          loading={isLoading}
          value={inr(summary?.detection ?? 0)}
          sub="taken off by HR"
        />
        <KpiTile
          testId="ps-kpi-deductions"
          label="Deductions"
          icon={IndianRupee}
          tone="bg-red-50 text-red-800"
          loading={isLoading}
          value={inr(summary?.deductions ?? 0)}
          sub="PF, ESI, TDS, advances and others"
        />
        <KpiTile
          testId="ps-kpi-net"
          label="Net pay"
          icon={Wallet}
          tone="bg-green-50 text-green-800"
          loading={isLoading}
          value={inr(summary?.net ?? 0)}
          sub="what the payslips pay out"
        />
      </div>

      <div className="clay-card rounded-2xl border border-slate-100 p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-full min-w-0 sm:w-auto sm:min-w-[14rem] sm:flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={filters.q}
              onChange={(e) => setFilters({ q: e.target.value })}
              placeholder="Search by name or employee code"
              aria-label="Search the payslips by name or employee code"
              className="h-10 pl-9"
              data-testid="ps-search"
            />
          </div>
          <Select
            value={filters.dept}
            onValueChange={(v) => setFilters({ dept: v })}
            disabled={isLoading || departments.length === 0}
          >
            <SelectTrigger className={selectClass} aria-label="Department" data-testid="ps-dept">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {departments.map((d) => (
                <SelectItem key={d.value} value={d.value}>
                  {d.label}
                </SelectItem>
              ))}
              {filters.dept !== ALL && !departments.some((d) => d.value === filters.dept) && (
                <SelectItem value={filters.dept}>{filters.dept}</SelectItem>
              )}
            </SelectContent>
          </Select>
          <Select value={filters.status} onValueChange={(v) => setFilters({ status: v as PayslipFilters["status"] })}>
            <SelectTrigger className={selectClass} aria-label="Status" data-testid="ps-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Cleared and pending</SelectItem>
              <SelectItem value="paid">Cleared</SelectItem>
              <SelectItem value="pending">Pending</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={filters.payment}
            onValueChange={(v) => setFilters({ payment: v as PayslipFilters["payment"] })}
          >
            <SelectTrigger className={selectClass} aria-label="Payment status" data-testid="ps-payment">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Paid and not paid</SelectItem>
              <SelectItem value="paid">Paid</SelectItem>
              <SelectItem value="unpaid">Not paid</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {filterCount > 0 && !isLoading && (
          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-gray-100 pt-2.5 text-xs text-gray-500">
            <span data-testid="ps-count">
              {shown.length} of {plural(rows.length, "payslip")} match
            </span>
            <button
              type="button"
              onClick={clearFilters}
              className={cn("font-semibold hover:underline", ui.link)}
              data-testid="ps-clear"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>

      <div
        className="sticky top-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-slate-200 bg-white px-3 py-2.5"
        data-testid="ps-bulk-bar"
      >
        <label className="flex min-w-0 cursor-pointer items-center gap-2.5">
          <Checkbox
            checked={allState}
            onCheckedChange={() => setSelected((s) => toggleAll(s, shownIds))}
            disabled={isLoading || shown.length === 0}
            aria-label={`Pick every payslip listed (${shown.length})`}
            className={cn("border-slate-300", ui.check)}
            data-testid="ps-pick-all"
          />
          {isLoading ? (
            <Skeleton className="h-4 w-36" />
          ) : (
            <span className="text-sm">
              <span className="font-semibold text-gray-900" data-testid="ps-picked-count">
                {picked.length > 0 ? `${picked.length} picked` : "Pick payslips"}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {picked.length > 0 ? "for one PDF" : `or download every one listed (${shown.length})`}
              </span>
            </span>
          )}
        </label>
        {picked.length > 0 && (
          <button
            type="button"
            className={cn("text-xs font-semibold hover:underline", ui.link)}
            onClick={() => setSelected(new Set())}
            data-testid="ps-unpick"
          >
            Clear the picks
          </button>
        )}
        <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
          <Select value={layout} onValueChange={(v) => setLayout(v as PayslipLayout)}>
            <SelectTrigger className="h-9 w-full sm:w-52" aria-label="Payslips per page" data-testid="ps-layout">
              <Layers size={14} className="mr-1.5 shrink-0 text-gray-500" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="single">{LAYOUT_LABEL.single}</SelectItem>
              <SelectItem value="double">{LAYOUT_LABEL.double}</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            className={cn("h-9 flex-1 gap-2 sm:flex-none", ui.solid)}
            disabled={picked.length === 0 || actions.bulk !== null}
            onClick={() => void actions.downloadMany(picked, layout, "picked")}
            title="One PDF of the payslips picked"
            data-testid="ps-download-picked"
          >
            <BusyIcon busy={actions.bulk === "picked"} icon={Download} /> Download picked ({picked.length})
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-9 flex-1 gap-2 sm:flex-none"
            disabled={isLoading || shown.length === 0 || actions.bulk !== null}
            onClick={() => void actions.downloadMany(shown, layout, "all")}
            title={filterCount > 0 ? "One PDF of every payslip listed" : `One PDF of every payslip of the ${noun}`}
            data-testid="ps-download-all"
          >
            <BusyIcon busy={actions.bulk === "all"} icon={FileText} /> {allLabel} ({shown.length})
          </Button>
        </div>
      </div>

      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : isError && !data ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-4"
          data-testid="ps-error"
        >
          <p className="text-sm text-red-800">
            <b>Could not load the payslips.</b> {errorText(error)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid="ps-retry"
          >
            <BusyIcon busy={isFetching} icon={RotateCcw} size={13} /> Try again
          </Button>
        </div>
      ) : rows.length === 0 ? (
        <EmptyNote
          testId="ps-empty"
          icon={FileText}
          title={`No payroll for ${periodName} yet: generate the payroll first`}
          hint={`Payslips are made from the ${noun}'s payroll. Once it is generated, every employee in it has a payslip here.`}
          action={
            canOpenPayroll ? (
              <Button
                type="button"
                className={cn("mt-2 gap-2", ui.solid)}
                onClick={() => setUrl({ tab: "payroll" })}
                data-testid="ps-open-payroll-tab"
              >
                Go to the Payroll tab <ArrowRight size={14} />
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Ask the payroll team to generate it.</p>
            )
          }
        />
      ) : shown.length === 0 ? (
        <EmptyNote
          testId="ps-empty-filters"
          icon={Search}
          title="No payslip matches these filters"
          hint="Try another name, department or status, or show every payslip again."
          action={
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={clearFilters}>
              Clear filters
            </Button>
          }
        />
      ) : (
        <>
          <PayslipList
            kind={kind}
            rows={view.items}
            totals={shownTotals}
            listedCount={shown.length}
            selected={selected}
            onPick={(id) => setSelected((s) => toggleOne(s, id))}
            onOpen={setOpenId}
            actions={actions}
            dimmed={isFetching}
          />
          <DataPagination
            page={view.page}
            totalPages={view.totalPages}
            totalItems={view.total}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={view.total > 10 ? setPageSize : undefined}
            className="px-1"
          />
        </>
      )}

      <PayslipSheet
        kind={kind}
        row={openRow}
        periodLabel={periodName}
        actions={actions}
        onClose={() => setOpenId(null)}
        onOpenPayroll={canOpenPayroll ? (id) => openPayrollDetails(navigate, kind, id) : undefined}
      />
    </div>
  );
}
