import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleAlert,
  ClipboardList,
  FileSpreadsheet,
  FileText,
  Info,
  SearchX,
  Users,
} from "lucide-react";
import { exportTableToCsv, exportTableToExcel } from "@/components/payroll/kit/export-table";
import type { ExportItem } from "@/components/payroll/kit/ExportMenu";
import { dateTime, fileStem, plural } from "@/components/payroll/kit/format";
import { SEVERITY_META, issueIcon } from "@/components/payroll/kit/issue-meta";
import { EmptyNote, KpiTile, SkeletonKpis, SkeletonRows } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { DataPagination } from "@/components/ui/DataPagination";
import { Skeleton } from "@/components/ui/skeleton";
import {
  usePayrollIssues,
  usePayrollSettings,
  type IssueSeverity,
  type PayrollIssue,
  type PayrollListFilters,
  type PayrollScope,
} from "@/lib/api-client/custom-hooks";
import { TONE } from "@/lib/statusTones";
import { cn } from "@/lib/utils";
import { VIEW_SAFE_ATTR } from "@/lib/view-only-lock";
import type { SkippedItem } from "../skipped/skipped-types";
import { DateGroupView, EmployeeGroupView, TypeGroupView } from "./IssueGroups";
import { IssuesToolbar } from "./IssuesToolbar";
import {
  DEFAULT_ISSUE_FILTERS,
  NO_DEPARTMENT,
  activeFilterCount,
  describeIssueFilters,
  filterIssues,
  groupIssues,
  issueDepartments,
  issueExportColumns,
  issueTypeCounts,
  mergeSkipped,
  normalizeGroupBy,
  paginateGroups,
  sanitizeFilters,
  severityTypeNames,
  showingText,
  summarizeIssues,
  typeLabelMap,
  wholePeriodHiddenByRange,
  PAGE_SIZE,
  type IssueFilterState,
} from "./issues-logic";
import { errorDetail } from "./lists";
import { FALLBACK_COMPANY, LoadError, type FilterOption, type PanelAccent } from "./panel-kit";

export type IssuesPanelProps = {
  /** The month (staff) or the pay period of one cycle (production) the issues are about. */
  scope: PayrollScope;
  /** Narrowing the server applies (a department, an employee, a branch). */
  filters?: PayrollListFilters;
  /** Staff Payroll is indigo, Production Payroll amber. */
  accent: PanelAccent;
  /** Employees payroll skipped, added to the list as issues of code "skipped". */
  skipped?: SkippedItem[];
  /**
   * The filters, when the page owns them (it keeps them in its address so Back from a details page returns to the same
   * view). Without it the panel keeps its own.
   */
  value?: IssueFilterState;
  /** Called with what changed whenever a filter or the grouping changes (controlled or not). */
  onChange?: (patch: Partial<IssueFilterState>) => void;
  /** Opens the details page of the payroll an issue belongs to. Skipped employees have none: they open the employee. */
  onOpenDetails: (issue: PayrollIssue) => void;
};

const NONE: PayrollIssue[] = [];
const SEVERITIES: IssueSeverity[] = ["critical", "warning", "info"];

/** The colour of a type's icon when its chip is not selected. */
const SEVERITY_ICON: Record<IssueSeverity, string> = {
  critical: "text-red-500",
  warning: "text-amber-500",
  info: "text-sky-500",
};

const CHIP_BASE =
  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4" data-testid="issues-panel" {...{ [VIEW_SAFE_ATTR]: "" }}>
      {children}
    </div>
  );
}

function IssuesSkeleton() {
  return (
    <div className="space-y-4" role="status" aria-label="Loading issues" data-testid="issues-loading">
      <SkeletonKpis count={4} className="md:grid-cols-4 xl:grid-cols-4" />
      <Skeleton className="h-28 w-full rounded-2xl" />
      <SkeletonRows rows={5} />
    </div>
  );
}

