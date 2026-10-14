import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalaryStatement, StatementRow } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { STAFF_COLUMNS, productionStatement, staffStatement } from "./fixtures";
import { SHEET_PX } from "./paper-css";
import { SalaryStatementView, type SalaryStatementViewProps } from "./SalaryStatementView";
import { filterStatement } from "./statement-model";

// jsdom renders of the on-screen statement: what each state shows, the grouped sticky header, the department bands, the
// subtotals and the grand total, the status accent, the Pages view, and the callbacks. (Layout - sticky offsets that really
// stick, scrolling - needs a real browser; what is checked here is the markup and classes that produce it.)

type Observed = { cb: ResizeObserverCallback; el: Element };
const observed: Observed[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // a ResizeObserver the tests can drive: it reports a width only when a test says so
  globalThis.ResizeObserver = class {
    private cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(el: Element) {
      observed.push({ cb: this.cb, el });
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  observed.length = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.useRealTimers();
});

function mount(props: Partial<SalaryStatementViewProps> = {}) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const render = (next: Partial<SalaryStatementViewProps>) =>
    act(() => root!.render(createElement(SalaryStatementView, { accent: "indigo", ...next })));
  render(props);
  return { el: host, render };
}

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = <T extends HTMLElement = HTMLElement>(el: ParentNode, selector: string) =>
  Array.from(el.querySelectorAll<T>(selector));
const cellsOf = (el: ParentNode) => qa<HTMLTableCellElement>(el, "td");
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const cls = (el: Element | null | undefined) => (el?.className ?? "").toString().split(/\s+/);

