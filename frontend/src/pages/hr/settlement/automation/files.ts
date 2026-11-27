// The files the Automation Method sends (owner 2026-11-26), built in the browser exactly like the Loan & Advance page's
// own: the finalized report (PDF + Excel, the Loan & Advance report's format: export.ts) for the auditor, and the bank
// file (the Payroll bank-file format: lib/bankFile.ts) for Accounts. The writers load only when a file is asked for.

import type { SettlementBatch } from "@/lib/api-client/custom-hooks/settlement-automation";
import { downloadBlob } from "@/lib/exportUtils";
import type { ExportCompany } from "../../attendance/export";
import { batchBankFileName, batchBankLines, buildFinalReport, reportSheet } from "./logic";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PDF_MIME = "application/pdf";

export type AuditorFiles = { pdf: File; xlsx: File };

/** The finalized report as the two files the auditor gets: "Loan_Advance_Salary_Advance_November_2026_Batch_1_Final.pdf"
 *  / ".xlsx". */
export async function buildAuditorFiles(
  batch: SettlementBatch,
  company: ExportCompany,
  now = new Date(),
): Promise<AuditorFiles> {
  const table = buildFinalReport(batch);
  const { buildSettlementWorkbook, buildSettlementPdf } = await import("../export");
  const input = { ...company, table, now };
  const wb = await buildSettlementWorkbook(input);
  const buffer = await wb.xlsx.writeBuffer();
  const xlsx = new File([buffer], `${table.fileStem}.xlsx`, { type: XLSX_MIME });
  const doc = await buildSettlementPdf(input);
  const pdf = new File([doc.output("blob")], `${table.fileStem}.pdf`, { type: PDF_MIME });
  return { pdf, xlsx };
}

/** The bank file Accounts gets: the batch's final approved requests (lib/bankFile.ts, the Payroll format). */
export async function buildBatchBankFile(batch: SettlementBatch): Promise<File> {
  const { buildBankFileWorkbook } = await import("@/lib/bankFile");
  const wb = await buildBankFileWorkbook(batchBankLines(batch), reportSheet(batch));
  const buffer = await wb.xlsx.writeBuffer();
  return new File([buffer], batchBankFileName(batch), { type: XLSX_MIME });
}

/** Saves a built file on this computer (HR checks it before sending). */
export const saveFile = (file: File): void => downloadBlob(file, file.name);
