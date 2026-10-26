import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import LateTable from "./LateTable";
import { DEFAULT_SORT, sortEntries, type LateEntry } from "./late";

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

const entry = (id: number, name: string, minutesLate: number): LateEntry => ({
  employeeId: id,
  name,
  code: `E${id}`,
  department: "Admin",
  unit: "HO",
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
  handlers: { onToggle?: (id: number) => void; onToggleAll?: () => void } = {},
) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(
      createElement(LateTable, {
        entries: sortEntries(ENTRIES, DEFAULT_SORT),
        sort: DEFAULT_SORT,
        onSort: () => {},
        selected: new Set<number>(),
        onToggle: handlers.onToggle ?? (() => {}),
        onToggleAll: handlers.onToggleAll ?? (() => {}),
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
