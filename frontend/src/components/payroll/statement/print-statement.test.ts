import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatedStaffStatement, productionStatement, staffStatement } from "./fixtures";
import { PAPER } from "./paper-layout";
import {
  PRINT_CLEANUP_MS,
  PRINT_CSS,
  PRINT_ROOT_ID,
  PRINT_STYLE_ID,
  clearPrint,
  printStatement,
} from "./print-statement";

const root = () => document.getElementById(PRINT_ROOT_ID);
const style = () => document.getElementById(PRINT_STYLE_ID);
const sheets = () => Array.from(root()?.querySelectorAll<HTMLElement>(".stmt-sheet") ?? []);
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

type Seen = { root: HTMLElement | null; style: HTMLElement | null; sheets: HTMLElement[]; css: string };

describe("printStatement", () => {
  let print: ReturnType<typeof vi.spyOn>;
  let seen: Seen | null;

  beforeEach(() => {
    seen = null;
    print = vi.spyOn(window, "print").mockImplementation(() => {
      seen = { root: root(), style: style(), sheets: sheets(), css: style()?.textContent ?? "" };
    });
  });

  afterEach(() => {
    clearPrint();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("puts the sheets and a print stylesheet on the page BEFORE it opens the print dialog", () => {
    printStatement(staffStatement());
    expect(print).toHaveBeenCalledTimes(1);
    expect(seen!.root).not.toBeNull();
    expect(seen!.root!.parentElement).toBe(document.body);
    expect(seen!.root!.getAttribute("aria-hidden")).toBe("true");
    expect(seen!.sheets).toHaveLength(2);
    expect(seen!.style).not.toBeNull();
    expect(seen!.style!.parentElement).toBe(document.head);
  });

  it("the print stylesheet sets A4 landscape with an 8 mm margin and hides everything else on the page", () => {
    printStatement(staffStatement());
    expect(seen!.css).toBe(PRINT_CSS);
    expect(PRINT_CSS).toContain("@page { size: A4 landscape; margin: 8mm }");
    expect(PRINT_CSS).toContain("@media print");
    expect(PRINT_CSS).toContain(`body > *:not(#${PRINT_ROOT_ID}) { display: none !important }`);
    expect(PRINT_CSS).toContain("break-after: page");
  });

  it("removes the container and the stylesheet when the dialog closes (afterprint)", () => {
    printStatement(staffStatement());
    expect(root()).not.toBeNull();
    window.dispatchEvent(new Event("afterprint"));
    expect(root()).toBeNull();
    expect(style()).toBeNull();
    // a second afterprint is harmless
    window.dispatchEvent(new Event("afterprint"));
    expect(root()).toBeNull();
  });

  it("removes them anyway after a while when the browser never says the dialog closed", () => {
    vi.useFakeTimers();
    printStatement(staffStatement());
    vi.advanceTimersByTime(PRINT_CLEANUP_MS - 1);
    expect(root()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(root()).toBeNull();
    expect(style()).toBeNull();
  });

  it("a print that fails cleans up and passes the error on", () => {
    print.mockImplementation(() => {
      throw new Error("the printer is on fire");
    });
    expect(() => printStatement(staffStatement())).toThrow("the printer is on fire");
    expect(root()).toBeNull();
    expect(style()).toBeNull();
  });

  it("printing again replaces the first container instead of adding a second", () => {
    printStatement(staffStatement());
    printStatement(productionStatement());
    expect(document.querySelectorAll(`#${PRINT_ROOT_ID}`)).toHaveLength(1);
    expect(document.querySelectorAll(`#${PRINT_STYLE_ID}`)).toHaveLength(1);
    expect(text(root())).toContain("UKTextiles - Weaving unit");
    expect(text(root())).not.toContain("U.K TEXTILES");
  });

  it("clearPrint takes it away by hand, and does nothing when there is nothing to take away", () => {
    clearPrint();
    printStatement(staffStatement());
    clearPrint();
    expect(root()).toBeNull();
  });

  it("guards a browser with no print dialog (jsdom has none): a readable error and nothing left on the page", () => {
    const saved = window.print;
    Object.defineProperty(window, "print", { value: undefined, configurable: true, writable: true });
    try {
      expect(() => printStatement(staffStatement())).toThrow(/not available/i);
      expect(root()).toBeNull();
      expect(style()).toBeNull();
    } finally {
      Object.defineProperty(window, "print", { value: saved, configurable: true, writable: true });
    }
  });
});

describe("the printed sheets", () => {
  beforeEach(() => {
    vi.spyOn(window, "print").mockImplementation(() => {});
  });
  afterEach(() => {
    clearPrint();
    vi.restoreAllMocks();
  });

  it("one landscape sheet per page, each with the company and title block and the header repeated", () => {
    printStatement(staffStatement());
    const pages = sheets();
    expect(pages).toHaveLength(2);
    pages.forEach((sheet, i) => {
      expect(text(sheet.querySelector(".stmt-company"))).toBe("U.K TEXTILES - H.O");
      expect(text(sheet.querySelector(".stmt-title"))).toBe("Salary Statement From 01-09-2026 To 30-09-2026");
      const labels = text(sheet.querySelector(".stmt-labels"));
      for (const label of [
        "SNO",
        "ID NO",
        "Name",
        "Designation",
        "Basic salary",
        "Total Days",
        "Lop& PSAmt",
        "NET",
        "Remarks",
      ]) {
        expect(labels).toContain(label);
      }
      expect(Array.from(sheet.querySelectorAll(".stmt-bands th")).map((th) => text(th))).toEqual([
        "EMPLOYEE",
        "EARNINGS",
        "ATTENDANCE",
        "EARNINGS",
        "DEDUCTIONS",
        "NET PAY",
      ]);
      expect(sheet.getAttribute("data-page")).toBe(String(i + 1));
    });
  });

  it("'Page x of y' at the bottom right and 'Generated ...' at the bottom left of every sheet", () => {
    printStatement(staffStatement());
    const feet = sheets().map((s) => s.querySelector(".stmt-foot")!);
    expect(feet.map((f) => text(f.lastElementChild))).toEqual(["Page 1 of 2", "Page 2 of 2"]);
    for (const f of feet) expect(text(f.firstElementChild)).toMatch(/^Generated \d{2}-\d{2}-\d{4} \d{2}:\d{2}$/);
  });

  it("bands, rows and subtotals as on the printed page; a department that carries over gets a (contd.) band", () => {
    printStatement(staffStatement());
    const [first, second] = sheets();
    expect(Array.from(first.querySelectorAll(".stmt-bandline")).map((b) => text(b))).toEqual([
      "ACCOUNTS 3 employees",
      "ADMIN 12 employees",
    ]);
    expect(first.querySelectorAll(".stmt-row")).toHaveLength(14);
    expect(text(first.querySelector(".stmt-sub"))).toContain("ACCOUNTS - Total");
    expect(Array.from(second.querySelectorAll(".stmt-bandline")).map((b) => text(b))).toEqual(["ADMIN (contd.)"]);
    expect(second.querySelectorAll(".stmt-row")).toHaveLength(1);
    expect(text(second.querySelector(".stmt-row"))).toContain("THIRUNAVUKARASU");
  });

  it("the grand total and the notes are on the last sheet only", () => {
    printStatement(staffStatement());
    const [first, second] = sheets();
    expect(first.querySelector(".stmt-total")).toBeNull();
    expect(first.querySelector(".stmt-notes")).toBeNull();
    expect(text(second.querySelector(".stmt-total"))).toContain("GRAND TOTAL");
    expect(text(second.querySelector(".stmt-total"))).toContain("7,29,499.00");
    expect(text(second.querySelector(".stmt-notes"))).toContain("TDS is not tracked by the HRMS and is always 0.");
    expect(second.querySelectorAll(".stmt-notes > div")).toHaveLength(7);
  });

  it("figures have Indian grouping and two decimals, a zero is muted, a designation may take two lines", () => {
    printStatement(staffStatement());
    const rows = Array.from(sheets()[0].querySelectorAll(".stmt-row"));
    const first = rows[0];
    const cells = Array.from(first.querySelectorAll("td")).map((td) => text(td));
    expect(cells.slice(0, 6)).toEqual(["1", "2316", "MEENATCHI.T", "ACCOUNTS EXECUTIVE", "14,750.00", "29,500.00"]);
    expect(cells[cells.length - 2]).toBe("26,230.00"); // NET, then the empty Remarks
    expect(cells[cells.length - 1]).toBe("");
    const zero = Array.from(first.querySelectorAll("td")).find((td) => text(td) === "0.00");
    expect(zero?.className).toContain("stmt-zero");
    expect(first.querySelector(".stmt-clip2")).not.toBeNull();
    expect(text(rows[2])).toContain("LEFT");
  });

  it("lays the columns out from the layout: one <col> per column, adding up to the printable width", () => {
    printStatement(staffStatement());
    const sheet = sheets()[0];
    const cols = Array.from(sheet.querySelectorAll("col")).map((c) => parseFloat(c.style.width));
    expect(cols).toHaveLength(24);
    // the columns and the table border add up to the printable width
    const widthMm = PAPER.contentWidthMm - PAPER.tableBorderMm;
    expect(cols.reduce((a, b) => a + b, 0)).toBeCloseTo(widthMm, 1);
    const table = sheet.querySelector<HTMLElement>(".stmt-table")!;
    expect(table.style.width).toBe(`${widthMm}mm`);
    expect(parseFloat(table.style.fontSize)).toBeGreaterThanOrEqual(5.5);
    expect(parseFloat(table.style.fontSize)).toBeLessThanOrEqual(7);
  });

  it("a longer statement prints on more sheets, and the number of lines per sheet can be changed", () => {
    printStatement(generatedStaffStatement(130, 8));
    expect(sheets()).toHaveLength(9);
    expect(text(sheets()[8].querySelector(".stmt-foot")!.lastElementChild)).toBe("Page 9 of 9");
    printStatement(staffStatement(), { rowsPerPage: 8 });
    expect(sheets().length).toBeGreaterThan(2);
  });

  it("the production statement gets its own sheet class (amber) and columns", () => {
    printStatement(productionStatement());
    const sheet = sheets()[0];
    expect(sheet.className).toContain("stmt-kind-production");
    expect(text(sheet.querySelector(".stmt-labels"))).toContain("Rate / shift");
  });

  it("an empty statement prints one sheet with just the header and a zero total", () => {
    const empty = { ...staffStatement(), groups: [] as never[] };
    printStatement(empty);
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].querySelectorAll(".stmt-row")).toHaveLength(0);
    expect(text(sheets()[0].querySelector(".stmt-total"))).toContain("GRAND TOTAL");
  });
});
