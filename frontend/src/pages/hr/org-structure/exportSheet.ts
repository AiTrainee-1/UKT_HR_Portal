// One-sheet Excel export for the Departments and Designations pages. exceljs is loaded when the button is pressed, so the
// pages do not pay for it on open.

export async function downloadSheet(sheetName: string, fileBase: string, rows: (string | number)[][]): Promise<void> {
  const { newWorkbook, downloadWorkbook, solidFill, todayStamp, fileSafe } = await import("@/lib/exportUtils");
  const wb = newWorkbook();
  const ws = wb.addWorksheet(sheetName);
  rows.forEach((r) => ws.addRow(r));
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.eachCell((cell) => {
    cell.fill = solidFill("FF1E3A8A");
  });
  ws.columns.forEach((col, i) => {
    const longest = rows.reduce((n, r) => Math.max(n, String(r[i] ?? "").length), 8);
    col.width = Math.min(40, longest + 2);
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  await downloadWorkbook(wb, `${fileSafe(fileBase)}_${todayStamp()}.xlsx`);
}
