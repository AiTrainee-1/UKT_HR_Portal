import type { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import {
  attentionPdfRows,
  buildEmployeePdf,
  buildEmployeeWorkbook,
  buildPagePdf,
  buildPageWorkbook,
  categorySheet,
  categoryTopRows,
  employeeFileName,
  employeeSheets,
  exportEmployees,
  hodSheet,
  pageFileName,
  pageSheets,
  pageSubtitle,
  sheetName,
  summarySheet,
  type PageExportInput,
} from "./export";
import { FIXTURE_HODS, fixtureCategory, fixtureEmployee, fixtureSummary } from "./fixtures";
import type { AnalyticsTab, CategoryDetail } from "./types";

// The HR Analytics exports (owner 2026-11-21): the page's workbook (Summary, one sheet per category, HODs on Staff) and
// PDF, and one employee's own workbook and PDF. Rows are checked against the fixture cast.

const company = { company: "UK Textiles", branchLabel: "All Branches", logoDataUrl: null };

function pageInput(type: AnalyticsTab, over: Partial<PageExportInput> = {}): PageExportInput {
  const summary = fixtureSummary(type);
  return {
    ...company,
    summary,
    filterText: [],
    levelFilter: "all",
    categories: summary.categories.map((c) => fixtureCategory(type, c.key)!) as CategoryDetail[],
    now: new Date(2026, 10, 21, 10, 30),
    ...over,
  };
}

/** Every string the document draws, in drawing order. */
function drawn(doc: jsPDF): string[] {
  const out = doc.output();
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out))) found.push(m[1].replace(/\\(.)/g, "$1"));
  return found;
}

describe("the Summary sheet", () => {
  it("one row per employee: identity, level, score, every category's count, the categories over the limit", () => {
    const sheet = summarySheet(fixtureSummary("staff"), "all");
    expect(sheet.columns.map((c) => c.header).slice(0, 9)).toEqual([
      "#",
      "Code",
      "Name",
      "Department",
      "Designation",
      "Level",
      "Score",
      "Leave (3)",
      "Late arrival (3)",
    ]);
    expect(sheet.columns).toHaveLength(7 + 11 + 2);
    const surya = sheet.rows.find((r) => r[1] === "30020")!;
    expect(surya.slice(0, 7)).toEqual([3, "30020", "SURYA M", "IT", "AI Engineer", "High", 2.67]);
    expect(surya[8]).toBe(6); // late
    expect(surya[17]).toBe(2); // permissions
    expect(surya[18]).toBe("Late arrival");
    expect(surya[19]).toBe("2026-11-20");
  });

  it("follows the list's level choice", () => {
    const s = fixtureSummary("staff");
    expect(summarySheet(s, "high").rows).toHaveLength(3);
    expect(summarySheet(s, "needs").rows).toHaveLength(8);
    expect(exportEmployees(s, "watch").every((e) => e.level === "watch")).toBe(true);
  });

  it("marks a reference-only category as such in its heading", () => {
    const sheet = summarySheet(fixtureSummary("production"), "all");
    expect(sheet.columns.map((c) => c.header)).toContain("Late attendance details (info)");
  });
});

describe("a category sheet", () => {
  it("one row per record, newest first, the employee on each row", () => {
    const sheet = categorySheet(fixtureCategory("staff", "late")!);
    expect(sheet.columns.map((c) => c.header).slice(0, 10)).toEqual([
      "Code",
      "Name",
      "Department",
      "Count (days)",
      "Limit",
      "Over the limit",
      "Level",
      "Pattern",
      "Date",
      "Until",
    ]);
    expect(sheet.rows).toHaveLength(19); // every late record of the cast
    const gokul = sheet.rows.filter((r) => r[0] === "30128");
    expect(gokul).toHaveLength(7);
    expect(gokul[0].slice(0, 7)).toEqual(["30128", "GOKUL T", "Merchandising", 7, "3", "Yes", "High"]);
    expect(gokul.map((r) => r[8])).toEqual([...gokul.map((r) => r[8])].sort().reverse());
    expect(sheet.note).toContain("4+ days a month · 3 for this period");
  });

  it("a run keeps its last day", () => {
    const sheet = categorySheet(fixtureCategory("production", "continuous_leave")!);
    const kavitha = sheet.rows.filter((r) => r[0] === "50045");
    expect(kavitha.map((r) => [r[8], r[9]])).toEqual([
      ["2026-11-12", "2026-11-14"],
      ["2026-11-04", "2026-11-06"],
    ]);
  });
});

describe("the HODs sheet", () => {
  it("decided, rejected, the rate, the speed and what waits", () => {
    const sheet = hodSheet(FIXTURE_HODS);
    expect(sheet.rows[0]).toEqual(["20004", "R KUMAR", "Accounts", 14, 3, "21%", "19.5 h", 2, 1, "2.9 days"]);
    expect(sheet.rows[1][9]).toBe("-");
  });
});

