import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { ArrowUpRight, ChevronRight, Loader2, Save, SlidersHorizontal } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { useReportCatalog } from "@/lib/api-client/custom-hooks/reports";
import {
  customiseErrorMessage,
  useCreateCustomReport,
  useCustomDatasets,
  useSavedCustomReport,
  useUpdateCustomReport,
  type CustomSort,
} from "@/lib/api-client/custom-hooks/report-customise";
import { buildQuery, defaultValues, validateFilters, type FilterValue, type ReportCatalog } from "@/lib/report-center";
import { useLevel } from "@/lib/tab-access";
import { ReportFilterBar } from "../ReportFilterBar";
import { Banner, ErrorState, LoadingState } from "../ReportStates";
import {
  DESCRIPTION_MAX,
  NAME_MAX,
  draftForDataset,
  draftFromSaved,
  draftProblem,
  draftSignature,
  draftToInput,
  editReportHref,
  emptyDraft,
  hasDateFilter,
  openReportHref,
  previewQuery,
  type Draft,
  type DraftProblem,
} from "./builder-logic";
import { DataSourceStep } from "./DataSourceStep";
import { DatesChoice } from "./DatesChoice";
import { FieldsStep } from "./FieldsStep";
import { PreviewPanel } from "./PreviewPanel";
import { useUnsavedGuard } from "./useUnsavedGuard";
import "../report-workspace.css";

/** Where "Back to reports" goes: the catalog, narrowed to Customise. */
export const CUSTOMISE_CATALOG_HREF = "/hr/reports?cat=customise";

const NO_OPTIONS: ReportCatalog["options"] = { departments: [], designations: [], branches: [] };

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (delay <= 0) return;
    const t = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(t);
  }, [value, delay]);
  return delay <= 0 ? value : debounced;
}

