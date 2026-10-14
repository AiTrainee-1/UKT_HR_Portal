import type ExcelJS from "exceljs";
import { dateTime, fileStem } from "@/components/payroll/kit/format";
import { issueLabel } from "@/components/payroll/kit/issue-meta";
import type { PayrollDetails } from "@/lib/api-client/custom-hooks";
import {
  addTitleBlock,
  allBorders,
  downloadWorkbook,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";
import { ISSUE_COLUMNS } from "./exports";
import { changedRules, countRules, humanizeKey, isRuleChanged, severityCounts, statusLabel } from "./logic";

// The "Details workbook": one Excel file with a sheet each for the summary, the earnings and deductions, the rules, the
// issues (with the date each was detected) and the days. Loaded only when the export is chosen (exceljs is large).

type CellValue = string | number | Date | null;
type Kind = "text" | "money" | "number" | "date";
type Column = { header: string; width: number; kind?: Kind };

const HEADER_FILL = "FF1E3A5F";
const TITLE_FILL = "FFDCE8F5";
const BAND_FILL = "FFF7F9FC";
const HAIR = allBorders("hair", "FFD0D7E2");

function writeCell(cell: ExcelJS.Cell, value: CellValue, kind: Kind = "text", banded = false, bold = false) {
  if (kind === "date" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split("-").map(Number);
    cell.value = new Date(Date.UTC(y, m - 1, d));
    cell.numFmt = "dd-mmm-yyyy";
  } else {
    cell.value = value;
    if (kind === "money") cell.numFmt = "#,##0.00";
    if (kind === "number") cell.numFmt = "0.##";
  }
  cell.border = HAIR;
  cell.alignment = {
    vertical: "middle",
    wrapText: true,
    horizontal: kind === "money" || kind === "number" ? "right" : "left",
  };
  if (banded) cell.fill = solidFill(BAND_FILL);
  if (bold) cell.font = { bold: true };
}

/** A sheet with the title block, a styled frozen header and the rows (each row's kind decides how a cell is written). */
function addTableSheet(
  wb: ExcelJS.Workbook,
  opts: {
    name: string;
    company: string;
    subtitle: string;
    title: string;
    columns: Column[];
    rows: CellValue[][];
    boldRows?: ReadonlySet<number>;
  },
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(opts.name.slice(0, 31));
  ws.columns = opts.columns.map((c) => ({ width: c.width }));
  const last = addTitleBlock(wb, ws, {
    totalCols: opts.columns.length,
    company: opts.company,
    branchLabel: opts.subtitle,
    title: opts.title,
    titleFill: TITLE_FILL,
  });
  const header = ws.getRow(last + 1);
  opts.columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.header;
    styleHeaderCell(cell, { fill: HEADER_FILL, border: allBorders("thin", "FFBFC9D6") });
  });
  header.height = 24;
  ws.views = [{ state: "frozen", ySplit: last + 1 }];
  opts.rows.forEach((values, r) => {
    const row = ws.getRow(last + 2 + r);
    values.forEach((value, i) =>
      writeCell(row.getCell(i + 1), value, opts.columns[i]?.kind, r % 2 === 1, opts.boldRows?.has(r) ?? false),
    );
  });
  return ws;
}

const KIND_WORD = { earning: "Earning", deduction: "Deduction", info: "Information (not added)", subtotal: "Subtotal" };

