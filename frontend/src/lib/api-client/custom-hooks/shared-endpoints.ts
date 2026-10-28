// shared-endpoints: the Settings -> Endpoint Sharing tab's API (backend/api/shared_endpoint_admin_views.py). Super admin only
// (every route answers 403 to anybody else). An "endpoint" publishes SELECTED fields of one dataset to the owner's other
// applications at GET /api/shared/<slug>, read with an API key. Everything here is the MANAGEMENT side: the public call
// itself is never made from the portal.
//
// The shapes below are the contract of the spec (section 3 to 5). The readers are forgiving about wrappers (`{endpoints: [...]}`
// or a bare array) so a small difference in the envelope does not blank the page, but the field names are exact.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, customFetch } from "../custom-fetch";

export type SharedFieldType = "string" | "integer" | "number" | "boolean" | "date" | "datetime" | "time";
/** basic = organisation data; personal = phone, e-mail, birth date, address; financial = salary and payroll amounts. */
export type SharedSensitivity = "basic" | "personal" | "financial";

export type SharedCatalogField = {
  key: string;
  label: string;
  type: SharedFieldType;
  sensitivity: SharedSensitivity;
  description: string;
};

/** enum = one of a few words (`values`); boolean = the words true / false; month = YYYY-MM; year = YYYY; the rest are what they say. */
export type SharedFilterType = "enum" | "integer" | "string" | "date" | "month" | "year" | "boolean";

export type SharedCatalogFilter = {
  key: string;
  label: string;
  type: SharedFilterType;
  required: boolean;
  description: string;
  /** When the filter takes one of a few words (active | inactive | all). Empty for every other type. */
  values: string[];
  /** What the filter is when the caller sends nothing (a locked filter overrides it). */
  default: string | null;
};

export type SharedDataset = {
  key: string;
  label: string;
  description: string;
  fields: SharedCatalogField[];
  filters: SharedCatalogFilter[];
  maxPageSize: number;
  defaultOrdering: string | null;
};

export type SharedLimits = { maxEndpoints: number; maxOriginsPerEndpoint: number; maxLiveKeysPerEndpoint: number };

export type SharedCatalog = {
  datasets: SharedDataset[];
  /** What can never be shared from any dataset, as plain sentences for the screen. */
  hardExcluded: string[];
  limits: SharedLimits;
};

/** One row of the endpoint list. */
export type SharedEndpointSummary = {
  id: number;
  slug: string;
  name: string;
  description: string;
  dataset: string;
  datasetLabel: string;
  enabled: boolean;
  fieldCount: number;
  originCount: number;
  liveKeyCount: number;
  calls24h: number;
  lastCallAt: string | null;
  updatedAt: string | null;
};

/** One endpoint, as the editor opens it. */
export type SharedEndpoint = {
  id: number;
  slug: string;
  name: string;
  description: string;
  dataset: string;
  datasetLabel: string;
  /** In response order. */
  fields: string[];
  lockedFilters: Record<string, string>;
  origins: string[];
  allowNoOrigin: boolean;
  pageSizeDefault: number;
  pageSizeMax: number;
  rateLimitPerMinute: number;
  enabled: boolean;
  /** A fingerprint a save sends back as `expectedVersion`, so a copy somebody else outdated is refused. */
  version: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  liveKeyCount: number;
};

/** What a create or a save sends. `slug` and `dataset` are only sent when creating (they never change afterwards). */
export type SharedEndpointInput = {
  slug?: string;
  dataset?: string;
  name: string;
  description: string;
  fields: string[];
  /** Filter key -> its value as text (the server reads numbers and dates from the text). */
  lockedFilters: Record<string, string>;
  origins: string[];
  allowNoOrigin: boolean;
  pageSizeDefault: number;
  pageSizeMax: number;
  rateLimitPerMinute: number;
  enabled: boolean;
  /** True only after the person confirmed the personal / financial fields that are newly shared. */
  acknowledgeSensitive?: boolean;
  expectedVersion?: string;
};

export type SharedKeyStatus = "active" | "revoked" | "expired";

/** Which employees' data a key may read. A key made before categories existed has none (`null`): it reads everything. */
export type SharedKeyCategory = "staff" | "production";

