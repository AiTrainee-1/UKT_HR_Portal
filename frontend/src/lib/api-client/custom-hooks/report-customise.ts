// report-customise: hooks/types for Report Center -> Customise, the report builder (/hr/reports/customise/new and
// /hr/reports/customise/<id>/edit) and the saved custom reports listed in the catalog's Customise section.
// Backend: api/reporting/custom/ (views + datasets). The server answers:
//
//   GET    /api/reports/custom/datasets                  {datasets: [{id, label, description, grain, filters, sections,
//                                                          defaultFields}]}; fields the role may not see are left out
//   GET    /api/reports/custom/preview?dataset=&fields=a,b&sort=key:asc&<filters>
//                                                         the same payload as /api/reports/run/<id>, rows capped at 200
//   GET    /api/reports/custom/saved                     {items: [saved report]} (a team library: everyone with view)
//   POST   /api/reports/custom/saved                     {name, description, dataset, fields, filters, sort} -> item (201)
//   GET    /api/reports/custom/saved/<id>                item
//   PUT    /api/reports/custom/saved/<id>                same body as POST -> item
//   DELETE /api/reports/custom/saved/<id>                204
//   POST   /api/reports/custom/saved/<id>/duplicate      the copy, named "<name> (copy)"
//
// A problem is 400 {error: "<code>", message, field?} (a field the role may not see: error "field_forbidden"). A saved
// report runs and exports through the ordinary Report Center endpoints as report "custom-<id>".
//
// Every answer is read leniently (read* below): a key an older or newer server leaves out shows as empty instead of
// crashing the builder.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";
import { getReportCatalogQueryKey } from "./reports";
import type { ReportFilter, ReportRunResult } from "@/lib/report-center";
import type { ColumnType } from "@/lib/report-format";

const BASE = "/api/reports/custom";

// ── types ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** How many rows a dataset gives: one per employee, per employee-day, per punch, per request or per payroll entry. */
export type CustomGrain = "employee" | "day" | "punch" | "request" | "payroll";

export type CustomField = {
  /** Stable key, e.g. "emp.code", "att.present_days", "pay.net". */
  key: string;
  label: string;
  type: ColumnType;
  /** The section id it is listed under. */
  section: string;
  description?: string;
};

export type CustomSection = { id: string; label: string; fields: CustomField[] };

export type CustomDataset = {
  id: string;
  label: string;
  description: string;
  grain: CustomGrain;
  /** Report Center filters (the same shape as a catalog report's). */
  filters: ReportFilter[];
  sections: CustomSection[];
  /** What a new report on this dataset starts with. */
  defaultFields: string[];
};

export type CustomSort = { key: string; dir: "asc" | "desc" };

/** Saved filter values in the Report Center's query-parameter format: {dateFrom, departmentIds: "3,4", ...}. */
export type SavedFilters = Record<string, string>;

export type SavedCustomReport = {
  id: number;
  /** "custom-<id>": the id the Report Center runs and exports it by. */
  reportId: string;
  name: string;
  description: string;
  dataset: string;
  datasetLabel: string;
  /** The fields this viewer may see, in report order. */
  fields: string[];
  /** Saved fields this viewer may not see: left out of `fields`, kept on the report when this viewer saves it. */
  hiddenFields: number;
  filters: SavedFilters;
  sort: CustomSort[];
  createdBy: string | null;
  createdAt: string | null;
  updatedBy: string | null;
  updatedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
};

export type SavedCustomReportInput = {
  name: string;
  description: string;
  dataset: string;
  fields: string[];
  filters: SavedFilters;
  sort: CustomSort[];
};

// ── lenient readers ───────────────────────────────────────────────────────────────────────────────────────────────────

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === "object" && !Array.isArray(v) ? (v as Raw) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v == null ? fallback : String(v));
const strOrNull = (v: unknown): string | null => (v == null || v === "" ? null : String(v));

const GRAINS: CustomGrain[] = ["employee", "day", "punch", "request", "payroll"];

export function readField(raw: unknown, section: string): CustomField | null {
  const r = obj(raw);
  const key = str(r.key);
  if (!key) return null;
  const field: CustomField = {
    key,
    label: str(r.label, key) || key,
    type: (str(r.type) || "text") as ColumnType,
    section: str(r.section) || section,
  };
  if (r.description) field.description = str(r.description);
  return field;
}

