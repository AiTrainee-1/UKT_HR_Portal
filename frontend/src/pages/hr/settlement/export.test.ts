import type { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import {
  PDF_TAIL_HEIGHT,
  buildSettlementPdf,
  buildSettlementWorkbook,
  exportFileName,
  signatureSpans,
  spans,
  summaryText,
  settlementPdfColumns,
  settlementPdfRows,
} from "./export";
import {
  DEFAULT_SORT,
  NO_FILTERS,
  TERM_DEFAULT_COLUMN_KEYS,
  buildExport,
  type PageState,
  type SettlementRow,
} from "./logic";

// The Loan & Advance exports (owner 2026-11-20, columns 2026-11-26): Excel and PDF of one tab's list as filtered, in the
// status chosen, with the 12 columns (requested, the salary earned 1st-20th, approved, an empty Remarks) and a totals row.
// The Term Loan tab has its own report (owner 2026-11-27): its own 16 columns and Final Summary.

const row = (over: Partial<SettlementRow>): SettlementRow => ({
  id: 1,
  employeeId: 1,
  employeeCode: "E001",
  employeeName: "Asha Kumar",
  employeeDepartment: "Stitching",
  advanceType: "general",
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
  tab: "advance",
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

/** Every string the document draws, in drawing order (one page's when `page` is given, from 1). */
function drawn(doc: jsPDF, page?: number): string[] {
  const pages = (doc.internal as unknown as { pages: (string[] | undefined)[] }).pages;
  const out = page ? (pages[page] ?? []).join(" ") : doc.output();
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let m = re.exec(out); m; m = re.exec(out)) found.push(m[1].replace(/\\([()\\])/g, "$1"));
  return found;
}

describe("the Loan & Advance workbook", () => {
  it("has the title with the tab and month, the scope line, the headings, a row per advance and the totals", async () => {
    const two = [
      row({}),
      row({ id: 2, employeeCode: "E002", employeeName: "Ravi", amount: 2000, requestedAmount: 2000, earnings: null }),
    ];
    const wb = await buildSettlementWorkbook(input(two));
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("Salary Advance Nov 2026");
    expect(String(ws.getCell(3, 1).value)).toBe("Loan & Advance – Salary Advance – Active – November 2026");
    expect(String(ws.getCell(4, 1).value)).toContain("2 of 5 salary advances · Status: Active. Amounts in rupees.");
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
    expect(ws.getCell(6, col("Type")).value).toBe("Salary Advance");
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
    expect(ws.getCell(8, col("Employee")).value).toBe("Total (2 salary advances)");
    expect(ws.getCell(8, col("Requested Amount")).value).toBe(3000);
    expect(ws.getCell(8, col("Fixed Salary")).value).toBe(26000);
    expect(ws.getCell(8, col("Earned Salary")).value).toBe(16120.5);
    expect(ws.getCell(8, col("Limit")).value).toBe(8060);
    expect(ws.getCell(8, col("Approved Amount")).value).toBe(2700);
    expect(ws.getCell(8, col("Employee")).font?.bold).toBe(true);
  });

  it("names the file after the tab, the status and the month", () => {
    const name = exportFileName(buildExport([row({})], state(), 1), "xlsx");
    expect(name).toMatch(/^Loan_Advance_Salary_Advance_Active_November_2026_\d{4}-\d{2}-\d{2}\.xlsx$/);
    const all = exportFileName(
      buildExport([row({})], state({ tab: "overview", period: null, filters: NO_FILTERS }), 1),
      "pdf",
    );
    expect(all).toMatch(/^Loan_Advance_All_types_All_statuses_All_months_\d{4}-\d{2}-\d{2}\.pdf$/);
  });
});

describe("the Loan & Advance PDF", () => {
  it("shares the A4 landscape width by the columns' weights", () => {
    for (const tab of ["overview", "advance"] as const) {
      const cols = settlementPdfColumns(buildExport([row({})], state({ tab }), 1));
      expect(cols.reduce((a, c) => a + c.mm, 0)).toBeCloseTo(277, 5);
      expect(cols).toHaveLength(12);
      expect(cols.find((c) => c.header.startsWith("Requested"))?.header).toBe("Requested Amount (Rs)");
      expect(cols.find((c) => c.header.startsWith("Working Days"))?.header).toBe("Working Days");
    }
    // the Term Loan report: its own 16 columns on the same width
    const term = settlementPdfColumns(buildExport([row({ advanceType: "term" })], state({ tab: "loan" }), 1));
    expect(term).toHaveLength(16);
    expect(term.reduce((a, c) => a + c.mm, 0)).toBeCloseTo(277, 5);
  });

  it("prints the amounts in Indian grouping and ends on a totals row", () => {
    const rows = settlementPdfRows(buildExport([row({ requestedAmount: 125000, amount: 100000.5 })], state(), 1));
    expect(rows).toHaveLength(2);
    expect(rows[0].cells).toContain("1,25,000");
    expect(rows[0].cells).toContain("1,00,000.5");
    expect(rows[1].total).toBe(true);
    expect(rows[1].cells).toContain("Total (1 salary advance)");
  });

  it("draws the title with the status, the rows, the earned figures and the totals on an A4 landscape page", async () => {
    const doc = await buildSettlementPdf(input([row({})], state({ tab: "overview" })));
    const text = drawn(doc).join(" | ");
    // the PDF's standard font has no en dash: the drawn title uses a plain one
    expect(text).toContain("Loan & Advance - All types - Active - November 2026");
    expect(text).toContain("Asha Kumar");
    expect(text).toContain("16,120.5");
    expect(text).not.toContain("Budget limit this"); // HR's decision remark is not a column any more
    expect(text).toContain("Total (1 advance)");
    expect(text).toContain("Page 1 of 1");
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
  });
});

// ───────────────────── the Final Summary and the signatures (owner 2026-11-26) ─────────────────────

describe("the Final Summary and the signatures", () => {
  // Asha twice (two requests), Ravi once (waiting, no earned figures): two employees
  const three = [
    row({}),
    row({
      id: 2,
      amount: 2000,
      requestedAmount: 2000,
      earnings: { ...row({}).earnings!, earnedAmount: 10000, workingSalary: 10000, limit: 5000 },
    }),
    row({
      id: 3,
      employeeId: 2,
      employeeCode: "E002",
      employeeName: "Ravi",
      status: "pending",
      amount: 3000,
      requestedAmount: 3000,
      earnings: null,
    }),
  ];
  const summaryOf = (cols: string[] | undefined = undefined) =>
    buildExport(three, state({ filters: NO_FILTERS }), 3, cols).summary;

  it("five overall figures from the exported rows, whatever columns are ticked", () => {
    const expected = [
      { label: "Total Employee Count", value: 2, kind: "count" }, // distinct employees, not the 3 requests
      { label: "Total Earned Salary", value: 26120.5, kind: "money" },
      { label: "Total Requested Amount", value: 6000, kind: "money" },
      { label: "Total Approved Amount", value: 2700, kind: "money" }, // the waiting one is not approved
      { label: "Total Limit Amount", value: 13060, kind: "money" },
    ];
    expect(summaryOf()).toEqual(expected);
    expect(summaryOf(["employee"])).toEqual(expected);
    expect(summaryOf().map(summaryText)).toEqual([
      "2",
      "Rs. 26,120.50",
      "Rs. 6,000.00",
      "Rs. 2,700.00",
      "Rs. 13,060.00",
    ]);
    expect(summaryText({ label: "x", value: 1234567.5, kind: "money" })).toBe("Rs. 12,34,567.50");
  });

  it("Excel: the Final Summary cards under the totals, then the signatures; no notes", async () => {
    const wb = await buildSettlementWorkbook({ ...input(three, state({ filters: NO_FILTERS })) });
    const ws = wb.worksheets[0];
    const find = (text: string) => {
      let at: { row: number; col: number } | null = null;
      ws.eachRow({ includeEmpty: false }, (r, rowNo) =>
        r.eachCell((cell, colNo) => {
          if (!at && cell.value === text) at = { row: rowNo, col: colNo };
        }),
      );
      return at as { row: number; col: number } | null;
    };
    const totals = find("Total (3 salary advances)")!;
    const title = find("Final Summary")!;
    expect(title.row).toBe(totals.row + 3);
    expect(ws.getCell(title.row, 1).font?.bold).toBe(true);
    // a labels row and a large figures row, the five cards side by side over the 12 columns
    const labels = title.row + 1;
    const values = title.row + 2;
    const cards = spans(12, 5).map(([first]) => first);
    expect(cards).toEqual([1, 4, 7, 9, 11]);
    expect(cards.map((c) => ws.getCell(labels, c).value)).toEqual([
      "Total Employee Count",
      "Total Earned Salary",
      "Total Requested Amount",
      "Total Approved Amount",
      "Total Limit Amount",
    ]);
    expect(cards.map((c) => ws.getCell(values, c).value)).toEqual([2, 26120.5, 6000, 2700, 13060]);
    expect(ws.getCell(values, 1).numFmt).toBe("#,##0");
    expect(ws.getCell(values, 4).numFmt).toContain("##\\,##\\,##0.00");
    expect(ws.getCell(values, 4).font?.size).toBe(15);
    expect(ws.getCell(labels, 4).isMerged).toBe(true);
    expect((ws.getCell(labels, 5).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe("FFE8EEF6");

    // the signatures: a tall row to sign in, then the five titles over a medium line, a column between them
    const sign = find("Prepared By")!;
    expect(sign.row).toBe(values + 4);
    expect(ws.getRow(sign.row - 1).height).toBe(52);
    const at = signatureSpans(12);
    expect(at).toEqual([
      [1, 2],
      [4, 5],
      [7, 8],
      [10, 10],
      [12, 12],
    ]);
    expect(at.map(([first]) => ws.getCell(sign.row, first).value)).toEqual([
      "Prepared By",
      "Checked By",
      "HRM",
      "Auditor",
      "MD",
    ]);
    expect(ws.getCell(sign.row, 1).border?.top?.style).toBe("medium");
    expect(ws.getCell(sign.row, 3).border?.top).toBeUndefined(); // the gap
    expect(ws.getCell(sign.row, 1).font?.bold).toBe(true);

    // no explanatory notes anywhere
    const everything: string[] = [];
    ws.eachRow((r) => r.eachCell((cell) => everything.push(String(cell.value ?? ""))));
    expect(everything.join(" ")).not.toMatch(/monthly fixed salary|Requested = what/);
  });

  it("Excel: a report of two columns still gets five cards and five signatures", async () => {
    const narrow = buildExport(three, state(), 3, ["sno", "employee"]);
    const ws = (await buildSettlementWorkbook({ ...input(three), table: narrow })).worksheets[0];
    const values: unknown[] = [];
    ws.eachRow((r) => r.eachCell((cell) => values.push(cell.value)));
    for (const text of ["Final Summary", "Total Limit Amount", "Prepared By", "MD"]) expect(values).toContain(text);
    expect(signatureSpans(2)).toHaveLength(5);
  });

  it("PDF: the Final Summary and the signatures under the totals, no notes", async () => {
    const doc = await buildSettlementPdf(input(three, state({ filters: NO_FILTERS })));
    const text = drawn(doc).join(" | ");
    expect(text).toContain("Total (3 salary advances)");
    expect(text).toContain("Final Summary");
    for (const label of [
      "Total Employee Count",
      "Total Earned Salary",
      "Total Requested Amount",
      "Total Approved Amount",
      "Total Limit Amount",
    ])
      expect(text).toContain(label);
    expect(text).toContain("Rs. 26,120.50");
    expect(text).toContain("Rs. 13,060.00");
    for (const title of ["Prepared By", "Checked By", "HRM", "Auditor", "MD"]) expect(text).toContain(title);
    expect(text).not.toMatch(/monthly fixed salary|Requested = what/);
    expect(text.indexOf("Total (3 salary advances)")).toBeLessThan(text.indexOf("Final Summary"));
    expect(text.indexOf("Final Summary")).toBeLessThan(text.indexOf("Prepared By"));
    expect(text).toContain("Page 1 of 1");
  });

  it("PDF: the summary and the signatures stay together, on a page of their own when they do not fit", async () => {
    expect(PDF_TAIL_HEIGHT).toBeGreaterThan(60);
    const many = Array.from({ length: 20 }, (_, i) =>
      row({ id: 100 + i, employeeId: 100 + i, employeeCode: `E${100 + i}`, employeeName: `Person ${i}` }),
    );
    const doc = await buildSettlementPdf(input(many, state({ filters: NO_FILTERS })));
    expect(doc.getNumberOfPages()).toBe(2);
    const first = drawn(doc, 1).join(" | ");
    const second = drawn(doc, 2).join(" | ");
    expect(first).toContain("Person 19");
    expect(first).not.toContain("Final Summary");
    expect(second).toContain("Final Summary");
    expect(second).toContain("Total Employee Count");
    expect(second).toContain("Prepared By");
    expect(second).toContain("MD");
    expect(second).toContain("Page 2 of 2");
    expect(first).toContain("Page 1 of 2");
  });
});

// ───────────────────── the Term Loan report (owner 2026-11-27) ─────────────────────

describe("the Term Loan report", () => {
  // Asha: ₹30,000 approved over 3 months (whole-rupee EMIs ₹10,000), one EMI deducted; Ravi: waiting; Mani: rejected
  const loan = (over: Partial<SettlementRow>): SettlementRow =>
    row({
      advanceType: "term",
      salaryAtRequest: 30000,
      termLimit: 30000,
      requestedAmount: 30000,
      amount: 30000,
      emiAmount: 10000,
      repaymentMonths: 3,
      repaymentStartMonth: 12,
      repaymentStartYear: 2026,
      totalRepaid: 10000,
      outstanding: 20000,
      earnings: null,
      ...over,
    });
  const loans = [
    loan({}),
    loan({
      id: 2,
      employeeId: 2,
      employeeCode: "E002",
      employeeName: "Ravi",
      status: "pending",
      requestedAmount: 12000,
      amount: 12000,
      emiAmount: 6000,
      repaymentMonths: 2,
      totalRepaid: 0,
      outstanding: 12000,
    }),
    loan({
      id: 3,
      employeeId: 3,
      employeeCode: "E003",
      employeeName: "Mani",
      status: "rejected",
      requestedAmount: 5000,
      amount: 5000,
      emiAmount: 0,
      totalRepaid: 0,
      outstanding: 0,
    }),
  ];
  const termState = state({ tab: "loan", filters: NO_FILTERS });

  it("has its own 16 columns, in the owner's order, with Remarks empty", () => {
    const table = buildExport(loans, termState, 3);
    expect(table.columns.map((c) => c.header)).toEqual([
      "S.No",
      "Employee Code",
      "Employee",
      "Department",
      "Fixed Salary",
      "Eligible Limit",
      "Requested Amount",
      "Approved Amount",
      "Months",
      "Monthly EMI",
      "First EMI",
      "Last EMI",
      "Repaid",
      "Outstanding",
      "Status",
      "Remarks",
    ]);
    expect(TERM_DEFAULT_COLUMN_KEYS).toHaveLength(16);
    const cell = (r: number, h: string) => table.rows[r][table.columns.findIndex((c) => c.header === h)];
    expect(cell(0, "Fixed Salary")).toBe(30000);
    expect(cell(0, "Eligible Limit")).toBe(30000);
    expect(cell(0, "Approved Amount")).toBe(30000);
    expect(cell(0, "Months")).toBe(3);
    expect(cell(0, "Monthly EMI")).toBe(10000);
    expect(cell(0, "First EMI")).toBe("Dec 2026");
    expect(cell(0, "Last EMI")).toBe("Feb 2027");
    expect(cell(0, "Repaid")).toBe(10000);
    expect(cell(0, "Outstanding")).toBe(20000);
    expect(cell(0, "Status")).toBe("Active");
    expect(cell(0, "Remarks")).toBe("");
    // a waiting loan has nothing repaid or outstanding yet; a rejected one no EMI and no months to deduct in
    expect(cell(1, "Repaid")).toBe("");
    expect(cell(1, "Outstanding")).toBe("");
    expect(cell(2, "Monthly EMI")).toBe("");
    expect(cell(2, "First EMI")).toBe("");
  });

  it("ends on its own Final Summary: employees, requested, approved, monthly EMI and outstanding", () => {
    const summary = buildExport(loans, termState, 3).summary;
    expect(summary).toEqual([
      { label: "Total Employees", value: 3, kind: "count" },
      { label: "Total Requested", value: 47000, kind: "money" },
      { label: "Total Approved", value: 30000, kind: "money" }, // the waiting and the rejected are not approved
      { label: "Total Monthly EMI", value: 10000, kind: "money" }, // active loans only
      { label: "Total Outstanding", value: 20000, kind: "money" },
    ]);
    // whatever columns are ticked
    expect(buildExport(loans, termState, 3, ["employee"]).summary).toEqual(summary);
  });

  it("Excel and PDF carry the Term Loan columns, the summary and the signatures", async () => {
    const wb = await buildSettlementWorkbook(input(loans, termState));
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("Term Loan Nov 2026");
    const headers = (ws.getRow(5).values as unknown[]).slice(1);
    expect(headers).toHaveLength(16);
    expect(headers).toContain("Eligible Limit");
    expect(headers).not.toContain("Earned Salary");
    const values: unknown[] = [];
    ws.eachRow((r) => r.eachCell((cell) => values.push(cell.value)));
    for (const text of ["Final Summary", "Total Monthly EMI", "Total Outstanding", "Prepared By", "MD"])
      expect(values).toContain(text);

    const doc = await buildSettlementPdf(input(loans, termState));
    const text = drawn(doc).join(" | ");
    expect(text).toContain("Loan & Advance - Term Loan - All statuses - November 2026");
    expect(text).toContain("Total Monthly EMI");
    expect(text).toContain("Rs. 20,000.00");
    expect(text).toContain("Prepared By");
  });
});
