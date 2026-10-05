// The MD Reports page's rules, kept apart from the screens so they can be tested on their own: which reports are the
// MD's own "executive" ones, how the library is searched and filtered, what "Starred" and "Recently opened" show, and
// what the assistant is told about the page. Everything here is a pure function of the Report Center catalog.

import { ApiError } from "@/lib/api-client/custom-fetch";
import { groupReports, sectionsByCategory, type CategorySection, type ReportGroup } from "@/lib/report-catalog";
import type { ReportCatalog, ReportCategory, ReportMeta, ReportRunResult } from "@/lib/report-center";
import { formatCell } from "@/lib/report-format";
import type { AssistantPageContext } from "@/lib/md/assistant-store";

/** Where the Report Center lives inside the MD portal (the HR portal keeps it at /hr/reports). */
export const MD_REPORTS_PATH = "/md/reports";

/** The category the backend reserves for the MD's own reports (ReportSpec.md_only): nobody else is ever sent it. */
export const EXECUTIVE_CATEGORY = "md";

/** Reports shown per category in the library before "Show all". */
export const PREVIEW_PER_CATEGORY = 6;

/** Questions the "Ask AI" entry offers (short, so each fits one line on a phone). */
export const ASK_EXAMPLES = [
  "Which report shows overtime by department?",
  "Which report shows monthly salary cost?",
  "Where can I see who came late this week?",
];

export type Library = {
  /** Every report, the variants of one report folded into one entry, in catalog order. */
  all: ReportGroup[];
  /** The MD's own executive reports (the shelf at the top of the page). */
  executive: ReportGroup[];
  /** Everything else: the Report Center's ordinary categories. */
  standard: ReportGroup[];
  /** The ordinary categories that hold reports (the chips), with how many entries each has. */
  categories: { category: ReportCategory; count: number }[];
  /** Every category the catalog names (the executive one included): for headings and for searching by category. */
  allCategories: ReportCategory[];
};

export function buildLibrary(catalog: ReportCatalog): Library {
  const all = groupReports(catalog.reports);
  const executive = all.filter((g) => g.category === EXECUTIVE_CATEGORY);
  const standard = all.filter((g) => g.category !== EXECUTIVE_CATEGORY);
  const categories = catalog.categories
    .filter((c) => c.id !== EXECUTIVE_CATEGORY)
    .map((category) => ({ category, count: standard.filter((g) => g.category === category.id).length }))
    .filter((c) => c.count > 0);
  return { all, executive, standard, categories, allCategories: catalog.categories };
}

// ── search ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Filler words in a natural question ("which report shows overtime BY department") that no report is named after. */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "in",
  "of",
  "on",
  "per",
  "the",
  "to",
  "with",
  "report",
  "reports",
]);

/** The words a search must find: lower case, punctuation removed, filler dropped (unless nothing else is left). */
export function queryWords(query: string): string[] {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const meaningful = words.filter((w) => !STOP_WORDS.has(w));
  return meaningful.length > 0 ? meaningful : words;
}

/** A word is found when the text holds it, or its singular ("visitors" finds "Visitor Register"). */
function found(text: string, word: string): boolean {
  if (text.includes(word)) return true;
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && text.includes(word.slice(0, -1));
}

/**
 * Every word must appear somewhere in the report's title, description, view names, tags or category name. Title matches
 * rank first, then description and tags, then the category; ties keep the catalog's order. An empty query keeps all.
 */
export function searchLibrary(groups: ReportGroup[], categories: ReportCategory[], query: string): ReportGroup[] {
  const words = queryWords(query);
  if (words.length === 0) return groups;
  const categoryName = new Map(categories.map((c) => [c.id, c.label.toLowerCase()]));
  const scored: { group: ReportGroup; score: number; index: number }[] = [];
  groups.forEach((group, index) => {
    const title = group.variants
      .map((v) => v.title)
      .join(" ")
      .toLowerCase();
    const rest = group.variants
      .flatMap((v) => [v.description, v.variant ?? "", ...v.tags])
      .join(" ")
      .toLowerCase();
    const category = categoryName.get(group.category) ?? group.category.toLowerCase();
    let score = 0;
    for (const word of words) {
      if (found(title, word)) score += 3;
      else if (found(rest, word)) score += 2;
      else if (found(category, word)) score += 1;
      else return; // a word nothing matches: this report is out
    }
    scored.push({ group, score, index });
  });
  return scored.sort((a, b) => b.score - a.score || a.index - b.index).map((s) => s.group);
}

// ── what the library shows ──────────────────────────────────────────────────────────────────────────────────────────

export type LibraryView =
  /** No search: the reports grouped by category, in the catalog's order. */
  | { mode: "browse"; sections: CategorySection[]; total: number }
  /** A search: one ranked list across every category (the executive ones included). */
  | { mode: "results"; groups: ReportGroup[]; total: number };

