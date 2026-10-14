import type ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { productionDetails, staffDetails } from "./fixtures";

// The details workbook, built for real (exceljs runs in Node) with only the download itself captured: its sheets, the
// date each issue was detected as a real date, money as numbers with a money format, the changed rule, the days.

const h = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadWorkbook: h.download,
}));

import { exportDetailsWorkbook } from "./workbook";

async function build(details = staffDetails()) {
  await exportDetailsWorkbook(details, "UK Textiles Ltd");
  expect(h.download).toHaveBeenCalledTimes(1);
  const [wb, filename] = h.download.mock.calls[0] as [ExcelJS.Workbook, string];
  return { wb, filename };
}

/** The values of a sheet's rows from `from` on, as plain arrays (cell 1 first). */
const rows = (ws: ExcelJS.Worksheet, from = 5) => {
  const out: unknown[][] = [];
  for (let r = from; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    out.push(Array.from({ length: ws.columnCount }, (_, c) => row.getCell(c + 1).value));
  }
  return out;
};

/** The number of the row whose first cell says `label`. */
function rowOf(ws: ExcelJS.Worksheet, label: string): number {
  for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getCell(r, 1).value === label) return r;
  throw new Error(`no row says "${label}"`);
}

beforeEach(() => {
  h.download.mockReset();
});

