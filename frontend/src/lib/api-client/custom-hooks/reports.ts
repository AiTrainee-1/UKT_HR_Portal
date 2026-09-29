// reports: Report Center hooks (catalog, run, employee picker). Backend: api/reporting/views.py.
// Downloads are not hooks - see @/lib/report-download.
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";
import type { ReportCatalog, ReportRunResult } from "@/lib/report-center";

export const getReportCatalogQueryKey = () => ["/api/reports/catalog"] as const;

/** Everything the current user may run, plus the department/designation/branch option lists. */
export const useReportCatalog = () =>
  useQuery<ReportCatalog>({
    queryKey: getReportCatalogQueryKey(),
    queryFn: ({ signal }) => customFetch<ReportCatalog>("/api/reports/catalog", { signal }),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    // A 4xx (no access, not deployed yet) will not fix itself on retry.
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
  });

export const getReportRunQueryKey = (reportId: string | null, query: string | null) =>
  ["/api/reports/run", reportId, query] as const;

/** Runs a report. `query` is the applied filter query string; `null` means "not run yet". */
export const useRunReport = (reportId: string | null, query: string | null) =>
  useQuery<ReportRunResult>({
    queryKey: getReportRunQueryKey(reportId, query),
    queryFn: ({ signal }) =>
      customFetch<ReportRunResult>(`/api/reports/run/${encodeURIComponent(reportId ?? "")}?${query ?? ""}`, { signal }),
    enabled: !!reportId && query !== null,
    // A bad filter (400) or a forbidden report (403) is a fact, not a glitch: do not re-run it.
    retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 1,
    refetchOnWindowFocus: false,
    staleTime: 60_000,
    placeholderData: keepPreviousData,
  });

export type EmployeeOption = { value: number; label: string; sub: string; status: string };

export const getReportEmployeeOptionsQueryKey = (q: string, departmentIds: string, ids: string) =>
  ["/api/reports/options/employees", q, departmentIds, ids] as const;

/** Server-side employee search for the report filter picker (branch-scoped). `ids` resolves chip labels. */
export const useReportEmployeeOptions = (opts: {
  q?: string;
  departmentIds?: string[];
  ids?: string[];
  enabled?: boolean;
}) => {
  const q = opts.q ?? "";
  const dept = (opts.departmentIds ?? []).join(",");
  const ids = (opts.ids ?? []).join(",");
  return useQuery<EmployeeOption[]>({
    queryKey: getReportEmployeeOptionsQueryKey(q, dept, ids),
    queryFn: ({ signal }) => {
      const p = new URLSearchParams();
      if (ids) p.set("ids", ids);
      else {
        if (q) p.set("q", q);
        if (dept) p.set("departmentIds", dept);
      }
      return customFetch<EmployeeOption[]>(`/api/reports/options/employees?${p.toString()}`, { signal });
    },
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    placeholderData: keepPreviousData,
  });
};