export type SharedKey = {
  id: number;
  label: string;
  /** The first characters after `uks_`: all the screen ever shows of a key. */
  prefix: string;
  createdAt: string | null;
  createdBy: string | null;
  expiresAt: string | null;
  /** True for a key that never expires (it works until it is revoked). */
  permanent: boolean;
  /** The data the key is limited to, or null for an older key that reads both categories. */
  category: SharedKeyCategory | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  status: SharedKeyStatus;
};

/** The answer to creating a key: `key` is the whole secret, shown this one time and never again. */
export type SharedKeyCreated = SharedKey & { key: string };

export type SharedPreview = {
  rows: Record<string, unknown>[];
  fields: string[];
  total: number | null;
  /** The filters the preview really used (the server fills a recent period in for a required one nobody gave). */
  filters: Record<string, string>;
};

export type SharedActivityRow = {
  id: number;
  at: string;
  status: number;
  rows: number | null;
  origin: string | null;
  ip: string | null;
  durationMs: number | null;
  error: string | null;
  keyLabel: string | null;
  keyPrefix: string | null;
  endpointId: number | null;
  /** The address of the endpoint that was called (kept in the log even after it is deleted). */
  endpointSlug: string | null;
};

export type SharedActivity = {
  rows: SharedActivityRow[];
  page: number;
  pageSize: number;
  total: number;
  hasMore: boolean;
};

export type SharedGuideHeader = { name: string; value: string; required: boolean; description: string };
export type SharedGuideParameter = {
  name: string;
  type: string;
  required: boolean;
  default: string | null;
  /** The words an `enum` parameter accepts. */
  values: string[];
  description: string;
  example: string | null;
};
export type SharedGuideField = {
  name: string;
  type: string;
  label: string;
  description: string;
  sensitivity: SharedSensitivity;
  sample: unknown;
};
export type SharedGuideError = { status: number; code: string; meaning: string };
export type SharedGuideExample = { language: string; label: string; code: string };

/** The per-endpoint integration documentation, generated by the server from what is saved; the screen only draws it. */
export type SharedGuide = {
  baseUrl: string;
  url: string;
  method: string;
  headers: SharedGuideHeader[];
  parameters: SharedGuideParameter[];
  /** Filters the endpoint has locked: the caller cannot change them. */
  lockedFilters: { name: string; value: string }[];
  pagination: { defaultPageSize: number; maxPageSize: number; rateLimitPerMinute: number } | null;
  responseFields: SharedGuideField[];
  sampleResponse: unknown;
  errors: SharedGuideError[];
  examples: SharedGuideExample[];
  /** The websites that may call it from a browser, and whether server-to-server calls are accepted. */
  origins: string[];
  allowNoOrigin: boolean;
  notes: string[];
};

export type SharedActivityQuery = { page: number; status: string };

const PATH = "/api/shared-endpoints";
export const SHARED_ENDPOINTS_PATH = PATH;

export const getSharedCatalogQueryKey = () => [`${PATH}/catalog`] as const;
export const getSharedEndpointsQueryKey = () => [PATH] as const;
export const getSharedEndpointQueryKey = (id: number) => [`${PATH}/${id}`] as const;
export const getSharedKeysQueryKey = (id: number) => [`${PATH}/${id}/keys`] as const;
export const getSharedGuideQueryKey = (id: number) => [`${PATH}/${id}/guide`] as const;
export const getSharedActivityQueryKey = (id: number, query?: SharedActivityQuery) =>
  query ? ([`${PATH}/${id}/activity`, query] as const) : ([`${PATH}/${id}/activity`] as const);

// ── reading what the server sends, tolerantly ──

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown, fallback = false): boolean => (typeof v === "boolean" ? v : fallback);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const list = (v: unknown, ...wrappers: string[]): unknown[] => {
  if (Array.isArray(v)) return v;
  if (isObj(v)) for (const key of wrappers) if (Array.isArray(v[key])) return v[key] as unknown[];
  return [];
};
const first = <T>(...values: (T | undefined)[]): T | undefined => values.find((v) => v !== undefined);

const FIELD_TYPES: SharedFieldType[] = ["string", "integer", "number", "boolean", "date", "datetime", "time"];
const fieldType = (v: unknown): SharedFieldType =>
  FIELD_TYPES.includes(v as SharedFieldType) ? (v as SharedFieldType) : "string";
const FILTER_TYPES: SharedFilterType[] = ["enum", "integer", "string", "date", "month", "year", "boolean"];
const filterType = (v: unknown): SharedFilterType =>
  FILTER_TYPES.includes(v as SharedFilterType) ? (v as SharedFilterType) : "string";
