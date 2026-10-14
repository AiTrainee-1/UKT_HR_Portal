import { useMemo, useState, type ComponentType, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowUpRight,
  CalendarClock,
  CalendarX2,
  CheckCircle2,
  CircleHelp,
  CircleSlash,
  Coins,
  FileSpreadsheet,
  FileText,
  Factory,
  Info,
  IndianRupee,
  Layers,
  RefreshCcw,
  Repeat,
  SearchX,
  UserX,
} from "lucide-react";
import { exportTableToCsv, exportTableToExcel } from "@/components/payroll/kit/export-table";
import { ExportMenu, type ExportItem } from "@/components/payroll/kit/ExportMenu";
import { fileStem, plural } from "@/components/payroll/kit/format";
import { BusyIcon, Chip, EmptyNote, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Skeleton } from "@/components/ui/skeleton";
import { usePayrollSettings } from "@/lib/api-client/custom-hooks";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import {
  ACCENT,
  FALLBACK_COMPANY,
  FilterSelect,
  LoadError,
  ResetButton,
  SearchField,
  type FilterOption,
  type PanelAccent,
} from "../issues/panel-kit";
import { errorDetail, paginateRows } from "../issues/lists";
import {
  NO_SKIP_FILTERS,
  classifySkipped,
  filterSkipped,
  skipCategoryCards,
  skipFiltersActive,
  skipSummary,
  skippedExportColumns,
  type SkipFilterState,
  type SkippedRow,
} from "./skipped-logic";
import type { SkipCategory, SkippedItem } from "./skipped-types";

export type SkippedPanelProps = {
  /** Who payroll skipped (from the skip check, or the result of a Generate run). Undefined until it has loaded. */
  skipped?: SkippedItem[];
  /** How many employees were checked: "5 of 42 employees were skipped". */
  totalChecked?: number;
  loading?: boolean;
  /** The skip check failed (shown with a Retry when there is nothing to show yet). */
  error?: unknown;
  /** Runs the check again. */
  onRecheck?: () => void;
  rechecking?: boolean;
  /** "October 2026" / "2 Feb - 8 Feb 2026". */
  periodLabel: string;
  kind: "staff" | "production";
  accent: PanelAccent;
};

export const SKIPPED_PAGE_SIZE = 25;

const CATEGORY_ICON: Record<SkipCategory, ComponentType<{ size?: number; className?: string }>> = {
  no_salary: IndianRupee,
  no_rate: Coins,
  no_working_days: CalendarX2,
  no_cycle: CalendarClock,
  wrong_cycle: Repeat,
  overlap: Layers,
  inactive: UserX,
  not_production: Factory,
  already_paid: CheckCircle2,
  other: CircleHelp,
};

const BANNER = {
  success: {
    box: "border-emerald-200 bg-emerald-50",
    icon: CheckCircle2,
    iconBox: "bg-white/70 text-emerald-600",
    title: "text-emerald-900",
    hint: "text-emerald-800",
  },
  danger: {
    box: "border-red-200 bg-red-50",
    icon: CircleSlash,
    iconBox: "bg-white/70 text-red-600",
    title: "text-red-900",
    hint: "text-red-800",
  },
  info: {
    box: "border-sky-200 bg-sky-50",
    icon: Info,
    iconBox: "bg-white/70 text-sky-600",
    title: "text-sky-900",
    hint: "text-sky-800",
  },
} as const;

function Shell({ children, stale }: { children: ReactNode; stale?: boolean }) {
  return (
    <div
      className={cn("space-y-4 transition-opacity", stale && "opacity-70")}
      aria-busy={stale ? true : undefined}
      data-testid="skipped-panel"
      {...{ [VIEW_SAFE_ATTR]: "" }}
    >
      {children}
    </div>
  );
}

function SkippedSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Checking who is skipped" data-testid="skipped-loading">
      <Skeleton className="h-20 w-full rounded-2xl" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
      <SkeletonRows rows={4} />
    </div>
  );
}

/** A link to a real page of the HRMS that helps fix a skip. */
function FixLink({
  href,
  label,
  accent,
  testId,
}: {
  href: string;
  label: string;
  accent: PanelAccent;
  testId?: string;
}) {
  return (
    <Link
      href={href}
      className={cn("inline-flex items-center gap-0.5 text-xs font-semibold hover:underline", ACCENT[accent].link)}
      data-testid={testId}
    >
      {label} <ArrowUpRight size={11} />
    </Link>
  );
}

