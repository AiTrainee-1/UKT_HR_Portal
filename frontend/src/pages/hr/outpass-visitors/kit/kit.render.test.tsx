import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DataTable, type DataColumn } from "./DataTable";
import { DateRangeFilter } from "./DateRangeFilter";
import { DetailDrawer, DrawerFields, DrawerSection } from "./DetailDrawer";
import { SearchFilter } from "./FilterBar";
import { StatusChip, toneOf } from "./StatusChip";
import { TimeBar } from "./TimeBar";

// The kit's pieces in jsdom: a table row opens by mouse and by keyboard (and a button inside it keeps its own click), the
// loading and empty states, the date filter's presets in India time, the search box's 350 ms wait, the chip and the bar.

let root: Root | null = null;
let host: HTMLElement | null = null;

function mount(el: ReactElement) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}
const rerender = (el: ReactElement) => act(() => root!.render(el));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

const press = (el: Element, key: string) =>
  act(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const click = (el: Element) => act(() => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

/** Types into a React-controlled input the way the browser does (the native setter, then an input event). */
function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

type Row = { id: number; name: string; note: string };
const ROWS: Row[] = [
  { id: 1, name: "Ravi Kumar", note: "A very long message that would wrap into a tall row if it were allowed to" },
  { id: 2, name: "Asha Devi", note: "Short" },
];
const COLUMNS: DataColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name },
  { key: "note", header: "Message", cell: (r) => r.note, text: (r) => r.note, maxWidth: 200 },
  {
    key: "act",
    header: "",
    truncate: false,
    cell: (r) => (
      <button type="button" data-testid={`act-${r.id}`}>
        Check out
      </button>
    ),
  },
];

