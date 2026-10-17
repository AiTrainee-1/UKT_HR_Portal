import type {
  SharedCatalog,
  SharedCatalogField,
  SharedCatalogFilter,
  SharedDataset,
  SharedEndpoint,
  SharedEndpointInput,
  SharedLimits,
  SharedSensitivity,
} from "@/lib/api-client/custom-hooks";
import { isIsoDate } from "../compensation/form";
import { checkOrigin } from "./origin";

// The endpoint editor's form: what is on screen (`EndpointDraft`), how it is built from a saved endpoint, how it is checked
// (the same limits as the server, so a save is rarely refused) and how it becomes the one request a Save sends.

export type EndpointDraft = {
  slug: string;
  /** True once the person typed in the address box themselves: from then on the name no longer suggests it. */
  slugTouched: boolean;
  name: string;
  description: string;
  dataset: string;
  /** The ticked fields (the request sends them in the dataset's own order). */
  fields: string[];
  /** A filter that is locked: key -> the value typed (the caller can never change it). */
  lockedFilters: Record<string, string>;
  origins: string[];
  allowNoOrigin: boolean;
  pageSizeDefault: string;
  pageSizeMax: string;
  rateLimit: string;
  enabled: boolean;
};

export const SLUG_PATTERN = /^[a-z0-9-]{3,60}$/;
export const RATE_LIMIT_MAX = 6000;
export const NAME_MAX = 100;
export const SENSITIVITY_ORDER: SharedSensitivity[] = ["basic", "personal", "financial"];

export const SENSITIVITY_TEXT: Record<SharedSensitivity, { title: string; help: string }> = {
  basic: {
    title: "Basic: organisation data",
    help: "Names of departments, branches and designations, employee codes, dates of joining. Nothing private about a person.",
  },
  personal: {
    title: "Personal: about one person",
    help: "Phone number, e-mail, date of birth, address, gender, leave reasons. Share only what the other application truly needs.",
  },
  financial: {
    title: "Financial: salary and pay",
    help: "Salary, salary per shift and payroll amounts. The most sensitive data in the system.",
  },
};

export function blankDraft(): EndpointDraft {
  return {
    slug: "",
    slugTouched: false,
    name: "",
    description: "",
    dataset: "",
    fields: [],
    lockedFilters: {},
    origins: [],
    allowNoOrigin: true,
    pageSizeDefault: "50",
    pageSizeMax: "200",
    rateLimit: "60",
    enabled: true,
  };
}

export function draftFrom(endpoint: SharedEndpoint): EndpointDraft {
  return {
    slug: endpoint.slug,
    slugTouched: true,
    name: endpoint.name,
    description: endpoint.description,
    dataset: endpoint.dataset,
    fields: [...endpoint.fields],
    lockedFilters: Object.fromEntries(Object.entries(endpoint.lockedFilters).map(([k, v]) => [k, String(v)])),
    origins: [...endpoint.origins],
    allowNoOrigin: endpoint.allowNoOrigin,
    pageSizeDefault: String(endpoint.pageSizeDefault),
    pageSizeMax: String(endpoint.pageSizeMax),
    rateLimit: String(endpoint.rateLimitPerMinute),
    enabled: endpoint.enabled,
  };
}

const sorted = (items: string[]) => [...items].sort();
const entries = (locked: Record<string, string>) => Object.entries(locked).sort(([a], [b]) => a.localeCompare(b));

/** True when two drafts say the same thing (the order of the ticks and the helper flag do not count). */
export function sameDraft(a: EndpointDraft, b: EndpointDraft): boolean {
  return (
    a.slug === b.slug &&
    a.name === b.name &&
    a.description === b.description &&
    a.dataset === b.dataset &&
    a.allowNoOrigin === b.allowNoOrigin &&
    a.pageSizeDefault === b.pageSizeDefault &&
    a.pageSizeMax === b.pageSizeMax &&
    a.rateLimit === b.rateLimit &&
    a.enabled === b.enabled &&
    JSON.stringify(sorted(a.fields)) === JSON.stringify(sorted(b.fields)) &&
    JSON.stringify(sorted(a.origins)) === JSON.stringify(sorted(b.origins)) &&
    JSON.stringify(entries(a.lockedFilters)) === JSON.stringify(entries(b.lockedFilters))
  );
}