describe("the details workbook", () => {
  it("is one file with a sheet each for the summary, the pay lines, the rules, the issues and the days", async () => {
    const { wb, filename } = await build();
    expect(filename).toBe("Payroll_Details_Meena_Subramanian_October_2026.xlsx");
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary", "Earnings & deductions", "Rules", "Issues", "Days"]);
    // every sheet opens with the company, who the payroll is for and what the sheet is
    for (const ws of wb.worksheets) {
      expect(ws.getCell(1, 1).value).toBe("UK Textiles Ltd");
      expect(ws.getCell(2, 1).value).toBe("Meena Subramanian (UKT-0142) · October 2026");
    }
  });

  it("Summary: who, which payroll, the money as numbers and the counts", async () => {
    const { wb } = await build();
    const ws = wb.getWorksheet("Summary")!;
    const all = rows(ws, 4);
    const value = (label: string) => all.find((r) => r[0] === label)?.[1];
    expect(value("Name")).toBe("Meena Subramanian");
    expect(value("Employee code")).toBe("UKT-0142");
    expect(value("Period")).toBe("October 2026");
    expect(value("Payroll status")).toBe("Pending");
    expect(value("Payslip number")).toBe("SLP-2026-10-0142");
    expect(value("Gross")).toBe(26663.46);
    expect(value("Deductions")).toBe(3167.23);
    expect(value("Net payable")).toBe(23496.23);
    expect(value("Total working days")).toBe(26);
    expect(value("Effective paid days")).toBe(23.5);
    expect(value("Issues detected")).toBe(11);
    expect(value("Critical")).toBe(1);
    expect(value("Rules")).toBe(15);
    expect(value("Rules changed since generated")).toBe(1);
    // a field that has no value is left out, not written blank
    expect(all.find((r) => r[0] === "Overtime pay")).toBeUndefined();
    expect(all.find((r) => r[0] === "Salary per shift")).toBeUndefined();
    const netRow = rowOf(ws, "Net payable");
    expect(ws.getCell(netRow, 2).value).toBe(23496.23);
    expect(ws.getCell(netRow, 2).numFmt).toBe("#,##0.00");
    expect(ws.getCell(netRow, 1).font?.bold).toBe(true);
    expect(ws.getCell(rowOf(ws, "Joined"), 2).value).toBeInstanceOf(Date);
  });

  it("Earnings & deductions: every stored line, the subtotals in bold, ending in the net payable", async () => {
    const { wb } = await build();
    const ws = wb.getWorksheet("Earnings & deductions")!;
    const lines = rows(ws);
    expect(lines).toHaveLength(9);
    expect(lines[2]).toEqual([
      "Earnings",
      "Earned salary",
      "₹1,134.62 x 23.5 paid days (21 present + 0.5 half day + 2 paid leave)",
      26663.46,
      "Earning",
    ]);
    expect(lines[0][4]).toBe("Information (not added)");
    expect(lines[4]).toEqual(["Deductions", "Provident fund", "12% of basic ₹13,332.69", 1599.92, "Deduction"]);
    expect(lines[8]).toEqual(["Result", "Net payable", "Gross - deductions", 23496.23, "Result"]);
    expect(ws.getCell(5 + 3, 2).font?.bold).toBe(true); // the Gross subtotal
    expect(ws.getCell(5 + 2, 2).font?.bold).toBeFalsy(); // an ordinary line
    expect(ws.getCell(5 + 2, 4).numFmt).toBe("#,##0.00");
  });

  it("Rules: what each says, what it was generated with, and whether it changed", async () => {
    const { wb } = await build();
    const ws = wb.getWorksheet("Rules")!;
    const all = rows(ws);
    expect(all).toHaveLength(15);
    const free = all.find((r) => r[1] === "Free late marks a month")!;
    expect(free[0]).toBe("Late detection");
    expect(free[2]).toBe("3 free, then slabs"); // Settings now
    expect(free[3]).toBe("2 free, then slabs"); // generated with
    expect(free[4]).toBe("Yes");
    expect(free[5]).toBe("Settings");
    expect(free[7]).toBe("/hr/settings?tab=late_detection#late-free-allowance");
    const unchanged = all.find((r) => r[1] === "Attendance mode")!;
    expect(unchanged[4]).toBe("No");
    expect(all.filter((r) => r[4] === "Yes")).toHaveLength(1);
  });

  it("Issues: the date each was detected as a real date, whole-period issues first, severity in words", async () => {
    const { wb } = await build();
    const ws = wb.getWorksheet("Issues")!;
    expect(rows(ws, 4)[0]).toEqual([
      "Date detected",
      "Type",
      "Severity",
      "Title",
      "Details",
      "Impact",
      "Rule",
      "Flagged at",
    ]);
    const all = rows(ws, 5);
    expect(all).toHaveLength(11);
    expect(all.slice(0, 3).every((r) => r[0] === "Whole period")).toBe(true);
    const absent = all.find((r) => r[1] === "Absent")!;
    expect(absent[0]).toBeInstanceOf(Date);
    expect((absent[0] as Date).toISOString().slice(0, 10)).toBe("2026-10-06");
    expect(absent[2]).toBe("Critical");
    expect(absent[5]).toBe("1 day; ₹1,134.62");
    expect(absent[6]).toBe("Loss of pay on absence");
    const dated = all.filter((r) => r[0] instanceof Date).map((r) => (r[0] as Date).toISOString().slice(0, 10));
    expect(dated).toEqual([...dated].sort());
    const rowOfAbsent = all.indexOf(absent) + 5;
    expect(ws.getCell(rowOfAbsent, 1).numFmt).toBe("dd-mmm-yyyy");
  });

  it("Days: every day of the period with its flags in words", async () => {
    const { wb } = await build();
    const ws = wb.getWorksheet("Days")!;
    const all = rows(ws);
    expect(all).toHaveLength(26); // the working days: a Sunday has no entry
    const late = all.find((r) => (r[0] as Date).toISOString().slice(0, 10) === "2026-10-13")!;
    expect(late.slice(1)).toEqual([
      "Tue",
      "Present",
      "09:42",
      "18:07",
      1,
      "Late arrival",
      "Morning late-in: first punch 09:42 is after the 09:10 deadline",
    ]);
    const half = all.find((r) => (r[0] as Date).toISOString().slice(0, 10) === "2026-10-22")!;
    expect(half[2]).toBe("Present"); // a half day is a present day at 0.5 shifts, flagged
    expect(half[5]).toBe(0.5);
    expect(half[6]).toBe("Half day");
  });

  it("a production payroll is exported the same way, under its own period", async () => {
    const { wb, filename } = await build(productionDetails());
    expect(filename).toBe("Payroll_Details_Ravi_Kumar_5_Oct_11_Oct_2026.xlsx");
    expect(wb.getWorksheet("Days")!.rowCount).toBeGreaterThanOrEqual(7 + 4);
    const summary = rows(wb.getWorksheet("Summary")!, 4);
    expect(summary.find((r) => r[0] === "Pay cycle")?.[1]).toBe("Weekly");
    expect(summary.find((r) => r[0] === "Salary per shift")?.[1]).toBe(650);
    expect(summary.find((r) => r[0] === "Total shifts")?.[1]).toBe(4.5);
  });
});
