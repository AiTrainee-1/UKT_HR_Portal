import type { jsPDF } from "jspdf";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SalaryStatement } from "@/lib/api-client/custom-hooks";
import {
  PDF_LINES_PER_PAGE,
  PDF_PAGE,
  buildStatementPdf,
  downloadStatementPdf,
  pdfPages,
  pdfSafe,
  statementPdfFilename,
} from "./export-statement-pdf";
import { generatedStaffStatement, productionStatement, staffStatement } from "./fixtures";
import { notesReserveLines } from "./paper-layout";
import { filterStatement, paginateStatement } from "./statement-model";

// 1x1 transparent PNG
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const RUPEE = String.fromCharCode(0x20b9);

/** Every string the document draws (the `(text) Tj` of its content streams), in drawing order. */
function drawn(doc: jsPDF): string[] {
  const out = doc.output();
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let m = re.exec(out); m; m = re.exec(out)) found.push(m[1].replace(/\\([()\\])/g, "$1"));
  return found;
}

/** Every string with the y it was drawn at, in millimetres from the TOP of the page (PDF coordinates start at the bottom). */
function drawnAt(doc: jsPDF): { text: string; y: number }[] {
  const out = doc.output();
  const found: { text: string; y: number }[] = [];
  const re = /([\d.]+) ([\d.]+) Td\s*\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  const pageHeightPt = (doc.internal.pageSize.getHeight() * 72) / 25.4;
  for (let m = re.exec(out); m; m = re.exec(out)) {
    found.push({ text: m[3].replace(/\\([()\\])/g, "$1"), y: ((pageHeightPt - Number(m[2])) * 25.4) / 72 });
  }
  return found;
}

/** The strings of each page: a page's drawing ends with its "Page x of y" footer. */
function perPage(doc: jsPDF): string[][] {
  const pages: string[][] = [];
  let current: string[] = [];
  for (const text of drawn(doc)) {
    current.push(text);
    if (/^Page \d+ of \d+$/.test(text)) {
      pages.push(current);
      current = [];
    }
  }
  return pages;
}

const count = (texts: string[], wanted: string) => texts.filter((t) => t === wanted).length;

/** A header label is wrapped by hand when its column is narrow: it is drawn whole, or word by word on several lines. */
const hasLabel = (texts: string[], label: string) =>
  texts.includes(label) || label.split(" ").every((word) => texts.some((t) => t.split(" ").includes(word)));

describe("pdfSafe", () => {
  it("never draws the rupee sign: it becomes Rs", () => {
    expect(pdfSafe(`${RUPEE}1,000`)).toBe("Rs 1,000");
    expect(pdfSafe(`${RUPEE} 1,000`)).toBe("Rs 1,000");
    expect(pdfSafe(`Net ${RUPEE}50`)).toBe("Net Rs 50");
    expect(pdfSafe(`${RUPEE}`)).toBe("Rs ");
  });

  it("turns typographic punctuation into plain punctuation and breaks into spaces", () => {
    const text = [
      "a",
      String.fromCharCode(0x2013),
      "b",
      String.fromCharCode(0x2014),
      String.fromCharCode(0x2018),
      "c",
      String.fromCharCode(0x2019),
      String.fromCharCode(0x201c),
      "d",
      String.fromCharCode(0x201d),
      String.fromCharCode(0x2026),
      String.fromCharCode(0xa0),
      "e\nf\tg",
    ].join("");
    expect(pdfSafe(text)).toBe("a-b-'c'\"d\"... e f g");
  });

  it("keeps ASCII and Latin-1 letters, and shows a letter Helvetica has no glyph for as a question mark", () => {
    expect(pdfSafe("MEENATCHI.T & Co. (1)")).toBe("MEENATCHI.T & Co. (1)");
    expect(pdfSafe(`Ren${String.fromCharCode(0xe9)}e`)).toBe(`Ren${String.fromCharCode(0xe9)}e`);
    expect(pdfSafe(`A${String.fromCharCode(0x0b95)}B`)).toBe("A?B");
  });
});

