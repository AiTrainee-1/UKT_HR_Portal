import type ExcelJS from "exceljs";
import { downloadWorkbook, newWorkbook, solidFill, styleHeaderCell, todayStamp } from "@/lib/exportUtils";
import type { Employee } from "@/lib/api-client";
import {
  CATEGORIES,
  COLUMN_NOTES,
  GROUP_FILL,
  GROUP_LABEL,
  REQUIRED_COLUMNS,
  ROW_STATUS_META,
  STATUS_HEADER,
  STATUS_LABEL,
  TEXT_COLUMNS,
  exportHeaders,
  groupOf,
  sampleRows,
} from "./config";
import { employeeRow, employeesOf } from "./logic";
import type { BulkResult, Category, ListStatus, UploadContext } from "./types";

type Scope = { branchName?: string | null; isSuperAdmin?: boolean } | null | undefined;

/** "Unit1", "Head Office" for a branch-scoped login; "Admin" for the super admin; "AllBranches" for any other
 *  unscoped role. Used in downloaded filenames so it is obvious whose data a sheet belongs to. */
export function scopeLabel(user: Scope): string {
  if (user?.branchName) return user.branchName.replace(/[^a-zA-Z0-9]+/g, "");
  if (user?.isSuperAdmin) return "Admin";
  return "AllBranches";
}

function styleHeaders(ws: ExcelJS.Worksheet, headers: string[]) {
  const row = ws.getRow(1);
  headers.forEach((h, i) => {
    const cell = row.getCell(i + 1);
    const required = REQUIRED_COLUMNS.has(h);
    cell.value = required ? `${h} *` : h;
    styleHeaderCell(cell, {
      fill: GROUP_FILL[groupOf(h)],
      size: 11,
      border: { bottom: { style: "medium", color: { argb: "FF0A2E3E" } } },
    });
    const note = COLUMN_NOTES[h];
    if (note) cell.note = { texts: [{ text: note }] };
  });
  row.height = 32;
  ws.columns = headers.map((h) => ({ key: h, width: Math.max(16, h.length + 4) }));
  ws.views = [{ state: "frozen", ySplit: 1, xSplit: 2 }];
  // Codes, phone and bank numbers are TEXT: a leading zero survives, a long account number is not turned into 1.2E+11,
  // and Excel does not flag every one of them with a green "Number Stored as Text" triangle.
  headers.forEach((h, i) => {
    if (TEXT_COLUMNS.has(h)) ws.getColumn(i + 1).numFmt = "@";
  });
}

function instructionsSheet(wb: ExcelJS.Workbook, category: Category, headers: string[]) {
  const cfg = CATEGORIES[category];
  const ws = wb.addWorksheet("Instructions");
  ws.columns = [{ width: 26 }, { width: 12 }, { width: 18 }, { width: 90 }];
  const title = ws.addRow([`${cfg.label} employees: how to fill the sheet`]);
  title.font = { bold: true, size: 14 };
  ws.addRow([`Pay: ${cfg.payLine}.`]);
  ws.addRow([
    "The first sheet (Employees) is the one that is uploaded. Rows starting with SAMPLE are examples and are skipped.",
  ]);
  ws.addRow(["Do not rename, reorder or remove a column: the file is refused if the columns differ."]);
  ws.addRow([]);
  const head = ws.addRow(["Column", "Required", "Section", "What to enter"]);
  head.eachCell((c) => styleHeaderCell(c, { fill: cfg.sheetFill, size: 11 }));
  for (const h of headers) {
    ws.addRow([h, REQUIRED_COLUMNS.has(h) ? "Yes" : "", GROUP_LABEL[groupOf(h)], COLUMN_NOTES[h] ?? ""]);
  }
  ws.getColumn(4).alignment = { wrapText: true, vertical: "top" };
}

