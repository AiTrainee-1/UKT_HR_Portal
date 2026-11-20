// The report builder's rules, kept apart from the screens so they can be tested on their own: the chosen fields and their
// order, the filters as the server stores them (and which period a saved report opens on), the preview's query string,
// the unsaved-changes check and what stops a save. Everything here is a pure function (today is a parameter).

import type {
  CustomDataset,
  CustomField,
  CustomGrain,
  CustomSection,
  CustomSort,
  SavedCustomReport,
  SavedCustomReportInput,
  SavedFilters,
} from "@/lib/api-client/custom-hooks/report-customise";
import {
  buildQuery,
  datePresets,
  defaultValues,
  parseQuery,
  periodLabel,
  shiftPeriod,
  validateFilters,
  type DateRangeValue,
  type FilterValues,
} from "@/lib/report-center";

/** Where the builder lives (HR portal only; the Report Center itself stays at /hr/reports). */
export const CUSTOMISE_PATH = "/hr/reports/customise";
export const newReportHref = () => `${CUSTOMISE_PATH}/new`;
export const editReportHref = (id: number) => `${CUSTOMISE_PATH}/${id}/edit`;
/** The saved report in the Report Center workspace (run, filters, Excel / PDF). */
export const openReportHref = (id: number) => `/hr/reports?report=${encodeURIComponent(`custom-${id}`)}`;

export const NAME_MAX = 120;
export const DESCRIPTION_MAX = 500;

export const GRAIN_LABEL: Record<CustomGrain, string> = {
  employee: "One row per employee",
  day: "One row per employee per day",
  punch: "One row per punch",
  request: "One row per request",
  payroll: "One row per payroll entry",
};

// ── fields ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Every field of a dataset by key. */
export function fieldIndex(dataset: CustomDataset | null | undefined): Map<string, CustomField> {
  const out = new Map<string, CustomField>();
  for (const s of dataset?.sections ?? []) for (const f of s.fields) out.set(f.key, f);
  return out;
}

/** Ticks a field on (added at the end) or off. */
export function toggleField(fields: string[], key: string): string[] {
  return fields.includes(key) ? fields.filter((k) => k !== key) : [...fields, key];
}

export function removeField(fields: string[], key: string): string[] {
  return fields.filter((k) => k !== key);
}

