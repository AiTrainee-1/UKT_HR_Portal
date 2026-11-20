import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import {
  ChevronRight,
  FileSpreadsheet,
  FileText,
  Link2,
  Loader2,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { useRunReport } from "@/lib/api-client/custom-hooks";
import { carryFilters, variantsOf } from "@/lib/report-catalog";
import {
  buildQuery,
  defaultValues,
  filterKeyForParam,
  hasFilterParams,
  parseQuery,
  rememberFilters,
  restoreFilters,
  validateFilters,
  type FilterValue,
  type FilterValues,
  type ReportCatalog,
  type ReportMeta,
  type ReportRunResult,
} from "@/lib/report-center";
import {
  downloadReportFile,
  exportBlockReason,
  ReportDownloadError,
  type ReportFileFormat,
} from "@/lib/report-download";
import { getLastFilters, pushRecent, setLastFilters, toggleFavorite, useReportPrefs } from "@/lib/report-prefs";
import { ReportFilterBar } from "./ReportFilterBar";
import { ReportTable, type TableView } from "./ReportTable";
import { categoryStyle, iconFor } from "./report-icons";
import {
  AppliedFilters,
  Banner,
  EmptyState,
  ErrorState,
  IdleState,
  LoadingState,
  Notes,
  RestoredNotice,
  SummaryCards,
  describeReportError,
} from "./ReportStates";
import "./report-workspace.css";

type SetParams = (next: URLSearchParams, opts?: { replace?: boolean }) => void;

/** The applied filters live in the URL (shareable, survives reload): ?report=<id>&run=1&<filters>. */
export function appliedFromUrl(spec: ReportMeta, params: URLSearchParams) {
  const values = parseQuery(spec.filters, params);
  return { values, run: params.get("run") === "1", query: buildQuery(spec.filters, values).toString() };
}

/**
 * Opening a report brings the page's own header (Browse reports, Refresh) into view with it: the box the page scrolls
 * in goes back to its top. Scrolling the workspace itself to the top, as it used to, hid that header on a phone. A
 * host page that scrolls the window has no such box: the workspace then scrolls itself into view.
 */
function scrollToPageTop(el: HTMLElement | null) {
  if (!el) return;
  for (let box = el.parentElement; box && box !== document.body; box = box.parentElement) {
    const overflow = getComputedStyle(box).overflowY;
    if (overflow === "auto" || overflow === "scroll") {
      if (typeof box.scrollTo === "function") box.scrollTo({ top: 0 });
      else box.scrollTop = 0;
      return;
    }
  }
  el.scrollIntoView?.({ block: "start" });
}

const dataRowsOf = (data: ReportRunResult) => data.rows.filter((r) => !r._kind).length;

function ResultsView({
  spec,
  data,
  stale,
  dirty,
  view,
  onViewChange,
}: {
  spec: ReportMeta;
  data: ReportRunResult;
  stale: boolean;
  dirty: boolean;
  view: TableView | null;
  onViewChange: (view: TableView) => void;
}) {
  const shown = dataRowsOf(data);
  const xlsx = spec.exportLimits?.xlsx;
  return (
    <div className="space-y-4">
      <SummaryCards cards={data.summary} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <AppliedFilters filters={data.filters} />
        <p className="text-[11px] text-muted-foreground">
          Generated {data.generatedAt} by {data.generatedBy}
        </p>
      </div>
      {dirty && (
        <Banner tone="info">
          You changed the filters. Press <b>Show report</b> to update the table; the downloads wait for it, so a file
          always matches what you see.
        </Banner>
      )}
      {data.truncated && (
        <Banner tone="warning">
          This report has more than {data.limit.toLocaleString("en-IN")} rows, so only the first{" "}
          {shown.toLocaleString("en-IN")} are shown and totals are hidden. Narrow the filters (dates, department,
          employees) to see everything
          {xlsx && xlsx > data.limit
            ? `, or download it as Excel, which holds up to ${xlsx.toLocaleString("en-IN")} rows.`
            : "."}
        </Banner>
      )}
      {data.rows.length === 0 ? (
        <EmptyState filters={data.filters} />
      ) : (
        <ReportTable
          key={spec.id}
          columns={data.columns}
          rows={data.rows}
          totals={data.totals}
          dimmed={stale}
          view={view}
          onViewChange={onViewChange}
        />
      )}
      <Notes notes={data.notes} />
    </div>
  );
}

function Workspace({
  catalog,
  spec,
  params,
  setParams,
  basePath,
  extraActions,
}: {
  catalog: ReportCatalog;
  spec: ReportMeta;
  params: URLSearchParams;
  setParams: SetParams;
  basePath: string;
  extraActions?: ReactNode;
}) {
  const { toast } = useToast();
  const top = useRef<HTMLDivElement>(null);
  const paramsKey = params.toString();
  const applied = useMemo(() => appliedFromUrl(spec, new URLSearchParams(paramsKey)), [spec, paramsKey]);

  // A plain open (from the catalog or the report list: no filters in the URL, not run yet) starts from what this person
  // used last time: who the report covers and how it is laid out, with months and dates worked out again for today
  // (lib/report-center.ts restoreFilters). A shared link or a variant switch keeps the filters it carries.
  const [opening] = useState(() => {
    if (params.get("run") === "1" || !spec.filters.length || hasFilterParams(spec.filters, params)) return null;
    const last = getLastFilters(spec.id);
    return last ? restoreFilters(spec.filters, last, new Date(), catalog.options) : null;
  });
  const [draft, setDraft] = useState<FilterValues>(() => opening?.values ?? applied.values);
  const [restored, setRestored] = useState<string[]>(() => opening?.restored ?? []);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReportFileFormat | null>(null);
  // On a phone the filter card folds into one line once a report is on screen; "Edit filters" opens it again.
  const [editing, setEditing] = useState(false);
  // The table's sort, search and page size live here (the workspace is keyed on the report), so they outlive a run
  // that showed no table at all: no rows, an error, a reload.
  const [tableView, setTableView] = useState<TableView | null>(null);
  const { favorites } = useReportPrefs();

  // Back / forward or a pasted link changes the URL: the form follows it (but not on first mount, which
  // would throw away the restored last-used filters).
  const lastKey = useRef(paramsKey);
  useEffect(() => {
    if (lastKey.current === paramsKey) return;
    lastKey.current = paramsKey;
    setDraft(applied.values);
    setFormError(null);
  }, [paramsKey, applied.values]);

  useEffect(() => {
    pushRecent(spec.id);
    scrollToPageTop(top.current);
  }, [spec.id]);

  const run = useRunReport(applied.run ? spec.id : null, applied.run ? applied.query : null);
  const refetch = run.refetch;
  const draftQuery = buildQuery(spec.filters, draft).toString();
  const dirty = applied.run && draftQuery !== applied.query;
  // keepPreviousData may hold the previous REPORT's rows for a moment - never show those under this title.
  const data = run.data && run.data.id === spec.id ? run.data : undefined;
  const starred = favorites.includes(spec.id);
  const variants = variantsOf(catalog.reports, spec);
  const Icon = iconFor(spec.icon);
  const style = categoryStyle(spec.category);
  const category = catalog.categories.find((c) => c.id === spec.category);

  const runWith = useCallback(
    (values: FilterValues, replace = false) => {
      const problem = validateFilters(spec.filters, values);
      setFormError(problem);
      if (problem) return;
      setEditing(false);
      setLastFilters(spec.id, rememberFilters(spec.filters, values, new Date()));
      const query = buildQuery(spec.filters, values).toString();
      // The same filters again would not change the URL, so nothing would load: fetch afresh instead (HR presses it
      // after approving something elsewhere and expects the new figures).
      if (applied.run && query === applied.query) {
        void refetch();
        return;
      }
      const next = new URLSearchParams(query);
      next.set("report", spec.id);
      next.set("run", "1");
      setParams(next, { replace });
    },
    [spec, applied.run, applied.query, refetch, setParams],
  );

  const show = () => {
    setRestored([]);
    runWith(draft);
  };

  // Opening a report shows its records straight away when the default filters are valid (a heavy report can still be
  // narrowed afterwards); a report that needs a choice first, or that the server marks autoRun=false, waits for "Show
  // report".
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || applied.run) return;
    autoRan.current = true;
    if (spec.autoRun === false) return;
    if (validateFilters(spec.filters, draft) === null) runWith(draft, true);
  }, [applied.run, spec.filters, spec.autoRun, draft, runWith]);

  const setValue = (key: string, value: FilterValue) => setDraft((d) => ({ ...d, [key]: value }));

  const resetRestored = () => {
    const defaults = defaultValues(spec.filters);
    setRestored([]);
    setDraft(defaults);
    setFormError(null);
    setLastFilters(spec.id, null);
    if (applied.run) runWith(defaults, true);
  };

  const switchVariant = (id: string) => {
    const target = catalog.reports.find((r) => r.id === id);
    if (!target || target.id === spec.id) return;
    const carried = carryFilters(spec, target, draft);
    const next = new URLSearchParams(buildQuery(target.filters, carried));
    next.set("report", target.id);
    if (applied.run) next.set("run", "1");
    setParams(next);
  };

  const dataRows = data ? dataRowsOf(data) : 0;
  // Downloads always match the table on screen: none while the filters are being edited (dirty) or a run is loading.
  const ready = applied.run && !!data && !run.isFetching && dataRows > 0 && !dirty;
  const pdfBlock = data ? exportBlockReason("pdf", dataRows, data.truncated, spec.exportLimits) : null;
  const xlsxBlock = data ? exportBlockReason("xlsx", dataRows, data.truncated, spec.exportLimits) : null;

  const download = async (format: ReportFileFormat) => {
    if (busy) return;
    setBusy(format);
    const kind = format === "pdf" ? "PDF" : "Excel";
    try {
      const name = await downloadReportFile({
        reportId: spec.id,
        title: spec.title,
        format,
        query: new URLSearchParams(applied.query),
      });
      toast({ title: `${kind} ready`, description: name });
    } catch (e) {
      // A PDF refused for its size (413 too_many_rows) can usually still be had as Excel, which holds far more rows.
      const offerExcel = format === "pdf" && e instanceof ReportDownloadError && e.status === 413 && !xlsxBlock;
      toast({
        title: `Could not create the ${kind} file`,
        description: e instanceof ReportDownloadError || e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
        action: offerExcel ? (
          <ToastAction altText="Download Excel instead" onClick={() => void download("xlsx")}>
            Download Excel instead
          </ToastAction>
        ) : undefined,
      });
    } finally {
      setBusy(null);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast({ title: "Link copied", description: "Anyone with access can open this report with the same filters." });
    } catch {
      toast({ title: "Could not copy the link", variant: "destructive" });
    }
  };

  // A refused run (400) names the filter at fault: it is highlighted until the filters are changed.
  const runError = run.isError && !run.isFetching ? describeReportError(run.error) : null;
  const invalidKey = runError && !dirty ? filterKeyForParam(spec.filters, runError.field) : null;
  const invalidLabel = invalidKey ? (spec.filters.find((f) => f.key === invalidKey)?.label ?? null) : null;

  const collapsed = applied.run && !!data && !dirty && !editing && !formError && !runError && spec.filters.length > 0;
  const summary = data?.filters.map((f) => `${f.label}: ${f.value}`).join(" · ") || "Default filters";
  const exportHint = ready ? (pdfBlock ?? xlsxBlock) : null;

  return (
    <div className="min-w-0 space-y-4" ref={top}>
      {/* header */}
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Link href={basePath} className="hover:text-gray-900 hover:underline">
            Reports
          </Link>
          <ChevronRight size={12} />
          <span>{category?.label ?? spec.category}</span>
        </div>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {/* data-report-chip: the Clean theme paints it like the catalog's chips (report-workspace.css) */}
            <span
              data-report-chip=""
              className={`mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1 ${style.chip} ${style.ring}`}
            >
              <Icon size={20} />
            </span>
            <div className="min-w-0">
              <h3 className="text-xl font-black text-gray-900">{spec.title}</h3>
              <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{spec.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={starred ? "Unstar this report" : "Star this report"}
              aria-pressed={starred}
              onClick={() => toggleFavorite(spec.id)}
              className={starred ? "text-amber-500" : "text-muted-foreground"}
            >
              <Star className={starred ? "fill-amber-400" : ""} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Copy link to this report"
              onClick={copyLink}
              disabled={!applied.run}
              className="text-gray-500"
            >
              <Link2 />
            </Button>
          </div>
        </div>
        {variants.length > 1 && (
          <div className="mt-3">
            <PillTabs
              size="sm"
              baseColor="#0f172a"
              pillBg="#f1f5f9"
              items={variants.map((v) => ({ value: v.id, label: v.variant ?? v.title }))}
              value={spec.id}
              onChange={switchVariant}
            />
          </div>
        )}
      </div>

      {/* filters */}
      <Card className="border-0 shadow-sm">
        <CardContent className="space-y-4 p-4 sm:p-5">
          <RestoredNotice labels={restored} onReset={resetRestored} />
          {collapsed && (
            <div className="flex items-center gap-2 sm:hidden" data-testid="report-filters-summary">
              <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 flex-1 truncate text-sm text-gray-700">{summary}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditing(true)}
                data-testid="report-edit-filters"
              >
                Edit filters
              </Button>
            </div>
          )}
          <div className={collapsed ? "hidden space-y-4 sm:block" : "space-y-4"} data-testid="report-filters-body">
            {spec.filters.length > 0 && (
              <ReportFilterBar
                filters={spec.filters}
                values={draft}
                onChange={setValue}
                options={catalog.options}
                invalidKey={invalidKey}
              />
            )}
            {formError && (
              <p className="text-sm font-medium text-red-600" role="alert" data-testid="report-form-error">
                {formError}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* folded on a phone, "Show report" stays (it fetches the same filters afresh); Reset needs the filters */}
            <Button
              type="button"
              onClick={show}
              disabled={run.isFetching && applied.run && !dirty}
              data-testid="report-show"
            >
              {run.isFetching && applied.run ? <Loader2 className="animate-spin" /> : <Play />}
              Show report
            </Button>
            <Button
              type="button"
              variant="ghost"
              className={collapsed ? "hidden sm:inline-flex" : undefined}
              onClick={() => {
                setDraft(defaultValues(spec.filters));
                setFormError(null);
              }}
              data-testid="report-reset"
            >
              <RotateCcw /> Reset filters
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {extraActions}
              <Button
                type="button"
                variant="outline"
                onClick={() => download("pdf")}
                disabled={!ready || busy !== null || !!pdfBlock}
                className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
                data-testid="report-download-pdf"
              >
                {busy === "pdf" ? <Loader2 className="animate-spin" /> : <FileText />}
                {busy === "pdf" ? "Preparing PDF…" : "Download PDF"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => download("xlsx")}
                disabled={!ready || busy !== null || !!xlsxBlock}
                className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                data-testid="report-download-xlsx"
              >
                {busy === "xlsx" ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
                {busy === "xlsx" ? "Preparing Excel…" : "Download Excel"}
              </Button>
            </div>
          </div>
          {exportHint && (
            <p className="text-xs text-amber-800" data-testid="report-export-hint">
              {exportHint}
            </p>
          )}
        </CardContent>
      </Card>

      {/* results */}
      {!applied.run ? (
        <IdleState waiting={spec.autoRun === false} />
      ) : runError ? (
        <ErrorState error={run.error} onRetry={() => void refetch()} filterLabel={invalidLabel} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <ResultsView
          spec={spec}
          data={data}
          stale={run.isFetching}
          dirty={dirty}
          view={tableView}
          onViewChange={setTableView}
        />
      )}
    </div>
  );
}

/**
 * One report: header, filters, actions and results. Remounts per report (fresh draft, fresh table state).
 * `basePath` is the page that hosts the Report Center, for the links back to it (the MD portal embeds it under
 * /md/reports); `extraActions` adds buttons in front of the download buttons (the MD's Print).
 */
export function ReportWorkspace({
  reportId,
  params,
  setParams,
  catalog,
  basePath = "/hr/reports",
  extraActions,
}: {
  reportId: string;
  params: URLSearchParams;
  setParams: SetParams;
  catalog: ReportCatalog;
  basePath?: string;
  extraActions?: ReactNode;
}) {
  const spec = catalog.reports.find((r) => r.id === reportId);
  if (!spec) {
    return (
      <Card className="border-0 shadow-sm">
        <CardContent className="space-y-3 p-8 text-center">
          <p className="text-base font-semibold text-gray-800">This report is not available</p>
          <p className="text-sm text-muted-foreground">
            It may not exist, or your role does not have access to the data in it.
          </p>
          <Link href={basePath} className="inline-block text-sm font-semibold text-sky-700 hover:underline">
            Browse all reports
          </Link>
        </CardContent>
      </Card>
    );
  }
  return (
    <Workspace
      key={spec.id}
      catalog={catalog}
      spec={spec}
      params={params}
      setParams={setParams}
      basePath={basePath}
      extraActions={extraActions}
    />
  );
}