function Step({
  n,
  title,
  hint,
  children,
  testId,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
  testId: string;
}) {
  const headingId = `custom-step-${n}`;
  return (
    <Card className="border-0 shadow-sm" data-testid={testId}>
      <CardContent className="space-y-3 p-4 sm:p-5">
        <section aria-labelledby={headingId} className="space-y-3">
          <div className="flex items-start gap-2.5">
            <span
              data-step-badge=""
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-50 text-xs font-black text-sky-700 ring-1 ring-sky-100"
            >
              {n}
            </span>
            <div className="min-w-0">
              <h3 id={headingId} className="text-sm font-black text-gray-900">
                {title}
              </h3>
              {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
            </div>
          </div>
          {children}
        </section>
      </CardContent>
    </Card>
  );
}

function FieldError({ problem, part }: { problem: DraftProblem | null; part: DraftProblem["part"] }) {
  if (!problem || problem.part !== part) return null;
  return (
    <p className="text-sm font-medium text-red-600" role="alert" data-testid={`problem-${part}`}>
      {problem.message}
    </p>
  );
}

/**
 * Report Center -> Customise: build a report from any HRMS data. Three steps on the left (data source, fields, filters),
 * the live preview on the right (below them on a phone), then name and save. A saved report is listed in the catalog's
 * Customise section and opens in the Report Center workspace like any other report (run, Excel, PDF).
 * `editId` is the saved report being changed (null: a new one); `previewDelay` is the debounce of the live preview.
 */
export function CustomReportBuilder({
  editId,
  onCreated,
  previewDelay = 400,
  today: todayProp,
}: {
  editId: number | null;
  /** A new report was saved and is about to move to its own address (/hr/reports/customise/<id>/edit). */
  onCreated?: (id: number) => void;
  previewDelay?: number;
  /** "Today" for relative periods (tests pin it). */
  today?: Date;
}) {
  const [today] = useState(() => todayProp ?? new Date());
  const level = useLevel()("reports.customise");
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const datasets = useCustomDatasets();
  const catalog = useReportCatalog();
  const saved = useSavedCustomReport(editId);
  const create = useCreateCustomReport();
  const update = useUpdateCustomReport();

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  /** What was last loaded or saved (the unsaved-changes check compares against it); null while a report is loading. */
  const [baseline, setBaseline] = useState<string | null>(() =>
    editId ? null : draftSignature(emptyDraft(), undefined),
  );
  /** The saved report this draft is (null until the first save of a new one). */
  const [savedId, setSavedId] = useState<number | null>(null);
  const [dropped, setDropped] = useState<string[]>([]);
  const [pendingDataset, setPendingDataset] = useState<string | null>(null);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const list = useMemo(() => datasets.data ?? [], [datasets.data]);
  const dataset = list.find((d) => d.id === draft.dataset);
  const item = editId ? saved.data : undefined;

  // An existing report: the draft is built once the report and the data sources are both here (not again after a save,
  // and not when the address changed to this report because it was just created here).
  useEffect(() => {
    if (!editId || savedId === editId || !saved.data || !datasets.data) return;
    const ds = datasets.data.find((d) => d.id === saved.data.dataset);
    const { draft: loaded, dropped: lost } = draftFromSaved(saved.data, ds, today);
    setDraft(loaded);
    setDropped(lost);
    setSavedId(editId);
    setBaseline(draftSignature(loaded, ds));
  }, [editId, savedId, saved.data, datasets.data, today]);

  const canSave = level === "edit" && (!item || item.canEdit);
  const saving = create.isPending || update.isPending;
  const dirty = baseline !== null && draftSignature(draft, dataset) !== baseline;
  const guard = useUnsavedGuard(dirty && canSave, { fallback: CUSTOMISE_CATALOG_HREF });

  const filterProblem = dataset ? validateFilters(dataset.filters, draft.values) : null;
  const liveQuery =
    dataset && draft.fields.length && !filterProblem
      ? previewQuery(dataset, draft.fields, draft.sort, draft.values)
      : null;
  const query = useDebouncedValue(liveQuery, previewDelay);
  const blocked = !dataset
    ? "Choose a data source to start."
    : !draft.fields.length
      ? "Pick at least one field to see the preview."
      : filterProblem
        ? `Fix the filters to see the preview: ${filterProblem}`
        : null;

  const change = (next: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...next }));
    setProblem(null);
    setServerError(null);
  };
  // Functional: the filter bar may change two filters in one go (a new employee type drops departments of the other).
  const setValue = (key: string, value: FilterValue) => {
    setDraft((d) => ({ ...d, values: { ...d.values, [key]: value } }));
    setProblem(null);
    setServerError(null);
  };

  // Switching data source replaces the fields and filters: asked first when the user has changed them.
  const untouched =
    !dataset ||
    (draft.fields.join(",") === dataset.defaultFields.join(",") &&
      draft.sort.length === 0 &&
      buildQuery(dataset.filters, draft.values).toString() ===
        buildQuery(dataset.filters, defaultValues(dataset.filters)).toString());
  const switchTo = (id: string) => {
    const next = list.find((d) => d.id === id);
    if (next) setDraft((d) => draftForDataset(d, next));
    setPendingDataset(null);
    setProblem(null);
  };
  const pickDataset = (id: string) => {
    if (id === draft.dataset) return setPendingDataset(null);
    if (untouched || !draft.fields.length) switchTo(id);
    else setPendingDataset(id);
  };

  const save = async () => {
    const found = draftProblem(draft, dataset, today);
    setProblem(found);
    setServerError(null);
    if (found || !dataset || !canSave) return;
    const body = draftToInput(draft, dataset, today);
    try {
      const result = savedId ? await update.mutateAsync({ id: savedId, body }) : await create.mutateAsync(body);
      // What was sent is now the saved state (anything typed while it was on its way still counts as a change).
      setBaseline(draftSignature(draft, dataset));
      setDropped([]);
      toast({ title: savedId ? "Changes saved" : "Report saved", description: result.name });
      if (!savedId) {
        // the unsaved-changes guard's extra history entry goes first, so the new address replaces this page's own
        // entry and Back from it leads where this page was opened from (not to an empty "new report")
        await guard.release();
        setSavedId(result.id);
        onCreated?.(result.id);
        navigate(editReportHref(result.id), { replace: true });
      }
    } catch (e) {
      setServerError(customiseErrorMessage(e) ?? "The report could not be saved. Please try again.");
    }
  };

  const title = editId || savedId ? "Edit custom report" : "Create a custom report";
  const header = (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        <Link href="/hr/reports" className="hover:text-gray-900 hover:underline">
          Reports
        </Link>
        <ChevronRight size={12} />
        <Link href={CUSTOMISE_CATALOG_HREF} className="hover:text-gray-900 hover:underline">
          Customise
        </Link>
        <ChevronRight size={12} />
        <span className="truncate">{draft.name.trim() || (editId ? "Saved report" : "New report")}</span>
      </div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* data-report-chip: the Clean theme paints it like the open report's chip (report-workspace.css) */}
          <span
            data-report-chip=""
            className="mt-0.5 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700 ring-1 ring-sky-100"
          >
            <SlidersHorizontal size={20} />
          </span>
          <div className="min-w-0">
            <h2 className="text-xl font-black text-gray-900 sm:text-2xl">{title}</h2>
            <p className="mt-0.5 max-w-3xl text-sm text-muted-foreground">
              Choose a data source, the fields you want as columns and the filters. The preview updates as you go; save
              it to find it under Customise and download it as Excel or PDF.
            </p>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href={CUSTOMISE_CATALOG_HREF}>Back to reports</Link>
        </Button>
      </div>
    </div>
  );

  // ── loading / failure of what the builder needs ──
  const loadError = datasets.isError ? datasets.error : editId && saved.isError ? saved.error : null;
  if (loadError) {
    return (
      <div className="space-y-5">
        {header}
        <ErrorState
          error={loadError}
          onRetry={() => {
            if (datasets.isError) void datasets.refetch();
            if (saved.isError) void saved.refetch();
          }}
        />
      </div>
    );
  }
  if (datasets.isLoading || (editId && savedId !== editId)) {
    return (
      <div className="space-y-5">
        {header}
        <LoadingState />
      </div>
    );
  }
  if (item && !dataset) {
    return (
      <div className="space-y-5">
        {header}
        <Banner tone="warning">
          This report reads from a data source your role cannot use ({item.datasetLabel || item.dataset}). Ask an
          administrator for access to it.
        </Banner>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="custom-report-builder">
      {header}

      {!canSave && (
        <Banner tone="info">
          View only: you can try fields and filters and see the preview, but not save. Saved reports open from the
          Customise section of the Report Center.
        </Banner>
      )}
      {dropped.length > 0 && (
        <Banner tone="warning">
          {dropped.length === 1 ? "One field" : `${dropped.length} fields`} of this report{" "}
          {dropped.length === 1 ? "is" : "are"} no longer offered by its data source and{" "}
          {dropped.length === 1 ? "was" : "were"} left out ({dropped.join(", ")}). Saving keeps the report without{" "}
          {dropped.length === 1 ? "it" : "them"}.
        </Banner>
      )}
      {!!item?.hiddenFields && (
        <Banner tone="info">
          This report also has {item.hiddenFields === 1 ? "one field" : `${item.hiddenFields} fields`} your role cannot
          see. {item.hiddenFields === 1 ? "It is" : "They are"} not shown here and stay in the report when you save.
        </Banner>
      )}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
        {/* the three steps, then name and save */}
        <div className="min-w-0 space-y-4">
          <Step n={1} title="Data source" hint="What one row of the report is about." testId="step-dataset">
            <DataSourceStep
              datasets={list}
              value={draft.dataset}
              pending={list.find((d) => d.id === pendingDataset) ?? null}
              onPick={pickDataset}
              onConfirm={() => pendingDataset && switchTo(pendingDataset)}
              onCancel={() => setPendingDataset(null)}
            />
            <FieldError problem={problem} part="dataset" />
          </Step>

          {dataset && (
            <Step
              n={2}
              title="Fields"
              hint="Tick the fields you want; they become the columns, in the order listed. Drag a row or use its arrows to reorder."
              testId="step-fields"
            >
              <FieldsStep
                dataset={dataset}
                fields={draft.fields}
                sort={draft.sort}
                onFields={(fields) => change({ fields })}
                onSort={(sort: CustomSort[]) => change({ sort })}
              />
              <FieldError problem={problem} part="fields" />
            </Step>
          )}

          {dataset && (
            <Step
              n={3}
              title="Filters"
              hint="Who and which period the report covers. Saved filters are where the report starts; they can be changed each time it is opened."
              testId="step-filters"
            >
              {dataset.filters.length > 0 ? (
                <div className="xl:[&>div]:grid-cols-2">
                  <ReportFilterBar
                    filters={dataset.filters}
                    values={draft.values}
                    onChange={setValue}
                    options={catalog.data?.options ?? NO_OPTIONS}
                  />
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This data source has no filters.</p>
              )}
              {hasDateFilter(dataset) && (
                <DatesChoice
                  dataset={dataset}
                  values={draft.values}
                  value={draft.dates}
                  onChange={(dates) => change({ dates })}
                  today={today}
                />
              )}
              {filterProblem && (
                <p className="text-sm font-medium text-red-600" role="alert">
                  {filterProblem}
                </p>
              )}
            </Step>
          )}

          {dataset && (
            <Step n={4} title="Name and save" testId="step-save">
              <div>
                <label htmlFor="custom-report-name" className="mb-1 block text-xs font-semibold text-gray-600">
                  Report name<span className="ml-0.5 text-red-500">*</span>
                </label>
                <Input
                  id="custom-report-name"
                  value={draft.name}
                  maxLength={NAME_MAX}
                  placeholder="e.g. Monthly Employee Performance Report"
                  onChange={(e) => change({ name: e.target.value })}
                  data-testid="custom-name"
                  className="h-9"
                />
              </div>
              <div>
                <label htmlFor="custom-report-description" className="mb-1 block text-xs font-semibold text-gray-600">
                  Description <span className="font-normal text-muted-foreground">(optional)</span>
                </label>
                <Textarea
                  id="custom-report-description"
                  value={draft.description}
                  maxLength={DESCRIPTION_MAX}
                  rows={2}
                  placeholder="What the report is for, who uses it"
                  onChange={(e) => change({ description: e.target.value })}
                  data-testid="custom-description"
                />
              </div>
              <FieldError problem={problem} part="name" />
              <FieldError problem={problem} part="filters" />
              {serverError && (
                <p className="text-sm font-medium text-red-600" role="alert" data-testid="save-error">
                  {serverError}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {canSave && (
                  <Button type="button" onClick={save} disabled={saving} data-testid="custom-save">
                    {saving ? <Loader2 className="animate-spin" /> : <Save />}
                    {saving ? "Saving…" : savedId ? "Save changes" : "Save report"}
                  </Button>
                )}
                {savedId && !dirty && (
                  <Button asChild variant="outline" data-testid="custom-open">
                    <Link href={openReportHref(savedId)}>
                      Open report <ArrowUpRight />
                    </Link>
                  </Button>
                )}
                <span className="text-xs text-muted-foreground" aria-live="polite" data-testid="save-status">
                  {dirty ? "Unsaved changes" : savedId ? "All changes saved" : ""}
                </span>
              </div>
            </Step>
          )}
        </div>

        {/* the preview: beside the steps on a wide screen, below them on a phone */}
        <div className="min-w-0 xl:sticky xl:top-2">
          <PreviewPanel query={query} waiting={query !== liveQuery} blocked={blocked} />
        </div>
      </div>

      <AlertDialog open={guard.pending !== null} onOpenChange={(open) => !open && guard.stay()}>
        <AlertDialogContent data-testid="unsaved-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              Your changes to this report have not been saved. If you leave now they are lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="unsaved-stay">Stay on this page</AlertDialogCancel>
            <AlertDialogAction data-testid="unsaved-leave" onClick={guard.leave}>
              Leave without saving
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
