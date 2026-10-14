import { FileSpreadsheet, FileText, Printer } from "lucide-react";
import type { ExportItem } from "@/components/payroll/kit/ExportMenu";
import type { TableColumn } from "@/components/payroll/kit/export-table";
import { dateTime, fileStem } from "@/components/payroll/kit/format";
import { issueLabel } from "@/components/payroll/kit/issue-meta";
import type { IssueSeverity, PayrollDetails, PayrollIssue } from "@/lib/api-client/custom-hooks";
import { impactParts } from "./logic";

// What can be taken away from the details page. Everything here only reads what is already on screen: a styled Excel
// workbook, the issues as Excel or CSV, and the browser's print dialog. The Excel / CSV builders are loaded when an
// export is chosen (not with the page), because exceljs is large.

const SEVERITY_WORD: Record<IssueSeverity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

/** The columns of every issue export: the date each issue was detected comes first. */
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

/** The same title block for every file: who, which period. */
const subtitleOf = (details: PayrollDetails): string =>
  `${details.employee.name} (${details.employee.code}) · ${details.period.label}`;

const issuesStem = (details: PayrollDetails): string =>
  fileStem("Payroll_Issues", details.employee.name, details.period.label);

async function exportIssuesExcel(details: PayrollDetails, issues: PayrollIssue[], company: string) {
  const { exportTableToExcel } = await import("@/components/payroll/kit/export-table");
  await exportTableToExcel({
    rows: issues,
    columns: ISSUE_COLUMNS,
    filename: issuesStem(details),
    sheetName: "Issues",
    company,
    subtitle: subtitleOf(details),
    title: "Payroll issues",
  });
}

async function exportIssuesCsv(details: PayrollDetails, issues: PayrollIssue[]) {
  const { exportTableToCsv } = await import("@/components/payroll/kit/export-table");
  exportTableToCsv({ rows: issues, columns: ISSUE_COLUMNS, filename: issuesStem(details) });
}

/** Excel and CSV of a list of issues (the whole list, or the ones the filters leave). */
export function issueExportItems({
  details,
  issues,
  company,
  hint,
  keyPrefix,
}: {
  details: PayrollDetails;
  issues: PayrollIssue[];
  company: string;
  /** One line under each label: "The 5 issues shown above". */
  hint: string;
  keyPrefix: string;
}): ExportItem[] {
  const none = issues.length === 0;
  return [
    {
      key: `${keyPrefix}xlsx`,
      label: "Issues (Excel)",
      hint: none ? "There are no issues to export" : hint,
      icon: FileSpreadsheet,
      disabled: none,
      run: () => exportIssuesExcel(details, issues, company),
    },
    {
      key: `${keyPrefix}csv`,
      label: "Issues (CSV)",
      hint: none ? "There are no issues to export" : hint,
      icon: FileText,
      disabled: none,
      run: () => exportIssuesCsv(details, issues),
    },
  ];
}

/** The page's Export menu: the whole details workbook, every issue, and a print of the page. */
export function detailsExportItems({ details, company }: { details: PayrollDetails; company: string }): ExportItem[] {
  const count = details.issues.length;
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
    ...issueExportItems({
      details,
      issues: details.issues,
      company,
      hint: `All ${count} ${count === 1 ? "issue" : "issues"} detected on this payroll, with the date of each`,
      keyPrefix: "issues-",
    }),
    {
      key: "print",
      label: "Print this page",
      hint: "Every section, laid out for paper",
      icon: Printer,
      run: () => window.print(),
    },
  ];
}
