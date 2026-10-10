// Departments / Designations: the rules behind the two pages, kept apart from the screens so they can be tested on their
// own (search, filters, sorting, the Branch -> Department -> Designation tree, the staff / production split).

import type { Tone } from "@/lib/statusTones";
import type { BranchRef, DepartmentRow, DesignationRow, DesignationsTree, Headcount, Person, Unassigned } from "./api";

/** "none" in a branch / department / level filter: rows that have no branch, no department, or no level. */
export const NONE = "none";

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Every word of the query must appear somewhere in the row's text (any order, any case). */
export function matchesAll(parts: (string | null | undefined)[], query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = parts
    .filter((p): p is string => !!p)
    .join(" ")
    .toLowerCase();
  return words.every((w) => text.includes(w));
}

// ─── Staff / production ─────────────────────────────────────────────────────────

export const TYPE_LABEL: Record<string, string> = { staff: "Staff", production: "Production" };

export const typeLabel = (t: string | null | undefined) =>
  (t && TYPE_LABEL[t]) || (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Staff");

/** The two shares of a split bar, in whole percent that add up to 100 (0 / 0 when there is nobody). */
export function splitPercent(staff: number, production: number): { staff: number; production: number } {
  const total = staff + production;
  if (total <= 0) return { staff: 0, production: 0 };
  const s = Math.round((staff / total) * 100);
  return { staff: s, production: 100 - s };
}

// ─── Departments ────────────────────────────────────────────────────────────────

export type DeptFilters = {
  query: string;
  /** "all", a branch id, or NONE (departments that have no branch). */
  branch: string;
  show: "all" | "with" | "empty";
};

export const NO_DEPT_FILTERS: DeptFilters = { query: "", branch: "all", show: "all" };

export const deptFiltersActive = (f: DeptFilters) => f.query.trim() !== "" || f.branch !== "all" || f.show !== "all";

export function filterDepartments(rows: DepartmentRow[], f: DeptFilters): DepartmentRow[] {
  return rows.filter((d) => {
    if (!matchesAll([d.name, d.description, d.branchName], f.query)) return false;
    if (f.branch === NONE ? d.branchId != null : f.branch !== "all" && String(d.branchId) !== f.branch) return false;
    if (f.show === "with" && d.active === 0) return false;
    if (f.show === "empty" && d.active !== 0) return false;
    return true;
  });
}

export type DeptSort = "name-asc" | "name-desc" | "total-desc" | "total-asc" | "staff-desc" | "production-desc";

export const DEPT_SORTS: { value: DeptSort; label: string }[] = [
  { value: "name-asc", label: "Name A to Z" },
  { value: "name-desc", label: "Name Z to A" },
  { value: "total-desc", label: "Most employees" },
  { value: "total-asc", label: "Fewest employees" },
  { value: "staff-desc", label: "Most staff" },
  { value: "production-desc", label: "Most production" },
];

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

export function sortDepartments(rows: DepartmentRow[], sort: DeptSort): DepartmentRow[] {
  const key: Record<DeptSort, (a: DepartmentRow, b: DepartmentRow) => number> = {
    "name-asc": (a, b) => byName(a.name, b.name),
    "name-desc": (a, b) => byName(b.name, a.name),
    "total-desc": (a, b) => b.active - a.active,
    "total-asc": (a, b) => a.active - b.active,
    "staff-desc": (a, b) => b.activeStaff - a.activeStaff,
    "production-desc": (a, b) => b.activeProduction - a.activeProduction,
  };
  // ties (and the equal counts of a young company) fall back to the name, so the order never jumps around
  return [...rows].sort((a, b) => key[sort](a, b) || byName(a.name, b.name) || a.id - b.id);
}

export type DeptSummary = {
  departments: number;
  branches: number;
  /** Active employees in a department. */
  active: number;
  staff: number;
  production: number;
  inactive: number;
  /** Departments with no active employee. */
  empty: number;
  /** Active employees with no department at all (not in `active`). */
  unassigned: number;
};

export function summarizeDepartments(rows: DepartmentRow[], unassigned: Unassigned | undefined): DeptSummary {
  return {
    departments: rows.length,
    branches: new Set(rows.map((d) => d.branchId ?? "none")).size,
    active: rows.reduce((n, d) => n + d.active, 0),
    staff: rows.reduce((n, d) => n + d.activeStaff, 0),
    production: rows.reduce((n, d) => n + d.activeProduction, 0),
    inactive: rows.reduce((n, d) => n + d.inactive, 0),
    empty: rows.filter((d) => d.active === 0).length,
    unassigned: unassigned?.active ?? 0,
  };
}

/** What deleting the department does, one sentence each, for the confirmation. Mirrors the database rules: employees
 *  and designations keep existing (their department is cleared), the department's own settings go with it. */
export function departmentDeleteImpact(d: DepartmentRow): string[] {
  const lines: string[] = [];
  const people = d.active + d.inactive;
  lines.push(
    people === 0
      ? "Nobody is in this department."
      : `${plural(people, "employee")} (${d.active} active${d.inactive ? `, ${d.inactive} inactive` : ""}) will be left with no department. They are not deleted.`,
  );
  if (d.designationCount > 0) {
    lines.push(
      `${plural(d.designationCount, "designation")} will lose ${d.designationCount === 1 ? "its" : "their"} department and move to Unassigned.`,
    );
  }
  if (d.hodCount > 0) {
    lines.push(`${plural(d.hodCount, "head of department")} will no longer cover it.`);
  }
  lines.push("Its required-role targets, hiring rules and department chat channel are deleted with it.");
  return lines;
}

// ─── Designation levels ─────────────────────────────────────────────────────────

export const LEVELS: { value: string; label: string; tone: Tone }[] = [
  { value: "junior", label: "Junior", tone: "neutral" },
  { value: "mid", label: "Mid", tone: "info" },
  { value: "senior", label: "Senior", tone: "accent" },
  { value: "manager", label: "Manager", tone: "caution" },
  { value: "executive", label: "Executive", tone: "success" },
];

export type LevelInfo = { key: string; label: string; tone: Tone; rank: number };

/** The level of a designation. The create form used to leave it blank and the server then stored "staff", so both
 *  mean "no level"; anything else that is not one of the five (a free-text level from the old form) is kept as typed. */
export function levelInfo(raw: string | null | undefined): LevelInfo {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "" || key === "staff") return { key: "", label: "Not set", tone: "neutral", rank: 99 };
  const i = LEVELS.findIndex((l) => l.value === key);
  if (i >= 0) return { key, label: LEVELS[i].label, tone: LEVELS[i].tone, rank: i };
  return { key, label: key.charAt(0).toUpperCase() + key.slice(1), tone: "neutral", rank: 50 };
}