describe("DataTable", () => {
  it("opens a row by mouse, and by keyboard with Enter or Space on the focused row", () => {
    const open = vi.fn();
    const el = mount(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} onRowClick={open} testId="t" />);
    const rows = [...el.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    expect(rows.map((r) => r.tabIndex)).toEqual([0, 0]);

    click(rows[0].querySelector("td")!);
    expect(open).toHaveBeenLastCalledWith(ROWS[0]);

    rows[1].focus();
    expect(document.activeElement).toBe(rows[1]);
    press(rows[1], "Enter");
    expect(open).toHaveBeenLastCalledWith(ROWS[1]);
    press(rows[0], " ");
    expect(open).toHaveBeenLastCalledWith(ROWS[0]);
    press(rows[0], "a");
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("leaves a button inside a row its own click and its own keys", () => {
    const open = vi.fn();
    const own = vi.fn();
    const columns = COLUMNS.map((c) =>
      c.key === "act"
        ? {
            ...c,
            cell: (r: Row) => (
              <button type="button" onClick={own} data-testid={`act-${r.id}`}>
                Check out
              </button>
            ),
          }
        : c,
    );
    const el = mount(<DataTable columns={columns} rows={ROWS} rowKey={(r) => r.id} onRowClick={open} />);
    const button = el.querySelector('[data-testid="act-1"]')!;
    click(button);
    press(button, "Enter");
    expect(own).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it("keeps a long cell on one line with its whole text as the tooltip", () => {
    const el = mount(<DataTable columns={COLUMNS} rows={ROWS} rowKey={(r) => r.id} />);
    const cell = el.querySelectorAll("tbody tr")[0].querySelectorAll("td")[1];
    expect(cell.className).toContain("whitespace-nowrap");
    expect(cell.style.maxWidth).toBe("200px");
    expect(cell.querySelector(".truncate")?.getAttribute("title")).toBe(ROWS[0].note);
    // without onRowClick the rows are not in the Tab order, the scroll box is (so it can be scrolled sideways)
    expect(el.querySelector("tbody tr")!.hasAttribute("tabindex")).toBe(false);
    expect((el.querySelector('[role="region"]') as HTMLElement).tabIndex).toBe(0);
  });

  it("shows skeleton rows and a hidden 'Loading…' while the first page loads, then a note when nothing matches", () => {
    const el = mount(<DataTable columns={COLUMNS} rows={undefined} rowKey={(r: Row) => r.id} loading testId="t" />);
    expect(text(el)).toContain("Loading…");
    expect(el.querySelector('[data-testid="t"]')!.getAttribute("aria-busy")).toBe("true");
    expect(el.querySelectorAll('tbody tr[aria-hidden="true"]').length).toBe(8);

    rerender(
      <DataTable
        columns={COLUMNS}
        rows={[]}
        rowKey={(r: Row) => r.id}
        testId="t"
        empty={{ title: "No gate records for these dates" }}
      />,
    );
    expect(text(el)).not.toContain("Loading…");
    expect(text(el)).toContain("No gate records for these dates");
    expect(el.querySelector("table")).toBeNull();
  });

  it("says when the list could not be loaded, and offers to try again", () => {
    const retry = vi.fn();
    const el = mount(
      <DataTable columns={COLUMNS} rows={undefined} rowKey={(r: Row) => r.id} error="Server error" onRetry={retry} />,
    );
    expect(text(el.querySelector('[role="alert"]'))).toContain("Could not load this list.");
    click([...el.querySelectorAll("button")].find((b) => text(b) === "Try again")!);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("draws the summary line, the tools and the pagination bar", () => {
    const onPage = vi.fn();
    const el = mount(
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        summary="128 passes · 117 back · 11 out"
        toolbar={<span data-testid="tools">tools</span>}
        pagination={{ page: 1, pageSize: 25, total: 128, onPageChange: onPage }}
      />,
    );
    expect(text(el)).toContain("128 passes · 117 back · 11 out");
    expect(el.querySelector('[data-testid="tools"]')).not.toBeNull();
    expect(text(el.querySelector('[data-slot="page-info"]'))).toContain("Page 1 of 6");
    click(el.querySelector('[aria-label="Next page"]')!);
    expect(onPage).toHaveBeenCalledWith(2);
  });

  it("goes to the last page when the list shrinks under the page shown (once it has loaded)", () => {
    const onPage = vi.fn();
    const table = (page: number, total: number, loading = false) => (
      <DataTable
        columns={COLUMNS}
        rows={ROWS}
        rowKey={(r) => r.id}
        loading={loading}
        pagination={{ page, pageSize: 10, total, onPageChange: onPage }}
      />
    );
    mount(table(5, 100));
    expect(onPage).not.toHaveBeenCalled();
    // rows were checked out / deleted elsewhere: 35 rows now, page 5 of 4 does not exist
    rerender(table(5, 35, true));
    expect(onPage).not.toHaveBeenCalled(); // still loading: the total may be the old one
    rerender(table(5, 35));
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenLastCalledWith(4);
    // an empty list stays where it is (nothing to go back to), and a page in range is left alone
    onPage.mockClear();
    rerender(table(3, 0));
    rerender(table(3, 35));
    expect(onPage).not.toHaveBeenCalled();
  });
});

describe("DateRangeFilter", () => {
  const WED = new Date("2026-11-18T06:00:00Z");

  it("shows the days a preset covers in India time, and marks the preset that is on", () => {
    const el = mount(<DateRangeFilter range="week" from="" to="" onChange={() => {}} now={WED} />);
    expect(el.querySelector<HTMLInputElement>('[data-testid="date-range-from"]')!.value).toBe("2026-11-16");
    expect(el.querySelector<HTMLInputElement>('[data-testid="date-range-to"]')!.value).toBe("2026-11-18");
    expect(el.querySelector('[data-testid="date-range-week"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(el.querySelector('[data-testid="date-range-today"]')!.getAttribute("aria-pressed")).toBe("false");
    // 00:30 in India on Thursday: today is already the 19th
    rerender(
      <DateRangeFilter range="today" from="" to="" onChange={() => {}} now={new Date("2026-11-18T19:00:00Z")} />,
    );
    expect(el.querySelector<HTMLInputElement>('[data-testid="date-range-from"]')!.value).toBe("2026-11-19");
  });

  it("a preset clears the typed days; typing a day makes the range custom and keeps the other day", () => {
    const change = vi.fn();
    const el = mount(<DateRangeFilter range="week" from="" to="" onChange={change} now={WED} allowAll />);
    click(el.querySelector('[data-testid="date-range-month"]')!);
    expect(change).toHaveBeenLastCalledWith({ range: "month", from: "", to: "" });
    click(el.querySelector('[data-testid="date-range-all"]')!);
    expect(change).toHaveBeenLastCalledWith({ range: "all", from: "", to: "" });
    typeInto(el.querySelector<HTMLInputElement>('[data-testid="date-range-from"]')!, "2026-11-10");
    expect(change).toHaveBeenLastCalledWith({ range: "custom", from: "2026-11-10", to: "2026-11-18" });
  });

  it("names its two day pickers", () => {
    const el = mount(<DateRangeFilter range="today" from="" to="" onChange={() => {}} now={WED} />);
    for (const input of el.querySelectorAll("input")) {
      const label = el.querySelector(`label[for="${input.id}"]`);
      expect(["From", "To"]).toContain(text(label));
    }
  });
});

describe("SearchFilter", () => {
  it("asks once, 350 ms after the last key; Enter asks at once; a change from outside is shown", async () => {
    vi.useFakeTimers();
    const change = vi.fn();
    const el = mount(<SearchFilter value="" onChange={change} label="Search by name or code" />);
    const input = el.querySelector("input")!;
    expect(text(el.querySelector(`label[for="${input.id}"]`))).toBe("Search by name or code");
    typeInto(input, "ra");
    act(() => vi.advanceTimersByTime(200));
    typeInto(input, "ravi");
    act(() => vi.advanceTimersByTime(349));
    expect(change).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(change).toHaveBeenCalledExactlyOnceWith("ravi");

    typeInto(input, "ravi k");
    press(input, "Enter");
    expect(change).toHaveBeenLastCalledWith("ravi k");
    act(() => vi.advanceTimersByTime(400));
    expect(change).toHaveBeenCalledTimes(2);

    // the page writes the value to the address and hands it back; then Clear filters empties it from outside
    rerender(<SearchFilter value="ravi k" onChange={change} />);
    expect(el.querySelector("input")!.value).toBe("ravi k");
    rerender(<SearchFilter value="" onChange={change} />);
    expect(el.querySelector("input")!.value).toBe("");
    expect(change).toHaveBeenCalledTimes(2);
  });
});

describe("DetailDrawer", () => {
  it("takes the focus, closes on Esc, and gives the focus back to the row that opened it", async () => {
    const change = vi.fn();
    const view = (open: boolean) => (
      <div>
        <button type="button" data-testid="opener">
          Ravi Kumar
        </button>
        <DetailDrawer open={open} onOpenChange={change} title="Ravi Kumar" subtitle="E1042 · Cutting">
          <DrawerSection title="Pass">
            <DrawerFields items={[{ label: "Destination", value: "Bank" }]} />
          </DrawerSection>
        </DetailDrawer>
      </div>
    );
    const el = mount(view(false));
    const opener = el.querySelector<HTMLButtonElement>('[data-testid="opener"]')!;
    opener.focus();
    rerender(view(true));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    const drawer = document.body.querySelector('[data-testid="detail-drawer"]')!;
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.contains(document.activeElement)).toBe(true);
    expect(text(drawer)).toContain("E1042 · Cutting");
    expect(text(drawer)).toContain("Bank");
    press(document.activeElement!, "Escape");
    expect(change).toHaveBeenCalledWith(false);
    rerender(view(false));
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(document.activeElement).toBe(opener);
  });
});

describe("StatusChip and TimeBar", () => {
  it("a chip is a dot and a word in its tone", () => {
    const el = mount(<StatusChip tone={toneOf("overdue")}>Overdue</StatusChip>);
    const chip = el.firstElementChild!;
    expect(chip.getAttribute("data-tone")).toBe("rose");
    expect(text(chip)).toBe("Overdue");
    expect(toneOf("back")).toBe("teal");
    expect(toneOf("on_break")).toBe("amber");
    expect(toneOf("pending")).toBe("indigo");
    expect(toneOf("something-new")).toBe("slate");
  });

  it("a time bar says the minutes and how far over the allowance", () => {
    const el = mount(createElement(TimeBar, { minutes: 22, allowed: 15, testId: "bar" }));
    const bar = el.querySelector('[data-testid="bar"]')!;
    expect(bar.getAttribute("data-tone")).toBe("rose");
    expect(text(bar)).toBe("22 min, 7 min over");
    expect(bar.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("22 min, 7 min over; 15 min allowed");
    rerender(createElement(TimeBar, { minutes: 9, allowed: 15, running: true, testId: "bar" }));
    expect(el.querySelector('[data-testid="bar"]')!.getAttribute("data-tone")).toBe("amber");
    expect(text(el.querySelector('[data-testid="bar"]'))).toBe("9 min so far");
  });
});