const sensitivity = (v: unknown): SharedSensitivity => (v === "personal" || v === "financial" ? v : "basic");

export const DEFAULT_LIMITS: SharedLimits = {
  maxEndpoints: 100,
  maxOriginsPerEndpoint: 20,
  maxLiveKeysPerEndpoint: 10,
};

export function readCatalog(raw: unknown): SharedCatalog {
  const root = isObj(raw) ? raw : {};
  const datasets = list(root.datasets ?? raw, "datasets")
    .filter(isObj)
    .map((d) => ({
      key: str(d.key),
      label: str(d.label, str(d.key)),
      description: str(d.description),
      fields: list(d.fields)
        .filter(isObj)
        .map((f) => ({
          key: str(f.key),
          label: str(f.label, str(f.key)),
          type: fieldType(f.type),
          sensitivity: sensitivity(f.sensitivity),
          description: str(f.description),
        })),
      filters: list(d.filters)
        .filter(isObj)
        .map((f) => ({
          key: str(f.key),
          label: str(f.label, str(f.key)),
          type: filterType(f.type),
          required: bool(f.required),
          description: str(f.description),
          values: strings(f.values),
          default: typeof f.default === "string" ? f.default : typeof f.default === "number" ? String(f.default) : null,
        })),
      maxPageSize: num(d.maxPageSize, 200),
      defaultOrdering: strOrNull(d.defaultOrdering),
    }));
  const excluded = first<unknown>(root.hardExcluded, root.excluded, root.neverShared);
  const limits = isObj(root.limits) ? root.limits : {};
  return {
    datasets,
    hardExcluded:
      typeof excluded === "string"
        ? excluded
            .split(/\r?\n|;\s*/)
            .map((s) => s.trim())
            .filter(Boolean)
        : strings(excluded),
    limits: {
      maxEndpoints: num(limits.maxEndpoints, DEFAULT_LIMITS.maxEndpoints),
      maxOriginsPerEndpoint: num(limits.maxOriginsPerEndpoint, DEFAULT_LIMITS.maxOriginsPerEndpoint),
      maxLiveKeysPerEndpoint: num(limits.maxLiveKeysPerEndpoint, DEFAULT_LIMITS.maxLiveKeysPerEndpoint),
    },
  };
}

const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : num(v));

function readSummary(raw: Json): SharedEndpointSummary {
  return {
    id: num(raw.id),
    slug: str(raw.slug),
    name: str(raw.name),
    description: str(raw.description),
    dataset: str(raw.dataset),
    datasetLabel: str(raw.datasetLabel, str(raw.dataset)),
    enabled: bool(raw.enabled, true),
    fieldCount: raw.fieldCount !== undefined ? num(raw.fieldCount) : countOf(raw.fields),
    originCount: raw.originCount !== undefined ? num(raw.originCount) : countOf(raw.origins),
    liveKeyCount: num(first(raw.liveKeyCount, raw.liveKeys, raw.keyCount)),
    calls24h: num(first(raw.calls24h, raw.calls24Hours, raw.callsToday)),
    lastCallAt: strOrNull(first(raw.lastCallAt, raw.lastCall)),
    updatedAt: strOrNull(raw.updatedAt),
  };
}

export function readEndpoint(raw: unknown): SharedEndpoint {
  const r = isObj(raw) ? (isObj(raw.endpoint) ? raw.endpoint : raw) : {};
  const locked: Record<string, string> = {};
  if (isObj(r.lockedFilters)) {
    for (const [k, v] of Object.entries(r.lockedFilters)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") locked[k] = String(v);
    }
  }
  return {
    id: num(r.id),
    slug: str(r.slug),
    name: str(r.name),
    description: str(r.description),
    dataset: str(r.dataset),
    datasetLabel: str(r.datasetLabel, str(r.dataset)),
    fields: strings(r.fields),
    lockedFilters: locked,
    origins: strings(r.origins),
    allowNoOrigin: bool(r.allowNoOrigin, true),
    pageSizeDefault: num(r.pageSizeDefault, 50),
    pageSizeMax: num(r.pageSizeMax, 200),
    rateLimitPerMinute: num(r.rateLimitPerMinute, 60),
    enabled: bool(r.enabled, true),
    version: strOrNull(r.version),
    createdAt: strOrNull(r.createdAt),
    updatedAt: strOrNull(r.updatedAt),
    createdBy: strOrNull(r.createdBy),
    liveKeyCount: num(first(r.liveKeyCount, r.liveKeys, r.keyCount)),
  };
}

