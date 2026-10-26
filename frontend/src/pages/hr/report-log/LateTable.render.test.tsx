import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LateTable from "./LateTable";
import { DEFAULT_SORT, flattenGroups, groupEntriesByUnit, sortEntries, type LateEntry, type LateGroup } from "./late";

// The Daily Late Report's table: the tick column (a box per row and one in the header that ticks everything in view, dimmed when
// only some are ticked), what a click calls, and that a tick stays on its row when the order changes. (The page with real data
// and the downloads: e2e/report-log.spec.ts.)

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const entry = (id: number, name: string, minutesLate: number, unit = "HO"): LateEntry => ({
  employeeId: id,
  name,
  code: `E${id}`,
  department: "Admin",
  unit,
  unitKey: unit === "HO" ? "1" : "2",
  branchName: unit === "HO" ? "Head Office" : "Unit One",
  shiftStart: "09:00",
  grace: 15,
  lateDeadline: "09:15",
  punchIn: "10:00",
  minutesLate,
  minutesAfterStart: minutesLate + 15,
});

const ENTRIES = [entry(1, "Anand", 5), entry(2, "Babu", 45), entry(3, "Chitra", 19)];

function draw(
  props: Partial<Parameters<typeof LateTable>[0]> = {},
  handlers: {
    onToggle?: (id: number) => void;
    onToggleAll?: () => void;
    onToggleGroup?: (group: LateGroup) => void;
  } = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(LateTable, {
        entries: sortEntries(ENTRIES, DEFAULT_SORT),
        groups: null,
        sort: DEFAULT_SORT,
        onSort: () => {},
        selected: new Set<number>(),
        onToggle: handlers.onToggle ?? (() => {}),
        onToggleAll: handlers.onToggleAll ?? (() => {}),
        onToggleGroup: handlers.onToggleGroup ?? (() => {}),
        ...props,
      }),
    );
  });
  return host;
}

const header = (el: HTMLElement) => el.querySelector<HTMLElement>("[data-testid='select-all']")!;
const rowBox = (el: HTMLElement, id: number) => el.querySelector<HTMLElement>(`[data-testid='late-select-${id}']`)!;

describe("the tick column of the late table", () => {
  it("has a box in the header and one on every row, none ticked at first", () => {
    const el = draw();
    expect(header(el).getAttribute("data-state")).toBe("unchecked");
    expect(el.querySelectorAll("[data-testid^='late-select-']")).toHaveLength(3);
    expect(el.querySelectorAll("tbody tr[data-state='selected']")).toHaveLength(0);
    expect(header(el).getAttribute("aria-label")).toBe("Select all 3 employees shown");
  });

  it("shows the ticked rows as selected, and the header box dimmed while only some are ticked", () => {
    const el = draw({ selected: new Set([2]) });
    expect(rowBox(el, 2).getAttribute("data-state")).toBe("checked");
    expect(rowBox(el, 1).getAttribute("data-state")).toBe("unchecked");
    expect(el.querySelectorAll("tbody tr[data-state='selected']")).toHaveLength(1);
    expect(header(el).getAttribute("data-state")).toBe("indeterminate");
  });

  it("ticks the header box when every row is ticked, and ignores ticks on people who are not listed", () => {
    expect(header(draw({ selected: new Set([1, 2, 3]) })).getAttribute("data-state")).toBe("checked");
    act(() => root?.unmount());
    host?.remove();
    expect(header(draw({ selected: new Set([1, 2, 3, 77]) })).getAttribute("data-state")).toBe("checked");
    act(() => root?.unmount());
    host?.remove();
    expect(header(draw({ selected: new Set([77]) })).getAttribute("data-state")).toBe("unchecked");
  });

  it("calls the row's handler with the employee id, and the header's for everything in view", () => {
    const onToggle = vi.fn();
    const onToggleAll = vi.fn();
    const el = draw({}, { onToggle, onToggleAll });
    act(() => rowBox(el, 3).click());
    expect(onToggle).toHaveBeenCalledWith(3);
    act(() => header(el).click());
    expect(onToggleAll).toHaveBeenCalledTimes(1);
  });

  it("keeps a tick on its row when the order changes", () => {
    const selected = new Set([1]);
    const byMinutes = draw({ selected });
    const first = Array.from(byMinutes.querySelectorAll("[data-testid='late-name']")).map((n) => n.textContent);
    expect(first).toEqual(["Babu", "Chitra", "Anand"]);
    expect(rowBox(byMinutes, 1).getAttribute("data-state")).toBe("checked");
    act(() => root?.unmount());
    host?.remove();

    const byName = draw({
      selected,
      entries: sortEntries(ENTRIES, { key: "name", dir: "desc" }),
      sort: { key: "name", dir: "desc" },
    });
    const second = Array.from(byName.querySelectorAll("[data-testid='late-name']")).map((n) => n.textContent);
    expect(second).toEqual(["Chitra", "Babu", "Anand"]);
    expect(rowBox(byName, 1).getAttribute("data-state")).toBe("checked");
    expect(rowBox(byName, 2).getAttribute("data-state")).toBe("unchecked");
  });
});