/** "Monthly Departments!" -> "monthly-departments": a suggestion for the address, which the person may change. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function datasetOf(catalog: SharedCatalog | undefined, key: string): SharedDataset | undefined {
  return catalog?.datasets.find((d) => d.key === key);
}

/** The fields of a dataset that are ticked, in the dataset's own order. */
export function orderedFields(draft: EndpointDraft, dataset: SharedDataset | undefined): string[] {
  if (!dataset) return [...draft.fields];
  const ticked = new Set(draft.fields);
  return dataset.fields.filter((f) => ticked.has(f.key)).map((f) => f.key);
}

/** The ticked fields that are personal or financial and were not shared before this save: they need the confirmation. */
export function newSensitiveFields(
  draft: EndpointDraft,
  savedFields: string[],
  dataset: SharedDataset | undefined,
): SharedCatalogField[] {
  if (!dataset) return [];
  const before = new Set(savedFields);
  const ticked = new Set(draft.fields);
  return dataset.fields.filter((f) => f.sensitivity !== "basic" && ticked.has(f.key) && !before.has(f.key));
}

/** What is wrong with a locked filter's text, or null when it is fine. */
export function filterProblem(filter: SharedCatalogFilter, text: string): string | null {
  const t = text.trim();
  if (t === "") return `Type a value for ${filter.label}, or untick the lock.`;
  if (filter.type === "enum" && !filter.values.includes(t)) {
    return `${filter.label} can only be one of: ${filter.values.join(", ")}.`;
  }
  if (filter.type === "integer" && !/^\d{1,9}$/.test(t)) return `${filter.label} must be a whole number.`;
  if (filter.type === "date" && !isIsoDate(t)) return `${filter.label} must be a date written like 2026-10-14.`;
  if (filter.type === "month" && !/^\d{4}-(0[1-9]|1[0-2])$/.test(t)) {
    return `${filter.label} must be a month written like 2026-09.`;
  }
  if (filter.type === "year" && !(/^\d{4}$/.test(t) && Number(t) >= 2000 && Number(t) <= 2100)) {
    return `${filter.label} must be a year from 2000 to 2100.`;
  }
  return null;
}

export type DraftValidation = {
  ok: boolean;
  /** One sentence per box, keyed by `name`, `slug`, `dataset`, `fields`, `origins`, `pageSizeDefault`, `pageSizeMax`,
   * `rateLimit` and `filter:<key>`. */
  errors: Record<string, string>;
  /** The first problem, in the order the editor shows them. */
  first: string | undefined;
};

const ORDER = [
  "name",
  "slug",
  "dataset",
  "fields",
  "filter:",
  "origins",
  "rateLimit",
  "pageSizeDefault",
  "pageSizeMax",
];

const wholeNumber = (text: string): number | null => (/^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : null);

