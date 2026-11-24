import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateTime } from "@/components/payroll/kit/format";
import { cleanDetails, staffDetails } from "./fixtures";

// What the page can export: the columns of the workbook's issues sheet (the date each issue was detected comes first),
// the items of the Export menu, and that choosing an item runs the right builder.

const h = vi.hoisted(() => ({ workbook: vi.fn() }));

vi.mock("./workbook", () => ({ exportDetailsWorkbook: h.workbook }));

import { ISSUE_COLUMNS, detailsExportItems } from "./exports";

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

describe("the Export menu", () => {
  it("the page's menu: the workbook and print (no Issues Excel / CSV since 2026-11-24)", () => {
    const items = detailsExportItems({ details, company: "UK Textiles Ltd" });
    expect(items.map((i) => i.key)).toEqual(["workbook", "print"]);
    expect(items.map((i) => i.label)).toEqual(["Details workbook (Excel)", "Print this page"]);
    expect(items[0].hint).toContain("Summary, earnings & deductions, rules, issues and days");
    expect(items.every((i) => !i.disabled)).toBe(true);
    expect(items.some((i) => i.key.startsWith("issues") || i.label.startsWith("Issues"))).toBe(false);
  });

  it("with no issues the workbook and print stay", () => {
    const items = detailsExportItems({ details: cleanDetails(), company: "UK Textiles Ltd" });
    expect(items.map((i) => i.key)).toEqual(["workbook", "print"]);
    expect(items.every((i) => !i.disabled)).toBe(true);
  });

  it("the workbook item builds the details workbook for this payroll under the company's name", async () => {
    const [workbook] = detailsExportItems({ details, company: "UK Textiles Ltd" });
    await workbook.run();
    expect(h.workbook).toHaveBeenCalledWith(details, "UK Textiles Ltd");
  });

  it("print opens the browser's print dialog", async () => {
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    const item = detailsExportItems({ details, company: "UK Textiles Ltd" }).find((i) => i.key === "print")!;
    await item.run();
    expect(print).toHaveBeenCalledTimes(1);
  });
});