export function SkippedPanel({
  skipped,
  totalChecked,
  loading,
  error,
  onRecheck,
  rechecking,
  periodLabel,
  kind,
  accent,
}: SkippedPanelProps) {
  const { data: settings } = usePayrollSettings();
  const rows = useMemo(() => classifySkipped(skipped), [skipped]);
  const cards = useMemo(() => skipCategoryCards(rows), [rows]);
  const [filters, setFilters] = useState<SkipFilterState>(NO_SKIP_FILTERS);
  const shown = useMemo(() => filterSkipped(rows, filters), [rows, filters]);

  // The page number belongs to the filters it was chosen under.
  const viewKey = `${filters.q}|${filters.category}`;
  const [pageState, setPageState] = useState({ key: viewKey, page: 1 });
  const page = paginateRows(shown, pageState.key === viewKey ? pageState.page : 1, SKIPPED_PAGE_SIZE);

  // Nothing yet and no error: still on its way (the page may not have set `loading` for a check it has not started).
  if (loading || (skipped === undefined && !error)) {
    return (
      <Shell>
        <SkippedSkeleton />
      </Shell>
    );
  }
  if (skipped === undefined) {
    return (
      <Shell>
        <LoadError
          what="who is skipped"
          detail={errorDetail(error)}
          onRetry={onRecheck}
          retrying={rechecking}
          testId="skipped-error"
        />
      </Shell>
    );
  }

  const summary = skipSummary(skipped, totalChecked, periodLabel);
  const refreshError = errorDetail(error);
  const tone = BANNER[summary.tone];
  const BannerIcon = tone.icon;
  const active = skipFiltersActive(filters);
  const hasDepartment = rows.some((r) => !!r.department);
  const patch = (change: Partial<SkipFilterState>) => setFilters((prev) => ({ ...prev, ...change }));
  const categoryOptions: FilterOption[] = cards.map((c) => ({ value: c.category, label: `${c.label} (${c.count})` }));

  // ── Export: the rows shown by the filters (every page) ──
  const company = settings?.companyName || FALLBACK_COMPANY;
  const exportName = fileStem(kind === "production" ? "Production" : "Staff", "Skipped", "Employees", periodLabel);
  const exportSubtitle = [
    kind === "production" ? "Production Payroll" : "Staff Payroll",
    periodLabel,
    active > 0 ? "Filtered" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const countText = `${plural(shown.length, "employee")}${active > 0 ? ", filtered" : ""}`;
  const exportItems: ExportItem[] = [
    {
      key: "excel",
      label: "Excel (.xlsx)",
      hint: `${countText}, with reasons and how to fix`,
      icon: FileSpreadsheet,
      disabled: shown.length === 0,
      run: () =>
        exportTableToExcel<SkippedRow>({
          rows: shown,
          columns: skippedExportColumns,
          filename: exportName,
          sheetName: "Skipped employees",
          company,
          subtitle: exportSubtitle,
          title: "Skipped employees",
        }),
    },
    {
      key: "csv",
      label: "CSV",
      hint: `${countText}, plain text`,
      icon: FileText,
      disabled: shown.length === 0,
      run: () => exportTableToCsv<SkippedRow>({ rows: shown, columns: skippedExportColumns, filename: exportName }),
    },
  ];

  return (
    <Shell stale={rechecking}>
      {/* the headline: how many are skipped, or that nobody is */}
      <div
        className={cn("flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border p-4", tone.box)}
        data-testid="skipped-banner"
        data-tone={summary.tone}
      >
        <span className={cn("rounded-xl p-2.5", tone.iconBox)}>
          <BannerIcon size={20} />
        </span>
        <div className="min-w-0 flex-1 basis-60">
          <p className={cn("text-sm font-bold", tone.title)} data-testid="skipped-banner-title">
            {summary.title}
          </p>
          <p className={cn("mt-0.5 text-xs", tone.hint)} data-testid="skipped-banner-hint">
            {summary.hint}
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 gap-1.5 bg-white"
          onClick={onRecheck}
          disabled={!onRecheck || rechecking}
          data-testid="skipped-recheck"
        >
          <BusyIcon busy={!!rechecking} icon={RefreshCcw} />
          Re-check
        </Button>
      </div>

      {!!error && (
        <p className="px-1 text-xs font-medium text-red-700" role="alert" data-testid="skipped-stale">
          The last check could not be refreshed{refreshError ? ` (${refreshError})` : ""}. This is the earlier result.
        </p>
      )}

      {rows.length > 0 && (
        <>
          {/* why they are skipped, and what to do about each reason */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="skipped-cards">
            {cards.map((card) => {
              const Icon = CATEGORY_ICON[card.category];
              const on = filters.category === card.category;
              return (
                <div
                  key={card.category}
                  className="clay-card rounded-2xl border border-slate-100 p-3.5 transition-shadow"
                  style={on ? { boxShadow: `0 0 0 2px ${ACCENT[accent].fill}` } : undefined}
                  data-testid={`skipped-card-${card.category}`}
                  data-selected={on ? "true" : undefined}
                >
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => patch({ category: on ? "" : card.category })}
                    className="flex w-full items-start justify-between gap-3 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    data-testid={`skipped-card-${card.category}-filter`}
                  >
                    <span className="flex min-w-0 items-start gap-2.5">
                      <span className={cn("mt-0.5 rounded-xl border p-2", TONE[card.tone])}>
                        <Icon size={16} />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-bold text-gray-900">{card.label}</span>
                        <span className="block text-xs text-muted-foreground">{plural(card.count, "employee")}</span>
                      </span>
                    </span>
                    <span className="text-2xl font-black tabular-nums text-gray-900" data-testid="skipped-card-count">
                      {card.count}
                    </span>
                  </button>
                  <p className="mt-2 text-xs leading-snug text-gray-600" data-testid="skipped-card-fix">
                    {card.fix}
                  </p>
                  {(card.href || card.secondary) && (
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      {card.href && card.hrefLabel && (
                        <FixLink href={card.href} label={card.hrefLabel} accent={accent} testId="skipped-card-link" />
                      )}
                      {card.secondary && (
                        <FixLink href={card.secondary.href} label={card.secondary.label} accent={accent} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* every skipped employee, with the reason in the engine's words and how to fix it */}
          <section className="clay-card rounded-2xl border border-slate-100" data-testid="skipped-table-card">
            <header className="space-y-3 border-b border-slate-100 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h3 className="text-sm font-bold text-gray-900">Skipped Employees</h3>
                <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="skipped-showing">
                  {shown.length === rows.length
                    ? plural(rows.length, "employee")
                    : `${shown.length} of ${plural(rows.length, "employee")}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Filter skipped employees">
                <SearchField
                  value={filters.q}
                  onChange={(q) => patch({ q })}
                  placeholder="Search by name, code or reason"
                  label="Search skipped employees"
                  testId="skipped-search"
                  className="min-w-48 flex-1"
                />
                <FilterSelect
                  value={filters.category}
                  onChange={(category) => patch({ category })}
                  options={categoryOptions}
                  allLabel="All reasons"
                  label="Filter by reason"
                  testId="skipped-category"
                  className="w-full sm:w-56"
                />
                {active > 0 && (
                  <ResetButton count={active} onClick={() => setFilters(NO_SKIP_FILTERS)} testId="skipped-reset" />
                )}
                <ExportMenu
                  items={exportItems}
                  testId="skipped-export"
                  heading="Export the employees shown (every page)"
                  className="h-9 gap-2 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                />
              </div>
            </header>

            {shown.length === 0 ? (
              <div className="p-3">
                <EmptyNote
                  icon={SearchX}
                  title="Nothing matches these filters"
                  hint="Try a different search, or reset the filters to see every skipped employee."
                  testId="skipped-no-match"
                  action={
                    <Button type="button" variant="outline" onClick={() => setFilters(NO_SKIP_FILTERS)}>
                      Reset filters
                    </Button>
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] text-sm" data-testid="skipped-table">
                  <thead className="bg-gray-50 text-left text-xs font-semibold uppercase tracking-wide text-gray-500">
                    <tr>
                      <th className="px-3 py-2.5">Employee</th>
                      <th className="px-3 py-2.5">Code</th>
                      {hasDepartment && <th className="px-3 py-2.5">Department</th>}
                      <th className="px-3 py-2.5">Reason</th>
                      <th className="px-3 py-2.5">How to fix</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {page.rows.map((row) => (
                      <tr
                        key={row.employeeId}
                        className="align-top hover:bg-gray-50/60"
                        data-testid={`skipped-row-${row.employeeCode || row.employeeId}`}
                        data-category={row.info.category}
                      >
                        <td className="px-3 py-3 font-semibold text-gray-900">{row.name}</td>
                        <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{row.employeeCode || "—"}</td>
                        {hasDepartment && <td className="px-3 py-3 text-gray-700">{row.department || "—"}</td>}
                        <td className="max-w-xs px-3 py-3">
                          <p className="break-words text-gray-800" data-testid="skipped-reason">
                            {row.reason}
                          </p>
                          <div className="mt-1.5">
                            <Chip tone={row.info.tone} icon={CATEGORY_ICON[row.info.category]}>
                              {row.info.label}
                            </Chip>
                          </div>
                        </td>
                        <td className="max-w-sm px-3 py-3">
                          <p className="text-xs leading-snug text-gray-600" data-testid="skipped-fix">
                            {row.info.fix}
                          </p>
                          {(row.info.href || row.info.secondary) && (
                            <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                              {row.info.href && row.info.hrefLabel && (
                                <FixLink
                                  href={row.info.href}
                                  label={row.info.hrefLabel}
                                  accent={accent}
                                  testId="skipped-fix-link"
                                />
                              )}
                              {row.info.secondary && (
                                <FixLink
                                  href={row.info.secondary.href}
                                  label={row.info.secondary.label}
                                  accent={accent}
                                />
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="px-3">
              <DataPagination
                page={page.page}
                totalPages={page.totalPages}
                totalItems={page.total}
                pageSize={SKIPPED_PAGE_SIZE}
                onPageChange={(next) => setPageState({ key: viewKey, page: next })}
              />
            </div>
          </section>
        </>
      )}
    </Shell>
  );
}
