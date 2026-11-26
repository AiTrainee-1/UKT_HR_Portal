import type { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import {
  buildSettlementPdf,
  buildSettlementWorkbook,
  exportFileName,
  settlementPdfColumns,
  settlementPdfRows,
} from "./export";
import { DEFAULT_SORT, NO_FILTERS, buildExport, type PageState, type SettlementRow } from "./logic";

// The Settlement exports (owner 2026-11-20, columns 2026-11-26): Excel and PDF of one tab's list as filtered, in the
// status chosen, with the 12 columns (requested, the salary earned 1st-20th, approved, an empty Remarks) and a totals row.

const row = (over: Partial<SettlementRow>): SettlementRow => ({
  id: 1,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  employeeDepartment: "Stitching",
  advanceType: "term",
  amount: 700,
  requestedAmount: 1000,
  purpose: "Medical",
  status: "approved",
  emiAmount: 234,
  repaymentMonths: 3,
  repaymentStartMonth: 12,
  repaymentStartYear: 2026,
  totalRepaid: 234,
  outstanding: 466,
  decisionRemark: "Budget limit this month",
  approvedBy: "HR Admin",
  decidedAt: "2026-11-20T05:00:00Z",
  createdAt: "2026-11-02T05:00:00Z",
  earnings: {
    month: 11,
    year: 2026,
    throughDay: 20,
    fixedSalary: 26000,
    workingDays: 14.5,
    paidDays: 15.5,
    earnedAmount: 16120.5,
    workingSalary: 16120.5,
    percent: 50,
    limit: 8060,
  },
  ...over,
});

const state = (over: Partial<PageState> = {}): PageState => ({
  tab: "loan",
  period: { month: 11, year: 2026 },
  basis: "applied",
  filters: { ...NO_FILTERS, status: "approved" },
  sort: DEFAULT_SORT,
  ...over,
});

const input = (rows: SettlementRow[], s = state()) => ({
  company: "UK Textiles",
  branchLabel: "All Branches",
  logoDataUrl: null,
  table: buildExport(rows, s, 5),
  now: new Date(2026, 10, 20, 10, 30),
});

/** Every string the document draws, in drawing order. */
function drawn(doc: jsPDF): string[] {
  const out = doc.output();
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let m = re.exec(out); m; m = re.exec(out)) found.push(m[1].replace(/\\([()\\])/g, "$1"));
  return found;
}

describe("the Settlement workbook", () => {
  it("has the title with the tab and month, the scope line, the headings, a row per advance and the totals", async () => {
    const two = [
      row({}),
      row({ id: 2, employeeCode: "E002", employeeName: "Ravi", amount: 2000, requestedAmount: 2000, earnings: null }),
    ];
    const wb = await buildSettlementWorkbook(input(two));
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("Term Loan Nov 2026");
    expect(String(ws.getCell(3, 1).value)).toBe("Settlement - Term Loan - Active - November 2026");
    expect(String(ws.getCell(4, 1).value)).toContain("2 of 5 term loans · Status: Active. Amounts in rupees.");
    const headers = (ws.getRow(5).values as unknown[]).slice(1);
    expect(headers).toEqual([
      "S.No",
      "Employee Code",
      "Employee",
      "Department",
      "Type",
      "Fixed Salary",
      "Working Days",
      "Earned Salary",
      "Requested Amount",
      "Limit",
      "Approved Amount",
      "Remarks",
    ]);
    const col = (h: string) => headers.indexOf(h) + 1;
    expect(ws.getCell(6, col("S.No")).value).toBe(1);
    expect(ws.getCell(7, col("S.No")).value).toBe(2);
    expect(ws.getCell(6, col("Employee")).value).toBe("Asha Kumar");
    expect(ws.getCell(6, col("Type")).value).toBe("Term Loan");
    expect(ws.getCell(6, col("Requested Amount")).value).toBe(1000);
    expect(ws.getCell(6, col("Fixed Salary")).value).toBe(26000);
    expect(ws.getCell(6, col("Working Days")).value).toBe(14.5);
    expect(ws.getCell(6, col("Earned Salary")).value).toBe(16120.5);
    expect(ws.getCell(6, col("Limit")).value).toBe(8060);
    expect(ws.getCell(6, col("Limit")).numFmt).toBe("#,##0.00");
    expect(ws.getCell(6, col("Approved Amount")).value).toBe(700);
    expect(ws.getCell(6, col("Approved Amount")).numFmt).toBe("#,##0.00");
    expect(ws.getCell(6, col("Remarks")).value).toBeNull(); // always empty
    // a production employee: blank salary figures
    expect(ws.getCell(7, col("Fixed Salary")).value).toBeNull();
    expect(ws.getCell(7, col("Working Days")).value).toBeNull();
    expect(ws.getCell(7, col("Limit")).value).toBeNull();
    expect(ws.getCell(8, col("Employee")).value).toBe("Total (2 term loans)");
    expect(ws.getCell(8, col("Requested Amount")).value).toBe(3000);
    expect(ws.getCell(8, col("Fixed Salary")).value).toBe(26000);
    expect(ws.getCell(8, col("Earned Salary")).value).toBe(16120.5);
    expect(ws.getCell(8, col("Limit")).value).toBe(8060);
    expect(ws.getCell(8, col("Approved Amount")).value).toBe(2700);
    expect(ws.getCell(8, col("Employee")).font?.bold).toBe(true);
  });

  it("names the file after the tab, the status and the month", () => {
    const name = exportFileName(buildExport([row({})], state(), 1), "xlsx");
    expect(name).toMatch(/^Settlement_Term_Loan_Active_November_2026_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const all = exportFileName(
      buildExport([row({})], state({ tab: "overview", period: null, filters: NO_FILTERS }), 1),
      "pdf",
    );
    expect(all).toMatch(/^Settlement_All_types_All_statuses_All_months_\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});

describe("the Settlement PDF", () => {
  it("shares the A4 landscape width by the columns' weights", () => {
    for (const tab of ["overview", "loan", "advance"] as const) {
      const cols = settlementPdfColumns(buildExport([row({})], state({ tab }), 1));
      expect(cols.reduce((a, c) => a + c.mm, 0)).toBeCloseTo(277, 5);
      expect(cols).toHaveLength(12);
      expect(cols.find((c) => c.header.startsWith("Requested"))?.header).toBe("Requested Amount (Rs)");
      expect(cols.find((c) => c.header.startsWith("Working Days"))?.header).toBe("Working Days");
    }
  });

  it("prints the amounts in Indian grouping and ends on a totals row", () => {
    const rows = settlementPdfRows(buildExport([row({ requestedAmount: 125000, amount: 100000.5 })], state(), 1));
    expect(rows).toHaveLength(2);
    expect(rows[0].cells).toContain("1,25,000");
    expect(rows[0].cells).toContain("1,00,000.5");
    expect(rows[1].total).toBe(true);
    expect(rows[1].cells).toContain("Total (1 term loan)");
  });

  it("draws the title with the status, the rows, the earned figures and the totals on an A4 landscape page", async () => {
    const doc = await buildSettlementPdf(input([row({})], state({ tab: "overview" })));
    const text = drawn(doc).join(" | ");
    expect(text).toContain("Settlement - All types - Active - November 2026");
    expect(text).toContain("Asha Kumar");
    expect(text).toContain("16,120.5");
    expect(text).not.toContain("Budget limit this"); // HR's decision remark is not a column any more
    expect(text).toContain("Total (1 advance)");
    expect(text).toContain("Page 1 of 1");
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
  });
});