// ─── Designations ───────────────────────────────────────────────────────────────

export type DesigFilters = {
  query: string;
  branch: string;
  department: string;
  /** "all", a level key, or NONE (no level). */
  level: string;
  /** Only designations nobody active holds. */
  empty: boolean;
};

export const NO_DESIG_FILTERS: DesigFilters = {
  query: "",
  branch: "all",
  department: "all",
  level: "all",
  empty: false,
};

export const desigFiltersActive = (f: DesigFilters) =>
  f.query.trim() !== "" || f.branch !== "all" || f.department !== "all" || f.level !== "all" || f.empty;

export function filterDesignations(rows: DesignationRow[], f: DesigFilters): DesignationRow[] {
  return rows.filter((d) => {
    // the department and the branch are searchable too: "cutting" finds every designation of that department
    if (!matchesAll([d.title, d.departmentName, d.branchName, levelInfo(d.level).label], f.query)) return false;
    if (f.branch === NONE ? d.branchId != null : f.branch !== "all" && String(d.branchId) !== f.branch) return false;
    if (
      f.department === NONE ? d.departmentId != null : f.department !== "all" && String(d.departmentId) !== f.department
    )
      return false;
    if (f.level !== "all") {
      const key = levelInfo(d.level).key;
      if (f.level === NONE ? key !== "" : key !== f.level) return false;
    }
    if (f.empty && d.active !== 0) return false;
    return true;
  });
}

export type DesigSort = "title-asc" | "title-desc" | "department" | "level" | "employees-desc" | "employees-asc";

export const DESIG_SORTS: { value: DesigSort; label: string }[] = [
  { value: "title-asc", label: "Title A to Z" },
  { value: "title-desc", label: "Title Z to A" },
  { value: "department", label: "Department" },
  { value: "level", label: "Level (junior first)" },
  { value: "employees-desc", label: "Most employees" },
  { value: "employees-asc", label: "Fewest employees" },
];

export function sortDesignations(rows: DesignationRow[], sort: DesigSort): DesignationRow[] {
  const key: Record<DesigSort, (a: DesignationRow, b: DesignationRow) => number> = {
    "title-asc": (a, b) => byName(a.title, b.title),
    "title-desc": (a, b) => byName(b.title, a.title),
    // designations with no department go last
    department: (a, b) => byName(a.departmentName ?? "￿", b.departmentName ?? "￿"),
    level: (a, b) => levelInfo(a.level).rank - levelInfo(b.level).rank,
    "employees-desc": (a, b) => b.active - a.active,
    "employees-asc": (a, b) => a.active - b.active,
  };
  return [...rows].sort((a, b) => key[sort](a, b) || byName(a.title, b.title) || a.id - b.id);
}