/**
 * The library for a search text and an optional category chip. Browsing leaves the executive reports out (the shelf
 * above already shows them); searching, or choosing a category, looks at everything.
 */
export function libraryView(library: Library, query: string, categoryId: string | null): LibraryView {
  const searching = query.trim() !== "";
  const pool = categoryId
    ? library.all.filter((g) => g.category === categoryId)
    : searching
      ? library.all
      : library.standard;
  if (searching) {
    const groups = searchLibrary(pool, library.allCategories, query);
    return { mode: "results", groups, total: groups.length };
  }
  return { mode: "browse", sections: sectionsByCategory(pool, library.allCategories), total: pool.length };
}

/** The catalog with the executive category first, so the MD's own reports lead the report list beside an open report. */
export function executiveFirst(catalog: ReportCatalog): ReportCatalog {
  const at = catalog.categories.findIndex((c) => c.id === EXECUTIVE_CATEGORY);
  if (at <= 0) return catalog; // none, or first already
  return { ...catalog, categories: [catalog.categories[at], ...catalog.categories.filter((_, i) => i !== at)] };
}

/** The name to show for a category id (the catalog's label, or the id itself if the catalog does not know it). */
export function categoryLabel(categories: ReportCategory[], id: string): string {
  return categories.find((c) => c.id === id)?.label ?? id;
}

// ── starred and recently opened ─────────────────────────────────────────────────────────────────────────────────────

export type PickedReport = { report: ReportMeta; group: ReportGroup };

/**
 * The reports behind a list of ids (starred, recently opened), in that order, at most `max`. An id the catalog does not
 * list (a report that was removed, or one only another account could see) is dropped.
 */
export function pickReports(ids: string[], groups: ReportGroup[], max = Number.POSITIVE_INFINITY): PickedReport[] {
  const byId = new Map<string, PickedReport>();
  for (const group of groups) for (const report of group.variants) byId.set(report.id, { report, group });
  const out: PickedReport[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const hit = byId.get(id);
    if (!hit || seen.has(id)) continue;
    seen.add(id);
    out.push(hit);
    if (out.length >= max) break;
  }
  return out;
}

/** The starred report of a group (any of its views), if there is one. */
export function starredIdOf(group: ReportGroup, favorites: string[]): string | undefined {
  return group.variants.find((v) => favorites.includes(v.id))?.id;
}

/** Why the list of reports could not be loaded, in plain words for the error banner. */
export function catalogFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) {
      return "Your account cannot open the Report Center right now. Sign in again, or ask an administrator.";
    }
    if (error.status >= 500) return "The server had a problem while loading the reports. Please try again in a moment.";
  }
  return "The list of reports could not be loaded. Check your connection and try again.";
}

// ── the assistant ───────────────────────────────────────────────────────────────────────────────────────────────────

const MAX_TITLES_PER_CATEGORY = 15;

/**
 * What the assistant is told while the library is on screen: how many reports there are and their titles by category
 * (titles only: it needs them to answer "which report shows overtime by department?", and they hold no data).
 */
export function libraryContext(library: Library): AssistantPageContext {
  const summary: Record<string, string | number> = {
    "Reports in the library": library.all.length,
    "Executive reports": library.executive.length,
  };
  for (const { category, groups } of sectionsByCategory(library.all, library.allCategories)) {
    const titles = groups.map((g) => g.primary.title);
    const more = titles.length - MAX_TITLES_PER_CATEGORY;
    summary[category.label] =
      titles.slice(0, MAX_TITLES_PER_CATEGORY).join(", ") + (more > 0 ? `, and ${more} more` : "");
  }
  return { page: "reports", title: "Reports", summary };
}

/**
 * What the assistant is told while a report is open: which report, the filters it ran with and its headline figures
 * (never the rows: the MD can ask for those on the page that owns them).
 */
export function reportContext(
  spec: ReportMeta,
  category: string,
  data: ReportRunResult | undefined,
): AssistantPageContext {
  const filters: Record<string, string> = { Report: spec.title, Category: category };
  for (const f of data?.filters ?? []) filters[f.label] = f.value;
  const summary: Record<string, string | number> = {};
  if (data) {
    summary["Records"] = data.rowCount;
    for (const card of data.summary) summary[card.label] = formatCell(card.value, card.format);
  }
  return { page: "reports", title: `Reports: ${spec.title}`, filters, summary: data ? summary : undefined };
}

/** The question behind "Ask AI about this report": the report and the filters it is showing. */
export function askAboutReport(spec: ReportMeta, data: ReportRunResult | undefined): string {
  const filters = (data?.filters ?? []).map((f) => `${f.label}: ${f.value}`).join(", ");
  return `Explain the "${spec.title}" report${filters ? ` (${filters})` : ""}: what stands out, and what should I look at first?`;
}
