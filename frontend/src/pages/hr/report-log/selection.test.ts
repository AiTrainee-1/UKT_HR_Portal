import { describe, expect, it } from "vitest";
import {
  exportChoice,
  exportScopeText,
  pickedRows,
  pruneSelection,
  selectState,
  tickedIds,
  toggleAllInView,
  toggleId,
} from "./selection";

const rows = (...ids: number[]) => ids.map((employeeId) => ({ employeeId, name: `P${employeeId}` }));
const set = (...ids: number[]) => new Set(ids);

describe("what is ticked in view", () => {
  it("counts only the rows in view, in the order they are in view", () => {
    const view = rows(5, 3, 9);
    expect(tickedIds(view, set(9, 5, 100))).toEqual([5, 9]);
    expect(pickedRows(view, set(9, 5, 100)).map((r) => r.name)).toEqual(["P5", "P9"]);
  });
  it("is none, some or all for the header box", () => {
    const view = rows(1, 2, 3);
    expect(selectState(view, set())).toBe("none");
    expect(selectState(view, set(2))).toBe("some");
    expect(selectState(view, set(1, 2, 3))).toBe("all");
    expect(selectState(view, set(1, 2, 3, 40))).toBe("all"); // a tick on a row that is not in view does not matter
    expect(selectState(view, set(40))).toBe("none");
    expect(selectState([], set(1))).toBe("none"); // an empty view has nothing to be all of
  });
});

describe("ticking", () => {
  it("ticks and unticks one row without changing the set it was given", () => {
    const start = set(1);
    const added = toggleId(start, 2);
    expect([...added].sort()).toEqual([1, 2]);
    expect([...toggleId(added, 1)]).toEqual([2]);
    expect([...start]).toEqual([1]);
  });
  it("ticks every row in view from none or some, and unticks them when all are ticked", () => {
    const view = rows(1, 2, 3);
    expect([...toggleAllInView(set(), view)].sort()).toEqual([1, 2, 3]);
    expect([...toggleAllInView(set(2), view)].sort()).toEqual([1, 2, 3]);
    expect([...toggleAllInView(set(1, 2, 3), view)]).toEqual([]);
  });
  it("leaves the ticks of rows that are not in view alone", () => {
    const view = rows(1, 2);
    expect([...toggleAllInView(set(99), view)].sort((a, b) => a - b)).toEqual([1, 2, 99]);
    expect([...toggleAllInView(set(1, 2, 99), view)]).toEqual([99]);
  });
  it("does nothing for an empty view", () => {
    expect([...toggleAllInView(set(7), [])]).toEqual([7]);
  });
  it("keeps a tick through a re-order of the same people", () => {
    const selected = set(2);
    expect(tickedIds(rows(1, 2, 3), selected)).toEqual(tickedIds(rows(3, 2, 1), selected));
  });
  it("prunes the ticks to the people of a new list", () => {
    expect([...pruneSelection(set(1, 2, 3), rows(2, 3, 4))].sort()).toEqual([2, 3]);
    expect([...pruneSelection(set(1), [])]).toEqual([]);
  });
});

describe("what a Daily Late Report download holds", () => {
  const view = rows(4, 8, 15, 16);
  it("is every row listed when nothing is ticked", () => {
    const choice = exportChoice(view, set());
    expect(choice.mode).toBe("all");
    expect(choice.rows).toBe(view);
    expect(exportScopeText(choice)).toBe("Exporting all 4");
  });
  it("is only the ticked rows, in the order of the list, when any is ticked", () => {
    const choice = exportChoice(view, set(16, 8));
    expect(choice.mode).toBe("selected");
    expect(choice.rows.map((r) => r.employeeId)).toEqual([8, 16]);
    expect(exportScopeText(choice)).toBe("Exporting 2 selected");
  });
  it("is every row listed when the only ticks are on people who are not listed now", () => {
    const choice = exportChoice(view, set(99));
    expect(choice.mode).toBe("all");
    expect(choice.rows).toHaveLength(4);
  });
  it("is everything, all ticked, when all are ticked", () => {
    const choice = exportChoice(view, set(4, 8, 15, 16));
    expect(choice).toMatchObject({ mode: "selected" });
    expect(choice.rows).toHaveLength(4);
    expect(exportScopeText(choice)).toBe("Exporting 4 selected");
  });
  it("says so for a list of one and for an empty list", () => {
    expect(exportScopeText(exportChoice(rows(1), set()))).toBe("Exporting all 1");
    expect(exportScopeText(exportChoice([], set()))).toBe("Exporting all 0");
  });
});
