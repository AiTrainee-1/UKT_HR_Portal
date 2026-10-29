// The payroll rows split by department, for a page that lists one department at a time (a strip of department tabs over the
// list). Pure data: the page decides which rows go in, this says which departments they make up and which one is open.

import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import { NO_DEPARTMENT, departmentOptionsFromRuns } from "../filters/filter-logic";

export type DepartmentGroup = {
  /** The department id as text, or `NO_DEPARTMENT` for rows without one. */
  id: string;
  name: string;
  /** Payroll rows in the department. */
  count: number;
  /** The department's net payable. */
  net: number;
};

/** The id a row belongs under: its department id as text, `NO_DEPARTMENT` when it has none. */
export const runDepartmentId = (run: PayrollRunItem): string =>
  run.departmentId === null || run.departmentId === undefined ? NO_DEPARTMENT : String(run.departmentId);

const netOf = (run: PayrollRunItem): number => {
  const v = Number(run.finalSalary);
  return Number.isFinite(v) ? v : 0;
};

/** One group per department the rows belong to, by name ("No department" last), each with its row count and net. */
export function departmentGroups(runs: readonly PayrollRunItem[] | null | undefined): DepartmentGroup[] {
  const totals = new Map<string, { count: number; net: number }>();
  for (const run of runs ?? []) {
    const id = runDepartmentId(run);
    const t = totals.get(id) ?? { count: 0, net: 0 };
    t.count += 1;
    t.net += netOf(run);
    totals.set(id, t);
  }
  return departmentOptionsFromRuns(runs).map((o) => {
    const id = String(o.id);
    const t = totals.get(id) ?? { count: 0, net: 0 };
    return { id, name: o.name, count: t.count, net: t.net };
  });
}

/** The department to show: the one asked for when the rows have it, otherwise the first; null when there are no rows. */
export function pickDepartment(groups: readonly DepartmentGroup[], wanted: string | null | undefined): string | null {
  if (groups.length === 0) return null;
  return groups.some((g) => g.id === wanted) ? (wanted as string) : groups[0].id;
}

/** The rows of one department, in the order given (null gives nothing). */
export function runsOfDepartment(runs: readonly PayrollRunItem[], id: string | null): PayrollRunItem[] {
  return id === null ? [] : runs.filter((run) => runDepartmentId(run) === id);
}
