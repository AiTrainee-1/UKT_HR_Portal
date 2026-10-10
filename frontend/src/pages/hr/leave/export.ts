// One sheet of a list, as an Excel file. Shared by the Leave & Holiday and Casual Leave pages (the page decides what the
// rows are; this only draws the header and downloads it).

import { downloadWorkbook, fileSafe, newWorkbook, solidFill, styleHeaderCell, todayStamp } from "@/lib/exportUtils";

export async function exportSheet(
  title: string,
  headers: string[],
  rows: (string | number)[][],
  widths?: number[],
): Promise<void> {
  const wb = newWorkbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow(headers);
  ws.getRow(1).eachCell((cell) => styleHeaderCell(cell, { fill: "FF1E3A8A" }));
  ws.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) ws.addRow(row);
  headers.forEach((h, i) => {
    const longest = rows.reduce((n, r) => Math.max(n, String(r[i] ?? "").length), h.length);
    ws.getColumn(i + 1).width = widths?.[i] ?? Math.min(48, Math.max(10, longest + 2));
  });
  // a light band on every other row keeps a long list readable
  rows.forEach((_, i) => {
    if (i % 2 === 1) ws.getRow(i + 2).fill = solidFill("FFF8FAFC");
  });
  await downloadWorkbook(wb, `${fileSafe(title)}_${todayStamp()}.xlsx`);
}
