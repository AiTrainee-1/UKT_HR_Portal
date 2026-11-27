import { describe, expect, it } from "vitest";
import { newWorkbook } from "@/lib/exportUtils";
import { buildAuditorFiles, buildBatchBankFile } from "./files";
import { batchAt } from "./test-fixtures";

// The files the Automation Method e-mails (owner 2026-11-26), built for real and read back: the finalized report for the
// auditor (the Loan & Advance report's format: title, the 12 columns, the FINAL decisions, totals, Final Summary,
// signatures) as PDF and Excel, and the bank file for Accounts (the Payroll format, the final approved amounts).

const COMPANY = { company: "UK Textiles", branchLabel: "All units", logoDataUrl: null };
const NOW = new Date("2026-11-26T10:00:00");

const bytes = async (file: File): Promise<ArrayBuffer> =>
  typeof file.arrayBuffer === "function"
    ? file.arrayBuffer()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });

async function sheetOf(file: File) {
  const wb = await newWorkbook();
  await wb.xlsx.load(await bytes(file));
  return wb.worksheets[0];
}

const rowValues = (ws: Awaited<ReturnType<typeof sheetOf>>, r: number): unknown[] =>
  (ws.getRow(r).values as unknown[]).slice(1);

describe("the finalized report for the auditor", () => {
  it("is a PDF and an Excel file named after the batch", async () => {
    const { pdf, xlsx } = await buildAuditorFiles(batchAt("auditor_send"), COMPANY, NOW);
    expect(pdf.name).toBe("Loan_Advance_Salary_Advance_November_2026_Batch_1_Final.pdf");
    expect(pdf.type).toBe("application/pdf");
    expect(xlsx.name).toBe("Loan_Advance_Salary_Advance_November_2026_Batch_1_Final.xlsx");
    expect(xlsx.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(pdf.size).toBeGreaterThan(1000);
    const head = new TextDecoder().decode((await bytes(pdf)).slice(0, 5));
    expect(head).toBe("%PDF-");
  });

  it("holds the Loan & Advance report's columns with the FINAL decisions, the totals and the signatures", async () => {
    const { xlsx } = await buildAuditorFiles(batchAt("auditor_send"), COMPANY, NOW);
    const ws = await sheetOf(xlsx);
    expect(ws.name).toBe("Nov 2026 Batch 1");
    const cells: string[] = [];
    ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? ""))));
    expect(cells).toContain("Loan & Advance – Salary Advance – November 2026 – Batch 1 – Final");
    const headerRow = (() => {
      let found = 0;
      ws.eachRow((row, n) => {
        if (!found && row.getCell(1).value === "S.No") found = n;
      });
      return found;
    })();
    expect(headerRow).toBeGreaterThan(0);
    expect(rowValues(ws, headerRow)).toEqual([
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
    const asha = rowValues(ws, headerRow + 1);
    expect(asha[2]).toBe("Asha Kumar");
    expect(asha[8]).toBe(8000);
    expect(asha[10]).toBe(6000);
    expect(asha[11] ?? "").toBe(""); // Remarks is always an empty cell (owner)
    const meena = rowValues(ws, headerRow + 3);
    expect(meena[2]).toBe("Meena Iyer");
    expect(meena[10] ?? null).toBeNull();
    expect(meena[11] ?? "").toBe(""); // Remarks is always an empty cell (owner)
    const totals = rowValues(ws, headerRow + 4);
    expect(totals[2]).toBe("Total (3 requests)");
    expect(totals[10]).toBe(31000);
    for (const word of ["Final Summary", "Total Approved Amount", "Prepared By", "HRM", "Auditor", "MD"]) {
      expect(cells, word).toContain(word);
    }
  });
});

describe("the bank file for Accounts", () => {
  it("pays the approved requests as paid (after the audit) in the Payroll bank-file format", async () => {
    const b = batchAt("accounts_send");
    b.items[0].final.amount = 6000.4;
    b.items[0].effective.amount = 6000.4; // what is paid: HR's final with no auditor change
    const file = await buildBatchBankFile(b);
    expect(file.name).toBe("Loan_Advance_Bank_File_Salary_Advance_November_2026_Batch_1.xlsx");
    const ws = await sheetOf(file);
    expect(String(ws.getCell(1, 3).value)).toBe("EMPLOYEE CODE");
    expect(String(ws.getCell(1, 5).value)).toContain("AMOUNT");
    // row 1 the headers, row 2 mandatory / optional, then one row per final approved request
    expect(ws.rowCount).toBe(4);
    expect(rowValues(ws, 3).slice(2, 8)).toEqual(["S101", "123456789", 6001, "ASHA KUMAR", "HDFC0001234", "HDFC BANK"]);
    expect(rowValues(ws, 4)[2]).toBe("S102");
    expect(rowValues(ws, 4)[4]).toBe(25000);
  });
});
