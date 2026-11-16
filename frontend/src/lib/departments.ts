// Staff and Production departments / designations (owner, 2026-11-16): ONE place that decides which departments and
// designations a page offers. A department is either Staff or Production (`category` on every /api/departments and
// /api/designations row; backend/api/org_category.py), and only employees of that kind belong in it.
//
//  - A page with an employment type (a Staff / Production filter or tab, the employee being edited) offers only that
//    kind:  departmentOptions(rows, { category: categoryForEmploymentType(type) }).
//  - A page that shows everyone offers both, grouped under "Staff" and "Production" so two CUTTINGs can be told apart:
//    departmentOptions(rows) and render with <OrgSelectItems> / <OrgNativeOptions> (lib/org-select.tsx).
//  - When the page's type changes, a picked department of the other kind is dropped: keepIfOffered(id, options).
//
// Rows from a server that predates the split have no `category`: they count as Staff, which is what every department
// was before.

import { useQuery } from "@tanstack/react-query";
import { customFetch } from "@/lib/api-client/custom-fetch";

export type OrgCategory = "staff" | "production";

export const ORG_CATEGORIES: readonly OrgCategory[] = ["staff", "production"];

export const ORG_CATEGORY_LABEL: Record<OrgCategory, string> = { staff: "Staff", production: "Production" };

/** Anything that carries a Staff / Production category (department and designation rows, options). */
export type Categorized = { category?: string | null };

/** A department as /api/departments returns it. */
export type OrgDepartment = {
  id: number;
  name: string;
  description?: string | null;
  category?: OrgCategory | null;
  branchId?: number | null;
  branchName?: string | null;
  /** Active employees in it. */
  employeeCount?: number | null;
};

/** A designation as /api/designations returns it. */
export type OrgDesignation = {
  id: number;
  title: string;
  departmentId?: number | null;
  departmentName?: string | null;
  level?: string | null;
  category?: OrgCategory | null;
  branchId?: number | null;
  employeeCount?: number | null;
};

/** What a picker needs to place an option: its value, what it reads, and the heading it sits under. */
export type OrgChoice = { value: string; label: string; category: OrgCategory };

/** One choice for a department / designation picker. `value` is the id as a string (what <Select> works with). */
export type OrgOption = OrgChoice & {
  id: number;
  /** What the option reads: the name, plus the branch when the same name is offered twice in one kind. */
  label: string;
  /** The name alone. */
  name: string;
  /** "Staff" / "Production": the heading the option sits under when both kinds are offered. */
  group: string;
  departmentId?: number | null;
  branchId?: number | null;
};

/** A choice built from names found in loaded rows (no ids): value is "<category>|<name>" (namedOrgOptions). */
export type NamedOrgOption = OrgChoice & { name: string; group: string };

/** The kind of a department / designation row (Staff when the row has none). */
export function orgCategoryOf(row: Categorized | null | undefined): OrgCategory {
  return row?.category === "production" ? "production" : "staff";
}

/** The kind an employment type (or a page's type filter) selects; null = both (an "All" filter, nothing picked). */
export function categoryForEmploymentType(value: string | null | undefined): OrgCategory | null {
  const text = (value ?? "").trim().toLowerCase();
  if (text === "staff") return "staff";
  if (text === "production" || text === "production employees" || text === "production employee") return "production";
  return null;
}

/** "Staff" / "Production". */
export function orgCategoryLabel(category: OrgCategory | null | undefined): string {
  return category ? ORG_CATEGORY_LABEL[category] : "All";
}

/** The rows of one kind; every row when `category` is null / undefined. */
export function inCategory<T extends Categorized>(
  rows: readonly T[] | null | undefined,
  category?: OrgCategory | null,
): T[] {
  const list = rows ?? [];
  return category ? list.filter((r) => orgCategoryOf(r) === category) : [...list];
}

export type OrgGroup<T> = { category: OrgCategory; label: string; items: T[] };

/** Rows under a Staff heading then a Production one (empty groups left out); only one group when `category` is set. */
export function groupByCategory<T extends Categorized>(
  rows: readonly T[] | null | undefined,
  category?: OrgCategory | null,
): OrgGroup<T>[] {
  return ORG_CATEGORIES.filter((c) => !category || c === category)
    .map((c) => ({ category: c, label: ORG_CATEGORY_LABEL[c], items: inCategory(rows, c) }))
    .filter((g) => g.items.length > 0);
}

/** True when the options hold both kinds (then a picker shows the Staff / Production headings). */
export function hasBothCategories(options: readonly Categorized[]): boolean {
  let staff = false;
  let production = false;
  for (const o of options) {
    if (orgCategoryOf(o) === "production") production = true;
    else staff = true;
    if (staff && production) return true;
  }
  return false;
}

const byName = (a: OrgOption, b: OrgOption) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.label.localeCompare(b.label) || a.id - b.id;