export type DesigSummary = {
  designations: number;
  /** Departments that have at least one designation. */
  departments: number;
  /** Active employees who hold a designation. */
  active: number;
  staff: number;
  production: number;
  /** Designations nobody active holds. */
  empty: number;
  /** Active employees with no designation (not in `active`). */
  unassigned: number;
};

export function summarizeDesignations(tree: DesignationsTree): DesigSummary {
  const rows = tree.designations;
  return {
    designations: rows.length,
    departments: new Set(rows.map((d) => d.departmentId).filter((id) => id != null)).size,
    active: rows.reduce((n, d) => n + d.active, 0),
    staff: rows.reduce((n, d) => n + d.activeStaff, 0),
    production: rows.reduce((n, d) => n + d.activeProduction, 0),
    empty: rows.filter((d) => d.active === 0).length,
    unassigned: tree.unassigned.active,
  };
}

export function designationDeleteImpact(d: DesignationRow): string[] {
  const people = d.active + d.inactive;
  return [
    people === 0
      ? "Nobody holds this designation."
      : `${plural(people, "employee")} (${d.active} active${d.inactive ? `, ${d.inactive} inactive` : ""}) will be left with no designation. They are not deleted and stay in their department.`,
  ];
}

// ─── The tree: Branch -> Department -> Designation ──────────────────────────────

export type Totals = Headcount & { designations: number };

export type DeptNode = {
  key: string;
  id: number;
  name: string;
  designations: DesignationRow[];
  totals: Totals;
  /** Active people of the department who hold none of its designations (only meaningful when nothing is filtered). */
  withoutDesignation: number;
};

export type BranchNode = {
  key: string;
  /** "branch": a real branch · "no-branch": departments that have none · "unassigned": designations with no department. */
  kind: "branch" | "no-branch" | "unassigned";
  id: number | null;
  name: string;
  departments: DeptNode[];
  /** Only for "unassigned": the designations themselves. */
  designations: DesignationRow[];
  totals: Totals & { departments: number };
};

const zero = (): Totals => ({
  activeStaff: 0,
  activeProduction: 0,
  activeOther: 0,
  active: 0,
  inactive: 0,
  designations: 0,
});

function addTo(t: Totals, d: DesignationRow) {
  t.activeStaff += d.activeStaff;
  t.activeProduction += d.activeProduction;
  t.activeOther += d.activeOther;
  t.active += d.active;
  t.inactive += d.inactive;
  t.designations += 1;
}

/**
 * The tree the page draws, from the designations that passed the filters.
 *
 * A department or branch with no designation at all is still shown (that is how HR sees what is missing), but only while
 * nothing narrows the view to designations: an active level / "no employees" / department filter, or a search that does
 * not name the department or branch, leaves it out. Departments are never shown without their branch, nor designations
 * without a department except under the Unassigned group.
 */
