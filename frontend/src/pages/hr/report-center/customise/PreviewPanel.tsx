import type { ReactNode } from "react";
import { Eye, Loader2, ShieldAlert } from "lucide-react";
import {
  customiseErrorCode,
  customiseErrorMessage,
  useCustomPreview,
} from "@/lib/api-client/custom-hooks/report-customise";
import { Banner, EmptyState, ErrorState, LoadingState, Notes, SummaryCards } from "../ReportStates";
import { ReportTable } from "../ReportTable";

/** Rows the preview endpoint sends at most (the saved report itself has no such cap). */
export const PREVIEW_ROWS = 200;

function Placeholder({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-xl border-2 border-dashed border-gray-200 bg-white/60 px-6 py-14 text-center"
      data-testid="preview-placeholder"
    >
      <Eye className="mx-auto mb-3 h-9 w-9 text-gray-300" />
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}

/**
 * The live preview: the report as it would run now, first 200 rows, refreshed (debounced by the builder) whenever the
 * data source, fields, sort or filters change. `query` is null while there is nothing to preview; `blocked` says why.
 */
export function PreviewPanel({
  query,
  waiting,
  blocked,
}: {
  query: string | null;
  /** The builder has a newer query that the debounce has not let through yet. */
  waiting: boolean;
  blocked: string | null;
}) {
  const preview = useCustomPreview(query);
  const data = query ? preview.data : undefined;
  const busy = waiting || preview.isFetching;
  const forbidden = customiseErrorCode(preview.error) === "field_forbidden";
  const rowCount = data ? data.rows.filter((r) => !r._kind).length : 0;

  let body: ReactNode;
  if (blocked) {
    body = <Placeholder>{blocked}</Placeholder>;
  } else if (preview.isError && !preview.isFetching) {
    body = forbidden ? (
      <div
        className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800"
        role="alert"
        data-testid="preview-forbidden"
      >
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          <p className="text-sm font-semibold">A field is not available to your role</p>
          <p className="mt-0.5 text-sm">
            {customiseErrorMessage(preview.error) ?? "Remove it from the chosen fields to see the preview."}
          </p>
        </div>
      </div>
    ) : (
      <ErrorState
        error={preview.error}
        onRetry={() => preview.refetch()}
        hint="Change the fields or filters; the preview updates by itself."
      />
    );
  } else if (!data) {
    body = <LoadingState />;
  } else {
    body = (
      <div className="space-y-3" data-testid="preview-result">
        <SummaryCards cards={data.summary ?? []} />
        {data.truncated && (
          <Banner tone="info">
            The preview shows the first {PREVIEW_ROWS} rows. The saved report shows every row, and its Excel and PDF
            downloads too.
          </Banner>
        )}
        {data.rows.length === 0 ? (
          <EmptyState filters={data.filters ?? []} />
        ) : (
          <ReportTable
            key={data.columns.map((c) => c.key).join("|")}
            columns={data.columns}
            rows={data.rows}
            totals={data.totals}
            dimmed={busy}
          />
        )}
        <Notes notes={data.notes ?? []} />
      </div>
    );
  }

  return (
    <section aria-labelledby="custom-preview-heading" className="min-w-0 space-y-3" data-testid="custom-preview">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="custom-preview-heading" className="text-base font-black text-gray-900">
            Live preview
          </h3>
          <p className="text-xs text-muted-foreground">Updates as you change the fields and filters.</p>
        </div>
        <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-500" aria-live="polite">
          {busy && !blocked ? (
            <>
              <Loader2 size={13} className="animate-spin" /> Updating…
            </>
          ) : data && !blocked ? (
            `${rowCount.toLocaleString("en-IN")} row${rowCount === 1 ? "" : "s"}`
          ) : null}
        </p>
      </div>
      {body}
    </section>
  );
}