/** Tells the ResizeObserver of the element with this test id that it is now `width` px wide. */
function resizeTo(el: HTMLElement, testId: string, width: number) {
  const target = q(el, testId);
  act(() => {
    for (const o of observed.filter((x) => x.el === target)) {
      o.cb([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver);
    }
  });
}

const statement = staffStatement();

describe("loading", () => {
  it("shows the skeleton of the paper: a title, a header and eight rows - and no blank area", () => {
    const { el } = mount({ loading: true });
    expect(q(el, "statement-skeleton")).not.toBeNull();
    expect(q(el, "statement-skeleton")!.getAttribute("aria-busy")).toBe("true");
    expect(q(el, "statement-skeleton-head")).not.toBeNull();
    expect(qa(el, '[data-testid="statement-skeleton-row"]')).toHaveLength(8);
    expect(q(el, "statement-view")).toBeNull();
    expect(q(el, "payroll-loader")).toBeNull();
  });

  it("after a long wait it says it is still working, with the payroll loader", () => {
    vi.useFakeTimers();
    const { el } = mount({ loading: true });
    act(() => {
      vi.advanceTimersByTime(2400);
    });
    expect(q(el, "payroll-loader")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(q(el, "payroll-loader")).not.toBeNull();
    expect(text(q(el, "payroll-loader"))).toContain("Preparing the salary statement");
  });

  it("is replaced by the statement when it arrives, and the long-wait loader goes with it", () => {
    vi.useFakeTimers();
    const { el, render } = mount({ loading: true });
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(q(el, "payroll-loader")).not.toBeNull();
    render({ statement, loading: false });
    expect(q(el, "statement-skeleton")).toBeNull();
    expect(q(el, "payroll-loader")).toBeNull();
    expect(q(el, "statement-table")).not.toBeNull();
  });

  it("keeps showing the statement while it refreshes (busy, not blank)", () => {
    const { el } = mount({ statement, loading: true });
    expect(q(el, "statement-skeleton")).toBeNull();
    expect(q(el, "statement-view")!.getAttribute("aria-busy")).toBe("true");
    expect(q(el, "statement-table")).not.toBeNull();
  });
});

describe("error and empty", () => {
  it("says what went wrong and offers Retry, which calls back", () => {
    const onRetry = vi.fn();
    const { el } = mount({ error: new Error("The server is busy"), onRetry });
    const box = q(el, "statement-error")!;
    expect(box.getAttribute("role")).toBe("alert");
    expect(text(box)).toContain("The salary statement could not be loaded");
    expect(text(box)).toContain("The server is busy");
    click(q(el, "statement-retry"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("has no Retry button when there is nothing to call, and a plain message for an unknown error", () => {
    const { el } = mount({ error: { weird: true } });
    expect(q(el, "statement-retry")).toBeNull();
    expect(text(q(el, "statement-error"))).toContain("Something went wrong");
  });

  it("an error while a statement is on screen is a banner above it, not instead of it", () => {
    const onRetry = vi.fn();
    const { el } = mount({ statement, error: new Error("offline"), onRetry });
    expect(q(el, "statement-inline-error")).not.toBeNull();
    expect(text(q(el, "statement-inline-error"))).toContain("Could not refresh the statement");
    expect(q(el, "statement-table")).not.toBeNull();
    click(q(el, "statement-inline-error")!.querySelector("button"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("an empty statement says what to do", () => {
    const empty = filterStatement(statement, { search: "no such person" });
    const { el } = mount({ statement: empty });
    const note = q(el, "statement-empty")!;
    expect(text(note)).toContain("No payroll to put on a statement for this period");
    expect(text(note).toLowerCase()).toContain("generate payroll first");
    expect(q(el, "statement-table")).toBeNull();
  });

  it("with no statement, nothing loading and no error it is the same empty note", () => {
    const { el } = mount({});
    expect(q(el, "statement-empty")).not.toBeNull();
  });
});

describe("the paper", () => {
  it("has the letterhead: logo, company and branch, and the title with the printed dates", () => {
    const { el } = mount({ statement });
    expect(q(el, "statement-letterhead")!.querySelector("svg")).not.toBeNull();
    expect(text(q(el, "statement-company"))).toBe("U.K TEXTILES - H.O");
    expect(text(q(el, "statement-title"))).toBe("Salary Statement From 01-09-2026 To 30-09-2026");
  });

  it("shows the counts as chips: employees, departments, paid, pending (and a production cycle)", () => {
    const { el } = mount({ statement });
    expect(text(q(el, "statement-chip-employees"))).toBe("15 employees");
    expect(text(q(el, "statement-chip-departments"))).toBe("2 departments");
    expect(text(q(el, "statement-chip-paid"))).toBe("11 paid");
    expect(text(q(el, "statement-chip-pending"))).toBe("4 pending");
    expect(text(q(el, "statement-chips"))).not.toContain("Weekly");
    act(() => root!.unmount());
    host!.remove();
    const second = mount({ statement: productionStatement(), accent: "amber" });
    expect(text(q(second.el, "statement-chips"))).toContain("Weekly");
    expect(text(q(second.el, "statement-chip-employees"))).toBe("6 employees");
  });

  it("prints the server's notes under the table in small type, and when it was generated", () => {
    const { el } = mount({ statement });
    const notes = q(el, "statement-notes")!;
    expect(qa(notes, "li").map((li) => text(li))).toEqual(statement.notes);
    expect(cls(notes)).toContain("text-[11px]");
    expect(text(q(el, "statement-generated"))).toMatch(/^Generated \d{2}-\d{2}-\d{4} \d{2}:\d{2}$/);
  });

  it("is a clay card with the page accent strip on top", () => {
    const { el } = mount({ statement });
    expect(cls(q(el, "statement-paper"))).toEqual(expect.arrayContaining(["clay-card", "rounded-2xl"]));
    expect(q(el, "statement-letterhead")!.querySelector(".from-indigo-500")).not.toBeNull();
  });
});

describe("the grouped sticky header", () => {
  it("has a band row naming the column groups, with the right spans, then a label row with the second lines", () => {
    const { el } = mount({ statement });
    const bands = qa<HTMLTableCellElement>(q(el, "statement-head-bands")!, "th");
    expect(bands.map((th) => [text(th), th.colSpan])).toEqual([
      ["Employee", 3],
      ["", 1], // the rest of the Employee band, cut where the sticky columns end
      ["Earnings", 2],
      ["Attendance", 5],
      ["Earnings", 3],
      ["Deductions", 8],
      ["Net pay", 2],
    ]);
    const labels = qa(q(el, "statement-head-labels")!, "th");
    expect(labels).toHaveLength(24);
    expect(labels.map((th) => text(th))).toEqual([
      "SNO",
      "ID NO",
      "Name",
      "Designation",
      "Basic salary",
      "Total",
      "Present",
      "CL",
      "LOP",
      "HD",
      "Total Days",
      "PTRL",
      "Others Allow",
      "E salary",
      "T.Advance",
      "Advance",
      "ESI",
      "PF",
      "TDS not tracked",
      "Others",
      "Lop& PSAmt information",
      "Total Deduction",
      "NET",
      "Remarks",
    ]);
    // a qualifier ("not tracked", "information") goes on its own line under the label
    expect(qa(labels[18], "span").map((s) => text(s))).toEqual(["TDS", "not tracked"]);
    expect(qa(labels[20], "span").map((s) => text(s))).toEqual(["Lop& PSAmt", "information"]);
    expect(qa(labels[4], "span")).toHaveLength(1);
    expect(qa(labels[3], "span")).toHaveLength(1);
  });

  it("sticks to the top: the two header rows add up (h-7 band row, second row at top-7)", () => {
    const { el } = mount({ statement });
    for (const th of qa(q(el, "statement-head-bands")!, "th")) {
      expect(cls(th)).toEqual(expect.arrayContaining(["sticky", "top-0", "h-7"]));
    }
    for (const th of qa(q(el, "statement-head-labels")!, "th")) {
      expect(cls(th)).toEqual(expect.arrayContaining(["sticky", "top-7", "h-12"]));
    }
  });

  it("keeps SNO, ID NO and Name at the left: sticky, each offset by the widths before it, above the other header cells", () => {
    const { el } = mount({ statement });
    const labels = qa(q(el, "statement-head-labels")!, "th");
    expect(labels.slice(0, 3).map((th) => th.style.left)).toEqual(["0px", "52px", "144px"]);
    for (const th of labels.slice(0, 3)) expect(cls(th)).toEqual(expect.arrayContaining(["sticky", "z-30"]));
    expect(labels[3].style.left).toBe("");
    expect(cls(labels[3])).toContain("z-20");
    expect(cls(labels[3])).not.toContain("z-30");
    // Name is the edge of the sticky block
    expect(cls(labels[2])).toContain("border-r");
    expect(q(el, "statement-scroll")!.getAttribute("data-sticky")).toBe("on");
  });

  it("the table is fixed-layout with one column width per column, and scrolls inside its own region", () => {
    const { el } = mount({ statement });
    const table = q(el, "statement-table")!;
    expect(table.style.tableLayout).toBe("fixed");
    const cols = qa(table, "col").map((c) => parseFloat(c.style.width));
    expect(cols).toHaveLength(24);
    expect(parseFloat(table.style.width)).toBe(cols.reduce((a, b) => a + b, 0));
    const scroller = q(el, "statement-scroll")!;
    expect(cls(scroller)).toEqual(expect.arrayContaining(["overflow-auto", "min-w-0"]));
    expect(scroller.getAttribute("role")).toBe("region");
    expect(scroller.getAttribute("aria-label")).toBe("Salary statement table");
    expect(scroller.tabIndex).toBe(0);
    expect(scroller.style.maxHeight).not.toBe("");
  });

  it("a table narrower than its container is stretched to fill it, and the sticky offsets follow the stretched widths", () => {
    const { el } = mount({ statement: productionStatement(), accent: "amber" });
    const widthsOf = () => qa(q(el, "statement-table")!, "col").map((c) => parseFloat(c.style.width));
    const natural = widthsOf();
    expect(natural.reduce((a, b) => a + b, 0)).toBeLessThan(2400);
    resizeTo(el, "statement-scroll", 2400);
    const stretched = widthsOf();
    expect(stretched).toHaveLength(natural.length);
    expect(stretched.reduce((a, b) => a + b, 0)).toBe(2400);
    expect(parseFloat(q(el, "statement-table")!.style.width)).toBe(2400);
    expect(stretched[0]).toBeGreaterThan(natural[0]);
    // the columns that stay in view are offset by the widths that are really drawn: nothing overlaps, nothing is left over
    const labels = qa(q(el, "statement-head-labels")!, "th");
    expect(labels.slice(0, 3).map((th) => parseFloat(th.style.left))).toEqual([
      0,
      stretched[0],
      stretched[0] + stretched[1],
    ]);
    // a container narrower than the table: the natural widths, and the table scrolls
    resizeTo(el, "statement-scroll", 900);
    expect(widthsOf()).toEqual(natural);
  });

  it("with an Actions column the stretch leaves it its own width", () => {
    const { el } = mount({ statement: productionStatement(), renderRowActions: () => null });
    resizeTo(el, "statement-scroll", 2400);
    const widths = qa(q(el, "statement-table")!, "col").map((c) => parseFloat(c.style.width));
    expect(widths.at(-1)).toBe(132);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(2400);
  });

  it("on a narrow container the identity columns stop being sticky (they would leave no room for the figures)", () => {
    const { el } = mount({ statement });
    expect(q(el, "statement-scroll")!.getAttribute("data-sticky")).toBe("on");
    resizeTo(el, "statement-scroll", 400);
    expect(q(el, "statement-scroll")!.getAttribute("data-sticky")).toBe("off");
    const labels = qa(q(el, "statement-head-labels")!, "th");
    expect(cls(labels[2])).not.toContain("z-30");
    expect(labels[2].style.left).toBe("");
    const firstRow = q(el, "statement-row-1001")!;
    expect(cls(qa(firstRow, "td")[2])).not.toContain("sticky");
    // the header still sticks to the top
    expect(cls(labels[2])).toContain("sticky");
    resizeTo(el, "statement-scroll", 1200);
    expect(q(el, "statement-scroll")!.getAttribute("data-sticky")).toBe("on");
  });
});

describe("departments, rows, subtotals and the grand total", () => {
  it("a tinted band per department with its name and employee count, then its rows in order", () => {
    const { el } = mount({ statement });
    const body = q(el, "statement-table")!.querySelector("tbody")!;
    const order = qa(body, "tr").map((tr) => tr.getAttribute("data-testid"));
    expect(order[0]).toBe("statement-band-accounts");
    expect(order.slice(1, 4)).toEqual(["statement-row-1001", "statement-row-1002", "statement-row-1003"]);
    expect(order[4]).toBe("statement-subtotal-accounts");
    expect(order[5]).toBe("statement-band-admin");
    expect(order[6]).toBe("statement-row-1004");
    expect(order[order.length - 1]).toBe("statement-subtotal-admin");
    expect(order).toHaveLength(2 + 15 + 2);
    const band = q(el, "statement-band-accounts")!;
    expect(text(band)).toBe("ACCOUNTS 3 employees");
    expect(text(q(el, "statement-band-admin"))).toContain("12 employees");
    expect(cellsOf(band)[0].colSpan).toBe(24);
    expect(cls(qa(band, "td")[0])).toContain("bg-indigo-50");
    // the label stays in view when the table scrolls sideways
    expect(cls(band.querySelector("div"))).toEqual(expect.arrayContaining(["sticky", "left-0"]));
  });

  it("the serial numbers run across the departments and every row has a cell per column", () => {
    const { el } = mount({ statement });
    const rows = qa(q(el, "statement-table")!, '[data-testid^="statement-row-"]');
    expect(rows).toHaveLength(15);
    // the number, then the status in words for a screen reader
    const expected = Array.from(
      { length: 15 },
      (_, i) => `${i + 1} ${[3, 6, 8, 11].includes(i + 1) ? "Pending" : "Paid"}`,
    );
    expect(rows.map((r) => text(qa(r, "td")[0]))).toEqual(expected);
    for (const r of rows) expect(qa(r, "td")).toHaveLength(24);
  });

  it("a row is zebra-striped and lights up under the mouse (group-hover in the page accent)", () => {
    const { el } = mount({ statement });
    const [r1, r2] = [q(el, "statement-row-1001")!, q(el, "statement-row-1002")!];
    expect(cls(r1)).toContain("group");
    expect(cls(qa(r1, "td")[5])).toEqual(expect.arrayContaining(["bg-white", "group-hover:bg-indigo-50"]));
    expect(cls(qa(r2, "td")[5])).toContain("bg-slate-50");
  });

  it("shows figures right-aligned in tabular numerals with two decimals and Indian grouping; zero is muted", () => {
    const { el } = mount({ statement });
    const cells = qa(q(el, "statement-row-1015")!, "td");
    expect(text(cells[4])).toBe("96,000.00"); // Basic
    expect(text(cells[5])).toBe("2,00,000.00"); // Total
    expect(text(cells[22])).toBe("1,67,462.00"); // NET
    expect(cls(cells[5])).toContain("text-right");
    expect(cells[5].querySelector(".tabular-nums")).not.toBeNull();
    const zero = cells[7].querySelector(".tabular-nums")!; // CL = 0.00
    expect(text(zero)).toBe("0.00");
    expect(cls(zero)).toContain("text-slate-400");
    expect(cls(cells[22].querySelector(".tabular-nums"))).not.toContain("text-slate-400");
    // NET is the result of the row: bold
    expect(cls(cells[22])).toContain("font-bold");
    // half days keep their decimals
    expect(text(qa(q(el, "statement-row-1008")!, "td")[6])).toBe("24.50");
  });

  it("marks the row's status as a small left accent with its words: green paid, amber pending", () => {
    const { el } = mount({ statement });
    const paid = qa(q(el, "statement-row-1001")!, "td")[0];
    const pending = qa(q(el, "statement-row-1003")!, "td")[0];
    expect(cls(paid)).toEqual(expect.arrayContaining(["border-l-4", "border-l-emerald-500"]));
    expect(cls(pending)).toEqual(expect.arrayContaining(["border-l-4", "border-l-amber-400"]));
    expect(paid.getAttribute("title")).toBe("Payroll paid");
    expect(pending.getAttribute("title")).toBe("Payroll pending");
    // not colour alone: the words are there for a screen reader
    expect(text(paid.querySelector(".sr-only"))).toBe("Paid");
    expect(text(pending.querySelector(".sr-only"))).toBe("Pending");
  });

  it("a row with no status has a clear accent and no words", () => {
    const noStatus: SalaryStatement = {
      ...statement,
      groups: statement.groups.map((g) => ({ ...g, rows: g.rows.map((r) => ({ ...r, status: null })) })),
    };
    const { el } = mount({ statement: noStatus });
    const first = qa(q(el, "statement-row-1001")!, "td")[0];
    expect(cls(first)).toContain("border-l-transparent");
    expect(first.querySelector(".sr-only")).toBeNull();
    expect(first.getAttribute("title")).toBeNull();
  });

  it("puts the remarks in chips (LEFT is a red one)", () => {
    const { el } = mount({ statement });
    const remarks = qa(q(el, "statement-row-1003")!, "td")[23];
    const chip = remarks.querySelector("[data-tone]")!;
    expect(text(chip)).toBe("LEFT");
    expect(chip.getAttribute("data-tone")).toBe("danger");
    expect(qa(q(el, "statement-row-1001")!, "td")[23].querySelector("[data-tone]")).toBeNull();
  });

  it("shows a dash for a figure that is missing", () => {
    const sparse: SalaryStatement = {
      ...statement,
      groups: statement.groups.map((g, gi) => ({
        ...g,
        rows: g.rows.map((r, ri) =>
          gi === 0 && ri === 0 ? { ...r, values: { ...r.values, net: null, designation: null } } : r,
        ),
      })),
    };
    const { el } = mount({ statement: sparse });
    const cells = qa(q(el, "statement-row-1001")!, "td");
    expect(text(cells[22])).toBe("—");
    expect(text(cells[3])).toBe("—");
  });

  it("closes each department with a bold subtotal row in its own tint, label across SNO..Name", () => {
    const { el } = mount({ statement });
    const sub = q(el, "statement-subtotal-accounts")!;
    const cells = cellsOf(sub);
    expect(cells[0].colSpan).toBe(3);
    expect(text(cells[0])).toBe("ACCOUNTS - Total");
    expect(cls(cells[0])).toEqual(expect.arrayContaining(["sticky", "left-0", "font-bold", "bg-indigo-50"]));
    expect(cells).toHaveLength(1 + 21);
    // the label takes SNO .. Name (three columns), so column k is the cell at k - 2
    const figureOf = (key: string) => text(cells[STAFF_COLUMNS.findIndex((c) => c.key === key) - 2]);
    expect(figureOf("designation")).toBe(""); // does not add up
    expect(figureOf("basic")).toBe("47,500.00");
    expect(figureOf("total")).toBe("97,000.00");
    expect(figureOf("present")).toBe("46.00");
    expect(figureOf("net")).toBe("46,004.00");
    expect(text(cells[cells.length - 2])).toBe("46,004.00"); // NET
    expect(text(cells[cells.length - 1])).toBe(""); // Remarks
    expect(text(q(el, "statement-subtotal-admin")!.querySelectorAll("td")[cells.length - 2])).toBe("6,83,495.00");
  });

  it("ends with a grand TOTAL row in the page accent, pinned to the bottom of the scroll area", () => {
    const { el } = mount({ statement });
    const total = q(el, "statement-total")!;
    expect(total.closest("tfoot")).not.toBeNull();
    const cells = qa(total, "td");
    expect(text(cells[0])).toBe("GRAND TOTAL");
    expect(text(cells[cells.length - 2])).toBe("7,29,499.00");
    expect(text(cells[2])).toBe("4,25,150.00"); // Basic (cells[1] is the Designation)
    expect(text(cells[3])).toBe("8,59,500.00"); // Total
    for (const c of cells)
      expect(cls(c)).toEqual(expect.arrayContaining(["bg-indigo-600", "text-white", "sticky", "bottom-0"]));
    expect(cls(cells[0])).toContain("z-30"); // above the other cells in its row, as it is a sticky corner
  });

  it("takes the amber accent on Production Payroll", () => {
    const { el } = mount({ statement: productionStatement(), accent: "amber" });
    expect(cls(qa(q(el, "statement-band-weaving")!, "td")[0])).toContain("bg-amber-50");
    expect(cls(qa(q(el, "statement-total")!, "td")[0])).toContain("bg-amber-600");
    expect(cls(qa(q(el, "statement-row-2001")!, "td")[3])).toContain("group-hover:bg-amber-50");
    expect(q(el, "statement-letterhead")!.querySelector(".from-amber-500")).not.toBeNull();
    expect(qa(q(el, "statement-head-labels")!, "th")).toHaveLength(18);
    expect(text(q(el, "statement-total"))).toContain("19,881.00");
  });
});

describe("opening a payroll's details", () => {
  it("a name is a button that hands the row to onOpenDetails", () => {
    const onOpenDetails = vi.fn();
    const { el } = mount({ statement, onOpenDetails });
    const button = q(el, "statement-details-1001")!;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-label")).toBe("Details of MEENATCHI.T");
    expect(text(button)).toBe("MEENATCHI.T");
    click(button);
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
    const row = onOpenDetails.mock.calls[0][0] as StatementRow;
    expect([row.payrollId, row.employeeId, row.sno]).toEqual([1001, 1501, 1]);
    expect(row.values.name).toBe("MEENATCHI.T");
    expect(qa(q(el, "statement-table")!, "tbody button")).toHaveLength(15);
  });

  it("without onOpenDetails the name is just text", () => {
    const { el } = mount({ statement });
    expect(q(el, "statement-details-1001")).toBeNull();
    expect(qa(q(el, "statement-table")!, "button")).toHaveLength(0);
    expect(text(qa(q(el, "statement-row-1001")!, "td")[2])).toBe("MEENATCHI.T");
  });

  it("the name button is marked view-safe: a View Only role can still open details, whatever the name says", () => {
    const risky: SalaryStatement = {
      ...statement,
      groups: statement.groups.map((g, gi) => ({
        ...g,
        rows: g.rows.map((r, ri) => (gi === 0 && ri === 0 ? { ...r, values: { ...r.values, name: "ROHAN SAVE" } } : r)),
      })),
    };
    const { el } = mount({ statement: risky, onOpenDetails: vi.fn() });
    lockMutatingControls(el);
    const button = q(el, "statement-details-1001") as HTMLButtonElement;
    expect(button.getAttribute("aria-label")).toContain("SAVE");
    expect(button.disabled).toBe(false);
  });
});

describe("row actions", () => {
  it("adds an Actions column with whatever the page renders for each row, and nothing on bands and totals", () => {
    const renderRowActions = vi.fn((row: StatementRow) =>
      createElement("button", { type: "button" }, `Edit ${row.payrollId}`),
    );
    const { el } = mount({ statement, renderRowActions });
    expect(text(qa(q(el, "statement-head-labels")!, "th").at(-1))).toBe("Actions");
    expect(qa(q(el, "statement-table")!, "col")).toHaveLength(25);
    const first = qa(q(el, "statement-row-1001")!, "td");
    expect(first).toHaveLength(25);
    expect(text(first[24])).toBe("Edit 1001");
    expect(cls(first[24])).toEqual(expect.arrayContaining(["sticky", "right-0"]));
    expect(renderRowActions).toHaveBeenCalledWith(expect.objectContaining({ payrollId: 1001, sno: 1 }));
    expect(cellsOf(q(el, "statement-band-accounts")!)[0].colSpan).toBe(25);
    expect(text(qa(q(el, "statement-total")!, "td").at(-1))).toBe("");
    // these are the page's own buttons: a View Only role has them locked like any other
    lockMutatingControls(el);
    expect((qa(first[24], "button")[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("has no Actions column unless asked", () => {
    const { el } = mount({ statement });
    expect(qa(q(el, "statement-table")!, "col")).toHaveLength(24);
    expect(text(q(el, "statement-head-labels"))).not.toContain("Actions");
  });
});

describe("the Pages view", () => {
  it("shows the A4 landscape sheets as they print, one at a time, with Page x of y", () => {
    const { el } = mount({ statement, view: "pages" });
    expect(q(el, "statement-table")).toBeNull();
    expect(q(el, "statement-pages")).not.toBeNull();
    expect(qa(el, '[data-testid="statement-sheet"]')).toHaveLength(1);
    const sheet = q(el, "statement-sheet")!;
    expect(sheet.getAttribute("data-page")).toBe("1");
    expect(cls(sheet)).toContain("stmt-sheet-preview");
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 2");
    expect(text(sheet.querySelector(".stmt-foot"))).toContain("Page 1 of 2");
    expect(text(sheet.querySelector(".stmt-company"))).toBe("U.K TEXTILES - H.O");
    expect(sheet.querySelectorAll(".stmt-row")).toHaveLength(14);
    // the paper's own stylesheet comes with it
    expect(el.querySelector("style[data-statement-paper]")!.textContent).toContain(".stmt-sheet");
  });

  it("Previous / Next move between pages, and are disabled at the ends", () => {
    const { el } = mount({ statement, view: "pages" });
    const prev = q(el, "statement-page-prev") as HTMLButtonElement;
    const next = q(el, "statement-page-next") as HTMLButtonElement;
    expect(prev.getAttribute("aria-label")).toBe("Previous page");
    expect(next.getAttribute("aria-label")).toBe("Next page");
    expect([prev.disabled, next.disabled]).toEqual([true, false]);
    click(next);
    expect(text(q(el, "statement-page-label"))).toBe("Page 2 of 2");
    expect(q(el, "statement-sheet")!.getAttribute("data-page")).toBe("2");
    expect(text(q(el, "statement-sheet"))).toContain("ADMIN (contd.)");
    expect(text(q(el, "statement-sheet"))).toContain("GRAND TOTAL");
    expect([prev.disabled, next.disabled]).toEqual([false, true]);
    click(prev);
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 2");
  });

  it("the arrow keys turn the page too", () => {
    const { el } = mount({ statement, view: "pages" });
    const box = q(el, "statement-pages-box")!;
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(text(q(el, "statement-page-label"))).toBe("Page 2 of 2");
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })));
    expect(text(q(el, "statement-page-label"))).toBe("Page 2 of 2");
    act(() => box.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 2");
  });

  it("can be driven from outside with page and onPageChange", () => {
    const onPageChange = vi.fn();
    const { el, render } = mount({ statement, view: "pages", page: 2, onPageChange });
    expect(text(q(el, "statement-page-label"))).toBe("Page 2 of 2");
    click(q(el, "statement-page-prev"));
    expect(onPageChange).toHaveBeenCalledWith(1);
    // controlled: it stays where the parent says until the parent moves it
    expect(text(q(el, "statement-page-label"))).toBe("Page 2 of 2");
    render({ statement, view: "pages", page: 1, onPageChange });
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 2");
  });

  it("falls back to a page that exists when the statement gets shorter", () => {
    const { el, render } = mount({ statement, view: "pages" });
    click(q(el, "statement-page-next"));
    expect(text(q(el, "statement-page-label"))).toBe("Page 2 of 2");
    render({ statement: filterStatement(statement, { search: "murugan" }), view: "pages" });
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 1");
    expect((q(el, "statement-page-next") as HTMLButtonElement).disabled).toBe(true);
  });

  it("scales the sheet down to the width there is, and keeps its natural size where there is room", () => {
    const { el } = mount({ statement, view: "pages" });
    expect(q(el, "statement-pages-box")!.getAttribute("data-scale")).toBe("1.000");
    resizeTo(el, "statement-pages-box", SHEET_PX.width / 2);
    expect(q(el, "statement-pages-box")!.getAttribute("data-scale")).toBe("0.500");
    const sheet = q(el, "statement-sheet")!;
    expect(sheet.parentElement!.style.transform).toBe("scale(0.5)");
    expect(parseFloat(sheet.parentElement!.parentElement!.style.width)).toBeCloseTo(SHEET_PX.width / 2, 1);
    // never below 35%: narrower than that the box scrolls
    resizeTo(el, "statement-pages-box", 100);
    expect(q(el, "statement-pages-box")!.getAttribute("data-scale")).toBe("0.350");
    resizeTo(el, "statement-pages-box", 5000);
    expect(q(el, "statement-pages-box")!.getAttribute("data-scale")).toBe("1.000");
  });

  it("the production statement previews with its own columns on an amber sheet", () => {
    const { el } = mount({ statement: productionStatement(), view: "pages", accent: "amber" });
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 1");
    expect(cls(q(el, "statement-sheet"))).toContain("stmt-kind-production");
    expect(text(q(el, "statement-sheet"))).toContain("Rate / shift");
  });

  it("shows the loading skeleton and the error in the Pages view just the same", () => {
    const loading = mount({ loading: true, view: "pages" });
    expect(q(loading.el, "statement-skeleton")).not.toBeNull();
    act(() => root!.unmount());
    host!.remove();
    const failed = mount({ error: new Error("x"), view: "pages", onRetry: () => {} });
    expect(q(failed.el, "statement-error")).not.toBeNull();
  });
});
