import type { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import { LATE_COLUMNS, groupEntriesByUnit, type LateEntry } from "./late";
import { PDF, buildLatePdf, latePdfName, pdfPlan } from "./late-pdf";

const entry = (id: number, over: Partial<LateEntry> = {}): LateEntry => ({
  employeeId: id,
  name: `Person ${id}`,
  code: `E${id}`,
  department: "Admin",
  unit: "HO",
  unitKey: "1",
  branchName: "Head Office",
  shiftStart: "09:00",
  grace: 15,
  lateDeadline: "09:15",
  punchIn: "09:40",
  minutesLate: 25,
  minutesAfterStart: 40,
  ...over,
});
const unit1 = (id: number, over: Partial<LateEntry> = {}) =>
  entry(id, { unit: "U-1", unitKey: "2", branchName: "Unit One", ...over });
const unit2 = (id: number, over: Partial<LateEntry> = {}) =>
  entry(id, { unit: "U-2", unitKey: "3", branchName: "Unit Two", ...over });

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

const plan = (entries: LateEntry[]) => pdfPlan(groupEntriesByUnit(entries));
const kinds = (page: ReturnType<typeof pdfPlan>[number]) => page.map((l) => l.kind);
const CAP_FIRST = Math.floor((PDF.bottom - PDF.firstTop - PDF.headHeight - 10) / PDF.rowHeight);
const CAP_NEXT = Math.floor((PDF.bottom - PDF.nextTop - PDF.headHeight - 10) / PDF.rowHeight);

describe("the PDF pages", () => {
  it("fit one page for a short list: a band, then its rows", () => {
    const pages = plan([entry(1), entry(2), unit1(3)]);
    expect(pages).toHaveLength(1);
    expect(kinds(pages[0])).toEqual(["band", "row", "row", "band", "row"]);
  });

  it("give nobody one empty page", () => {
    expect(plan([])).toEqual([[]]);
  });

  it("carry a long list over pages, the later ones holding more, and every employee is on exactly one page", () => {
    const entries = Array.from({ length: 70 }, (_, i) => entry(i + 1, { minutesLate: (i % 45) + 1 }));
    const pages = plan(entries);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]).toHaveLength(CAP_FIRST);
    expect(pages[1].length).toBeGreaterThan(pages[0].length);
    const rows = pages.flat().filter((l) => l.kind === "row");
    expect(rows).toHaveLength(70);
    expect(new Set(rows.map((l) => (l.kind === "row" ? l.entry.employeeId : 0))).size).toBe(70);
  });

  it("start a page that continues a unit with that unit's (contd.) band", () => {
    const entries = Array.from({ length: CAP_FIRST + 3 }, (_, i) => entry(i + 1));
    const pages = plan(entries);
    expect(pages[1][0]).toMatchObject({ kind: "band", contd: true });
    expect(pages[0].filter((l) => l.kind === "band")).toHaveLength(1);
    expect(pages[0][0]).toMatchObject({ kind: "band", contd: false });
  });

  it("never end a page on a band: a unit's band moves to the next page with its first row", () => {
    // HO fills the first page except for its last line, so the next unit's band (and its first row) must not fit
    const ho = Array.from({ length: CAP_FIRST - 2 }, (_, i) => entry(i + 1)); // band + (CAP_FIRST - 2) rows = CAP_FIRST - 1 lines
    const entries = [...ho, unit1(900), unit1(901)];
    const pages = plan(entries);
    expect(pages[0]).toHaveLength(CAP_FIRST - 1);
    expect(pages[0][pages[0].length - 1].kind).toBe("row");
    expect(pages[1][0]).toMatchObject({ kind: "band", contd: false });
    expect(pages[1][0].group.label).toBe("U-1");
    expect(kinds(pages[1]).slice(0, 2)).toEqual(["band", "row"]);
    // and in general no page of any plan ends on a band
    for (const n of [1, 5, CAP_FIRST - 3, CAP_FIRST - 2, CAP_FIRST - 1, CAP_FIRST, CAP_FIRST + CAP_NEXT, 90]) {
      const mixed = [...Array.from({ length: n }, (_, i) => entry(i + 1)), unit1(1000), unit2(1001), unit2(1002)];
      for (const page of plan(mixed)) expect(page[page.length - 1].kind).toBe("row");
    }
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

  it("draws a band per unit with its count, the units in order and the longest delay first inside a unit", async () => {
    const doc = await buildLatePdf(
      base([
        unit1(1, { name: "Kumar", minutesLate: 5 }),
        entry(2, { name: "Anand", minutesLate: 12 }),
        entry(3, { name: "Babu", minutesLate: 40 }),
        unit1(4, { name: "Mani", minutesLate: 31 }),
      ]),
    );
    const text = drawn(doc);
    expect(text).toContain("HO   2 late");
    expect(text).toContain("U-1   2 late");
    const at = (t: string) => text.indexOf(t);
    expect(at("HO   2 late")).toBeLessThan(at("Babu"));
    expect(at("Babu")).toBeLessThan(at("Anand"));
    expect(at("Anand")).toBeLessThan(at("U-1   2 late"));
    expect(at("U-1   2 late")).toBeLessThan(at("Mani"));
    expect(at("Mani")).toBeLessThan(at("Kumar"));
  });

  it("draws only the units of the rows it is given", async () => {
    const text = drawn(await buildLatePdf(base([unit2(1), unit2(2)])));
    expect(text).toContain("U-2   2 late");
    expect(text.some((t) => t.startsWith("HO "))).toBe(false);
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

  it("repeats the header, the (contd.) band and the page numbers when the list is long", async () => {
    const entries = Array.from({ length: 70 }, (_, i) => entry(i + 1, { minutesLate: (i % 45) + 1 }));
    const doc = await buildLatePdf(base(entries));
    const pages = plan(entries).length;
    expect(doc.getNumberOfPages()).toBe(pages);
    const text = drawn(doc);
    expect(text.filter((t) => t === "Employee Name")).toHaveLength(pages);
    expect(text.filter((t) => t === "Total Minutes Late")).toHaveLength(pages);
    expect(text.filter((t) => t === "HO (contd.)")).toHaveLength(pages - 1);
    expect(text).toContain("HO   70 late");
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
