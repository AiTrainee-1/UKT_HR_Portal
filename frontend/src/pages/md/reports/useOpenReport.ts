import { useMemo } from "react";
import { useRunReport } from "@/lib/api-client/custom-hooks";
import type { ReportCatalog } from "@/lib/report-center";
import { appliedFromUrl } from "@/pages/hr/report-center/ReportWorkspace";

/**
 * The report named in the URL and its current result, read from the same query the workspace runs (the cache answers
 * both, so this adds no request): what the page needs to print it and to tell the assistant what is on screen.
 */
export function useOpenReport(catalog: ReportCatalog, reportId: string, params: URLSearchParams) {
  const spec = catalog.reports.find((r) => r.id === reportId);
  const paramsKey = params.toString();
  const applied = useMemo(
    () => (spec ? appliedFromUrl(spec, new URLSearchParams(paramsKey)) : null),
    [spec, paramsKey],
  );
  const run = useRunReport(spec && applied?.run ? spec.id : null, spec && applied?.run ? applied.query : null);
  // keepPreviousData may still hold the previous report's rows for a moment: never treat those as this report's.
  const data = spec && run.data && run.data.id === spec.id ? run.data : undefined;
  /** The same rule as the download buttons: a finished, non-empty result for the filters in the URL. */
  const canPrint = !!data && data.rows.length > 0 && !run.isFetching;
  return { spec, run, data, canPrint };
}
