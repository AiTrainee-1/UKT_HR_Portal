import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateTime } from "@/components/payroll/kit/format";
import { cleanDetails, staffDetails } from "./fixtures";

// What the page can export: the columns of the issue files (the date each issue was detected comes first), the items of
// the two Export menus, and that choosing an item hands the right rows to the right builder.

const h = vi.hoisted(() => ({ excel: vi.fn(), csv: vi.fn(), workbook: vi.fn() }));

vi.mock("@/components/payroll/kit/export-table", () => ({ exportTableToExcel: h.excel, exportTableToCsv: h.csv }));
vi.mock("./workbook", () => ({ exportDetailsWorkbook: h.workbook }));

import { ISSUE_COLUMNS, detailsExportItems, issueExportItems } from "./exports";

const details = staffDetails();

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the issue columns", () => {
  it("are the eight the owner asked for, the date detected first", () => {
    expect(ISSUE_COLUMNS.map((c) => c.label)).toEqual([
      "Date detected",
      "Type",
      "Severity",
      "Title",
      "Details",
      "Impact",
      "Rule",
      "Flagged at",
    ]);
    expect(ISSUE_COLUMNS[0].type).toBe("date");
  });

  it("read a dated issue", () => {
    const absent = details.issues.find((i) => i.code === "absent")!;
    expect(ISSUE_COLUMNS.map((c) => c.value!(absent))).toEqual([
      "2026-10-06",
      "Absent",
      "Critical",
      "Absent",
      "No punches on Tue 6 Oct and no approved leave: counted as loss of pay.",
      "1 day; ₹1,134.62",
      "Loss of pay on absence",
      dateTime(absent.detectedAt),
    ]);
  });

  it("read a whole-period issue, with no rule and no cost", () => {
    const esi = details.issues.find((i) => i.code === "esi_number_missing")!;
    const row = ISSUE_COLUMNS.map((c) => c.value!(esi));
    expect(row[0]).toBe("Whole period");
    expect(row[2]).toBe("Info");
    expect(row[5]).toBe("");
    expect(row[6]).toBe("");
    const unflagged = { ...esi, detectedAt: null };
    expect(ISSUE_COLUMNS[7].value!(unflagged)).toBe("");
  });
});

describe("the Export menus", () => {
  it("the page's menu: the workbook, the issues in Excel and CSV, and print", () => {
    const items = detailsExportItems({ details, company: "UK Textiles Ltd" });
    expect(items.map((i) => i.key)).toEqual(["workbook", "issues-xlsx", "issues-csv", "print"]);
    expect(items.map((i) => i.label)).toEqual([
      "Details workbook (Excel)",
      "Issues (Excel)",
      "Issues (CSV)",
      "Print this page",
    ]);
    expect(items[0].hint).toContain("Summary, earnings & deductions, rules, issues and days");
    expect(items[2].hint).toContain("All 11 issues detected on this payroll");
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  it("with no issues there is nothing to export in Excel or CSV, but the workbook and print stay", () => {
    const items = detailsExportItems({ details: cleanDetails(), company: "UK Textiles Ltd" });
    const by = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(by["issues-xlsx"].disabled).toBe(true);
    expect(by["issues-csv"].disabled).toBe(true);
    expect(by["issues-csv"].hint).toBe("There are no issues to export");
    expect(by.workbook.disabled).toBeFalsy();
    expect(by.print.disabled).toBeFalsy();
  });

  it("the workbook item builds the details workbook for this payroll under the company's name", async () => {
    const [workbook] = detailsExportItems({ details, company: "UK Textiles Ltd" });
    await workbook.run();
    expect(h.workbook).toHaveBeenCalledWith(details, "UK Textiles Ltd");
  });

  it("the CSV item exports every issue under a file name that says who and when", async () => {
    const csv = detailsExportItems({ details, company: "UK Textiles Ltd" }).find((i) => i.key === "issues-csv")!;
    await csv.run();
    expect(h.csv).toHaveBeenCalledTimes(1);
    const args = h.csv.mock.calls[0][0];
    expect(args.rows).toHaveLength(11);
    expect(args.columns).toBe(ISSUE_COLUMNS);
    expect(args.filename).toBe("Payroll_Issues_Meena_Subramanian_October_2026");
  });

  it("the Excel item is titled for the employee and the period", async () => {
    const xlsx = detailsExportItems({ details, company: "UK Textiles Ltd" }).find((i) => i.key === "issues-xlsx")!;
    await xlsx.run();
    expect(h.excel).toHaveBeenCalledWith(
      expect.objectContaining({
        sheetName: "Issues",
        company: "UK Textiles Ltd",
        subtitle: "Meena Subramanian (UKT-0142) · October 2026",
        title: "Payroll issues",
        filename: "Payroll_Issues_Meena_Subramanian_October_2026",
      }),
    );
    expect(h.excel.mock.calls[0][0].rows).toHaveLength(11);
  });

  it("the issues card's menu exports just the issues it was given (the filtered ones)", async () => {
    const shown = details.issues.filter((i) => i.severity === "critical");
    const items = issueExportItems({
      details,
      issues: shown,
      company: "UK Textiles Ltd",
      hint: "The 1 issue shown below",
      keyPrefix: "",
    });
    expect(items.map((i) => i.key)).toEqual(["xlsx", "csv"]);
    expect(items[0].hint).toBe("The 1 issue shown below");
    await items[1].run();
    expect(h.csv.mock.calls[0][0].rows).toEqual(shown);
    expect(
      issueExportItems({ details, issues: [], company: "x", hint: "h", keyPrefix: "" }).every((i) => i.disabled),
    ).toBe(true);
  });

  it("print opens the browser's print dialog", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const item = detailsExportItems({ details, company: "UK Textiles Ltd" }).find((i) => i.key === "print")!;
    await item.run();
    expect(print).toHaveBeenCalledTimes(1);
  });
});