export function keyStatus(
  k: { revokedAt: string | null; expiresAt: string | null },
  now = Date.now(),
): SharedKeyStatus {
  if (k.revokedAt) return "revoked";
  if (k.expiresAt && Date.parse(k.expiresAt) <= now) return "expired";
  return "active";
}

export function readKey(raw: unknown): SharedKey {
  const r = isObj(raw) ? raw : {};
  const base = {
    id: num(r.id),
    label: str(r.label),
    prefix: str(r.prefix),
    createdAt: strOrNull(r.createdAt),
    createdBy: strOrNull(r.createdBy),
    expiresAt: strOrNull(r.expiresAt),
    revokedAt: strOrNull(r.revokedAt),
    lastUsedAt: strOrNull(r.lastUsedAt),
    lastUsedIp: strOrNull(r.lastUsedIp),
  };
  const category = r.category === "staff" || r.category === "production" ? r.category : null;
  return { ...base, permanent: base.expiresAt === null, category, status: keyStatus(base) };
}

export function readPreview(raw: unknown): SharedPreview {
  const r = isObj(raw) ? raw : {};
  const rows = list(r.data ?? r.rows ?? raw, "data", "rows").filter(isObj);
  const meta = isObj(r.meta) ? r.meta : {};
  const fields = strings(meta.fields).length > 0 ? strings(meta.fields) : strings(r.fields);
  return {
    rows,
    fields: fields.length > 0 ? fields : rows[0] ? Object.keys(rows[0]) : [],
    total: numOrNull(meta.total ?? r.total),
    filters: isObj(meta.filters)
      ? Object.fromEntries(Object.entries(meta.filters).map(([k, v]) => [k, String(v)]))
      : {},
  };
}

export function readActivity(raw: unknown): SharedActivity {
  const r = isObj(raw) ? raw : {};
  const rows = list(r.results ?? r.rows ?? r.items ?? r.data ?? raw, "results", "rows", "items", "data")
    .filter(isObj)
    .map((a) => ({
      id: num(a.id),
      at: str(a.at, str(a.createdAt)),
      status: num(a.status),
      rows: numOrNull(a.rows),
      origin: strOrNull(a.origin),
      ip: strOrNull(a.ip),
      durationMs: numOrNull(a.durationMs),
      error: strOrNull(a.error),
      keyLabel: strOrNull(a.keyLabel),
      keyPrefix: strOrNull(a.keyPrefix),
      endpointId: numOrNull(a.endpointId),
      endpointSlug: strOrNull(a.endpointSlug),
    }));
  const total = num(r.total, rows.length);
  const page = num(r.page, 1);
  const pageSize = num(r.pageSize, rows.length || 50);
  return { rows, page, pageSize, total, hasMore: bool(r.hasMore, page * pageSize < total) };
}

const LANGUAGE_LABELS: Record<string, string> = {
  curl: "curl",
  javascript: "JavaScript",
  python: "Python",
  php: "PHP",
  csharp: "C#",
  node: "Node",
};
export const GUIDE_LANGUAGES = ["curl", "javascript", "python", "php", "csharp", "node"] as const;