export function readDataset(raw: unknown): CustomDataset | null {
  const r = obj(raw);
  const id = str(r.id);
  if (!id) return null;
  const sections: CustomSection[] = arr(r.sections)
    .map((s) => {
      const so = obj(s);
      const sid = str(so.id);
      return {
        id: sid,
        label: str(so.label, sid) || sid,
        fields: arr(so.fields)
          .map((f) => readField(f, sid))
          .filter((f): f is CustomField => f !== null),
      };
    })
    .filter((s) => s.fields.length > 0);
  const grain = str(r.grain) as CustomGrain;
  return {
    id,
    label: str(r.label, id) || id,
    description: str(r.description),
    grain: GRAINS.includes(grain) ? grain : "employee",
    filters: arr(r.filters) as ReportFilter[],
    sections,
    defaultFields: arr(r.defaultFields)
      .map((k) => str(k))
      .filter(Boolean),
  };
}

export function readDatasets(raw: unknown): CustomDataset[] {
  return arr(obj(raw).datasets)
    .map(readDataset)
    .filter((d): d is CustomDataset => d !== null);
}

/** Saved filter values as strings ("3,4" for a list, "true" / "false" for a tick box). */
export function readSavedFilters(raw: unknown): SavedFilters {
  const out: SavedFilters = {};
  for (const [key, value] of Object.entries(obj(raw))) {
    if (value === null || value === undefined || value === "") continue;
    out[key] = Array.isArray(value) ? value.map(String).join(",") : String(value);
  }
  return out;
}

export function readSort(raw: unknown): CustomSort[] {
  return arr(raw)
    .map((s) => {
      const so = obj(s);
      const key = str(so.key);
      return key ? { key, dir: so.dir === "desc" ? "desc" : "asc" } : null;
    })
    .filter((s): s is CustomSort => s !== null);
}

export function readSavedReport(raw: unknown): SavedCustomReport | null {
  const r = obj(raw);
  const id = Number(r.id);
  if (!Number.isFinite(id) || id <= 0) return null;
  return {
    id,
    reportId: str(r.reportId) || `custom-${id}`,
    name: str(r.name) || `Custom report ${id}`,
    description: str(r.description),
    dataset: str(r.dataset),
    datasetLabel: str(r.datasetLabel) || str(r.dataset),
    fields: arr(r.fields)
      .map((k) => str(k))
      .filter(Boolean),
    hiddenFields: Math.max(0, Math.trunc(Number(r.hiddenFields) || 0)),
    filters: readSavedFilters(r.filters),
    sort: readSort(r.sort),
    createdBy: strOrNull(r.createdBy),
    createdAt: strOrNull(r.createdAt),
    updatedBy: strOrNull(r.updatedBy),
    updatedAt: strOrNull(r.updatedAt),
    canEdit: r.canEdit === true,
    canDelete: r.canDelete === true,
  };
}

export function readSavedReports(raw: unknown): SavedCustomReport[] {
  return arr(obj(raw).items)
    .map(readSavedReport)
    .filter((r): r is SavedCustomReport => r !== null);
}

/** The server's one-line reason for a refused request ({message} or {error}), or null. */
export function customiseErrorMessage(err: unknown): string | null {
  if (err instanceof ApiError) {
    const data = obj(err.data);
    return strOrNull(data.message) ?? (typeof data.error === "string" && data.error.includes(" ") ? data.error : null);
  }
  return null;
}

/** The error code of a refused request ("field_forbidden", "invalid_request" ...), or null. */
export function customiseErrorCode(err: unknown): string | null {
  return err instanceof ApiError ? strOrNull(obj(err.data).error) : null;
}

// ── queries ───────────────────────────────────────────────────────────────────────────────────────────────────────────

// A 4xx (no access, not deployed yet) will not fix itself on retry.
const retry4xx = (count: number, err: unknown) => !(err instanceof ApiError && err.status < 500) && count < 1;

export const getCustomDatasetsQueryKey = () => [`${BASE}/datasets`] as const;
export const getSavedCustomReportsQueryKey = () => [`${BASE}/saved`] as const;
export const getSavedCustomReportQueryKey = (id: number) => [`${BASE}/saved`, id] as const;
export const getCustomPreviewQueryKey = (query: string | null) => [`${BASE}/preview`, query] as const;

/** The data sources the builder offers, each with its filters and the fields this role may use. */
export const useCustomDatasets = () =>
  useQuery<CustomDataset[]>({
    queryKey: getCustomDatasetsQueryKey(),
    queryFn: async ({ signal }) => readDatasets(await customFetch<unknown>(`${BASE}/datasets`, { signal })),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: retry4xx,
  });

