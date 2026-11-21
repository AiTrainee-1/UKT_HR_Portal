import { useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  FileSpreadsheet,
  FileText,
  Hourglass,
  Play,
  RotateCcw,
  Search,
  SearchX,
  UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ACCENT_UI, accentOf } from "@/components/payroll/kit/accent-ui";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { dateShort, plural } from "@/components/payroll/kit/format";
import { Avatar, BusyIcon, Chip, EmptyNote, SkeletonRows } from "@/components/payroll/kit/parts";
import { generateKey, periodNoun } from "@/components/payroll/kit/scope";
import { errorText } from "@/components/payroll/panels/payslips/payslips-logic";
import { pageSlice } from "@/components/payroll/panels/records/records-logic";
import {
  usePayrollSettings,
  usePeriodNotIncluded,
  type NotIncludedEmployee,
  type PayrollKind,
  type PayrollScope,
} from "@/lib/api-client/custom-hooks";
import { Gate } from "@/lib/tab-access";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import {
  ALL,
  CATEGORY_CLASS,
  categoryLabel,
  defaultCategory,
  defaultNotIncludedFilters,
  filterNotIncluded,
  filterOptions,
  isActive,
  listedNoun,
  notIncludedColumns,
  notIncludedFileStem,
  notIncludedFilterCount,
  notIncludedFiltersFromUrl,
  notIncludedFiltersToUrl,
  otherPayrollReason,
  pickReason,
  reasonChips,
  reasonMeta,
  type NotIncludedFilters,
} from "./logic";

type UrlSetter = (patch: Record<string, string>) => void;

// Employee | Department | Status | Joined | Reason | (Open payroll): the columns at tablet width and up; below that each row
// is a card. The list scrolls sideways inside its own box when the screen is narrower than the columns need.
const GRID =
  "md:grid md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.1fr)_minmax(0,0.8fr)_minmax(0,0.65fr)_minmax(0,2.2fr)_8.5rem] md:items-start md:gap-4";

function ReasonChip({ code, kind }: { code: string; kind: PayrollKind }) {
  const meta = reasonMeta(code, kind);
  return (
    <Chip tone={meta.tone} className={meta.className}>
      {meta.label}
    </Chip>
  );
}

function Row({
  e,
  kind,
  onOpenPayroll,
}: {
  e: NotIncludedEmployee;
  kind: PayrollKind;
  onOpenPayroll: (payrollId: number) => void;
}) {
  const active = isActive(e);
  const ui = ACCENT_UI[accentOf(kind)];
  return (
    <li
      className={cn(GRID, "flex flex-col gap-3 px-4 py-3.5 transition-colors hover:bg-slate-50/70")}
      data-testid={`ni-row-${e.id}`}
      data-reason={e.reasonCode}
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={e.name} size={36} />
        <div className="min-w-0">
          <p className="truncate text-sm font-bold text-gray-900">{e.name}</p>
          <p className="truncate text-xs text-muted-foreground">
            <span className="font-mono">{e.code}</span>
            {e.unit && <> · {e.unit}</>}
          </p>
        </div>
      </div>
      <div className="min-w-0 text-sm">
        <span className="text-[11px] font-medium text-muted-foreground md:sr-only">Department · </span>
        <span className="text-gray-800">{e.department ?? "No department"}</span>
        <p className="truncate text-xs text-muted-foreground">{e.designation ?? "No designation"}</p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 md:flex-col md:items-start">
        <span className="sr-only">Status</span>
        <Chip tone={active ? "success" : "neutral"}>{active ? "Active" : "Inactive"}</Chip>
        <Chip tone="neutral" className={CATEGORY_CLASS[e.category as keyof typeof CATEGORY_CLASS]}>
          {categoryLabel(e.category)}
        </Chip>
      </div>
      <div className="text-xs text-gray-700">
        <span className="font-medium text-muted-foreground md:sr-only">Joined </span>
        <span className="tabular-nums">{dateShort(e.joinDate)}</span>
      </div>
      <div className="min-w-0 rounded-xl bg-slate-50 p-2.5 md:bg-transparent md:p-0">
        <span className="sr-only">Reason</span>
        <p className="text-sm font-semibold leading-snug text-gray-900" data-testid={`ni-row-${e.id}-reason`}>
          {e.reason}
        </p>
        {e.detail && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{e.detail}</p>}
        <div className="mt-1.5">
          <ReasonChip code={e.reasonCode} kind={kind} />
        </div>
      </div>
      <div className="md:text-right">
        {e.payrollId ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn("h-8 gap-1.5 text-xs", ui.pill, ui.pillHover)}
            aria-label={`Open the payroll of ${e.name}`}
            onClick={() => onOpenPayroll(e.payrollId!)}
            data-testid={`ni-row-${e.id}-open`}
          >
            Open payroll <ArrowRight size={13} />
          </Button>
        ) : (
          <span className="hidden text-xs text-gray-400 md:inline">No payroll</span>
        )}
      </div>
    </li>
  );
}

