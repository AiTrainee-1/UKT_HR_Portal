import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayrollScope, SalaryStatement, StatementRow } from "@/lib/api-client/custom-hooks";
import { lockMutatingControls } from "@/lib/view-only-lock";
import { productionStatement, staffStatement } from "./fixtures";
import {
  DEFAULT_STATEMENT_UI,
  SalaryStatementPanel,
  type SalaryStatementPanelProps,
  type StatementUiState,
} from "./SalaryStatementPanel";

// The panel with its data (customFetch is mocked: nothing goes to a server): the request it makes, loading / error / retry,
// the search and the filters recomputing the totals, the Scroll / Pages switch, refresh, and the Export menu - what each
// item hands to its exporter (the rows that are filtered in), and that a View Only role is not locked out of it.

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/api-client/custom-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client/custom-fetch")>()),
  customFetch: net.fetch,
}));

const exporters = vi.hoisted(() => ({ xlsx: vi.fn(), pdf: vi.fn(), print: vi.fn() }));
vi.mock("./export-statement-xlsx", () => ({ downloadStatementXlsx: exporters.xlsx }));
vi.mock("./export-statement-pdf", () => ({ downloadStatementPdf: exporters.pdf }));
vi.mock("./print-statement", () => ({ printStatement: exporters.print }));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
});

const STAFF_SCOPE: PayrollScope = { kind: "staff", month: 9, year: 2026 };
const statement = staffStatement();

beforeEach(() => {
  net.fetch.mockReset();
  net.fetch.mockResolvedValue(statement);
  exporters.xlsx.mockReset().mockResolvedValue(undefined);
  exporters.pdf.mockReset().mockResolvedValue(undefined);
  exporters.print.mockReset();
});

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const q = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const qa = (el: ParentNode, selector: string) => Array.from(el.querySelectorAll<HTMLElement>(selector));
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (el: Element | null | undefined) =>
  act(() => el!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
const press = (el: Element | null | undefined, key: string) =>
  act(() => el!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));

/** Lets the pending requests and their re-renders finish. */
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
};

/** Waits for an expectation to hold, letting React settle between tries (so nothing updates outside act). */
const until = (assertion: () => void) =>
  vi.waitFor(async () => {
    await flush();
    assertion();
  });