export async function exportDetailsWorkbook(details: PayrollDetails, company: string): Promise<void> {
  const wb = newWorkbook();
  const { employee, period, money } = details;
  const subtitle = `${employee.name} (${employee.code}) · ${period.label}`;

  // ── Summary: who, which payroll, the money, the counts ──
  const summary = wb.addWorksheet("Summary");
  summary.columns = [{ width: 34 }, { width: 52 }];
  const last = addTitleBlock(wb, summary, {
    totalCols: 2,
    company,
    branchLabel: subtitle,
    title: "Payroll details",
    titleFill: TITLE_FILL,
  });
  let at = last + 2;
  const section = (title: string) => {
    summary.mergeCells(at, 1, at, 2);
    const cell = summary.getCell(at, 1);
    cell.value = title;
    styleHeaderCell(cell, { fill: HEADER_FILL, border: allBorders("thin", "FFBFC9D6") });
    cell.alignment = { horizontal: "left", vertical: "middle" };
    at += 1;
  };
  const field = (label: string, value: CellValue, kind: Kind = "text") => {
    if (value === null || value === "") return;
    writeCell(summary.getCell(at, 1), label, "text", false, true);
    writeCell(summary.getCell(at, 2), value, kind);
    at += 1;
  };
  const counts = severityCounts(details.issues);

  section("Employee");
  field("Name", employee.name);
  field("Employee code", employee.code);
  field("Department", employee.department);
  field("Designation", employee.designation);
  field("Branch", employee.branch);
  field("Employment type", statusLabel(employee.employmentType));
  field("Pay cycle", period.cycleLabel ?? (employee.payCycle ? statusLabel(employee.payCycle) : null));
  field("Joined", employee.joinDate, "date");
  field("Status now", statusLabel(employee.status));
  at += 1;
  section("Payroll");
  field("Period", period.label);
  field("Payroll status", statusLabel(details.status));
  field("Payslip number", details.slipNumber);
  field("Last computed", details.generatedAt ? dateTime(details.generatedAt) : null);
  field("First generated", details.firstGeneratedAt ? dateTime(details.firstGeneratedAt) : null);
  at += 1;
  section("Money (₹)");
  field("Gross", money.gross, "money");
  field("Deductions", money.deductions, "money");
  field("Bonus", money.bonus, "money");
  field("Overtime", money.otAmount, "money");
  field("Net payable", money.net, "money");
  field("Monthly salary", money.monthlySalary, "money");
  field("Daily rate", money.dailyRate, "money");
  field("Salary per shift", employee.salaryPerShift, "money");
  at += 1;
  section("Days and shifts");
  for (const [key, value] of Object.entries(details.summary)) {
    if (typeof value === "number") field(statusLabel(humanizeKey(key)), value, "number");
  }
  at += 1;
  section("Issues and rules");
  field("Issues detected", details.issues.length, "number");
  field("Critical", counts.critical, "number");
  field("Needs a look", counts.warning, "number");
  field("For information", counts.info, "number");
  field("Rules", countRules(details.rules), "number");
  field("Rules changed since generated", changedRules(details.rules).length, "number");

  // ── Earnings & deductions ──
  const lineRows: CellValue[][] = [];
  const bold = new Set<number>();
  const addLines = (sectionName: string, lines: PayrollDetails["earnings"]) => {
    for (const line of lines) {
      if (line.kind === "subtotal") bold.add(lineRows.length);
      lineRows.push([sectionName, line.label, line.note ?? "", line.amount, KIND_WORD[line.kind] ?? line.kind]);
    }
  };
  addLines("Earnings", details.earnings);
  addLines("Deductions", details.deductions);
  bold.add(lineRows.length);
  lineRows.push(["Result", "Net payable", "Gross - deductions" + (money.bonus ? " + bonus" : ""), money.net, "Result"]);
  addTableSheet(wb, {
    name: "Earnings & deductions",
    company,
    subtitle,
    title: "How this salary was worked out",
    columns: [
      { header: "Section", width: 14 },
      { header: "Line", width: 30 },
      { header: "How it was worked out", width: 62 },
      { header: "Amount (₹)", width: 16, kind: "money" },
      { header: "Type", width: 24 },
    ],
    rows: lineRows,
    boldRows: bold,
  });

  // ── Rules ──
  addTableSheet(wb, {
    name: "Rules",
    company,
    subtitle,
    title: "Rules behind this payroll",
    columns: [
      { header: "Group", width: 18 },
      { header: "Rule", width: 30 },
      { header: "Settings now", width: 44 },
      { header: "Generated with", width: 44 },
      { header: "Changed since generated", width: 14 },
      { header: "Comes from", width: 14 },
      { header: "Detail", width: 50 },
      { header: "Where to change it", width: 46 },
    ],
    rows: details.rules.flatMap((group) =>
      group.items.map((item): CellValue[] => [
        group.group,
        item.label,
        item.value,
        item.applied ?? item.value,
        isRuleChanged(item) ? "Yes" : "No",
        statusLabel(item.source),
        item.detail ?? "",
        item.settingsPath ?? "",
      ]),
    ),
  });

  // ── Issues ──
  addTableSheet(wb, {
    name: "Issues",
    company,
    subtitle,
    title: "Payroll issues",
    columns: ISSUE_COLUMNS.map((c) => ({
      header: c.label,
      width: c.width ?? 16,
      kind: c.type === "date" ? "date" : "text",
    })),
    rows: [...details.issues]
      .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id))
      .map((issue) => ISSUE_COLUMNS.map((c) => (c.value ? (c.value(issue) ?? null) : null))),
  });

  // ── Days ──
  addTableSheet(wb, {
    name: "Days",
    company,
    subtitle,
    title: "Day by day",
    columns: [
      { header: "Date", width: 14, kind: "date" },
      { header: "Day", width: 8 },
      { header: "Status", width: 16 },
      { header: "First in", width: 10 },
      { header: "Last out", width: 10 },
      { header: "Shifts", width: 8, kind: "number" },
      { header: "Flags", width: 40 },
      { header: "Note", width: 46 },
    ],
    rows: details.days.map((d): CellValue[] => [
      d.date,
      d.day,
      statusLabel(d.status),
      d.firstIn ?? "",
      d.lastOut ?? "",
      d.shifts,
      (d.flags ?? []).map((f) => issueLabel(f)).join(", "),
      d.note ?? "",
    ]),
  });

  await downloadWorkbook(wb, `${fileStem("Payroll_Details", employee.name, period.label)}.xlsx`);
}
