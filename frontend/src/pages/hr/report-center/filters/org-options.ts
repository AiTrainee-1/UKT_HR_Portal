// The Department / Designation filters of a report: Staff and production have their own (lib/departments.ts), so the
// report's Employee type decides which kind is offered, and with no type picked both kinds are, under two headings.

import {
  categoryForEmploymentType,
  departmentOptions,
  designationOptions,
  hasBothCategories,
  type OrgCategory,
  type OrgOption,
} from "@/lib/departments";
import type { FilterValue, NamedOption } from "@/lib/report-center";
import type { MultiOption } from "./MultiSelectFilter";

/** The kind the report's Employee type filter is on (null: all types, or the report has no such filter). */
export function reportOrgKind(employmentType: FilterValue | undefined): OrgCategory | null {
  return categoryForEmploymentType(typeof employmentType === "string" ? employmentType : null);
}

/** The picker's choices: only `kind`'s when one is set, both kinds grouped under Staff / Production otherwise. */
export function orgFilterOptions(
  what: "department" | "designation",
  list: readonly NamedOption[],
  kind: OrgCategory | null,
): MultiOption[] {
  const opts: OrgOption[] =
    what === "department"
      ? departmentOptions(
          list.map((o) => ({
            id: o.id,
            name: o.name,
            category: o.category ?? null,
            branchId: o.branchId ?? null,
            branchName: o.branchName ?? null,
          })),
          { category: kind },
        )
      : designationOptions(
          list.map((o) => ({ id: o.id, title: o.name, category: o.category ?? null, departmentId: o.departmentId })),
          { category: kind },
        );
  const grouped = hasBothCategories(opts);
  // grouped: Staff first, then Production, each by name (departmentOptions sorts by name only)
  const ordered = grouped
    ? [...opts].sort((a, b) => (a.category === b.category ? 0 : a.category === "staff" ? -1 : 1))
    : opts;
  return ordered.map((o) => ({ value: o.value, label: o.label, ...(grouped ? { group: o.group } : {}) }));
}

/** The picked values still offered (a kind switch drops the other kind's). */
export function prunePicked(picked: readonly string[], options: readonly MultiOption[]): string[] {
  const offered = new Set(options.map((o) => o.value));
  return picked.filter((v) => offered.has(v));
}
