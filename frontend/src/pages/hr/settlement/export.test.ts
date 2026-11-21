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

// The Settlement exports (owner 2026-11-20): Excel and PDF of one tab's list as filtered, with requested and approved
// amounts apart, the remark, and a totals row.

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
  ...over,
});

const state = (over: Partial<PageState> = {}): PageState => ({
  tab: "loan",
  period: { month: 11, year: 2026 },
  basis: "any",
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
      row({ id: 2, employeeCode: "E002", employeeName: "Ravi", amount: 2000, requestedAmount: 2000 }),
    ];
    const wb = await buildSettlementWorkbook(input(two));
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("Term Loan Nov 2026");
    expect(String(ws.getCell(3, 1).value)).toBe("Settlement - Term Loan - November 2026");
    expect(String(ws.getCell(4, 1).value)).toContain("2 of 5 term loans · Status: Active. Amounts in rupees.");
    const headers = (ws.getRow(5).values as unknown[]).slice(1);
    expect(headers).toEqual(input(two).table.columns.map((c) => c.header));
    const col = (h: string) => headers.indexOf(h) + 1;
    expect(ws.getCell(6, col("Employee")).value).toBe("Asha Kumar");
    expect(ws.getCell(6, col("Requested amount")).value).toBe(1000);
    expect(ws.getCell(6, col("Approved amount")).value).toBe(700);
    expect(ws.getCell(6, col("Approved amount")).numFmt).toBe("#,##0.00");
    expect(ws.getCell(6, col("Remark")).value).toBe("Budget limit this month");
    expect(ws.getCell(8, col("Employee")).value).toBe("Total (2 term loans)");
    expect(ws.getCell(8, col("Requested amount")).value).toBe(3000);
    expect(ws.getCell(8, col("Approved amount")).value).toBe(2700);
    expect(ws.getCell(8, col("Employee")).font?.bold).toBe(true);
  });

  it("names the file after the tab and the month", () => {
    const name = exportFileName(buildExport([row({})], state(), 1), "xlsx");
    expect(name).toMatch(/^Settlement_Term_Loan_November_2026_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const all = exportFileName(buildExport([row({})], state({ tab: "overview", period: null }), 1), "pdf");
    expect(all).toMatch(/^Settlement_Overview_All_months_\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});

describe("the Settlement PDF", () => {
  it("shares the A4 landscape width by the columns' weights", () => {
    for (const tab of ["overview", "loan", "advance"] as const) {
      const cols = settlementPdfColumns(buildExport([row({})], state({ tab }), 1));
      expect(cols.reduce((a, c) => a + c.mm, 0)).toBeCloseTo(277, 5);
      expect(cols.find((c) => c.header.startsWith("Requested"))?.header).toBe("Requested amount (Rs)");
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

  it("draws the title, the rows, the remark and the totals on an A4 landscape page", async () => {
    const doc = await buildSettlementPdf(input([row({})], state({ tab: "overview" })));
    const text = drawn(doc).join(" | ");
    expect(text).toContain("Settlement - Overview - November 2026");
    expect(text).toContain("Asha Kumar");
    expect(text).toContain("Budget limit this");
    expect(text).toContain("Total (1 advance)");
    expect(text).toContain("Page 1 of 1");
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
  });
});
