import type { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { LATE_COLUMNS, type LateEntry } from "./late";
import { PDF, buildLatePdf, latePdfName, pdfRowsPerPage } from "./late-pdf";

const entry = (id: number, over: Partial<LateEntry> = {}): LateEntry => ({
  employeeId: id,
  name: `Person ${id}`,
  code: `E${id}`,
  department: "Admin",
  unit: "HO",
  shiftStart: "09:00",
  grace: 15,
  lateDeadline: "09:15",
  punchIn: "09:40",
  minutesLate: 25,
  minutesAfterStart: 40,
  ...over,
});

const base = (entries: LateEntry[]) => ({
  date: "2026-08-03",
  entries,
  company: "UK Textiles",
  branchLabel: "All Branches",
  logoDataUrl: null,
  filter: "",
  now: new Date(2026, 9, 26, 11, 45),
});

/** Every string the document draws, in drawing order. */
function drawn(doc: jsPDF): string[] {
  const out = doc.output();
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let m = re.exec(out); m; m = re.exec(out)) found.push(m[1].replace(/\\([()\\])/g, "$1"));
  return found;
}

describe("the PDF pages", () => {
  it("fit one page for a short list and the totals row has room", () => {
    expect(pdfRowsPerPage(0)).toEqual([0]);
    expect(pdfRowsPerPage(5)).toEqual([5]);
  });
  it("carry a long list over pages, the later ones holding more", () => {
    const pages = pdfRowsPerPage(60);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.reduce((a, b) => a + b, 0)).toBe(60);
    expect(pages[1]).toBeGreaterThan(pages[0]);
  });
  it("hold the rows of a full page and carry the next one over, with room kept for the colour key", () => {
    const cap = Math.floor((PDF.bottom - PDF.firstTop - PDF.headHeight - 10) / PDF.rowHeight);
    expect(pdfRowsPerPage(cap)).toEqual([cap]);
    expect(pdfRowsPerPage(cap + 1)).toEqual([cap, 1]);
  });
});

describe("the Daily Late Report PDF", () => {
  it("is A4 landscape with the company, the title, the date and the seven headers", async () => {
    const doc = await buildLatePdf(base([entry(1, { minutesLate: 40 }), entry(2, { minutesLate: 5 })]));
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
    expect(doc.internal.pageSize.getHeight()).toBeCloseTo(210, 0);
    const text = drawn(doc);
    expect(text).toContain("UK Textiles");
    expect(text).toContain("Daily Late Report");
    expect(text).toContain("Mon, 3 Aug 2026");
    // a long header wraps onto two lines, so read the headers as running text
    const running = text.join(" ");
    for (const col of LATE_COLUMNS) expect(running).toContain(col.header);
  });

  it("draws every row and a footer with the moment and the page number, and no summary, explanation or totals", async () => {
    const doc = await buildLatePdf(base([entry(1, { minutesLate: 40 }), entry(2, { minutesLate: 5 })]));
    const text = drawn(doc);
    expect(text).toContain("Person 1");
    expect(text).toContain("Person 2");
    expect(text).toContain("09:40 AM");
    expect(text).toContain("40 min");
    // the two lines the owner did not want, and the totals row, are not in the file
    const running = text.join(" ");
    expect(running).not.toContain("Total late");
    expect(running).not.toContain("Average");
    expect(running).not.toContain("Longest");
    expect(running).not.toContain("Total Minutes Late =");
    expect(running).not.toContain("Total:");
    expect(text).not.toContain("45 min"); // the minutes added up
    expect(text).toContain("Late by:"); // the small colour key stays
    expect(text).toContain("Generated 26 Oct 2026, 11:45 AM  -  UKTextiles HRMS");
    expect(text).toContain("Page 1 of 1");
  });

  it("repeats the header and numbers the pages when the list is long", async () => {
    const entries = Array.from({ length: 70 }, (_, i) => entry(i + 1, { minutesLate: (i % 45) + 1 }));
    const doc = await buildLatePdf(base(entries));
    const pages = pdfRowsPerPage(70).length;
    expect(doc.getNumberOfPages()).toBe(pages);
    const text = drawn(doc);
    expect(text.filter((t) => t === "Employee Name")).toHaveLength(pages);
    expect(text.filter((t) => t === "Total Minutes Late")).toHaveLength(pages);
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text).toContain("Person 70");
  });

  it("draws a dash for what is missing, and shows the filter in the header", async () => {
    const doc = await buildLatePdf({
      ...base([entry(1, { shiftStart: null, grace: null, minutesLate: null })]),
      filter: "Department: Admin",
    });
    const text = drawn(doc);
    expect(text).toContain("-");
    expect(text).toContain("Department: Admin");
  });

  it("is named after the report and its date", () => {
    expect(latePdfName("2026-08-03")).toBe("Daily_Late_Report_2026-08-03.pdf");
  });
});