function AllClear({ label }: { label: string }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-emerald-200 bg-emerald-50/40 px-6 py-12 text-center"
      data-testid="issues-all-clear"
    >
      <CheckCircle2 size={32} className="text-emerald-500" />
      <p className="text-sm font-semibold text-gray-800">No issues detected for this period</p>
      <p className="max-w-md text-xs text-muted-foreground">
        Payroll found nothing to flag{label ? ` for ${label}` : ""}.
      </p>
    </div>
  );
}

/** Issues are detected from generated payroll: with none yet there is nothing checked, which is not the same as all clear. */
function NoPayroll({ label }: { label: string }) {
  return (
    <EmptyNote
      icon={ClipboardList}
      title="No payroll has been generated for this period yet"
      hint={`Issues are detected from the payroll that has been generated${label ? ` for ${label}` : ""}. Generate payroll first, and they will appear here.`}
      testId="issues-no-payroll"
    />
  );
}

export function IssuesPanel({ scope, filters, accent, skipped, value, onChange, onOpenDetails }: IssuesPanelProps) {
  const query = usePayrollIssues(scope, filters);
  const { data: settings } = usePayrollSettings();
  const data = query.data;

  // The filters: the page's when it passes them, else the panel's own.
  const [inner, setInner] = useState<IssueFilterState>(DEFAULT_ISSUE_FILTERS);
  const { q, code, severity, dept, from, to, groupBy } = value ?? inner;
  const state = useMemo(
    () => sanitizeFilters({ q, code, severity, dept, from, to, groupBy }),
    [q, code, severity, dept, from, to, groupBy],
  );
  const by = normalizeGroupBy(state.groupBy);

  const patch = (change: Partial<IssueFilterState>) => {
    if (value === undefined) setInner((prev) => ({ ...prev, ...change }));
    onChange?.(change);
  };
  const reset = () => patch({ q: "", code: "", severity: "", dept: "", from: "", to: "" });

  // What payroll detected plus who it skipped, then what the filters keep, arranged and cut into a page.
  const all = useMemo(() => mergeSkipped(data?.issues ?? NONE, skipped), [data?.issues, skipped]);
  const byCode = data?.summary?.byCode;
  const labels = useMemo(() => typeLabelMap(byCode), [byCode]);
  const types = useMemo(() => issueTypeCounts(all, byCode), [all, byCode]);
  const totals = useMemo(() => summarizeIssues(all), [all]);
  const departments = useMemo(() => issueDepartments(all), [all]);
  const visible = useMemo(() => filterIssues(all, state), [all, state]);
  const groups = useMemo(() => groupIssues(visible, by, labels), [visible, by, labels]);

  // The page number belongs to the view it was chosen in: a new filter, grouping or period starts again at page 1.
  const viewKey = [
    JSON.stringify(scope),
    JSON.stringify(filters ?? null),
    state.q,
    state.code,
    state.severity,
    state.dept,
    state.from,
    state.to,
    by,
  ].join("|");
  const [pageState, setPageState] = useState({ key: viewKey, page: 1 });
  const wantedPage = pageState.key === viewKey ? pageState.page : 1;
  const page = useMemo(() => paginateGroups(groups, by, wantedPage, PAGE_SIZE), [groups, by, wantedPage]);
  const listTop = useRef<HTMLDivElement>(null);
  const goToPage = (next: number) => {
    setPageState({ key: viewKey, page: next });
    listTop.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  // Which employees' accordions are open (by employee).
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set());
  const toggleOpen = (id: number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pageEmployees = page.groups.flatMap((g) => (g.group.employeeId === null ? [] : [g.group.employeeId]));
  const allOpen = pageEmployees.length > 0 && pageEmployees.every((id) => open.has(id));
  const setAll = (opened: boolean) =>
    setOpen((prev) => {
      const next = new Set(prev);
      for (const id of pageEmployees) {
        if (opened) next.add(id);
        else next.delete(id);
      }
      return next;
    });

  if (query.isLoading || (!data && !query.isError)) {
    return (
      <Shell>
        <IssuesSkeleton />
      </Shell>
    );
  }
  if (!data) {
    return (
      <Shell>
        <LoadError
          what="the issues"
          detail={errorDetail(query.error)}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          testId="issues-error"
        />
      </Shell>
    );
  }

  const activeCount = activeFilterCount(state);
  const scopeLabel = data.scope?.label ?? "";
  const hiddenByRange = wholePeriodHiddenByRange(all, state);
  const kind = scope.kind;

  // ── Export: the issues shown (every page), in the order shown ──
  const company = settings?.companyName || FALLBACK_COMPANY;
  const exportRows = groups.flatMap((g) => g.issues);
  const exportName = fileStem(...(kind === "production" ? ["Production"] : []), "Payroll", "Issues", scopeLabel);
  const exportTitle = `${kind === "production" ? "Production payroll" : "Payroll"} issues`;
  const filterWords = describeIssueFilters(state, labels);
  const exportSubtitle = [
    kind === "production" ? "Production Payroll" : "Staff Payroll",
    scopeLabel,
    filterWords.length > 0 ? `Filtered: ${filterWords.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const columns = issueExportColumns(labels);
  const countText = `${plural(exportRows.length, "issue")}${activeCount > 0 ? ", filtered" : ""}`;
  const exportItems: ExportItem[] = [
    {
      key: "excel",
      label: "Excel (.xlsx)",
      hint: `${countText}, one sheet`,
      icon: FileSpreadsheet,
      disabled: exportRows.length === 0,
      run: () =>
        exportTableToExcel({
          rows: exportRows,
          columns,
          filename: exportName,
          sheetName: "Issues",
          company,
          subtitle: exportSubtitle,
          title: exportTitle,
        }),
    },
    {
      key: "csv",
      label: "CSV",
      hint: `${countText}, plain text`,
      icon: FileText,
      disabled: exportRows.length === 0,
      run: () => exportTableToCsv({ rows: exportRows, columns, filename: exportName }),
    },
  ];

  const severityOptions: FilterOption[] = SEVERITIES.map((s) => ({
    value: s,
    label: `${SEVERITY_META[s].label} (${totals.bySeverity[s]})`,
  }));
  const typeOptions: FilterOption[] = types.map((t) => ({ value: t.code, label: `${t.label} (${t.count})` }));
  const departmentOptions: FilterOption[] = [
    ...departments.names.map((name) => ({ value: name, label: name })),
    ...(departments.hasNone ? [{ value: NO_DEPARTMENT, label: "No department" }] : []),
  ];

  const pickSeverity = (s: IssueSeverity) => patch({ severity: state.severity === s ? "" : s });
  const common = { labels, accent, onOpenDetails };

  return (
    <Shell>
      <div>
        <h3 className="text-sm font-bold text-gray-900">Detected issues{scopeLabel ? ` · ${scopeLabel}` : ""}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Everything payroll flagged, with the day it was detected and what it cost.
          {data.detectedAt ? ` Payroll last computed ${dateTime(data.detectedAt)}.` : ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="issues-kpis">
        <KpiTile
          testId="issues-kpi-critical"
          label={SEVERITY_META.critical.label}
          value={totals.bySeverity.critical}
          sub={severityTypeNames(types, "critical")}
          icon={CircleAlert}
          tone="bg-red-50 text-red-800"
          onClick={() => pickSeverity("critical")}
          active={state.severity === "critical"}
        />
        <KpiTile
          testId="issues-kpi-warning"
          label={SEVERITY_META.warning.label}
          value={totals.bySeverity.warning}
          sub={severityTypeNames(types, "warning")}
          icon={AlertTriangle}
          tone="bg-amber-50 text-amber-800"
          onClick={() => pickSeverity("warning")}
          active={state.severity === "warning"}
        />
        <KpiTile
          testId="issues-kpi-info"
          label={SEVERITY_META.info.label}
          value={totals.bySeverity.info}
          sub={severityTypeNames(types, "info")}
          icon={Info}
          tone="bg-sky-50 text-sky-800"
          onClick={() => pickSeverity("info")}
          active={state.severity === "info"}
        />
        <KpiTile
          testId="issues-kpi-employees"
          label="Employees affected"
          value={totals.employees}
          sub={data.summary ? `${data.summary.employees} with payroll in this period` : undefined}
          icon={Users}
          tone="bg-slate-100 text-slate-800"
        />
      </div>

      {all.length === 0 ? (
        data.summary?.employees === 0 ? (
          <NoPayroll label={scopeLabel} />
        ) : (
          <AllClear label={scopeLabel} />
        )
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-2"
            role="group"
            aria-label="Quick filter by issue type"
            data-testid="issues-types"
          >
            <button
              type="button"
              aria-pressed={state.code === ""}
              onClick={() => patch({ code: "" })}
              className={cn(
                CHIP_BASE,
                state.code === ""
                  ? "border-slate-800 bg-slate-800 text-white"
                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
              )}
              data-testid="issues-type-all"
            >
              All types <span className="tabular-nums opacity-70">{totals.total}</span>
            </button>
            {types.map((t) => {
              const Icon = issueIcon(t.code);
              const on = state.code === t.code;
              return (
                <button
                  key={t.code}
                  type="button"
                  aria-pressed={on}
                  onClick={() => patch({ code: on ? "" : t.code })}
                  className={cn(
                    CHIP_BASE,
                    on
                      ? cn(TONE[SEVERITY_META[t.severity].tone], "shadow-sm ring-2 ring-current/40")
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50",
                  )}
                  data-testid={`issues-type-${t.code}`}
                >
                  <Icon size={13} className={on ? undefined : SEVERITY_ICON[t.severity]} />
                  {t.label} <span className="tabular-nums opacity-70">{t.count}</span>
                </button>
              );
            })}
          </div>

          <IssuesToolbar
            state={state}
            patch={patch}
            activeCount={activeCount}
            onReset={reset}
            severityOptions={severityOptions}
            typeOptions={typeOptions}
            departmentOptions={departmentOptions}
            bounds={data.scope ? { start: data.scope.start, end: data.scope.end } : undefined}
            exportItems={exportItems}
            accent={accent}
          />

          <div ref={listTop} className="scroll-mt-24 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <p className="text-xs text-muted-foreground" aria-live="polite" data-testid="issues-showing">
                {[
                  showingText(page, by, visible.length) || "No issues match",
                  activeCount > 0 ? `${plural(all.length, "issue")} in this period` : null,
                  hiddenByRange > 0 ? `${plural(hiddenByRange, "whole-period issue")} hidden by the date range` : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {by === "employee" && page.total > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => setAll(!allOpen)}
                  data-testid="issues-expand-all"
                >
                  {allOpen ? "Collapse all" : "Expand all"}
                </Button>
              )}
            </div>

            {visible.length === 0 ? (
              <EmptyNote
                icon={SearchX}
                title="Nothing matches these filters"
                hint="Try a different search, or clear the filters to see every issue of the period."
                testId="issues-no-match"
                action={
                  <Button type="button" variant="outline" onClick={reset} data-testid="issues-no-match-reset">
                    Reset filters
                  </Button>
                }
              />
            ) : (
              <div className="space-y-5" data-testid="issues-list" data-group-by={by}>
                {page.groups.map((paged) =>
                  by === "date" ? (
                    <DateGroupView key={paged.group.key} paged={paged} {...common} />
                  ) : by === "type" ? (
                    <TypeGroupView key={paged.group.key} paged={paged} {...common} />
                  ) : (
                    <EmployeeGroupView
                      key={paged.group.key}
                      paged={paged}
                      open={paged.group.employeeId !== null && open.has(paged.group.employeeId)}
                      onToggle={() => paged.group.employeeId !== null && toggleOpen(paged.group.employeeId)}
                      {...common}
                    />
                  ),
                )}
              </div>
            )}
          </div>

          <DataPagination
            page={page.page}
            totalPages={page.totalPages}
            totalItems={page.total}
            pageSize={PAGE_SIZE}
            onPageChange={goToPage}
          />
        </>
      )}
    </Shell>
  );
}