describe("the page", () => {
  it("is A4 landscape and holds a page's worth of lines", () => {
    expect(PDF_PAGE.width).toBe(297);
    expect(PDF_PAGE.height).toBe(210);
    expect(PDF_LINES_PER_PAGE).toBeGreaterThanOrEqual(24);
    // the lines fit between the header and the bottom margin
    expect(
      PDF_PAGE.tableTop + PDF_PAGE.bandHeight + PDF_PAGE.headHeight + PDF_LINES_PER_PAGE * PDF_PAGE.rowHeight,
    ).toBeLessThanOrEqual(PDF_PAGE.bottom);
  });

  it("pdfPages is the model's pagination at that size", () => {
    const s = generatedStaffStatement(40, 4);
    const reserve = notesReserveLines(s.notes, {
      lineMm: PDF_PAGE.rowHeight,
      notesPt: PDF_PAGE.notesPt,
      notesLineMm: PDF_PAGE.notesLineMm,
    });
    expect(reserve).toBeGreaterThan(0);
    expect(pdfPages(s).map((p) => p.lines.length)).toEqual(
      paginateStatement(s, PDF_LINES_PER_PAGE, { reserveLastPage: reserve }).map((p) => p.lines.length),
    );
  });
});

describe("buildStatementPdf: pages", () => {
  it("one A4 landscape page for the fifteen printed rows", async () => {
    const doc = await buildStatementPdf(staffStatement());
    expect(doc.getNumberOfPages()).toBe(1);
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 1);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 1);
  });

  it("the page count follows the rows: 15 -> 1, 40 -> 2, 120 -> 6", async () => {
    for (const [employees, departments, pages] of [
      [15, 2, 1],
      [40, 4, 2],
      [120, 8, 6],
    ] as const) {
      const statement = generatedStaffStatement(employees, departments);
      const doc = await buildStatementPdf(statement);
      expect(doc.getNumberOfPages()).toBe(pages);
      expect(doc.getNumberOfPages()).toBe(pdfPages(statement).length);
    }
  });

  it("every page says 'Page x of y' at the bottom right and 'Generated dd-mm-yyyy hh:mm' at the bottom left", async () => {
    const doc = await buildStatementPdf(generatedStaffStatement(120, 8));
    const pages = perPage(doc);
    expect(pages).toHaveLength(6);
    pages.forEach((texts, i) => {
      expect(texts.at(-1)).toBe(`Page ${i + 1} of 6`);
      expect(texts.at(-2)).toMatch(/^Generated \d{2}-\d{2}-\d{4} \d{2}:\d{2}$/);
    });
  });
});