export function readGuide(raw: unknown): SharedGuide {
  const r = isObj(raw) ? (isObj(raw.guide) ? raw.guide : raw) : {};
  const rawExamples = r.examples;
  const examples: SharedGuideExample[] = [];
  if (Array.isArray(rawExamples)) {
    for (const e of rawExamples.filter(isObj)) {
      const language = str(e.language, str(e.key)).toLowerCase();
      examples.push({ language, label: str(e.label, LANGUAGE_LABELS[language] ?? language), code: str(e.code) });
    }
  } else if (isObj(rawExamples)) {
    for (const [language, code] of Object.entries(rawExamples)) {
      if (typeof code === "string") examples.push({ language, label: LANGUAGE_LABELS[language] ?? language, code });
    }
  }
  const response = isObj(r.response) ? r.response : {};
  const schemaRows = list(response.fields ?? r.responseFields).filter(isObj);
  const access = isObj(r.access) ? r.access : {};
  const pagination = isObj(r.pagination) ? r.pagination : null;
  return {
    baseUrl: str(r.baseUrl),
    url: str(r.url),
    method: str(r.method, "GET"),
    headers: list(r.headers)
      .filter(isObj)
      .map((h) => ({
        name: str(h.name),
        value: str(h.value),
        required: bool(h.required, true),
        description: str(h.description),
      })),
    parameters: list(r.parameters)
      .filter(isObj)
      .map((p) => ({
        name: str(p.name),
        type: str(p.type, "string"),
        required: bool(p.required),
        default: p.default === undefined || p.default === null ? null : String(p.default),
        values: strings(p.values),
        description: str(p.description),
        example: p.example === undefined || p.example === null ? null : String(p.example),
      })),
    lockedFilters: list(r.lockedFilters)
      .filter(isObj)
      .map((l) => ({ name: str(l.name), value: String(l.value ?? "") })),
    pagination: pagination
      ? {
          defaultPageSize: num(pagination.defaultPageSize, 50),
          maxPageSize: num(pagination.maxPageSize, 200),
          rateLimitPerMinute: num(pagination.rateLimitPerMinute, 60),
        }
      : null,
    responseFields: schemaRows.map((f) => ({
      name: str(f.name, str(f.key)),
      type: str(f.type, "string"),
      label: str(f.label, str(f.name)),
      description: str(f.description),
      sensitivity: sensitivity(f.sensitivity),
      sample: f.sample ?? f.example ?? null,
    })),
    sampleResponse: response.sample ?? r.sampleResponse ?? null,
    errors: list(r.errors)
      .filter(isObj)
      .map((e) => ({
        status: num(e.status),
        code: str(e.code, str(e.error)),
        meaning: str(e.meaning, str(e.message, str(e.description))),
      })),
    examples,
    origins: strings(access.origins),
    allowNoOrigin: bool(access.allowNoOrigin, true),
    notes: strings(access.notes).length > 0 ? strings(access.notes) : strings(r.notes),
  };
}

// ── hooks ──

/** What a datasets catalogue read says when the backend is not there yet or the person is not a super admin. */
export const isNotSuperAdminError = (err: unknown): boolean => err instanceof ApiError && err.status === 403;

/** True when the server refused a save because somebody else saved after this editor was opened. */
export const isStaleEndpointError = (err: unknown): boolean => {
  if (!(err instanceof ApiError) || err.status !== 400) return false;
  const code = (err.data as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.includes("stale");
};

/** The datasets, their fields and filters, and what is never shared. Changes only with a release. */
export const useSharedCatalog = (enabled = true) =>
  useQuery<SharedCatalog>({
    queryKey: getSharedCatalogQueryKey(),
    queryFn: async () => readCatalog(await customFetch<unknown>(`${PATH}/catalog`)),
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

export const useSharedEndpoints = (enabled = true) =>
  useQuery<SharedEndpointSummary[]>({
    queryKey: getSharedEndpointsQueryKey(),
    queryFn: async () =>
      list(await customFetch<unknown>(PATH), "endpoints", "results", "items")
        .filter(isObj)
        .map(readSummary),
    enabled,
    retry: false,
  });

export const useSharedEndpoint = (id: number | null) =>
  useQuery<SharedEndpoint>({
    queryKey: getSharedEndpointQueryKey(id ?? 0),
    queryFn: async () => readEndpoint(await customFetch<unknown>(`${PATH}/${id}`)),
    enabled: id !== null,
    retry: false,
  });

/** After any change the list (its counts) and the one endpoint are read again. */
function useRefresh() {
  const queryClient = useQueryClient();
  return (id?: number) => {
    void queryClient.invalidateQueries({ queryKey: getSharedEndpointsQueryKey() });
    if (id !== undefined) {
      void queryClient.invalidateQueries({ queryKey: getSharedEndpointQueryKey(id) });
      void queryClient.invalidateQueries({ queryKey: getSharedGuideQueryKey(id) });
    }
  };
}

/** Creates an endpoint (nothing is shared until a key is made too) and returns it as saved. */
export const useCreateSharedEndpoint = () => {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (body: SharedEndpointInput) =>
      readEndpoint(await customFetch<unknown>(PATH, { method: "POST", body: JSON.stringify(body) })),
    onSuccess: (saved) => {
      queryClient.setQueryData(getSharedEndpointQueryKey(saved.id), saved);
      refresh();
    },
  });
};

/** Saves the whole endpoint (all or nothing) and returns it as it now is. */
export const useUpdateSharedEndpoint = (id: number) => {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: async (body: SharedEndpointInput) => {
      const answer = await customFetch<unknown>(`${PATH}/${id}`, { method: "PUT", body: JSON.stringify(body) });
      const looksSaved = isObj(answer) && (typeof answer.slug === "string" || isObj(answer.endpoint));
      return looksSaved ? readEndpoint(answer) : readEndpoint(await customFetch<unknown>(`${PATH}/${id}`));
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(getSharedEndpointQueryKey(id), saved);
      refresh(id);
    },
  });
};

