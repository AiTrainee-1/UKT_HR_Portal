// Ticking rows to put on a list (the Daily Leave Report and the Daily Late Report). A tick belongs to an employee (a row id), not
// to a position, so sorting or narrowing the list never loses it: a tick on a row that is not in the list at the moment is kept
// but simply not counted, and comes back when the row does. Pure: every rule has a test (selection.test.ts).

export type SelectState = "none" | "some" | "all";

type HasId = { employeeId: number };

/** The ids of the rows in view that are ticked. */
export const tickedIds = (rows: HasId[], selected: ReadonlySet<number>): number[] =>
  rows.filter((r) => selected.has(r.employeeId)).map((r) => r.employeeId);

/** The rows in view that are ticked, in the order they are in view. */
export const pickedRows = <T extends HasId>(rows: T[], selected: ReadonlySet<number>): T[] =>
  rows.filter((r) => selected.has(r.employeeId));

/** The state of the header box: all the rows in view ticked, some, or none (an empty view is none). */
export function selectState(rows: HasId[], selected: ReadonlySet<number>): SelectState {
  const ticked = tickedIds(rows, selected).length;
  if (ticked === 0) return "none";
  return ticked === rows.length ? "all" : "some";
}

/** One row ticked or unticked (a new set). */
export function toggleId(selected: ReadonlySet<number>, id: number): Set<number> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** The header box: every row in view ticked, or, when they all already are, none of them. Ticks on rows that are not in view
 *  are left as they are. */
export function toggleAllInView(selected: ReadonlySet<number>, rows: HasId[]): Set<number> {
  const next = new Set(selected);
  const all = rows.length > 0 && rows.every((r) => next.has(r.employeeId));
  for (const r of rows) {
    if (all) next.delete(r.employeeId);
    else next.add(r.employeeId);
  }
  return next;
}

/** The ticks that are still on rows of this list: what is left after the list changed (a new date has other people). */
export function pruneSelection(selected: ReadonlySet<number>, rows: HasId[]): Set<number> {
  const present = new Set(rows.map((r) => r.employeeId));
  return new Set([...selected].filter((id) => present.has(id)));
}

export type ExportChoice<T> = {
  /** "selected": only the ticked rows (at least one is ticked); "all": nothing is ticked, so every listed row. */
  mode: "selected" | "all";
  rows: T[];
};

/** What a download of the Daily Late Report contains: the ticked rows when any is ticked, else every row listed. (The Daily
 *  Leave Report is stricter: it exports ONLY ticked rows and does not use this.) */
export function exportChoice<T extends HasId>(rows: T[], selected: ReadonlySet<number>): ExportChoice<T> {
  const ticked = pickedRows(rows, selected);
  return ticked.length > 0 ? { mode: "selected", rows: ticked } : { mode: "all", rows };
}

/** "Exporting 5 selected" / "Exporting all 18": what the buttons will download, in words. */
export const exportScopeText = (choice: ExportChoice<unknown>): string =>
  choice.mode === "selected" ? `Exporting ${choice.rows.length} selected` : `Exporting all ${choice.rows.length}`;