export async function downloadTemplate(category: Category, user: Scope) {
  const cfg = CATEGORIES[category];
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Employees", { properties: { tabColor: { argb: cfg.sheetFill } } });
  styleHeaders(ws, cfg.headers);

  // Sample rows: a distinct amber fill so they read as "example", not "data".
  const samples = sampleRows(category);
  samples.forEach((values) => {
    const row = ws.addRow(values);
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.fill = solidFill("FFFDF3D6");
      cell.font = { italic: true, color: { argb: "FF8A6D1D" } };
    });
  });

  // A banner marking where real data starts. Its own Employee Code starts with SAMPLE so the backend skips it too.
  const banner = ws.addRow([]);
  ws.mergeCells(banner.number, 1, banner.number, cfg.headers.length);
  const cell = banner.getCell(1);
  cell.value = `SAMPLE ROWS ABOVE (2-${1 + samples.length}): for reference only, skipped on upload. Enter your real ${cfg.label.toLowerCase()} employees from row ${banner.number + 1} downwards.`;
  cell.fill = solidFill(cfg.sheetFill);
  cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
  cell.alignment = { horizontal: "center", vertical: "middle" };
  banner.height = 22;

  instructionsSheet(wb, category, cfg.headers);
  await downloadWorkbook(wb, `${cfg.label}_Employee_Template_${scopeLabel(user)}_${todayStamp()}.xlsx`);
}

export async function downloadEmployees(category: Category, status: ListStatus, employees: Employee[], user: Scope) {
  const cfg = CATEGORIES[category];
  const headers = exportHeaders(category);
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Employees", { properties: { tabColor: { argb: cfg.sheetFill } } });
  styleHeaders(ws, headers);
  employeesOf(employees, category, status).forEach((emp) => ws.addRow(employeeRow(emp, headers)));
  // The Status column is a pick-list, so it can only ever say Active or Inactive.
  const statusCol = headers.indexOf(STATUS_HEADER) + 1;
  const lastRow = ws.rowCount; // fixed first: touching a cell below could add rows
  for (let r = 2; r <= lastRow; r += 1) {
    ws.getCell(r, statusCol).dataValidation = { type: "list", allowBlank: true, formulae: ['"Active,Inactive"'] };
  }
  await downloadWorkbook(wb, `${cfg.label}_${STATUS_LABEL[status]}_Employees_${scopeLabel(user)}_${todayStamp()}.xlsx`);
}

/** The result of an upload as an Excel report: one row per sheet row, with what happened and why. */
export async function downloadResultReport(result: BulkResult, context: UploadContext) {
  const cfg = CATEGORIES[context.category];
  const wb = newWorkbook();
  const ws = wb.addWorksheet("Result", { properties: { tabColor: { argb: cfg.sheetFill } } });
  const headers = ["Sheet row", "Employee Code", "Name", "Result", "Reason / what changed", "Warnings"];
  ws.columns = [{ width: 11 }, { width: 18 }, { width: 28 }, { width: 14 }, { width: 70 }, { width: 50 }];
  headers.forEach((h, i) => styleHeaderCell(ws.getRow(1).getCell(i + 1), { fill: cfg.sheetFill, size: 11 }));
  for (const r of result.rows) {
    const row = ws.addRow([
      r.row,
      r.code,
      r.name,
      ROW_STATUS_META[r.status].label,
      [...r.messages, ...(r.changes.length ? [`Changed: ${r.changes.join(", ")}`] : [])].join("; "),
      r.warnings.join("; "),
    ]);
    if (r.status === "invalid" || r.status === "failed" || r.status === "duplicate" || r.status === "not_found") {
      row.getCell(4).font = { bold: true, color: { argb: "FFB91C1C" } };
    }
  }
  for (const m of result.missing ?? []) {
    ws.addRow(["", m.code, m.name, "Not in file", m.result ?? "Not in the uploaded file", ""]);
  }
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const kind = context.kind === "create" ? "Upload" : `${STATUS_LABEL[context.status]}_Update`;
  await downloadWorkbook(wb, `${cfg.label}_${kind}_Result_${todayStamp()}.xlsx`);
}
