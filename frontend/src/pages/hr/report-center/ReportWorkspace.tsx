import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight, FileSpreadsheet, FileText, Link2, Loader2, RotateCcw, Star, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PillTabs } from "@/components/ui/pill-tabs";
import { useToast } from "@/hooks/use-toast";
import { useRunReport } from "@/lib/api-client/custom-hooks";
import { carryFilters, variantsOf } from "@/lib/report-catalog";
import {
  buildQuery,
  defaultValues,
  parseQuery,
  validateFilters,
  type FilterValue,
  type FilterValues,
  type ReportCatalog,
  type ReportMeta,
  type ReportRunResult,
} from "@/lib/report-center";
import { downloadReportFile, ReportDownloadError, type ReportFileFormat } from "@/lib/report-download";
import { getLastQuery, pushRecent, setLastQuery, toggleFavorite, useReportPrefs } from "@/lib/report-prefs";
import { ReportFilterBar } from "./ReportFilterBar";
import { ReportTable } from "./ReportTable";
import { categoryStyle, iconFor } from "./report-icons";
import {
  AppliedFilters,
  Banner,
  EmptyState,
  ErrorState,
  IdleState,
  LoadingState,
  Notes,
  SummaryCards,
} from "./ReportStates";

type SetParams = (next: URLSearchParams, opts?: { replace?: boolean }) => void;

/** The applied filters live in the URL (shareable, survives reload): ?report=<id>&run=1&<filters>. */
export function appliedFromUrl(spec: ReportMeta, params: URLSearchParams) {
  const values = parseQuery(spec.filters, params);
  return { values, run: params.get("run") === "1", query: buildQuery(spec.filters, values).toString() };
}

function ResultsView({
  spec,
  data,
  stale,
  dirty,
}: {
  spec: ReportMeta;
  data: ReportRunResult;
  stale: boolean;
  dirty: boolean;
}) {
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
          You changed the filters. Press <b>Show report</b> to update the table. Downloads still use the filters shown
          above the table.
        </Banner>
      )}
      {data.truncated && (
        <Banner tone="warning">
          This report has more than {data.limit.toLocaleString("en-IN")} rows, so only the first{" "}
          {data.rowCount.toLocaleString("en-IN")} are shown and totals are hidden. Narrow the filters (dates,
          department, employees) to see everything.
        </Banner>
      )}
      {data.rows.length === 0 ? (
        <EmptyState filters={data.filters} />
      ) : (
        <ReportTable
          key={`${spec.id}:${data.generatedAt}`}
          columns={data.columns}
          rows={data.rows}
          totals={data.totals}
          dimmed={stale}
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

  const [draft, setDraft] = useState<FilterValues>(() => {
    // A fresh visit (no run in the URL) starts from what this person used last time.
    if (params.get("run") !== "1" && spec.filters.length) {
      const last = getLastQuery(spec.id);
      if (last) return parseQuery(spec.filters, new URLSearchParams(last));
    }
    return applied.values;
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<ReportFileFormat | null>(null);
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
    top.current?.scrollIntoView({ block: "start" });
  }, [spec.id]);

  const run = useRunReport(applied.run ? spec.id : null, applied.run ? applied.query : null);
  const draftQuery = buildQuery(spec.filters, draft).toString();
  const dirty = applied.run && draftQuery !== applied.query;
  // keepPreviousData may hold the previous REPORT's rows for a moment - never show those under this title.
  const data = run.data && run.data.id === spec.id ? run.data : undefined;
  const starred = favorites.includes(spec.id);
  const variants = variantsOf(catalog.reports, spec);
  const Icon = iconFor(spec.icon);
  const style = categoryStyle(spec.category);
  const category = catalog.categories.find((c) => c.id === spec.category);

  const show = useCallback(
    (replace = false) => {
      const problem = validateFilters(spec.filters, draft);
      setFormError(problem);
      if (problem) return;
      const next = new URLSearchParams(buildQuery(spec.filters, draft));
      next.set("report", spec.id);
      next.set("run", "1");
      setLastQuery(spec.id, buildQuery(spec.filters, draft).toString());
      setParams(next, { replace });
    },
    [spec, draft, setParams],
  );

  // Opening a report shows its records straight away when the default filters are valid (a heavy report
  // can still be narrowed afterwards); a report that needs a choice first waits for "Show report".
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current || applied.run) return;
    autoRan.current = true;
    if (validateFilters(spec.filters, draft) === null) show(true);
  }, [applied.run, spec.filters, draft, show]);

  const setValue = (key: string, value: FilterValue) => setDraft((d) => ({ ...d, [key]: value }));

  const switchVariant = (id: string) => {
    const target = catalog.reports.find((r) => r.id === id);
    if (!target || target.id === spec.id) return;
    const carried = carryFilters(spec, target, draft);
    const next = new URLSearchParams(buildQuery(target.filters, carried));
    next.set("report", target.id);
    if (applied.run) next.set("run", "1");
    setParams(next);
  };

  const download = async (format: ReportFileFormat) => {
    if (busy) return;
    setBusy(format);
    try {
      const name = await downloadReportFile({
        reportId: spec.id,
        title: spec.title,
        format,
        query: new URLSearchParams(applied.query),
      });
      toast({ title: `${format === "pdf" ? "PDF" : "Excel"} ready`, description: name });
    } catch (e) {
      toast({
        title: `Could not create the ${format === "pdf" ? "PDF" : "Excel"} file`,
        description: e instanceof ReportDownloadError || e instanceof Error ? e.message : "Please try again.",
        variant: "destructive",
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

  const canDownload = applied.run && !!data && !run.isFetching && data.rows.length > 0;

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
            <span
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
              className={starred ? "text-amber-500" : "text-gray-400"}
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
          {spec.filters.length > 0 && (
            <ReportFilterBar filters={spec.filters} values={draft} onChange={setValue} options={catalog.options} />
          )}
          {formError && (
            <p className="text-sm font-medium text-red-600" role="alert" data-testid="report-form-error">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              onClick={() => show()}
              disabled={run.isFetching && applied.run && !dirty}
              data-testid="report-show"
            >
              {run.isFetching && applied.run ? <Loader2 className="animate-spin" /> : <Play />}
              Show report
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setDraft(defaultValues(spec.filters));
                setFormError(null);
              }}
            >
              <RotateCcw /> Reset filters
            </Button>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {extraActions}
              <Button
                type="button"
                variant="outline"
                onClick={() => download("pdf")}
                disabled={!canDownload || busy !== null}
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
                disabled={!canDownload || busy !== null}
                className="border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                data-testid="report-download-xlsx"
              >
                {busy === "xlsx" ? <Loader2 className="animate-spin" /> : <FileSpreadsheet />}
                {busy === "xlsx" ? "Preparing Excel…" : "Download Excel"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* results */}
      {!applied.run ? (
        <IdleState />
      ) : run.isError && !run.isFetching ? (
        <ErrorState error={run.error} onRetry={() => run.refetch()} />
      ) : !data ? (
        <LoadingState />
      ) : (
        <ResultsView spec={spec} data={data} stale={run.isFetching} dirty={dirty} />
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