export const useDeleteSharedEndpoint = () => {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (id: number) => customFetch<unknown>(`${PATH}/${id}`, { method: "DELETE" }),
    onSuccess: (_data, id) => {
      queryClient.removeQueries({ queryKey: getSharedEndpointQueryKey(id) });
      refresh();
    },
  });
};

export const useSharedKeys = (id: number | null) =>
  useQuery<SharedKey[]>({
    queryKey: getSharedKeysQueryKey(id ?? 0),
    queryFn: async () =>
      list(await customFetch<unknown>(`${PATH}/${id}/keys`), "keys", "results", "items")
        .filter(isObj)
        .map(readKey),
    enabled: id !== null,
    retry: false,
  });

/** Makes a key. The answer holds the whole secret ONCE: keep it in memory only, never in the cache. */
export const useCreateSharedKey = (id: number) => {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    // `category` is required; exactly one of `permanent: true` and `expiresAt` (a date and time) says when the key stops
    mutationFn: async (body: {
      label: string;
      category: SharedKeyCategory;
      permanent?: boolean;
      expiresAt?: string;
    }): Promise<SharedKeyCreated> => {
      const raw = await customFetch<unknown>(`${PATH}/${id}/keys`, { method: "POST", body: JSON.stringify(body) });
      const r = isObj(raw) ? (isObj(raw.apiKey) ? raw.apiKey : raw) : {};
      const secret = str(first(isObj(raw) ? raw.key : undefined, r.key, r.secret));
      return { ...readKey(r), key: secret };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getSharedKeysQueryKey(id) });
      // the editor's status banner ("Nothing is shared until..." / "This endpoint is live: ... with K live key") and the list's
      // key counts both depend on the number of live keys
      refresh(id);
    },
  });
};

export const useRevokeSharedKey = (id: number) => {
  const queryClient = useQueryClient();
  const refresh = useRefresh();
  return useMutation({
    mutationFn: (keyId: number) => customFetch<unknown>(`${PATH}/${id}/keys/${keyId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: getSharedKeysQueryKey(id) });
      // the editor's status banner ("Nothing is shared until..." / "This endpoint is live: ... with K live key") and the list's
      // key counts both depend on the number of live keys
      refresh(id);
    },
  });
};

/** The first rows exactly as the public call would send them (saved fields and locked filters). Reads, never writes. */
export const usePreviewSharedEndpoint = (id: number) =>
  useMutation({
    mutationFn: async (body: { limit: number; filters?: Record<string, string>; category?: SharedKeyCategory }) =>
      readPreview(await customFetch<unknown>(`${PATH}/${id}/preview`, { method: "POST", body: JSON.stringify(body) })),
  });

export const useSharedGuide = (id: number | null) =>
  useQuery<SharedGuide>({
    queryKey: getSharedGuideQueryKey(id ?? 0),
    queryFn: async () => readGuide(await customFetch<unknown>(`${PATH}/${id}/guide`)),
    enabled: id !== null,
    retry: false,
  });

/** The access log of one endpoint (a number) or of every endpoint ("all"). `status` is ok, error or an HTTP code. */
export const useSharedActivity = (id: number | "all" | null, query: SharedActivityQuery) =>
  useQuery<SharedActivity>({
    queryKey: getSharedActivityQueryKey(id === "all" ? -1 : (id ?? 0), query),
    queryFn: async () => {
      const params = new URLSearchParams({ page: String(query.page) });
      if (query.status) params.set("status", query.status);
      const path = id === "all" ? `${PATH}/activity` : `${PATH}/${id}/activity`;
      return readActivity(await customFetch<unknown>(`${path}?${params.toString()}`));
    },
    enabled: id !== null,
    placeholderData: keepPreviousData,
    retry: false,
  });
