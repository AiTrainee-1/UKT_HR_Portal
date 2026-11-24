import { FileSpreadsheet, Printer } from "lucide-react";
import type { ExportItem } from "@/components/payroll/kit/ExportMenu";
import type { TableColumn } from "@/components/payroll/kit/export-table";
import { dateTime } from "@/components/payroll/kit/format";
import { issueLabel } from "@/components/payroll/kit/issue-meta";
import type { IssueSeverity, PayrollDetails, PayrollIssue } from "@/lib/api-client/custom-hooks";
import { impactParts } from "./logic";

// What can be taken away from the details page. Everything here only reads what is already on screen: a styled Excel
// workbook and the browser's print dialog. The workbook builder is loaded when the export is chosen (not with the page),
// because exceljs is large. (The separate Issues Excel / CSV items went with the Issues section, owner 2026-11-24: the
// workbook still has its issues sheet.)

const SEVERITY_WORD: Record<IssueSeverity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

/** The columns of the workbook's issues sheet: the date each issue was detected comes first. */
export const ISSUE_COLUMNS: TableColumn<PayrollIssue>[] = [
  { key: "date", label: "Date detected", width: 16, type: "date", value: (i) => i.date ?? "Whole period" },
  { key: "type", label: "Type", width: 22, value: (i) => issueLabel(i.code) },
  { key: "severity", label: "Severity", width: 12, value: (i) => SEVERITY_WORD[i.severity] ?? i.severity },
  { key: "title", label: "Title", width: 24, value: (i) => i.title },
  { key: "detail", label: "Details", width: 70, value: (i) => i.detail },
  { key: "impact", label: "Impact", width: 24, value: (i) => impactParts(i.impact).join("; ") },
  { key: "rule", label: "Rule", width: 30, value: (i) => i.rule?.label ?? "" },
  { key: "flaggedAt", label: "Flagged at", width: 20, value: (i) => (i.detectedAt ? dateTime(i.detectedAt) : "") },
];

/** The page's Export menu: the whole details workbook and a print of the page. */
export function detailsExportItems({ details, company }: { details: PayrollDetails; company: string }): ExportItem[] {
  return [
    {
      key: "workbook",
      label: "Details workbook (Excel)",
      hint: "Summary, earnings & deductions, rules, issues and days, one sheet each",
      icon: FileSpreadsheet,
      run: async () => {
        const { exportDetailsWorkbook } = await import("./workbook");
        await exportDetailsWorkbook(details, company);
      },
    },
    {
      key: "print",
      label: "Print this page",
      hint: "Every section, laid out for paper",
      icon: Printer,
      run: () => window.print(),
    },
  ];
}