export function buildTree(tree: DesignationsTree, filtered: DesignationRow[], f: DesigFilters): BranchNode[] {
  const byDept = new Map<number, DesignationRow[]>();
  const loose: DesignationRow[] = [];
  for (const d of sortDesignations(filtered, "title-asc")) {
    if (d.departmentId == null) loose.push(d);
    else byDept.set(d.departmentId, [...(byDept.get(d.departmentId) ?? []), d]);
  }
  const hasDesignations = new Set(tree.designations.map((d) => d.departmentId));
  const designationsOnly = f.level !== "all" || f.empty;

  const branchOf = (id: number | null, fallback: string | null): string =>
    (id != null ? tree.branches.find((b) => b.id === id)?.name : null) ?? fallback ?? "Branch";

  const passesBranch = (branchId: number | null) =>
    f.branch === "all" ? true : f.branch === NONE ? branchId == null : String(branchId) === f.branch;

  const deptNodes = new Map<number | null, DeptNode[]>();
  for (const dept of [...tree.departments].sort((a, b) => byName(a.name, b.name) || a.id - b.id)) {
    const own = byDept.get(dept.id) ?? [];
    let show = own.length > 0;
    if (!show && !hasDesignations.has(dept.id) && !designationsOnly && passesBranch(dept.branchId)) {
      const deptOk = f.department === "all" || f.department === String(dept.id);
      show = deptOk && matchesAll([dept.name, dept.branchName], f.query);
    }
    if (!show) continue;
    const totals = zero();
    own.forEach((d) => addTo(totals, d));
    const all = tree.designations.filter((d) => d.departmentId === dept.id);
    const heldActive = all.reduce((n, d) => n + d.active, 0);
    const node: DeptNode = {
      key: `d:${dept.id}`,
      id: dept.id,
      name: dept.name,
      designations: own,
      totals,
      withoutDesignation: Math.max(0, dept.active - heldActive),
    };
    deptNodes.set(dept.branchId, [...(deptNodes.get(dept.branchId) ?? []), node]);
  }

  const nodes: BranchNode[] = [];
  const makeNode = (kind: BranchNode["kind"], id: number | null, name: string, departments: DeptNode[]) => {
    const totals = { ...zero(), departments: departments.length };
    departments.forEach((d) => {
      totals.activeStaff += d.totals.activeStaff;
      totals.activeProduction += d.totals.activeProduction;
      totals.activeOther += d.totals.activeOther;
      totals.active += d.totals.active;
      totals.inactive += d.totals.inactive;
      totals.designations += d.totals.designations;
    });
    nodes.push({ key: kind === "branch" ? `b:${id}` : kind, kind, id, name, departments, designations: [], totals });
    return nodes[nodes.length - 1];
  };

  const branches: BranchRef[] = [...tree.branches].sort((a, b) => byName(a.name, b.name));
  for (const b of branches) {
    const depts = deptNodes.get(b.id) ?? [];
    // a branch with no department yet is listed too, unless the view is narrowed to something it cannot match
    const bare =
      depts.length === 0 &&
      !designationsOnly &&
      f.department === "all" &&
      passesBranch(b.id) &&
      matchesAll([b.name], f.query) &&
      !tree.departments.some((d) => d.branchId === b.id);
    if (depts.length > 0 || bare) makeNode("branch", b.id, branchOf(b.id, b.name), depts);
  }
  // departments of a branch that is not in the list (a switched-off branch keeps its departments)
  for (const [branchId, depts] of deptNodes) {
    if (branchId != null && branches.some((b) => b.id === branchId)) continue;
    if (branchId == null) continue;
    const name = tree.departments.find((d) => d.branchId === branchId)?.branchName ?? "Branch";
    makeNode("branch", branchId, name, depts);
  }
  const noBranch = deptNodes.get(null);
  if (noBranch?.length) makeNode("no-branch", null, "No branch", noBranch);

  if (loose.length > 0) {
    const group = makeNode("unassigned", null, "Unassigned", []);
    group.designations = loose;
    loose.forEach((d) => addTo(group.totals, d));
  }
  return nodes;
}

/** Every key that can be opened or closed in the tree, for Expand all. */
export function allNodeKeys(nodes: BranchNode[]): string[] {
  return nodes.flatMap((b) => [b.key, ...b.departments.map((d) => d.key)]);
}

// ─── The people drawer ──────────────────────────────────────────────────────────

export type PeopleFilters = {
  query: string;
  type: "all" | "staff" | "production";
  status: "active" | "inactive" | "all";
};

export const NO_PEOPLE_FILTERS: PeopleFilters = { query: "", type: "all", status: "active" };

export function filterPeople(people: Person[], f: PeopleFilters): Person[] {
  return people.filter((p) => {
    if (f.status === "active" ? p.status !== "active" : f.status === "inactive" && p.status === "active") return false;
    if (f.type !== "all" && p.employmentType !== f.type) return false;
    return matchesAll(
      [p.name, p.employeeCode, p.designationTitle, p.departmentName, typeLabel(p.employmentType)],
      f.query,
    );
  });
}

export function summarizePeople(people: Person[]) {
  const active = people.filter((p) => p.status === "active");
  return {
    active: active.length,
    staff: active.filter((p) => p.employmentType === "staff").length,
    production: active.filter((p) => p.employmentType === "production").length,
    inactive: people.length - active.length,
  };
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join("") || "?";

// ─── Export ─────────────────────────────────────────────────────────────────────

/** The sheet of the Departments export: a header row, then a row per department. */
export function departmentSheet(rows: DepartmentRow[]): (string | number)[][] {
  return [
    [
      "Department",
      "Branch",
      "Description",
      "Active staff",
      "Active production",
      "Active total",
      "Inactive",
      "Designations",
    ],
    ...rows.map((d) => [
      d.name,
      d.branchName ?? "",
      d.description ?? "",
      d.activeStaff,
      d.activeProduction,
      d.active,
      d.inactive,
      d.designationCount,
    ]),
  ];
}

export function designationSheet(rows: DesignationRow[]): (string | number)[][] {
  return [
    ["Branch", "Department", "Designation", "Level", "Active staff", "Active production", "Active total", "Inactive"],
    ...rows.map((d) => [
      d.branchName ?? "",
      d.departmentName ?? "Unassigned",
      d.title,
      levelInfo(d.level).label,
      d.activeStaff,
      d.activeProduction,
      d.active,
      d.inactive,
    ]),
  ];
}
