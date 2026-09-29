// Report Center catalog helpers: grouping variants of one report ("families"), search, and carrying
// filter values across a variant switch. Pure functions, unit-tested.

import { defaultValues, type FilterValues, type ReportCategory, type ReportMeta } from "./report-center";

/** One card in the catalog: a single report, or a family of variants (Records | Counts | ...). */
export interface ReportGroup {
  key: string;
  category: string;
  primary: ReportMeta;
  variants: ReportMeta[];
}

/** Groups reports that share a family (same category) into one entry, keeping catalog order. */
export function groupReports(reports: ReportMeta[]): ReportGroup[] {
  const groups: ReportGroup[] = [];
  const byKey = new Map<string, ReportGroup>();
  for (const r of reports) {
    const key = r.family ? `${r.category}:${r.family}` : r.id;
    const existing = byKey.get(key);
    if (existing) {
      existing.variants.push(r);
    } else {
      const g: ReportGroup = { key, category: r.category, primary: r, variants: [r] };
      byKey.set(key, g);
      groups.push(g);
    }
  }
  return groups;
}

export interface CategorySection {
  category: ReportCategory;
  groups: ReportGroup[];
}

/** Sections in the catalog's category order; categories with nothing to show are dropped. */
export function sectionsByCategory(groups: ReportGroup[], categories: ReportCategory[]): CategorySection[] {
  return categories
    .map((category) => ({ category, groups: groups.filter((g) => g.category === category.id) }))
    .filter((s) => s.groups.length > 0);
}

function haystack(g: ReportGroup): { title: string; rest: string } {
  const title = g.variants
    .map((v) => v.title)
    .join(" ")
    .toLowerCase();
  const rest = g.variants
    .flatMap((v) => [v.description, v.variant ?? "", ...v.tags])
    .join(" ")
    .toLowerCase();
  return { title, rest };
}

/** Every word of the query must appear (title matches rank first). Empty query returns everything. */
export function searchGroups(groups: ReportGroup[], query: string): ReportGroup[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const scored: { g: ReportGroup; score: number; i: number }[] = [];
  groups.forEach((g, i) => {
    const { title, rest } = haystack(g);
    let score = 0;
    for (const w of words) {
      if (title.includes(w)) score += 2;
      else if (rest.includes(w)) score += 1;
      else return;
    }
    scored.push({ g, score, i });
  });
  return scored.sort((a, b) => b.score - a.score || a.i - b.i).map((s) => s.g);
}

/** The group a report belongs to (for the family switcher). */
export function variantsOf(reports: ReportMeta[], report: ReportMeta): ReportMeta[] {
  if (!report.family) return [report];
  return reports.filter((r) => r.family === report.family && r.category === report.category);
}

/**
 * Filter values for `to` when the user switches from `from` (a variant of the same family): every filter
 * that exists in both with the same key and kind keeps its current value, the rest take their defaults.
 */
export function carryFilters(from: ReportMeta, to: ReportMeta, values: FilterValues): FilterValues {
  const next = defaultValues(to.filters);
  for (const f of to.filters) {
    const old = from.filters.find((x) => x.key === f.key && x.kind === f.kind);
    if (old && values[f.key] !== undefined) next[f.key] = values[f.key];
  }
  return next;
}