export function validateDraft(
  draft: EndpointDraft,
  ctx: { creating: boolean; dataset: SharedDataset | undefined; limits: SharedLimits },
): DraftValidation {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (name === "") errors.name = "Give the endpoint a name, so you know what it is for.";
  else if (name.length > NAME_MAX) errors.name = `The name is too long: ${NAME_MAX} characters at most.`;

  if (ctx.creating) {
    if (!SLUG_PATTERN.test(draft.slug)) {
      errors.slug = "The address needs 3 to 60 characters: small letters a to z, digits and hyphens only.";
    }
  }

  if (draft.dataset === "" || !ctx.dataset) errors.dataset = "Choose which data this endpoint shares.";

  const known = new Set(ctx.dataset?.fields.map((f) => f.key) ?? []);
  if (draft.fields.length === 0) errors.fields = "Tick at least one field. An endpoint with no fields shares nothing.";
  else if (ctx.dataset && draft.fields.some((f) => !known.has(f)))
    errors.fields = "A ticked field is not in this dataset.";

  for (const [key, text] of Object.entries(draft.lockedFilters)) {
    const filter = ctx.dataset?.filters.find((f) => f.key === key);
    if (!filter) {
      errors[`filter:${key}`] = `${key} is not a filter of this dataset.`;
      continue;
    }
    const problem = filterProblem(filter, text);
    if (problem) errors[`filter:${key}`] = problem;
  }

  if (draft.origins.length > ctx.limits.maxOriginsPerEndpoint) {
    errors.origins = `An endpoint can have ${ctx.limits.maxOriginsPerEndpoint} allowed websites at most.`;
  } else {
    const bad = draft.origins.find((o) => !checkOrigin(o).ok);
    if (bad) errors.origins = `"${bad}" is not a valid origin.`;
  }

  const rate = wholeNumber(draft.rateLimit);
  if (rate === null || rate < 1 || rate > RATE_LIMIT_MAX) {
    errors.rateLimit = `The limit is a whole number of calls a minute, from 1 to ${RATE_LIMIT_MAX}.`;
  }
  const maxCap = ctx.dataset?.maxPageSize ?? 1000;
  const max = wholeNumber(draft.pageSizeMax);
  if (max === null || max < 1 || max > maxCap) {
    errors.pageSizeMax = `The largest page is a whole number from 1 to ${maxCap} for this dataset.`;
  }
  const def = wholeNumber(draft.pageSizeDefault);
  if (def === null || def < 1) errors.pageSizeDefault = "The usual page size is a whole number, 1 or more.";
  else if (max !== null && def > max)
    errors.pageSizeDefault = "The usual page size cannot be bigger than the largest page.";

  const first = ORDER.map((k) => Object.keys(errors).find((e) => e === k || (k.endsWith(":") && e.startsWith(k)))).find(
    (e): e is string => e !== undefined,
  );
  return { ok: Object.keys(errors).length === 0, errors, first: first ? errors[first] : undefined };
}

/** The one request a Save sends (a create sends `slug` and `dataset` too; a save of an existing one sends the version it started from). */
export function toInput(
  draft: EndpointDraft,
  ctx: {
    creating: boolean;
    dataset: SharedDataset | undefined;
    version?: string | null;
    acknowledgeSensitive?: boolean;
  },
): SharedEndpointInput {
  const lockedFilters: Record<string, string> = {};
  for (const [key, text] of entries(draft.lockedFilters)) lockedFilters[key] = text.trim();
  const body: SharedEndpointInput = {
    name: draft.name.trim(),
    description: draft.description.trim(),
    fields: orderedFields(draft, ctx.dataset),
    lockedFilters,
    origins: [...draft.origins],
    allowNoOrigin: draft.allowNoOrigin,
    pageSizeDefault: Number(draft.pageSizeDefault),
    pageSizeMax: Number(draft.pageSizeMax),
    rateLimitPerMinute: Number(draft.rateLimit),
    enabled: draft.enabled,
  };
  if (ctx.creating) {
    body.slug = draft.slug;
    body.dataset = draft.dataset;
  }
  if (!ctx.creating && ctx.version) body.expectedVersion = ctx.version;
  if (ctx.acknowledgeSensitive) body.acknowledgeSensitive = true;
  return body;
}

/** "3 calls in the last 24 hours" style helpers. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "14 Oct 2026, 10:00 am" in the factory's own time; "Never" for nothing. */
export function stamp(iso: string | null | undefined, never = "Never"): string {
  if (!iso) return never;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "Asia/Kolkata",
  });
}

/** What a locked filter is worth in words, for the list ("status = active"). */
export function lockedWords(locked: Record<string, string>): string {
  const parts = entries(locked).map(([k, v]) => `${k} = ${v}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** The public address of an endpoint, from where the API lives. */
export function publicUrl(origin: string, slug: string): string {
  return `${origin.replace(/\/+$/, "")}/api/shared/${slug || "<address>"}`;
}
