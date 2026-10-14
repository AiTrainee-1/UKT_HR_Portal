import type ExcelJS from "exceljs";
import {
  addTitleBlock,
  allBorders,
  downloadBlob,
  downloadWorkbook,
  newWorkbook,
  solidFill,
  styleHeaderCell,
} from "@/lib/exportUtils";

// One plain "export this table" for every list on the payroll screens (issues, skipped employees, rules, records):
// an Excel sheet with the company-style title block and a styled header, or a CSV. The Salary Statement has its own
// layout (components/payroll/statement); this is for the tables.

export type TableColumn<Row> = {
  key: string;
  label: string;
  /** Excel column width in characters. */
  width?: number;
  /** "money" cells get the Indian two-decimal number format, "date" cells are written as real dates. */
  type?: "text" | "int" | "money" | "date";
  /** How to read the cell from a row (defaults to row[key]). */
  value?: (row: Row) => string | number | null | undefined;
};

const read = <Row>(col: TableColumn<Row>, row: Row): string | number | null => {
  const v = col.value ? col.value(row) : (row as Record<string, unknown>)[col.key];
  return v === undefined || v === null ? null : (v as string | number);
};

const HEADER_FILL = "FF1E3A5F";

export async function exportTableToExcel<Row>({
  rows,
  columns,
  filename,
  sheetName,
  company,
  subtitle,
  title,
}: {
  rows: Row[];
  columns: TableColumn<Row>[];
  /** Without the extension. */
  filename: string;
  sheetName: string;
  company: string;
  subtitle: string;
  title: string;
}): Promise<void> {
  const wb = newWorkbook();
  const ws = wb.addWorksheet(sheetName.slice(0, 31));
  ws.columns = columns.map((c) => ({ key: c.key, width: c.width ?? 16 }));
  const last = addTitleBlock(wb, ws, {
    totalCols: columns.length,
    company,
    branchLabel: subtitle,
    title,
    titleFill: "FFDCE8F5",
  });
  const header = ws.getRow(last + 1);
  columns.forEach((c, i) => {
    const cell = header.getCell(i + 1);
    cell.value = c.label;
    styleHeaderCell(cell, { fill: HEADER_FILL, border: allBorders("thin", "FFBFC9D6") });
  });
  header.height = 24;
  ws.views = [{ state: "frozen", ySplit: last + 1 }];

  rows.forEach((row, r) => {
    const excelRow = ws.getRow(last + 2 + r);
    columns.forEach((c, i) => {
      const cell = excelRow.getCell(i + 1);
      const v = read(c, row);
      if (c.type === "date" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) {
        const [y, m, d] = v.slice(0, 10).split("-").map(Number);
        cell.value = new Date(Date.UTC(y, m - 1, d));
        cell.numFmt = "dd-mmm-yyyy";
      } else {
        cell.value = v as ExcelJS.CellValue;
        if (c.type === "money") cell.numFmt = "#,##0.00";
        if (c.type === "int") cell.numFmt = "0";
      }
      cell.border = allBorders("hair", "FFD0D7E2");
      cell.alignment = {
        vertical: "middle",
        wrapText: true,
        horizontal: c.type === "money" || c.type === "int" ? "right" : "left",
      };
      if (r % 2 === 1) cell.fill = solidFill("FFF7F9FC");
    });
  });
  await downloadWorkbook(wb, `${filename}.xlsx`);
}

const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  const text = String(v);
  // Spreadsheet formula injection: a cell that starts with = + - @ is read as a formula by Excel.
  const safe = /^[=+\-@]/.test(text) && typeof v === "string" ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function exportTableToCsv<Row>({
  rows,
  columns,
  filename,
}: {
  rows: Row[];
  columns: TableColumn<Row>[];
  filename: string;
}): void {
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  for (const row of rows) lines.push(columns.map((c) => csvCell(read(c, row))).join(","));
  // A byte-order mark so Excel opens the UTF-8 file with the right characters (₹, names).
  downloadBlob(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }), `${filename}.csv`);
}