describe("the page's workbook", () => {
  it("Summary, then one sheet per category (Excel-safe names), then HODs on Staff only", () => {
    const staff = pageSheets(pageInput("staff")).map((s) => s.name);
    expect(staff[0]).toBe("Summary");
    expect(staff).toHaveLength(1 + 11 + 1);
    expect(staff[staff.length - 1]).toBe("HODs");
    expect(staff).toContain("Late arrival");
    expect(staff.every((n) => n.length <= 31)).toBe(true);
    expect(new Set(staff.map((n) => n.toLowerCase())).size).toBe(staff.length);
    const production = pageSheets(pageInput("production")).map((s) => s.name);
    expect(production).toEqual([
      "Summary",
      "Days off",
      "Late arrival",
      "Night work",
      "Continuous leave",
      "Late attendance details",
    ]);
  });

  it("sheet names are cut to 31 characters, cleaned and never repeated", () => {
    const used = new Set<string>();
    expect(sheetName("Absent despite approved leave: a very long name", used)).toBe("Absent despite approved leave a");
    expect(sheetName("Absent despite approved leave: a very long name", used)).toBe("Absent despite approved leave 2");
    expect(sheetName("A/B [x]", used)).toBe("A B x");
  });

  it("the subtitle carries the period, the filters and the list's level", () => {
    const input = pageInput("staff", { filterText: ["Department: IT"], levelFilter: "high" });
    expect(pageSubtitle(input)).toBe("1 Nov - 21 Nov 2026 · Department: IT · List: High");
    expect(pageFileName(input.summary, "xlsx")).toMatch(
      /^HR_Analytics_Staff_1_Nov_21_Nov_2026_\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
  });

  it("builds every sheet with its title block, frozen heading and rows", async () => {
    const wb = await buildPageWorkbook(pageInput("staff"));
    expect(wb.worksheets.map((w) => w.name)).toEqual(pageSheets(pageInput("staff")).map((s) => s.name));
    const summary = wb.getWorksheet("Summary")!;
    expect(String(summary.getCell(1, 1).value)).toBe("UK Textiles");
    expect(String(summary.getCell(3, 1).value)).toBe("HR Analytics - Staff - Summary");
  });

  it("the PDF has the figures, the list, each category's top list and the HODs", async () => {
    const text = drawn(await buildPagePdf(pageInput("staff"))).join(" | ");
    expect(text).toContain("HR Analytics - Staff");
    expect(text).toContain("Employees in scope");
    expect(text).toContain("Employees (12)");
    expect(text).toContain("SURYA M");
    expect(text).toContain("Frequent late arrival: 3 over the limit, 5 with records");
    // a long heading wraps onto a second line instead of being cut
    expect(text).toMatch(/Waiting over \| 2 days|Waiting over 2 \| days|Waiting over 2 days/);
    expect(text).toContain("Department Heads");
    expect(text).toMatch(/Page 1 of \d/);
  });

  it("the PDF list rows say each category with its count, a star when over the limit", () => {
    const s = fixtureSummary("staff");
    const rows = attentionPdfRows(s.employees, s.categories);
    const surya = rows.find((r) => r[1] === "30020")!;
    expect(surya[6]).toBe("Late arrival 6*, Excessive permission requests 2");
    expect(categoryTopRows(fixtureCategory("staff", "late")!, 2).map((r) => r[2])).toEqual(["GOKUL T", "SURYA M"]);
  });
});

describe("one employee's exports", () => {
  const detail = fixtureEmployee("staff", 5)!;

  it("Summary has every category against its limit with the pattern; Timeline every record", () => {
    const [summary, timeline] = employeeSheets(detail);
    expect(summary.rows).toHaveLength(11);
    const late = summary.rows.find((r) => r[0] === "Frequent late arrival")!;
    expect(late.slice(0, 7)).toEqual(["Frequent late arrival", 6, "3", "Yes", "Mon (3)", 2, "2026-11-20"]);
    expect(late[7]).toBe("Mostly on Mondays");
    expect(late[8]).toContain("Avg first punch: 09:21");
    expect(timeline.rows).toHaveLength(8);
    expect(timeline.rows[0][0]).toBe("Frequent late arrival");
    expect(timeline.rows[0][1]).toBe("2026-11-20");
    expect(employeeFileName(detail, "pdf")).toMatch(/^HR_Analytics_30020_SURYA_M_1_Nov_21_Nov_2026_/);
  });

  it("builds the workbook and the PDF", async () => {
    const wb = await buildEmployeeWorkbook({ ...company, detail, now: new Date(2026, 10, 21) });
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Summary", "Timeline"]);
    const text = drawn(await buildEmployeePdf({ ...company, detail, now: new Date(2026, 10, 21) })).join(" | ");
    expect(text).toContain("SURYA M (30020)");
    expect(text).toContain("Every record (8)");
    expect(text).toContain("Late by first punch");
  });
});
