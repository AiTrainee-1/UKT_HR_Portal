import type ExcelJS from "exceljs";
import { downloadWorkbook, newWorkbook, styleHeaderCell } from "@/lib/exportUtils";

// The bank transfer file (the bank's NEFT / RTGS upload template): ONE writer for every page that pays through the bank,
// so "the same format as the payroll's bank file" is a fact of the code (2026-11-26). The Payroll pages
// (payrollExcelExport.ts) hand it the month's NET pay; the Settlement page hands it the approved advances. The callers
// choose the rows, the amount (payroll rounds its NET up to the rupee, Settlement pays the approved amount) and the file
// name; this file only writes them. bankFile.test.ts holds the payroll's file to its golden copy.

/** One payment: who is paid, into which account, and how much (written as given). */
export type BankFileLine = {
  employeeCode?: string | null;
  employeeName?: string | null;
  bankAccount?: string | null;
  bankIfsc?: string | null;
  bankName?: string | null;
  amount: number;
};

const AMOUNT_COLUMN = 5;
const GREEN = "FF5B8C00"; // olive-green matching the bank template
const WHITE = "FFFFFFFF";
const RED = "FFFF0000"; // Amount header is red in the template

// Row 1: the header labels, as the bank's template writes them
const HEADERS = [
  "TXN TYPE\nRTGS-R\nNEFT-N\nHDFC TRF-I\nIMPS - M(1)",
  'BENEFICIARY CODE\n(MANDATORY ONLY FOR\nTXN TYPE "I")\n(13)',
  "EMPLOYEE CODE",
  "BENE A/C NO\n(25)",
  "AMOUNT\n(20)",
  "BENEFICIARY NAME\n(35)",
  "IFSC CODE\n(11)",
  "BENE BANK NAME\n(40)",
  "BENE BANK BRANCH NAME\n(40)",
  "BENE EMAIL ID\n(100)",
];

// Row 2: mandatory / optional
const INDICATORS = ["M", "M / O", "", "M", "M", "M", "M", "M", "O", "M"];

/** The bank file as a workbook: the header row, the M / O row, then one row per line. */
export async function buildBankFileWorkbook(lines: BankFileLine[], sheetLabel: string): Promise<ExcelJS.Workbook> {
  const wb = await newWorkbook();
  const ws = wb.addWorksheet(sheetLabel.substring(0, 31));

  // Column definitions -widths match the bank template
  ws.columns = [
    { key: "A", width: 18 }, // Txn type
    { key: "B", width: 22 }, // Beneficiary Code
    { key: "C", width: 16 }, // Employee Code (owner 2026-11-06: right after Beneficiary Code)
    { key: "D", width: 24 }, // Bene A/c No
    { key: "E", width: 14 }, // Amount
    { key: "F", width: 32 }, // Beneficiary Name
    { key: "G", width: 16 }, // IFSC code
    { key: "H", width: 30 }, // Bene Bank Name
    { key: "I", width: 30 }, // Bene Bank Branch Name
    { key: "J", width: 32 }, // Bene Email ID
  ];
  // Whole-rupee amounts show as whole rupees, genuine paise still show - never a raw float's stray decimal tail.
  ws.getColumn(AMOUNT_COLUMN).numFmt = "#,##0.00";

  const styleHeader = (cell: ExcelJS.Cell, isAmount = false) =>
    styleHeaderCell(cell, { fill: GREEN, color: isAmount ? RED : WHITE });
  const styleData = (cell: ExcelJS.Cell) => {
    cell.alignment = { horizontal: "center", vertical: "middle" };
  };

  const hRow = ws.addRow(HEADERS);
  hRow.height = 72;
  hRow.eachCell((cell, col) => styleHeader(cell, col === AMOUNT_COLUMN));

  const mRow = ws.addRow(INDICATORS);
  mRow.height = 18;
  mRow.eachCell({ includeEmpty: true }, (cell) => styleHeader(cell));

  for (const line of lines) {
    const dataRow = ws.addRow([
      "", // Txn type -blank
      "", // Beneficiary Code -blank
      line.employeeCode || "", // Employee Code (as text, so a code like 0123 keeps its zero)
      (line.bankAccount || "").toUpperCase(), // Bene A/c No
      line.amount, // Amount
      (line.employeeName || "").toUpperCase(), // Beneficiary Name
      (line.bankIfsc || "").toUpperCase(), // IFSC code
      (line.bankName || "").toUpperCase(), // Bene Bank Name
      "", // Branch Name -blank
      "", // Email -blank
    ]);
    dataRow.height = 16;
    dataRow.eachCell({ includeEmpty: true }, (cell) => styleData(cell));
  }
  return wb;
}

/** Writes the bank file and downloads it as `filename`. */
export async function downloadBankFile(lines: BankFileLine[], sheetLabel: string, filename: string): Promise<void> {
  await downloadWorkbook(await buildBankFileWorkbook(lines, sheetLabel), filename);
}