describe("the late table unit by unit", () => {
  const MIXED = [
    entry(1, "Anand", 5),
    entry(2, "Babu", 45),
    entry(3, "Chitra", 19, "U-1"),
    entry(4, "Dev", 30, "U-1"),
    entry(5, "Esha", 2, "U-1"),
  ];
  const groups = groupEntriesByUnit(MIXED);
  const grouped = (props: Partial<Parameters<typeof LateTable>[0]> = {}, handlers = {}) =>
    draw({ entries: flattenGroups(groups), groups, ...props }, handlers);
  const names = (el: HTMLElement) =>
    Array.from(el.querySelectorAll("tbody tr")).map((tr) =>
      tr.getAttribute("data-testid")?.startsWith("late-group-")
        ? `[${tr.getAttribute("data-testid")}]`
        : (tr.querySelector("[data-testid='late-name']")?.textContent ?? ""),
    );

  it("has a slim row per unit before its rows, with the unit's label and how many were late", () => {
    const el = grouped();
    expect(names(el)).toEqual(["[late-group-1]", "Babu", "Anand", "[late-group-2]", "Dev", "Chitra", "Esha"]);
    expect(el.querySelector("[data-testid='late-group-label-1']")?.textContent).toBe("HO");
    expect(el.querySelector("[data-testid='late-group-count-1']")?.textContent).toBe("2 late");
    expect(el.querySelector("[data-testid='late-group-label-2']")?.textContent).toBe("U-1");
    expect(el.querySelector("[data-testid='late-group-count-2']")?.textContent).toBe("3 late");
  });

  it("has no unit rows in a flat list, and the Unit column says which unit each row is in", () => {
    const flat = draw({ entries: sortEntries(MIXED, DEFAULT_SORT), groups: null });
    expect(flat.querySelectorAll("[data-testid^='late-group-']")).toHaveLength(0);
    expect(names(flat)).toEqual(["Babu", "Dev", "Chitra", "Anand", "Esha"]);
    expect(flat.querySelector("[data-testid='late-unit-3']")?.textContent).toBe("U-1");
    expect(flat.querySelector("[data-testid='late-unit-1']")?.textContent).toBe("HO");
    // the column is there when grouped too
    expect(grouped().querySelector("[data-testid='sort-unit']")).not.toBeNull();
  });

  it("ticks a whole unit from its own box, which is dimmed while only some of the unit is ticked", () => {
    const onToggleGroup = vi.fn();
    const el = grouped({ selected: new Set([3]) }, { onToggleGroup });
    const box = (key: string) => el.querySelector<HTMLElement>(`[data-testid='late-group-select-${key}']`)!;
    expect(box("1").getAttribute("data-state")).toBe("unchecked");
    expect(box("2").getAttribute("data-state")).toBe("indeterminate");
    expect(box("2").getAttribute("aria-label")).toBe("Select all 3 in U-1");
    act(() => box("2").click());
    expect(onToggleGroup).toHaveBeenCalledTimes(1);
    expect(onToggleGroup.mock.calls[0][0].label).toBe("U-1");
    // the header box still counts every row in view
    expect(header(el).getAttribute("data-state")).toBe("indeterminate");
    expect(header(el).getAttribute("aria-label")).toBe("Select all 5 employees shown");
  });

  it("ticks a unit's box when all its rows are ticked, whatever else is ticked", () => {
    const el = grouped({ selected: new Set([3, 4, 5, 1]) });
    expect(el.querySelector("[data-testid='late-group-select-2']")?.getAttribute("data-state")).toBe("checked");
    expect(el.querySelector("[data-testid='late-group-select-1']")?.getAttribute("data-state")).toBe("indeterminate");
  });

  it("keeps a tick on its row between the grouped and the flat list", () => {
    const selected = new Set([4]);
    const a = grouped({ selected });
    expect(rowBox(a, 4).getAttribute("data-state")).toBe("checked");
    act(() => root?.unmount());
    host?.remove();
    const b = draw({ entries: sortEntries(MIXED, { key: "name", dir: "asc" }), groups: null, selected });
    expect(rowBox(b, 4).getAttribute("data-state")).toBe("checked");
    expect(rowBox(b, 3).getAttribute("data-state")).toBe("unchecked");
  });
});