/** Every saved custom report (the team library). */
export const useSavedCustomReports = (opts: { enabled?: boolean } = {}) =>
  useQuery<SavedCustomReport[]>({
    queryKey: getSavedCustomReportsQueryKey(),
    queryFn: async ({ signal }) => readSavedReports(await customFetch<unknown>(`${BASE}/saved`, { signal })),
    enabled: opts.enabled ?? true,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: retry4xx,
  });

/** One saved custom report (the builder's edit page). */
export const useSavedCustomReport = (id: number | null) =>
  useQuery<SavedCustomReport>({
    queryKey: getSavedCustomReportQueryKey(id ?? 0),
    queryFn: async ({ signal }) => {
      const item = readSavedReport(await customFetch<unknown>(`${BASE}/saved/${id}`, { signal }));
      if (!item) throw new Error("The server sent a saved report the page cannot read.");
      return item;
    },
    enabled: id !== null && id > 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: retry4xx,
  });

/** The builder's live preview. `query` is the whole query string (dataset, fields, sort, filters); null = not yet. */
export const useCustomPreview = (query: string | null) =>
  useQuery<ReportRunResult>({
    queryKey: getCustomPreviewQueryKey(query),
    queryFn: ({ signal }) => customFetch<ReportRunResult>(`${BASE}/preview?${query ?? ""}`, { signal }),
    enabled: query !== null,
    // A bad filter or a forbidden field (400) is a fact, not a glitch: do not re-run it.
    retry: retry4xx,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

// ── mutations ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A saved report changes the library and the catalog (saved reports are listed there, category "customise"). The
 *  report's own runs (useRunReport, ["/api/reports/run", "custom-<id>", query]) are dropped too: they hold the old
 *  columns and count as fresh for a minute, so opening the report straight after an edit would show the old table. */
function useRefreshLibrary() {
  const qc = useQueryClient();
  return (item?: SavedCustomReport | null, changedId?: number) => {
    if (item) qc.setQueryData(getSavedCustomReportQueryKey(item.id), item);
    const id = changedId ?? item?.id;
    if (id !== undefined) qc.removeQueries({ queryKey: ["/api/reports/run", `custom-${id}`] });
    void qc.invalidateQueries({ queryKey: getSavedCustomReportsQueryKey(), exact: true });
    void qc.invalidateQueries({ queryKey: getReportCatalogQueryKey() });
  };
}

async function sendItem(url: string, method: "POST" | "PUT", body?: SavedCustomReportInput) {
  const answer = await customFetch<unknown>(url, { method, body: body ? JSON.stringify(body) : undefined });
  const item = readSavedReport(answer);
  if (!item) throw new Error("The server did not send the saved report back.");
  return item;
}

export const useCreateCustomReport = () => {
  const refresh = useRefreshLibrary();
  return useMutation<SavedCustomReport, unknown, SavedCustomReportInput>({
    mutationFn: (body) => sendItem(`${BASE}/saved`, "POST", body),
    onSuccess: (item) => refresh(item),
  });
};

export const useUpdateCustomReport = () => {
  const refresh = useRefreshLibrary();
  return useMutation<SavedCustomReport, unknown, { id: number; body: SavedCustomReportInput }>({
    mutationFn: ({ id, body }) => sendItem(`${BASE}/saved/${id}`, "PUT", body),
    onSuccess: (item) => refresh(item),
  });
};

export const useDuplicateCustomReport = () => {
  const refresh = useRefreshLibrary();
  return useMutation<SavedCustomReport, unknown, number>({
    mutationFn: (id) => sendItem(`${BASE}/saved/${id}/duplicate`, "POST"),
    onSuccess: (item) => refresh(item),
  });
};

export const useDeleteCustomReport = () => {
  const qc = useQueryClient();
  const refresh = useRefreshLibrary();
  return useMutation<number, unknown, number>({
    mutationFn: async (id) => {
      await customFetch<unknown>(`${BASE}/saved/${id}`, { method: "DELETE" });
      return id;
    },
    onSuccess: (id) => {
      // Gone at once from the list, before the refetch answers.
      qc.setQueryData<SavedCustomReport[]>(getSavedCustomReportsQueryKey(), (list) => list?.filter((r) => r.id !== id));
      qc.removeQueries({ queryKey: getSavedCustomReportQueryKey(id) });
      refresh(null, id);
    },
  });
};
