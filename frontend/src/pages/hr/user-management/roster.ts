import type { RosterDepartment, RosterEmployee, RosterState } from "@/lib/api-client/custom-hooks";
import type { Tone } from "@/lib/statusTones";

// The employees of a Department Head's departments, as the manager page lists and filters them. The rules for who
// really reports to whom live on the server (backend/api/hod_scope.py); this only decides how the list is shown.

export type RosterFilter = "all" | "reporting" | "removed" | "elsewhere";

export const ROSTER_FILTERS: { value: RosterFilter; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "reporting", label: "Reporting" },
  { value: "removed", label: "Removed" },
  { value: "elsewhere", label: "Another HOD" },
];

export const STATE_META: Record<RosterState, { label: string; tone: Tone }> = {
  reporting: { label: "Reporting", tone: "success" },
  removed: { label: "Removed", tone: "neutral" },
  elsewhere: { label: "Another HOD", tone: "warning" },
  self: { label: "Department head", tone: "info" },
};

/** How many rows a department shows before "Show more". */
export const PAGE_SIZE = 40;

export const isActive = (e: RosterEmployee) => e.status === "active";

/** Only someone who reports to this HOD can be removed from them. */
export const canRemove = (e: RosterEmployee) => e.state === "reporting";

export const canRestore = (e: RosterEmployee) => e.state === "removed";

/** In the department but reporting to a different HOD: this HOD can claim them. */
export const canClaim = (e: RosterEmployee) => e.state === "elsewhere";

function matchesQuery(e: RosterEmployee, q: string): boolean {
  if (!q) return true;
  return (
    e.name.toLowerCase().includes(q) ||
    e.employeeCode.toLowerCase().includes(q) ||
    (e.designation ?? "").toLowerCase().includes(q)
  );
}

/** The rows to show for a filter and a search: the head first, then everybody in the server's (name) order with the
 *  employees who have left (not active) at the bottom. */
export function filterRoster(employees: RosterEmployee[], filter: RosterFilter, query: string): RosterEmployee[] {
  const q = query.trim().toLowerCase();
  const rank = (e: RosterEmployee) => (e.state === "self" ? 0 : isActive(e) ? 1 : 2);
  return employees
    .filter((e) => (filter === "all" || e.state === filter) && matchesQuery(e, q))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i)
    .map(({ e }) => e);
}

/** The number on each filter chip (the head counts toward Everyone only). */
export function filterCounts(employees: RosterEmployee[]): Record<RosterFilter, number> {
  const counts: Record<RosterFilter, number> = { all: employees.length, reporting: 0, removed: 0, elsewhere: 0 };
  for (const e of employees) if (e.state !== "self") counts[e.state] += 1;
  return counts;
}

/** The people in `rows` who can be removed (the checkbox column's "select all"). */
export const removable = (rows: RosterEmployee[]) => rows.filter(canRemove);

/** '12 reporting · 2 removed · 1 with another HOD' for a department's header; empty parts are left out. */
export function departmentSummary(counts: RosterDepartment["counts"]): string {
  const parts = [`${counts.reporting} reporting`];
  if (counts.removed) parts.push(`${counts.removed} removed`);
  if (counts.elsewhere) parts.push(`${counts.elsewhere} with another HOD`);
  return parts.join(" · ");
}

/** Where a removed person's requests go: the next HOD who holds the department, otherwise HR. */
export function removedDestination(e: RosterEmployee): string {
  return e.manager ? `Requests go to ${e.manager.employeeName}` : "Requests go to HR";
}

/** The second line of a row: the designation (when there is one) and, for the states that need it, the consequence. */
export function rowDetail(e: RosterEmployee): string {
  const parts: string[] = [];
  if (e.designation) parts.push(e.designation);
  if (e.state === "removed") parts.push(removedDestination(e));
  else if (e.state === "elsewhere" && e.manager) {
    parts.push(`Reports to ${e.manager.employeeName}${e.via === "direct" ? " (assigned individually)" : ""}`);
  }
  return parts.join(" · ");
}

/** What removing `count` people means, said once above the list so nobody has to guess. */
export const REMOVE_EXPLANATION =
  "Removing someone does not take them out of the department. They simply stop reporting to this HOD, so their requests " +
  "go to the next HOD who holds the department, or to HR. You can put them back at any time.";

export function pageSlice<T>(rows: T[], shown: number): { rows: T[]; hidden: number } {
  const visible = rows.slice(0, shown);
  return { rows: visible, hidden: rows.length - visible.length };
}

/** A department section starts open when it is the first one, or the one just added. */
export function initialOpen(departments: RosterDepartment[], justAdded: number | null): Set<number> {
  const open = new Set<number>();
  if (departments.length > 0) open.add(departments[0].id);
  if (justAdded !== null) open.add(justAdded);
  return open;
}