describe("buildStatementPdf: content", () => {
  const statement = generatedStaffStatement(40, 4);

  it("repeats the company and title block and the header on every page", async () => {
    const doc = await buildStatementPdf(statement);
    const pages = perPage(doc);
    expect(pages).toHaveLength(2);
    for (const texts of pages) {
      expect(count(texts, "U.K TEXTILES - H.O")).toBe(1);
      expect(count(texts, "Salary Statement From 01-09-2026 To 30-09-2026")).toBe(1);
      for (const label of [
        "SNO",
        "ID NO",
        "Name",
        "Designation",
        "NET",
        "Remarks",
        "Basic salary",
        "Total Deduction",
        "Others Allow",
        "not tracked",
        "information",
      ]) {
        expect(hasLabel(texts, label)).toBe(true);
      }
      // the group bands
      for (const band of ["EMPLOYEE", "ATTENDANCE", "EARNINGS", "DEDUCTIONS", "NET PAY"]) expect(texts).toContain(band);
    }
    // the header row is drawn once per page: "Designation" appears exactly as often as there are pages
    expect(count(drawn(doc), "Designation")).toBe(2);
  });

  it("puts a (contd.) band at the top of a page when a department carries over", async () => {
    const doc = await buildStatementPdf(statement);
    const [first, second] = perPage(doc);
    expect(first.some((t) => t.includes("(contd.)"))).toBe(false);
    expect(second.some((t) => /^[A-Z]+ \(contd\.\)$/.test(t))).toBe(true);
    // each department has one real band (with its count) and the carried-over one has none
    const bands = drawn(doc).filter((t) => /employees$/.test(t));
    expect(bands.length).toBeGreaterThanOrEqual(4);
  });

  it("has a band, the employees, a subtotal per department, then ONE grand total, on the last page", async () => {
    const doc = await buildStatementPdf(statement);
    const [first, second] = perPage(doc);
    expect(count(drawn(doc), "GRAND TOTAL")).toBe(1);
    expect(second).toContain("GRAND TOTAL");
    expect(first).not.toContain("GRAND TOTAL");
    const subtotals = drawn(doc).filter((t) => / - Total$/.test(t));
    expect(subtotals).toEqual(["ACCOUNTS - Total", "ADMIN - Total", "CUTTING - Total", "STITCHING - Total"]);
  });

  it("draws plain figures with Indian grouping, never cut, in the right rows", async () => {
    const doc = await buildStatementPdf(staffStatement());
    const [texts] = perPage(doc);
    for (const figure of ["1,67,462.00", "26,230.00", "99,200.00", "14,750.00", "29,500.00", "24.50", "7,29,499.00"]) {
      expect(texts).toContain(figure);
    }
    expect(texts).toContain("8,05,875.00"); // the E salary grand total: 47,808 + 7,58,067
    expect(texts.filter((t) => /\.\.\./.test(t))).toEqual([]);
    expect(texts.join(" ")).not.toContain(RUPEE);
  });

  it("cuts a text that is too long for its column with an ellipsis, and only text", async () => {
    const base = staffStatement();
    const long = "A VERY LONG EMPLOYEE NAME THAT CANNOT POSSIBLY FIT ITS COLUMN ON THE PAGE";
    const s: SalaryStatement = {
      ...base,
      groups: base.groups.map((g, gi) => ({
        ...g,
        rows: g.rows.map((r, ri) => (gi === 0 && ri === 0 ? { ...r, values: { ...r.values, name: long } } : r)),
      })),
    };
    const texts = perPage(await buildStatementPdf(s))[0];
    expect(texts).not.toContain(long);
    const cut = texts.find((t) => t.endsWith("...") && long.startsWith(t.slice(0, -3)));
    expect(cut).toBeDefined();
    expect(cut!.length).toBeLessThan(long.length);
    // figures are never cut
    expect(texts.filter((t) => /^[\d,.]+$/.test(t) && t.includes("..."))).toEqual([]);
  });

  it("prints the notes under the table on the last page only", async () => {
    const doc = await buildStatementPdf(statement);
    const [first, second] = perPage(doc);
    expect(second).toContain("Notes");
    expect(second).toContain("TDS is not tracked by the HRMS and is always 0.");
    // the long notes are wrapped by hand, every line within the table's width
    expect(second.some((t) => t.startsWith("Basic is the first salary-split portion"))).toBe(true);
    expect(first).not.toContain("Notes");
  });

  it("keeps every note on the page: a full last page makes room for them first (they are never cut off)", async () => {
    const base = generatedStaffStatement(60, 3);
    const long = (n: number) =>
      `Note ${n}: ` + "this is a long sentence about how a column is worked out and what it means. ".repeat(6);
    const statement: SalaryStatement = { ...base, notes: Array.from({ length: 12 }, (_, i) => long(i + 1)) };
    const doc = await buildStatementPdf(statement);
    const last = doc.getNumberOfPages();
    expect(last).toBe(pdfPages(statement).length);
    const at = drawnAt(doc);
    // every note is there, and everything is above the footer line (205 mm) with the table's last row above the first note
    for (let n = 1; n <= 12; n += 1) expect(at.some((d) => d.text.startsWith(`Note ${n}: `))).toBe(true);
    const lowest = Math.max(...at.filter((d) => !/^(Page \d+ of \d+|Generated )/.test(d.text)).map((d) => d.y));
    expect(lowest).toBeLessThan(PDF_PAGE.footerY - 1);
    const heading = at.filter((d) => d.text === "Notes").at(-1)!;
    const lastTotal = at.filter((d) => d.text === "GRAND TOTAL").at(-1)!;
    expect(heading.y).toBeGreaterThan(lastTotal.y);
  });

  it("writes the rupee as Rs and never draws the rupee glyph", async () => {
    const base = staffStatement();
    const s: SalaryStatement = {
      ...base,
      notes: [`Net pay is shown in ${RUPEE} (rupees)`, `${RUPEE}1,000 advance recovered`],
      company: { name: `UKTextiles ${RUPEE}`, branchLabel: "H.O" },
    };
    const doc = await buildStatementPdf(s);
    const texts = drawn(doc);
    expect(texts.join("")).not.toContain(RUPEE);
    expect(doc.output()).not.toContain(RUPEE);
    expect(texts).toContain("Net pay is shown in Rs (rupees)");
    expect(texts).toContain("Rs 1,000 advance recovered");
    expect(texts).toContain("UKTextiles Rs - H.O");
  });

  it("sets the document properties", async () => {
    const out = (await buildStatementPdf(staffStatement())).output();
    expect(out).toContain("/Title (Salary Statement From 01-09-2026 To 30-09-2026)");
    expect(out).toContain("/Author (UKTextiles HRMS)");
  });

  it("draws the company logo on the page when it is given, and ignores anything that is not an image", async () => {
    expect((await buildStatementPdf(staffStatement(), { logoDataUrl: PNG_DATA_URL })).output()).toContain(
      "/Subtype /Image",
    );
    expect(
      (await buildStatementPdf(staffStatement(), { logoDataUrl: "https://example.com/logo.png" })).output(),
    ).not.toContain("/Subtype /Image");
    expect((await buildStatementPdf(staffStatement())).output()).not.toContain("/Subtype /Image");
  });

  it("does not stop for a broken logo", async () => {
    const doc = await buildStatementPdf(staffStatement(), { logoDataUrl: "data:image/png;base64,AAAA" });
    expect(doc.getNumberOfPages()).toBe(1);
  });

  it("a filtered statement is what is drawn, with its recomputed totals", async () => {
    const doc = await buildStatementPdf(filterStatement(staffStatement(), { search: "kannan" }));
    const [texts] = perPage(doc);
    expect(texts).toContain("LOKESH KANNAN");
    expect(texts).not.toContain("MEENATCHI.T");
    expect(texts).toContain("1,32,005.00"); // the grand total net: 14,005 + 1,18,000
    expect(texts).toContain("14,005.00");
  });

  it("an empty statement is one page with the header and a zero grand total", async () => {
    const doc = await buildStatementPdf(filterStatement(staffStatement(), { search: "zzz" }));
    expect(doc.getNumberOfPages()).toBe(1);
    const [texts] = perPage(doc);
    expect(texts).toContain("GRAND TOTAL");
    expect(texts).toContain("0.00");
  });

  it("the production statement fits one page with its own columns", async () => {
    const doc = await buildStatementPdf(productionStatement());
    expect(doc.getNumberOfPages()).toBe(1);
    const [texts] = perPage(doc);
    expect(texts).toContain("UKTextiles - Weaving unit");
    expect(texts).toContain("Production Salary Statement From 02-02-2026 To 08-02-2026");
    expect(hasLabel(texts, "Rate / shift")).toBe(true);
    expect(hasLabel(texts, "Days worked")).toBe(true);
    expect(hasLabel(texts, "ESI / EF")).toBe(true);
    expect(texts).toContain("Weaving");
    expect(texts).toContain("Spinning");
    expect(texts).toContain("19,881.00"); // the grand total net
  });
});

describe("downloadStatementPdf", () => {
  let created: Blob[];
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    created = [];
    clicked = [];
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          created.push(b);
          return "blob:statement-pdf";
        },
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is named Salary_Statement_<period>.pdf", () => {
    expect(statementPdfFilename(staffStatement())).toBe("Salary_Statement_September_2026.pdf");
    expect(statementPdfFilename(productionStatement())).toBe("Salary_Statement_Production_2_Feb_8_Feb_2026.pdf");
  });

  it("downloads a real PDF", async () => {
    await downloadStatementPdf(staffStatement());
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("Salary_Statement_September_2026.pdf");
    expect(created[0].type).toBe("application/pdf");
    const head = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).slice(0, 8));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(created[0].slice(0, 8));
    });
    expect(head).toBe("%PDF-1.3");
  });
});