/**
 * The "Not included" view of the Payroll tab (owner 2026-11-20): every employee of the HRMS who is not in the month's staff
 * payroll (Staff Payroll) or the period's production payroll (a Production Payroll cycle page), and why. The page's own
 * category is shown first (the others are paid on the other payroll); the reason chips filter the list; a row with a
 * payroll of its own (held, new joiner, paid separately) opens it. Read only.
 */
export function NotIncludedView({
  scope,
  periodLabel,
  url,
  setUrl,
  onOpenPayroll,
  onGenerate,
}: {
  /** The staff month or production period of the page. */
  scope: PayrollScope;
  periodLabel: string;
  url: Record<string, string>;
  setUrl: UrlSetter;
  onOpenPayroll: (payrollId: number) => void;
  /** Opens the Generate dialog; leave out when the role may not generate or the month / period is locked. */
  onGenerate?: () => void;
}) {
  const kind = scope.kind;
  const production = kind === "production";
  const ui = ACCENT_UI[accentOf(kind)];
  const noun = periodNoun(kind);
  const own = defaultCategory(kind);
  const query = usePeriodNotIncluded(scope);
  const { data, isLoading, isError, error, isFetching, refetch } = query;
  const { data: settings } = usePayrollSettings();
  const filters = useMemo(() => notIncludedFiltersFromUrl(url, kind), [url, kind]);
  const setFilters = (patch: Partial<NotIncludedFilters>) =>
    setUrl(notIncludedFiltersToUrl(patch) as Record<string, string>);
  const clearFilters = () => setFilters(defaultNotIncludedFilters(kind));

  const generated = data?.generated ?? true;
  const rows = useMemo(() => data?.employees ?? [], [data]);
  const shown = useMemo(
    () => filterNotIncluded(rows, filters, { hideWaiting: !generated }),
    [rows, filters, generated],
  );
  // what the count line compares against: everyone of the chosen category the list could show
  const inCategory = useMemo(
    () =>
      filterNotIncluded(
        rows,
        { ...defaultNotIncludedFilters(kind), category: filters.category },
        { hideWaiting: !generated },
      ).length,
    [rows, filters.category, generated, kind],
  );
  const chips = useMemo(() => reasonChips(data?.summary.byReason, kind), [data, kind]);
  const options = useMemo(() => filterOptions(data, filters), [data, filters]);
  const reasonOptions = useMemo(() => {
    const list = chips.map((c) => ({ value: c.code, label: c.label }));
    if (filters.reason !== ALL && !list.some((o) => o.value === filters.reason))
      list.push({ value: filters.reason, label: reasonMeta(filters.reason, kind).label });
    return list;
  }, [chips, filters.reason, kind]);
  const filterCount = notIncludedFilterCount(filters, kind);
  const waitingRows = rows.filter((e) => e.reasonCode === "not_generated").length;
  const toAdd = generated ? (data?.summary.byReason.not_generated ?? 0) : 0;

  // ── pages ──
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const resetKey = `${JSON.stringify(scope)}|${JSON.stringify(filters)}`;
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setPage(1);
  }
  const view = useMemo(() => pageSlice(shown, page, pageSize), [shown, page, pageSize]);

  // ── the export: the list as filtered ──
  const fileStem = notIncludedFileStem(scope);
  const columns = useMemo(() => notIncludedColumns(kind), [kind]);
  const subtitle = `${periodLabel} - ${filters.category === ALL ? "every employee" : categoryLabel(filters.category)}`;
  const exportItems: ExportItem[] = [
    {
      key: "excel",
      label: "Not included list (Excel)",
      hint: `${plural(shown.length, "employee")} as listed, with the reasons`,
      icon: FileSpreadsheet,
      disabled: shown.length === 0,
      run: async () => {
        const { exportTableToExcel } = await import("@/components/payroll/kit/export-table");
        await exportTableToExcel({
          rows: shown,
          columns,
          filename: fileStem,
          sheetName: "Not included",
          company: settings?.companyName || "UKTextiles",
          subtitle,
          title: "Employees not in the payroll",
        });
      },
    },
    {
      key: "csv",
      label: "Not included list (CSV)",
      hint: `${plural(shown.length, "employee")} as listed, plain text`,
      icon: FileText,
      disabled: shown.length === 0,
      run: async () => {
        const { exportTableToCsv } = await import("@/components/payroll/kit/export-table");
        exportTableToCsv({ rows: shown, columns, filename: fileStem });
      },
    },
  ];

  const selectClass = "h-10 w-full sm:w-44";

  return (
    <div className="min-w-0 space-y-4" data-testid="not-included-view" data-kind={kind}>
      <p className="text-xs text-muted-foreground">
        {production
          ? `Everyone in the HRMS who is not in the payroll of ${periodLabel}, and why. Production employees are shown first: staff are paid on the Staff Payroll.`
          : `Everyone in the HRMS who is not in the payroll of ${periodLabel}, and why. Staff are shown first: production employees are paid on Production Payroll.`}
      </p>

      {data && !data.generated && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="ni-not-generated"
        >
          <div className="flex min-w-0 items-start gap-3">
            <Hourglass size={18} className="mt-0.5 shrink-0 text-amber-700" />
            <div className="min-w-0 text-sm text-amber-900">
              <p className="font-bold">The payroll of {periodLabel} is not generated yet.</p>
              <p className="mt-0.5 text-xs leading-snug text-amber-800">
                {data.notGeneratedCount > 0
                  ? `${plural(data.notGeneratedCount, production ? "active worker" : "active staff employee")} with a salary ${data.notGeneratedCount === 1 ? "is" : "are"} waiting for it. `
                  : `No active ${production ? "worker" : "staff employee"} with a salary is waiting for it. `}
                The employees below stay out of the payroll even when it is generated.
                {waitingRows > 0 && ' Pick "Not generated" to see the ones waiting.'}
              </p>
            </div>
          </div>
          {onGenerate && (
            <Gate k={generateKey(kind)}>
              <Button
                type="button"
                className={cn("h-9 shrink-0 gap-2", ui.solid)}
                onClick={onGenerate}
                data-testid="ni-generate"
              >
                <Play size={14} /> Generate Payroll
              </Button>
            </Gate>
          )}
        </div>
      )}

      {toAdd > 0 && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          data-testid="ni-generate-again"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-red-700" />
            <p className="min-w-0 text-sm text-red-900">
              <b>
                {plural(toAdd, production ? "worker" : "staff employee")} would be paid but {toAdd === 1 ? "is" : "are"}{" "}
                not in the payroll.
              </b>{" "}
              <span className="text-xs text-red-800">Generate the payroll again to add them.</span>
            </p>
          </div>
          {onGenerate && (
            <Gate k={generateKey(kind)}>
              <Button
                type="button"
                className={cn("h-9 shrink-0 gap-2", ui.solid)}
                onClick={onGenerate}
                data-testid="ni-generate-again-button"
              >
                <Play size={14} /> Generate Payroll
              </Button>
            </Gate>
          )}
        </div>
      )}

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Reasons" data-testid="ni-reasons">
          <button
            type="button"
            aria-pressed={filters.reason === ALL}
            onClick={() => setFilters({ reason: ALL })}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors",
              filters.reason === ALL ? ui.chipOn : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50",
            )}
            data-testid="ni-reason-chip-all"
          >
            All reasons
            <span className="rounded-full bg-black/5 px-1.5 tabular-nums">{data?.summary.total ?? 0}</span>
          </button>
          {chips.map((c) => {
            const on = filters.reason === c.code;
            return (
              <button
                key={c.code}
                type="button"
                aria-pressed={on}
                title={reasonMeta(c.code, kind).hint || undefined}
                onClick={() => setFilters(pickReason(filters, c.code, kind))}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors hover:brightness-95",
                  TONE[c.tone],
                  c.className,
                  on && cn("ring-2 ring-offset-1", ui.chipRing),
                )}
                data-testid={`ni-reason-chip-${c.code}`}
              >
                {c.label}
                <span className="rounded-full bg-white/70 px-1.5 tabular-nums">{c.count}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="clay-card rounded-2xl border border-slate-100 p-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="relative w-full min-w-0 sm:w-auto sm:min-w-[14rem] sm:flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={filters.q}
              onChange={(ev) => setFilters({ q: ev.target.value })}
              placeholder="Search by name or employee code"
              aria-label="Search by name or employee code"
              className="h-10 pl-9"
              data-testid="ni-search"
            />
          </div>
          <Select
            value={filters.category}
            onValueChange={(v) => setFilters({ category: v as NotIncludedFilters["category"] })}
          >
            <SelectTrigger className={selectClass} aria-label="Category" data-testid="ni-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(production ? (["production", "staff"] as const) : (["staff", "production"] as const)).map((c) => (
                <SelectItem key={c} value={c}>
                  {categoryLabel(c)}
                </SelectItem>
              ))}
              <SelectItem value={ALL}>Staff and production</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.reason} onValueChange={(v) => setFilters({ reason: v })} disabled={isLoading}>
            <SelectTrigger className={selectClass} aria-label="Reason" data-testid="ni-reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All reasons</SelectItem>
              {reasonOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.dept} onValueChange={(v) => setFilters({ dept: v })} disabled={isLoading}>
            <SelectTrigger className={selectClass} aria-label="Department" data-testid="ni-dept">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All departments</SelectItem>
              {options.departments.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.desig} onValueChange={(v) => setFilters({ desig: v })} disabled={isLoading}>
            <SelectTrigger className={selectClass} aria-label="Designation" data-testid="ni-desig">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All designations</SelectItem>
              {options.designations.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.status}
            onValueChange={(v) => setFilters({ status: v as NotIncludedFilters["status"] })}
          >
            <SelectTrigger className={selectClass} aria-label="Status" data-testid="ni-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Active and inactive</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
            </SelectContent>
          </Select>
          <ExportMenu
            items={exportItems}
            testId="ni-export"
            heading="What to export"
            disabled={isLoading || shown.length === 0}
            className="h-10 gap-2"
          />
        </div>
        {!isLoading && data && (
          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 pt-2.5 text-xs text-gray-500">
            <span data-testid="ni-count">
              {shown.length === inCategory
                ? `${plural(shown.length, listedNoun(filters.category))} not in the payroll`
                : `${shown.length} of ${plural(inCategory, listedNoun(filters.category))} match`}
            </span>
            {filterCount > 0 && (
              <button
                type="button"
                onClick={clearFilters}
                className={cn("font-semibold hover:underline", ui.link)}
                data-testid="ni-clear"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
      </div>

      {isLoading ? (
        <SkeletonRows rows={6} />
      ) : isError && !data ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-red-200 bg-red-50 px-4 py-4"
          data-testid="ni-error"
        >
          <p className="text-sm text-red-800">
            <b>Could not load who is not in the payroll.</b> {errorText(error)}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => void refetch()}
            disabled={isFetching}
            data-testid="ni-retry"
          >
            <BusyIcon busy={isFetching} icon={RotateCcw} size={13} /> Try again
          </Button>
        </div>
      ) : shown.length === 0 ? (
        filterCount > 0 ? (
          <EmptyNote
            icon={SearchX}
            title="No employee matches these filters"
            hint="Change or clear the filters to see the rest."
            testId="ni-empty"
            action={
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyNote
            icon={UserCheck}
            title={
              filters.category === own
                ? `Every ${listedNoun(own)} is in the payroll of ${periodLabel}`
                : filters.category === ALL
                  ? `Everyone is in a payroll for ${periodLabel}`
                  : `No ${listedNoun(filters.category)} to list for ${periodLabel}`
            }
            hint={
              filters.category === otherPayrollReason(kind)
                ? `${categoryLabel(filters.category)} employees are paid on the ${production ? "Staff Payroll" : "Production Payroll"}.`
                : production
                  ? `Nobody is left out of the ${noun}: no one inactive, on another cycle, without a rate or waiting to be added.`
                  : "Nobody is left out: no one inactive, on hold, without a salary or waiting to be added."
            }
            testId="ni-empty"
          />
        )
      ) : (
        <>
          <div
            className={cn(
              "clay-card overflow-hidden rounded-2xl border border-slate-100 transition-opacity",
              isFetching && "opacity-60",
            )}
          >
            <div className="overflow-x-auto">
              <div className="md:min-w-[960px]">
                <div
                  className={cn(
                    GRID,
                    "hidden border-b bg-gray-50 px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-gray-500",
                  )}
                  aria-hidden="true"
                >
                  <span>Employee</span>
                  <span>Department</span>
                  <span>Status</span>
                  <span>Joined</span>
                  <span>Reason</span>
                  <span className="text-right">Payroll</span>
                </div>
                <ul
                  className="divide-y divide-gray-100"
                  aria-label="Employees not in the payroll"
                  data-testid="ni-list"
                >
                  {view.items.map((e) => (
                    <Row key={`${e.category}-${e.id}`} e={e} kind={kind} onOpenPayroll={onOpenPayroll} />
                  ))}
                </ul>
              </div>
            </div>
          </div>
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
    </div>
  );
}
