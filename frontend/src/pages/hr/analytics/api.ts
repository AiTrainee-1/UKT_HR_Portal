// HR Analytics: the page's data hooks. They live here (not in lib/api-client) because only this page reads them.

import { keepPreviousData, useQuery, type QueryClient } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";
import type {
  AnalyticsSummary,
  CategoryDetail,
  CategoryEmployee,
  CategoryMeta,
  EmployeeDetail,
  EmployeeHit,
  Pattern,
  Period,
} from "./types";

export const ANALYTICS_KEY = "/api/hr-analytics";

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

// The answers are read defensively: a list the server left out is an empty list, so a partial answer never breaks the page.

const EMPTY_PERIOD: Period = { from: "", to: "", days: 0, months: 0, label: "", dataGaps: [] };

const pattern = (p: Partial<Pattern> | null | undefined): Pattern => ({
  ...(p ?? {}),
  byWeekday: p?.byWeekday ?? {},
  longestStreak: p?.longestStreak ?? 0,
  lastDate: p?.lastDate ?? null,
  note: p?.note ?? null,
});

const hit = (e: Partial<EmployeeHit>): EmployeeHit => ({
  id: e.id ?? 0,
  code: e.code ?? "",
  name: e.name ?? "",
  department: e.department ?? null,
  departmentId: e.departmentId ?? null,
  designation: e.designation ?? null,
  branch: e.branch ?? null,
  photoUrl: e.photoUrl ?? null,
  type: e.type ?? "staff",
  counts: e.counts ?? {},
  flags: e.flags ?? [],
  level: e.level ?? "ok",
  score: e.score ?? 0,
  lastDate: e.lastDate ?? null,
});

export function normalizeSummary(raw: Partial<AnalyticsSummary> | null | undefined): AnalyticsSummary {
  const r = raw ?? {};
  return {
    type: r.type ?? "staff",
    period: { ...EMPTY_PERIOD, ...(r.period ?? {}), dataGaps: r.period?.dataGaps ?? [] },
    categories: (r.categories ?? []) as CategoryMeta[],
    employees: (r.employees ?? []).map(hit),
    weekly: r.weekly ?? [],
    departments: r.departments ?? [],
    hods: r.hods ?? [],
    totals: { employeesInScope: 0, employeesWithIssues: 0, needingAttention: 0, high: 0, ...(r.totals ?? {}) },
    options: { departments: r.options?.departments ?? [] },
  };
}

export function normalizeCategory(raw: Partial<CategoryDetail>): CategoryDetail {
  return {
    category: raw.category as CategoryMeta,
    period: { ...EMPTY_PERIOD, ...(raw.period ?? {}) },
    employees: (raw.employees ?? []).map((e): CategoryEmployee => ({
      ...hit(e as Partial<EmployeeHit>),
      count: e.count ?? 0,
      flagged: !!e.flagged,
      level: e.level ?? "ok",
      lastDate: e.lastDate ?? null,
      pattern: pattern(e.pattern),
      records: e.records ?? [],
    })),
  };
}

export function normalizeEmployee(raw: Partial<EmployeeDetail>): EmployeeDetail {
  const categories: EmployeeDetail["categories"] = {};
  for (const [key, c] of Object.entries(raw.categories ?? {})) {
    categories[key] = {
      category: c.category,
      count: c.count ?? 0,
      flagged: !!c.flagged,
      records: c.records ?? [],
      pattern: pattern(c.pattern),
    };
  }
  return {
    employee: hit((raw.employee ?? {}) as Partial<EmployeeHit>),
    period: { ...EMPTY_PERIOD, ...(raw.period ?? {}) },
    level: raw.level ?? "ok",
    score: raw.score ?? 0,
    counts: raw.counts ?? {},
    flags: raw.flags ?? [],
    categories,
    timeline: raw.timeline ?? [],
  };
}

/** Everything the page shows for the filters: cards, charts, the attention list and the HOD view. */
export function useAnalyticsSummary(params: Record<string, string>) {
  return useQuery<AnalyticsSummary>({
    queryKey: [ANALYTICS_KEY, "summary", params],
    queryFn: async ({ signal }) =>
      normalizeSummary(
        await customFetch<Partial<AnalyticsSummary>>(`${ANALYTICS_KEY}/summary?${qs(params)}`, { signal }),
      ),
    // a filter change keeps the old figures on screen (dimmed) instead of flashing the loaders
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });
}

const categoryQuery = (key: string, params: Record<string, string>) => ({
  queryKey: [ANALYTICS_KEY, "category", key, params] as const,
  queryFn: async ({ signal }: { signal?: AbortSignal }) =>
    normalizeCategory(
      await customFetch<Partial<CategoryDetail>>(`${ANALYTICS_KEY}/category/${encodeURIComponent(key)}?${qs(params)}`, {
        signal,
      }),
    ),
  staleTime: 60_000,
});

/** One category's employees with every record (the category drill-down). */
export function useAnalyticsCategory(key: string | null, params: Record<string, string>) {
  return useQuery<CategoryDetail>({ ...categoryQuery(key ?? "", params), enabled: !!key });
}

/** The categories for an export: shared with the drill-down's cache, so an opened one is not fetched twice. */
export function fetchCategories(
  client: QueryClient,
  keys: string[],
  params: Record<string, string>,
): Promise<CategoryDetail[]> {
  return Promise.all(keys.map((key) => client.fetchQuery(categoryQuery(key, params))));
}

const employeeQuery = (id: number, params: Record<string, string>) => ({
  queryKey: [ANALYTICS_KEY, "employee", id, params] as const,
  queryFn: async ({ signal }: { signal?: AbortSignal }) =>
    normalizeEmployee(
      await customFetch<Partial<EmployeeDetail>>(`${ANALYTICS_KEY}/employee/${id}?${qs(params)}`, { signal }),
    ),
  staleTime: 60_000,
});

/** One employee in full: every category, every record, the patterns (the employee drill-down). */
export function useAnalyticsEmployee(id: number | null, params: Record<string, string>) {
  return useQuery<EmployeeDetail>({ ...employeeQuery(id ?? 0, params), enabled: id !== null });
}

/** The server's own words for a refusal ("from must be before to"), else a plain sentence. */
export function errorText(err: unknown): string {
  const data = (err as { data?: { error?: unknown } } | null)?.data;
  if (data && typeof data.error === "string" && data.error) return data.error;
  const status = (err as { status?: number } | null)?.status;
  if (status === 404) return "Not found in your scope for this period.";
  if (status === 403) return "Your role cannot see this.";
  return "Check your connection and try again.";
}