/** Labels that tell apart the same name offered twice in one kind (two branches each with a CUTTING). */
function disambiguate(options: OrgOption[], branchOf: (o: OrgOption) => string | null | undefined): OrgOption[] {
  const seen = new Map<string, number>();
  for (const o of options) {
    const key = `${o.category}|${o.name.trim().toLowerCase()}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return options.map((o) => {
    const twice = (seen.get(`${o.category}|${o.name.trim().toLowerCase()}`) ?? 0) > 1;
    const branch = twice ? branchOf(o) : null;
    return branch ? { ...o, label: `${o.name} · ${branch}` } : o;
  });
}

/** Department choices, sorted by name: only one kind with `category`, both (grouped by the renderer) without. */
export function departmentOptions(
  rows: readonly OrgDepartment[] | null | undefined,
  opts: { category?: OrgCategory | null; branchId?: number | null } = {},
): OrgOption[] {
  const branchNames = new Map<number, string>();
  const out = inCategory(rows, opts.category)
    .filter((d) => opts.branchId == null || d.branchId == null || d.branchId === opts.branchId)
    .map((d): OrgOption => {
      const category = orgCategoryOf(d);
      if (d.branchId != null && d.branchName) branchNames.set(d.branchId, d.branchName);
      return {
        id: d.id,
        value: String(d.id),
        label: d.name,
        name: d.name,
        category,
        group: ORG_CATEGORY_LABEL[category],
        branchId: d.branchId ?? null,
      };
    });
  return disambiguate(out, (o) => (o.branchId != null ? branchNames.get(o.branchId) : null)).sort(byName);
}

/** Designation choices, sorted by title: one kind with `category`, optionally only one department's. */
export function designationOptions(
  rows: readonly OrgDesignation[] | null | undefined,
  opts: { category?: OrgCategory | null; departmentId?: number | null } = {},
): OrgOption[] {
  const out = inCategory(rows, opts.category)
    .filter((d) => opts.departmentId == null || d.departmentId === opts.departmentId)
    .map((d): OrgOption => {
      const category = orgCategoryOf(d);
      return {
        id: d.id,
        value: String(d.id),
        label: d.title,
        name: d.title,
        category,
        group: ORG_CATEGORY_LABEL[category],
        departmentId: d.departmentId ?? null,
        branchId: d.branchId ?? null,
      };
    });
  const deptNames = new Map<number, string>();
  for (const d of rows ?? [])
    if (d.departmentId != null && d.departmentName) deptNames.set(d.departmentId, d.departmentName);
  return disambiguate(out, (o) => (o.departmentId != null ? deptNames.get(o.departmentId) : null)).sort(byName);
}

/**
 * A single label for places that cannot show group headings (a chip, an export, a checklist): the option's label,
 * plus " (Staff)" / " (Production)" when `withCategory` (pass hasBothCategories(options)).
 */
export function optionText(option: { label: string; group: string }, withCategory: boolean): string {
  return withCategory ? `${option.label} (${option.group})` : option.label;
}

/**
 * Department (or designation) choices for a page that only has NAMES in its rows (a request list, a report table):
 * each name once per kind, the kind taken from the row's employee type, sorted by name. Filter rows with
 * matchesNamedOrgOption(value, row's name, row's employment type). With `category`, only that kind's names.
 */
export function namedOrgOptions<T>(
  rows: readonly T[] | null | undefined,
  nameOf: (row: T) => string | null | undefined,
  employmentTypeOf: (row: T) => string | null | undefined,
  category?: OrgCategory | null,
): NamedOrgOption[] {
  const seen = new Map<string, NamedOrgOption>();
  for (const r of rows ?? []) {
    const name = (nameOf(r) ?? "").trim();
    if (!name) continue;
    const kind = categoryForEmploymentType(employmentTypeOf(r)) ?? "staff";
    if (category && kind !== category) continue;
    const value = `${kind}|${name}`;
    if (!seen.has(value)) {
      seen.set(value, { value, label: name, name, category: kind, group: ORG_CATEGORY_LABEL[kind] });
    }
  }
  return [...seen.values()].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.value.localeCompare(b.value),
  );
}

/** Does a row (its department / designation name and its employee's type) match a namedOrgOptions value ("all" = any)? */
export function matchesNamedOrgOption(
  value: string | null | undefined,
  name: string | null | undefined,
  employmentType: string | null | undefined,
): boolean {
  if (!value || value === "all") return true;
  const cut = value.indexOf("|");
  if (cut < 0) return (name ?? "").trim() === value; // a plain name (an older saved filter)
  const kind = value.slice(0, cut);
  return (
    (name ?? "").trim() === value.slice(cut + 1) && (categoryForEmploymentType(employmentType) ?? "staff") === kind
  );
}

/** The value back when it is still offered, else `fallback` ("all", "" or null): for a filter whose type switch moved. */
export function keepIfOffered<F>(
  value: string | number | null | undefined,
  options: readonly OrgChoice[],
  fallback: F,
) {
  if (value == null || value === "") return fallback;
  const v = String(value);
  return options.some((o) => o.value === v) ? v : fallback;
}

// ── Data ─────────────────────────────────────────────────────────────────────
// The lists are fetched ONCE (both kinds) under the generated client's keys ("/api/departments", "/api/designations"),
// so every existing invalidation refreshes them, and filtered here.

export const listOrgDepartments = () => customFetch<OrgDepartment[]>("/api/departments");

/** Every department the user may see (both kinds), or only one kind with `category`. */
export function useOrgDepartments(category?: OrgCategory | null, options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ["/api/departments"] as const,
    queryFn: listOrgDepartments,
    enabled: options.enabled ?? true,
  });
  const all = query.data ?? [];
  return { ...query, all, data: category ? inCategory(all, category) : all };
}

/** Every designation the user may see (both kinds), or only one kind with `category`. */
export function useOrgDesignations(category?: OrgCategory | null, options: { enabled?: boolean } = {}) {
  const query = useQuery({
    queryKey: ["/api/designations", undefined] as const,
    queryFn: () => customFetch<OrgDesignation[]>("/api/designations"),
    enabled: options.enabled ?? true,
  });
  const all = query.data ?? [];
  return { ...query, all, data: category ? inCategory(all, category) : all };
}