function type(input: HTMLElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function mount(props: Partial<SalaryStatementPanelProps> = {}, wrap?: (node: ReactNode) => ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const node = createElement(SalaryStatementPanel, { scope: STAFF_SCOPE, accent: "indigo", ...props });
  act(() => root!.render(createElement(QueryClientProvider, { client }, wrap ? wrap(node) : node)));
  await flush();
  return { el: host, client };
}

const rowIds = (el: ParentNode) =>
  qa(el, '[data-testid^="statement-row-"]').map((r) =>
    Number(r.getAttribute("data-testid")!.replace("statement-row-", "")),
  );

describe("loading the statement", () => {
  it("asks the staff endpoint for the month and year, and the production endpoint for the cycle and period", async () => {
    await mount();
    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(net.fetch).toHaveBeenCalledWith("/api/payroll/salary-statement?month=9&year=2026");
    act(() => root!.unmount());
    host!.remove();

    net.fetch.mockResolvedValue(productionStatement());
    await mount({
      scope: { kind: "production", cycle: "weekly", periodStart: "2026-02-02", periodEnd: "2026-02-08" },
      filters: { departmentId: 4 },
      accent: "amber",
    });
    expect(net.fetch).toHaveBeenLastCalledWith(
      "/api/payroll/production/salary-statement?cycle=weekly&periodStart=2026-02-02&periodEnd=2026-02-08&departmentId=4",
    );
  });

  it("shows the skeleton of the paper while it loads, with the toolbar waiting", async () => {
    net.fetch.mockReturnValue(new Promise(() => {}));
    const { el } = await mount();
    expect(q(el, "statement-skeleton")).not.toBeNull();
    expect(text(q(el, "statement-count"))).toBe("Loading...");
    expect((q(el, "statement-search") as HTMLInputElement).disabled).toBe(true);
    expect((q(el, "statement-export") as HTMLButtonElement).disabled).toBe(true);
    expect(q(el, "statement-table")).toBeNull();
  });

  it("shows the statement when it arrives: the table, the chips and a count of who is on it", async () => {
    const { el } = await mount();
    expect(q(el, "statement-skeleton")).toBeNull();
    expect(q(el, "statement-table")).not.toBeNull();
    expect(rowIds(el)).toHaveLength(15);
    expect(text(q(el, "statement-count"))).toBe("15 employees in 2 departments");
    expect(text(q(el, "statement-chip-paid"))).toBe("11 paid");
    expect((q(el, "statement-export") as HTMLButtonElement).disabled).toBe(false);
  });

  it("an error is a message with Retry; Retry asks again and the statement appears", async () => {
    net.fetch.mockRejectedValueOnce(new Error("The server is not answering"));
    const { el } = await mount();
    expect(text(q(el, "statement-error"))).toContain("The server is not answering");
    expect(text(q(el, "statement-count"))).toBe("Not loaded");
    expect((q(el, "statement-export") as HTMLButtonElement).disabled).toBe(true);
    click(q(el, "statement-retry"));
    await flush();
    expect(net.fetch).toHaveBeenCalledTimes(2);
    expect(q(el, "statement-error")).toBeNull();
    expect(rowIds(el)).toHaveLength(15);
  });

  it("an empty period says to generate payroll first, and nothing can be exported", async () => {
    net.fetch.mockResolvedValue({
      ...statement,
      groups: [],
      counts: { employees: 0, departments: 0, paid: 0, pending: 0 },
    });
    const { el } = await mount();
    expect(text(q(el, "statement-empty"))).toContain("No payroll to put on a statement for this period");
    expect((q(el, "statement-export") as HTMLButtonElement).disabled).toBe(true);
    expect(q(el, "statement-no-match")).toBeNull();
  });

  it("Refresh asks the server again, with a spinner and a disabled button while it runs", async () => {
    const { el } = await mount();
    let finish: (s: SalaryStatement) => void = () => {};
    net.fetch.mockReturnValueOnce(new Promise<SalaryStatement>((resolve) => (finish = resolve)));
    const refresh = q(el, "statement-refresh") as HTMLButtonElement;
    expect(refresh.getAttribute("aria-label")).toBe("Refresh the statement");
    click(refresh);
    await flush();
    expect(net.fetch).toHaveBeenCalledTimes(2);
    expect(refresh.disabled).toBe(true);
    expect(refresh.querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
    // the statement stays on screen meanwhile
    expect(q(el, "statement-table")).not.toBeNull();
    await act(async () => finish(statement));
    await flush();
    expect(refresh.disabled).toBe(false);
  });
});

describe("search, department and status", () => {
  it("search narrows the rows live (name or ID no, any case) and the totals follow", async () => {
    const { el } = await mount();
    type(q(el, "statement-search")!, "kannan");
    expect(rowIds(el)).toEqual([1002, 1007]);
    expect(text(q(el, "statement-count"))).toBe("Showing 2 of 15 employees");
    expect(text(q(el, "statement-subtotal-accounts"))).toContain("14,005.00");
    expect(text(q(el, "statement-subtotal-admin"))).toContain("1,18,000.00");
    expect(text(q(el, "statement-total"))).toContain("1,32,005.00");
    expect(text(q(el, "statement-chip-employees"))).toBe("2 employees");
    // by ID no
    type(q(el, "statement-search")!, "30071");
    expect(rowIds(el)).toEqual([1003]);
    expect(q(el, "statement-band-admin")).toBeNull(); // a department with nobody left is dropped
    // the serial numbers stay the server's
    expect(text(qa(q(el, "statement-row-1003")!, "td")[0])).toContain("3");
  });

  it("the clear button empties the search", async () => {
    const { el } = await mount();
    expect(q(el, "statement-search-clear")).toBeNull();
    type(q(el, "statement-search")!, "murug");
    expect(rowIds(el)).toEqual([1004, 1006]); // MURUGAN.K and MURUGESAN.K
    click(q(el, "statement-search-clear"));
    expect((q(el, "statement-search") as HTMLInputElement).value).toBe("");
    expect(rowIds(el)).toHaveLength(15);
  });

  it("nobody matching says so, offers to clear the filters, and disables the exports", async () => {
    const { el } = await mount();
    type(q(el, "statement-search")!, "zzz");
    expect(text(q(el, "statement-no-match"))).toContain("No employee matches these filters");
    expect(q(el, "statement-table")).toBeNull();
    expect(text(q(el, "statement-count"))).toBe("Showing 0 of 15 employees");
    expect((q(el, "statement-export") as HTMLButtonElement).disabled).toBe(true);
    click(q(el, "statement-clear-filters"));
    expect(rowIds(el)).toHaveLength(15);
    expect((q(el, "statement-search") as HTMLInputElement).value).toBe("");
  });

  it("the department select lists the departments of the statement and filters to one", async () => {
    const { el } = await mount();
    const trigger = q(el, "statement-department")!;
    expect(text(trigger)).toContain("All departments");
    press(trigger, "Enter");
    const options = qa(document.body, '[role="option"]');
    expect(options.map((o) => text(o))).toEqual(["All departments", "ACCOUNTS (3)", "ADMIN (12)"]);
    press(options[2], "Enter");
    expect(rowIds(el)).toEqual([1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1014, 1015]);
    expect(q(el, "statement-band-accounts")).toBeNull();
    expect(text(q(el, "statement-count"))).toBe("Showing 12 of 15 employees");
    expect(text(q(el, "statement-total"))).toContain("6,83,495.00");
    expect(text(q(el, "statement-department"))).toContain("ADMIN");
  });

  it("the status select keeps paid or pending rows", async () => {
    const { el } = await mount();
    press(q(el, "statement-status"), "Enter");
    const options = qa(document.body, '[role="option"]');
    expect(options.map((o) => text(o))).toEqual(["All statuses", "Paid", "Pending"]);
    press(options[2], "Enter");
    expect(rowIds(el)).toEqual([1003, 1006, 1008, 1011]);
    expect(text(q(el, "statement-total"))).toContain("1,43,699.00");
    expect(text(q(el, "statement-chip-pending"))).toBe("4 pending");
    expect(text(q(el, "statement-chip-paid"))).toBe("0 paid");
  });

  it("the filters work together", async () => {
    const { el } = await mount({
      uiState: { ...DEFAULT_STATEMENT_UI, department: "admin", status: "pending", search: "m" },
    });
    expect(rowIds(el)).toEqual([1006, 1011]);
    expect(text(q(el, "statement-total"))).toContain("1,16,861.00");
  });

  it("a department that is not in this statement filters nothing", async () => {
    const { el } = await mount({ uiState: { ...DEFAULT_STATEMENT_UI, department: "weaving" } });
    expect(rowIds(el)).toHaveLength(15);
    expect(text(q(el, "statement-count"))).toBe("15 employees in 2 departments");
  });
});

describe("Scroll and Pages", () => {
  const tabs = (el: ParentNode) => qa(el, '[role="tab"]');
  const tab = (el: ParentNode, label: string) => tabs(el).find((t) => t.textContent?.includes(label))!;

  it("is a Scroll / Pages switch (tabs), on Scroll to begin with", async () => {
    const { el } = await mount();
    expect(q(el, "statement-scroll")).not.toBeNull();
    expect(tabs(el).map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(el.querySelector('[role="tablist"]')).not.toBeNull();
  });

  it("Pages shows the paper preview of what is filtered in; Scroll brings the table back", async () => {
    const { el } = await mount();
    click(tab(el, "Pages"));
    expect(q(el, "statement-scroll")).toBeNull();
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 2");
    expect(tab(el, "Pages").getAttribute("aria-selected")).toBe("true");
    type(q(el, "statement-search")!, "kannan");
    expect(text(q(el, "statement-page-label"))).toBe("Page 1 of 1");
    expect(text(q(el, "statement-sheet"))).toContain("LOKESH KANNAN");
    expect(text(q(el, "statement-sheet"))).not.toContain("MEENATCHI.T");
    click(tab(el, "Scroll"));
    expect(q(el, "statement-scroll")).not.toBeNull();
    expect(rowIds(el)).toEqual([1002, 1007]);
  });
});

describe("the Export menu", () => {
  const openMenu = async (el: ParentNode) => {
    press(q(el, "statement-export"), "Enter");
    await flush();
  };
  const item = (key: string) => q(document.body, `statement-export-${key}`)!;
  /** Picks an item, opening the menu first if it is not open (it may close between two picks). */
  const choose = async (el: ParentNode, key: string) => {
    if (!q(document.body, `statement-export-${key}`)) await openMenu(el);
    click(item(key));
  };

  it("lists Excel, PDF and Print, with a line each on what they do", async () => {
    const { el } = await mount();
    await openMenu(el);
    expect(text(item("xlsx"))).toContain("Excel statement");
    expect(text(item("xlsx"))).toContain("Styled workbook, one sheet");
    expect(text(item("pdf"))).toContain("PDF statement");
    expect(text(item("pdf"))).toContain("A4 landscape pages with page numbers");
    expect(text(item("print"))).toContain("Print");
    expect(text(item("print"))).toContain("Opens the print dialog");
    expect(text(document.body.querySelector('[role="menu"]'))).toContain("Exports all 15 employees");
  });

  it("Excel hands the statement to the workbook export, and says what was saved", async () => {
    const { el } = await mount({ logoDataUrl: "data:image/png;base64,AAAA" });
    await openMenu(el);
    await choose(el, "xlsx");
    await until(() => expect(exporters.xlsx).toHaveBeenCalledTimes(1));
    const [sent, options] = exporters.xlsx.mock.calls[0] as [SalaryStatement, { logoDataUrl: string }];
    expect(sent).toBe(statement); // nothing filtered: the statement as the server sent it
    expect(options).toEqual({ logoDataUrl: "data:image/png;base64,AAAA" });
    expect(exporters.pdf).not.toHaveBeenCalled();
    await flush();
  });

  it("PDF and Print get the same statement", async () => {
    const { el } = await mount();
    await openMenu(el);
    await choose(el, "pdf");
    await until(() => expect(exporters.pdf).toHaveBeenCalledTimes(1));
    expect((exporters.pdf.mock.calls[0] as [SalaryStatement])[0]).toBe(statement);
    await choose(el, "print");
    await until(() => expect(exporters.print).toHaveBeenCalledTimes(1));
    expect((exporters.print.mock.calls[0] as [SalaryStatement])[0]).toBe(statement);
  });

  it("exports what is on screen: the filtered rows, with their recomputed totals", async () => {
    const { el } = await mount();
    type(q(el, "statement-search")!, "kannan");
    await openMenu(el);
    expect(text(document.body.querySelector('[role="menu"]'))).toContain("Exports the 2 of 15 employees on screen");
    await choose(el, "pdf");
    await until(() => expect(exporters.pdf).toHaveBeenCalledTimes(1));
    const sent = (exporters.pdf.mock.calls[0] as [SalaryStatement])[0];
    const sentRows: StatementRow[] = sent.groups.flatMap((g) => g.rows);
    expect(sentRows.map((r) => r.values.name)).toEqual(["LOKESH KANNAN", "KUNHIK KANNAN PV"]);
    expect(sent.total.values.net).toBe(132005);
    expect(sent.counts.employees).toBe(2);
    expect(sent).not.toBe(statement);
  });

  it("a failing export becomes a message, not a crash", async () => {
    exporters.xlsx.mockRejectedValue(new Error("exceljs blew up"));
    const { el } = await mount();
    await openMenu(el);
    await choose(el, "xlsx");
    await until(() => expect(exporters.xlsx).toHaveBeenCalled());
    await flush();
    expect(q(el, "statement-table")).not.toBeNull();
  });
});

describe("a View Only role", () => {
  it("is not locked out of the toolbar or the Export menu, while the page's own buttons are locked", async () => {
    const { el } = await mount({
      extraToolbar: createElement("button", { type: "button", "data-testid": "page-generate" }, "Generate payroll"),
      onOpenDetails: vi.fn(),
    });
    lockMutatingControls(el);
    // the page's own button is locked like any other mutating one ...
    expect((q(el, "page-generate") as HTMLButtonElement).disabled).toBe(true);
    // ... but every control of the statement is read-only and stays usable
    expect((q(el, "statement-export") as HTMLButtonElement).disabled).toBe(false);
    expect((q(el, "statement-refresh") as HTMLButtonElement).disabled).toBe(false);
    for (const t of qa(el, '[role="tab"]')) expect((t as HTMLButtonElement).disabled).toBe(false);
    expect((q(el, "statement-department") as HTMLButtonElement).disabled).toBe(false);
    expect((q(el, "statement-status") as HTMLButtonElement).disabled).toBe(false);
    for (const b of qa(el, "tbody button")) expect((b as HTMLButtonElement).disabled).toBe(false);
    // and the menu works
    press(q(el, "statement-export"), "Enter");
    await flush();
    lockMutatingControls(document.body);
    click(q(document.body, "statement-export-xlsx"));
    await until(() => expect(exporters.xlsx).toHaveBeenCalledTimes(1));
  });

  it("can still search and filter (inputs are never locked)", async () => {
    const { el } = await mount();
    lockMutatingControls(el);
    type(q(el, "statement-search")!, "kannan");
    expect(rowIds(el)).toEqual([1002, 1007]);
  });
});

describe("the page's hooks into the panel", () => {
  it("opens a payroll's details from a name, handing over the row", async () => {
    const onOpenDetails = vi.fn();
    const { el } = await mount({ onOpenDetails });
    click(q(el, "statement-details-1004"));
    expect(onOpenDetails).toHaveBeenCalledTimes(1);
    expect((onOpenDetails.mock.calls[0][0] as StatementRow).payrollId).toBe(1004);
  });

  it("renders the page's own row actions and extra toolbar items", async () => {
    const { el } = await mount({
      renderRowActions: (row) => createElement("span", { "data-testid": `act-${row.payrollId}` }, "actions"),
      extraToolbar: createElement("span", { "data-testid": "extra" }, "Generate"),
    });
    expect(q(el, "act-1001")).not.toBeNull();
    expect(qa(el, '[data-testid^="act-"]')).toHaveLength(15);
    expect(text(q(el, "extra"))).toBe("Generate");
    expect(q(el, "statement-toolbar")!.contains(q(el, "extra"))).toBe(true);
  });

  it("keeps the toolbar's state itself, or hands it to a page that wants it (uiState + onUiStateChange)", async () => {
    const seen: Partial<StatementUiState>[] = [];
    function Host() {
      const [ui, setUi] = useState<StatementUiState>({ ...DEFAULT_STATEMENT_UI, search: "kannan" });
      return createElement(SalaryStatementPanel, {
        scope: STAFF_SCOPE,
        accent: "amber",
        uiState: ui,
        onUiStateChange: (patch) => {
          seen.push(patch);
          setUi((s) => ({ ...s, ...patch }));
        },
      });
    }
    const { el } = await mount({}, () => createElement(Host));
    expect((q(el, "statement-search") as HTMLInputElement).value).toBe("kannan");
    expect(rowIds(el)).toEqual([1002, 1007]);
    type(q(el, "statement-search")!, "nair");
    expect(seen).toEqual([{ search: "nair" }]);
    expect(rowIds(el)).toEqual([1005]);
  });

  it("with uiState and no one listening, it shows what it is told and ignores edits", async () => {
    const { el } = await mount({ uiState: { ...DEFAULT_STATEMENT_UI, search: "nair" } });
    expect(rowIds(el)).toEqual([1005]);
    type(q(el, "statement-search")!, "kannan");
    expect(rowIds(el)).toEqual([1005]);
  });

  it("takes the page accent: amber on Production Payroll", async () => {
    net.fetch.mockResolvedValue(productionStatement());
    const { el } = await mount({ accent: "amber" });
    expect(q(el, "statement-total")!.querySelector("td")!.className).toContain("bg-amber-600");
  });

  it("has accessible names on its controls", async () => {
    const { el } = await mount();
    expect(q(el, "statement-panel")!.getAttribute("aria-label")).toBe("Salary statement");
    expect(q(el, "statement-search")!.getAttribute("aria-label")).toBe("Search the statement by name or ID number");
    expect(q(el, "statement-department")!.getAttribute("aria-label")).toBe("Department");
    expect(q(el, "statement-status")!.getAttribute("aria-label")).toBe("Payment status");
    expect(q(el, "statement-count")!.getAttribute("aria-live")).toBe("polite");
  });
});