/** Moves the field at `from` to position `to` (both clamped); the others keep their order. */
export function moveField(fields: string[], from: number, to: number): string[] {
  if (from < 0 || from >= fields.length) return fields;
  const target = Math.max(0, Math.min(fields.length - 1, to));
  if (target === from) return fields;
  const next = [...fields];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Every field of a section on (the ones not yet chosen are added in the section's order), or every one off. */
export function setSection(fields: string[], section: CustomSection, on: boolean): string[] {
  const keys = section.fields.map((f) => f.key);
  if (!on) return fields.filter((k) => !keys.includes(k));
  return [...fields, ...keys.filter((k) => !fields.includes(k))];
}

/** The sections with only the fields whose label, key, section or description holds every word of the search. */
export function searchSections(sections: CustomSection[], needle: string): CustomSection[] {
  const words = needle.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return sections;
  return sections
    .map((s) => ({
      ...s,
      fields: s.fields.filter((f) => {
        const text = `${f.label} ${f.key} ${s.label} ${f.description ?? ""}`.toLowerCase();
        return words.every((w) => text.includes(w));
      }),
    }))
    .filter((s) => s.fields.length > 0);
}

// ── filters as the server stores them ────────────────────────────────────────────────────────────────────────────────

/** The query parameters that carry fixed dates or a fixed month. */
export const DATE_PARAMS = new Set(["dateFrom", "dateTo", "period", "year"]);

/** What a saved report covers when it is opened: the data source's default period (this month), a period counted from
 *  the day it is opened ("Last month", "Last 7 days" ...), or exactly the dates on screen now. */
export type DatesMode = "default" | "relative" | "fixed";

/** The server's relative periods (api/reporting/custom/build.py PERIOD_TOKENS / RANGE_TOKENS). */
export const PERIOD_TOKENS = ["thisMonth", "lastMonth"];
export const RANGE_TOKENS = ["thisMonth", "lastMonth", "today", "yesterday", "last7", "thisWeek"];
export const TOKEN_LABEL: Record<string, string> = {
  thisMonth: "This month",
  lastMonth: "Last month",
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  thisWeek: "This week",
};
/** The Report Center's quick ranges (lib/report-center datePresets) that the server also knows by a token. */
const PRESET_TOKEN: Record<string, string> = {
  today: "today",
  yesterday: "yesterday",
  week: "thisWeek",
  last7: "last7",
  month: "thisMonth",
  lastMonth: "lastMonth",
};

const thisPeriod = (today: Date) => `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

function dateFilters(dataset: CustomDataset) {
  return {
    range: dataset.filters.find((f) => f.kind === "dateRange"),
    period: dataset.filters.find((f) => f.kind === "period"),
  };
}

/** The relative period the dates on screen are ("lastMonth" when they are last month's), or null. */
export function relativeToken(dataset: CustomDataset, values: FilterValues, today: Date): string | null {
  const { range, period } = dateFilters(dataset);
  if (range) {
    const v = values[range.key] as DateRangeValue | undefined;
    const preset = datePresets(today).find(
      (p) => PRESET_TOKEN[p.id] && p.range.dateFrom === v?.dateFrom && p.range.dateTo === v?.dateTo,
    );
    return preset ? PRESET_TOKEN[preset.id] : null;
  }
  if (period) {
    const v = String(values[period.key] ?? "");
    if (v === thisPeriod(today)) return "thisMonth";
    if (v === shiftPeriod(thisPeriod(today), -1)) return "lastMonth";
  }
  return null;
}

/** Filter values -> the saved form (the Report Center query-parameter format). "default" leaves the dates out (the
 *  report opens on its data source's default period), "relative" saves the period's token, "fixed" the dates. */
export function filtersToSaved(
  dataset: CustomDataset,
  values: FilterValues,
  dates: DatesMode,
  today: Date = new Date(),
): SavedFilters {
  const out: SavedFilters = {};
  buildQuery(dataset.filters, values).forEach((value, key) => {
    if (dates !== "fixed" && DATE_PARAMS.has(key)) return;
    out[key] = value;
  });
  const token = dates === "relative" ? relativeToken(dataset, values, today) : null;
  if (token) {
    if (dateFilters(dataset).range) out.dateRange = token;
    else out.period = token;
  }
  return out;
}

/** Saved filters -> query parameters a filter form understands (a relative token is not one: it is left out). */
export function savedToParams(saved: SavedFilters): URLSearchParams {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(saved)) {
    if (value === "" || key === "dateRange" || (key === "period" && PERIOD_TOKENS.includes(value))) continue;
    q.set(key, value);
  }
  return q;
}

/** How a saved report's dates were saved. */
export function savedDatesMode(saved: SavedFilters): DatesMode {
  if (saved.dateFrom || saved.dateTo || saved.year || (saved.period && !PERIOD_TOKENS.includes(saved.period)))
    return "fixed";
  if (RANGE_TOKENS.includes(saved.dateRange ?? "") || PERIOD_TOKENS.includes(saved.period ?? "")) return "relative";
  return "default";
}

/** A saved relative period as the dates it means today, onto the filter values. */
function applyToken(dataset: CustomDataset, values: FilterValues, saved: SavedFilters, today: Date): FilterValues {
  const { range, period } = dateFilters(dataset);
  const out = { ...values };
  const rangeToken = saved.dateRange;
  if (range && rangeToken) {
    const preset = datePresets(today).find((p) => PRESET_TOKEN[p.id] === rangeToken);
    if (preset) out[range.key] = preset.range;
  }
  const periodToken = saved.period;
  if (period && periodToken && PERIOD_TOKENS.includes(periodToken)) {
    out[period.key] = periodToken === "thisMonth" ? thisPeriod(today) : shiftPeriod(thisPeriod(today), -1);
  }
  return out;
}

/** "1 Nov 2026 - 19 Nov 2026" / "November 2026" / "2026": the dates the filters on screen cover ("" for none). */
export function describeDates(dataset: CustomDataset, values: FilterValues): string {
  const { range, period } = dateFilters(dataset);
  if (range) {
    const v = values[range.key] as DateRangeValue | undefined;
    if (v?.dateFrom && v?.dateTo) {
      return v.dateFrom === v.dateTo ? shortDate(v.dateFrom) : `${shortDate(v.dateFrom)} - ${shortDate(v.dateTo)}`;
    }
    return "";
  }
  if (period) return periodLabel(String(values[period.key] ?? ""));
  const year = dataset.filters.find((f) => f.kind === "year");
  return year ? String(values[year.key] ?? "") : "";
}

/** Whether the data source has a date, month or year filter at all (otherwise there is nothing to choose). */
export const hasDateFilter = (dataset: CustomDataset) =>
  dataset.filters.some((f) => f.kind === "dateRange" || f.kind === "period" || f.kind === "year");

export const sortParam = (sort: CustomSort[]): string => sort.map((s) => `${s.key}:${s.dir}`).join(",");

/** The preview's query string: dataset, fields in order, sort, then the filters exactly as a report run sends them. */
export function previewQuery(
  dataset: CustomDataset,
  fields: string[],
  sort: CustomSort[],
  values: FilterValues,
): string {
  const q = new URLSearchParams();
  q.set("dataset", dataset.id);
  q.set("fields", fields.join(","));
  if (sort.length) q.set("sort", sortParam(sort));
  buildQuery(dataset.filters, values).forEach((value, key) => q.set(key, value));
  return q.toString();
}

// ── the draft ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type Draft = {
  dataset: string | null;
  fields: string[];
  sort: CustomSort[];
  values: FilterValues;
  /** What period the saved report covers when it is opened. */
  dates: DatesMode;
  name: string;
  description: string;
};

export const emptyDraft = (): Draft => ({
  dataset: null,
  fields: [],
  sort: [],
  values: {},
  dates: "default",
  name: "",
  description: "",
});

/** A draft switched to another data source: its default fields and filters; the name and description stay. */
export function draftForDataset(draft: Draft, dataset: CustomDataset): Draft {
  const known = fieldIndex(dataset);
  return {
    ...draft,
    dataset: dataset.id,
    fields: dataset.defaultFields.filter((k) => known.has(k)),
    sort: [],
    values: defaultValues(dataset.filters),
    dates: "default",
  };
}

/** A saved report as a draft. Fields its data source no longer offers are dropped and returned. */
export function draftFromSaved(
  item: SavedCustomReport,
  dataset: CustomDataset | undefined,
  today: Date = new Date(),
): { draft: Draft; dropped: string[] } {
  const known = fieldIndex(dataset);
  const fields = dataset ? item.fields.filter((k) => known.has(k)) : [...item.fields];
  const dropped = dataset ? item.fields.filter((k) => !known.has(k)) : [];
  const dates = savedDatesMode(item.filters);
  let values: FilterValues = {};
  if (dataset) {
    values = parseQuery(dataset.filters, savedToParams(item.filters));
    if (dates === "relative") values = applyToken(dataset, values, item.filters, today);
  }
  return {
    draft: {
      dataset: item.dataset || null,
      fields,
      sort: item.sort.filter((s) => fields.includes(s.key)),
      values,
      dates,
      name: item.name,
      description: item.description,
    },
    dropped,
  };
}

/** What the server would store (dataset filters, in order): compared to tell whether anything changed. */
export function draftSignature(draft: Draft, dataset: CustomDataset | undefined): string {
  return JSON.stringify([
    draft.dataset,
    draft.fields,
    draft.sort,
    dataset ? buildQuery(dataset.filters, draft.values).toString() : "",
    draft.dates,
    draft.name.trim(),
    draft.description.trim(),
  ]);
}

export type DraftProblem = { part: "dataset" | "fields" | "filters" | "name"; message: string };

/** The first thing that stops a save, in plain words (or null). */
export function draftProblem(
  draft: Draft,
  dataset: CustomDataset | undefined,
  today: Date = new Date(),
): DraftProblem | null {
  if (!draft.dataset || !dataset) return { part: "dataset", message: "Choose a data source." };
  if (!draft.fields.length) return { part: "fields", message: "Pick at least one field." };
  const filters = validateFilters(dataset.filters, draft.values);
  if (filters) return { part: "filters", message: filters };
  if (draft.dates === "relative" && !relativeToken(dataset, draft.values, today)) {
    return {
      part: "filters",
      message: "For a period counted from the day the report is opened, pick a quick range such as “Last month”.",
    };
  }
  const name = draft.name.trim();
  if (!name) return { part: "name", message: "Give the report a name." };
  if (name.length > NAME_MAX) return { part: "name", message: `Keep the name to ${NAME_MAX} characters.` };
  if (draft.description.trim().length > DESCRIPTION_MAX)
    return { part: "name", message: `Keep the description to ${DESCRIPTION_MAX} characters.` };
  return null;
}

/** The body of POST / PUT /api/reports/custom/saved. */
export function draftToInput(draft: Draft, dataset: CustomDataset, today: Date = new Date()): SavedCustomReportInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    dataset: dataset.id,
    fields: draft.fields,
    filters: filtersToSaved(dataset, draft.values, draft.dates, today),
    sort: draft.sort.filter((s) => draft.fields.includes(s.key)),
  };
}

// ── the catalog's Customise section ──────────────────────────────────────────────────────────────────────────────────

/** Saved reports whose name, description or data source holds every word of the search (all of them for none). */
export function searchSaved(items: SavedCustomReport[], query: string): SavedCustomReport[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((r) => {
    const text = `${r.name} ${r.description} ${r.datasetLabel}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-11-19T10:42:00+05:30" -> "19 Nov 2026" (the date as written, no timezone shift); anything else as it came. */
export function shortDate(value: string | null): string {
  if (!value) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : value;
}

/** "Updated by Priya · 19 Nov 2026" (or Created ..., or nothing). */
export function savedByLine(item: SavedCustomReport): string {
  const who = item.updatedBy ?? item.createdBy;
  const when = shortDate(item.updatedAt ?? item.createdAt);
  const verb = item.updatedAt || item.updatedBy ? "Updated" : "Created";
  if (who && when) return `${verb} by ${who} · ${when}`;
  if (who) return `${verb} by ${who}`;
  if (when) return `${verb} ${when}`;
  return "";
}
