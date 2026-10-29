import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { solidFill } from "@/lib/exportUtils";
import {
  NUMBER_FORMAT,
  buildStatementWorkbook,
  downloadStatementXlsx,
  excelColumnWidth,
  statementXlsxFilename,
} from "./export-statement-xlsx";
import { PRODUCTION_COLUMNS, STAFF_COLUMNS, productionStatement, staffStatement } from "./fixtures";
import { filterStatement } from "./statement-model";

// 1x1 transparent PNG
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Where things land on the sheet (24 staff columns A..X): title 1-3, header bands 4, labels 5, then
// 6 ACCOUNTS band, 7-9 its rows, 10 its subtotal, 11 ADMIN band, 12-23 its rows, 24 its subtotal, 25 GRAND TOTAL,
// 26 blank, 27 "Notes", 28-34 the seven notes, 35 the counts line.
const COL = {
  sno: "A",
  code: "B",
  name: "C",
  designation: "D",
  basic: "E",
  total: "F",
  present: "G",
  totalDays: "K",
  eSalary: "N",
  totalDeduction: "V",
  net: "W",
  remarks: "X",
};

const sheet = (wb: ExcelJS.Workbook) => wb.getWorksheet("Salary Statement")!;
const at = (ws: ExcelJS.Worksheet, address: string) => ws.getCell(address);

describe("the workbook: layout", () => {
  const wb = buildStatementWorkbook(staffStatement());
  const ws = sheet(wb);

  it("is one sheet with the title block merged across every column", () => {
    expect(wb.worksheets).toHaveLength(1);
    expect(at(ws, "A1").value).toBe("U.K TEXTILES");
    expect(at(ws, "A2").value).toBe("H.O");
    expect(at(ws, "A3").value).toBe("Salary Statement From 01-09-2026 To 30-09-2026");
    expect(ws.model.merges).toEqual(expect.arrayContaining(["A1:X1", "A2:X2", "A3:X3"]));
    expect(wb.creator).toBe("UKTextiles HRMS");
    expect(wb.title).toBe("Salary Statement From 01-09-2026 To 30-09-2026");
  });

  it("has a two-row header: the column-group bands, then the labels with their second lines", () => {
    const bands = [
      ["A4", "A4:D4", "EMPLOYEE"],
      ["E4", "E4:F4", "EARNINGS"],
      ["G4", "G4:K4", "ATTENDANCE"],
      ["L4", "L4:N4", "EARNINGS"],
      ["O4", "O4:V4", "DEDUCTIONS"],
      ["W4", "W4:X4", "NET PAY"],
    ] as const;
    for (const [address, range, label] of bands) {
      expect(at(ws, address).value).toBe(label);
      expect(ws.model.merges).toContain(range);
    }
    expect(at(ws, "A4").fill).toEqual(solidFill("FFE2E8F0"));
    expect(at(ws, "G4").fill).toEqual(solidFill("FFDBEAFE"));
    expect(at(ws, "O4").fill).toEqual(solidFill("FFFFE4E6"));

    const labels: [string, string][] = [
      ["A5", "SNO"],
      ["B5", "ID NO"],
      ["C5", "Name"],
      ["D5", "Designation"],
      ["E5", "Basic salary"],
      ["F5", "Total"],
      ["K5", "Total Days"],
      ["L5", "PTRL"],
      ["M5", "Others Allow"],
      ["S5", "TDS\nnot tracked"],
      ["N5", "E salary"],
      ["O5", "T.Advance"],
      ["U5", "Lop& PSAmt\ninformation"],
      ["V5", "Total Deduction"],
      ["W5", "NET"],
      ["X5", "Remarks"],
    ];
    for (const [address, text] of labels) expect(at(ws, address).value).toBe(text);
    expect(at(ws, "E5").fill).toEqual(solidFill("FF1E3A5F"));
    expect(at(ws, "E5").font).toMatchObject({ bold: true });
    expect(at(ws, "E5").alignment).toMatchObject({ wrapText: true, horizontal: "center" });
    expect(ws.getRow(5).height).toBe(30);
  });

  it("puts a merged, bold, tinted band row per department above its employees", () => {
    expect(at(ws, "A6").value).toBe("ACCOUNTS  (3 employees)");
    expect(at(ws, "A11").value).toBe("ADMIN  (12 employees)");
    expect(ws.model.merges).toEqual(expect.arrayContaining(["A6:X6", "A11:X11"]));
    expect(at(ws, "A6").font).toMatchObject({ bold: true });
    expect(at(ws, "A6").fill).toEqual(solidFill("FFE8EEF7"));
  });

  it("writes REAL numbers with number formats, and text as text", () => {
    // row 7 is MEENATCHI.T
    expect(at(ws, `${COL.sno}7`).value).toBe(1);
    expect(at(ws, `${COL.sno}7`).numFmt).toBe("0");
    expect(at(ws, `${COL.code}7`).value).toBe("2316");
    expect(at(ws, `${COL.name}7`).value).toBe("MEENATCHI.T");
    expect(at(ws, `${COL.designation}7`).value).toBe("ACCOUNTS EXECUTIVE");
    expect(at(ws, `${COL.basic}7`).value).toBe(14750);
    expect(at(ws, `${COL.basic}7`).numFmt).toBe("#,##0.00");
    expect(at(ws, `${COL.total}7`).value).toBe(29500);
    expect(at(ws, `${COL.present}7`).value).toBe(22);
    expect(at(ws, `${COL.present}7`).numFmt).toBe("0.00");
    expect(at(ws, `${COL.eSalary}7`).value).toBe(27230);
    expect(at(ws, `${COL.net}7`).value).toBe(26230);
    expect(at(ws, `${COL.remarks}7`).value).toBeNull();
    // zero is a number too (the sheet can be summed), half days are exact
    expect(at(ws, "L7").value).toBe(0);
    expect(at(ws, "G16").value).toBe(24.5); // NARAYANAN KUPPAYI, serial number 8 (sheet row 8 + 8)
    expect(typeof at(ws, `${COL.net}7`).value).toBe("number");
    // the remark of the third ACCOUNTS row
    expect(at(ws, `${COL.name}9`).value).toBe("SRIRAM DORAISWAMY");
    expect(at(ws, `${COL.remarks}9`).value).toBe("LEFT");
  });

  it("zebra-stripes the rows and right-aligns the figures", () => {
    expect(at(ws, `${COL.basic}8`).fill).toEqual(solidFill("FFF7F9FC"));
    expect(at(ws, `${COL.basic}7`).fill).toBeUndefined();
    expect(at(ws, `${COL.basic}7`).alignment).toMatchObject({ horizontal: "right" });
    expect(at(ws, `${COL.name}7`).alignment).toMatchObject({ horizontal: "left" });
    expect(at(ws, `${COL.sno}7`).alignment).toMatchObject({ horizontal: "center" });
    expect(at(ws, `${COL.net}7`).font).toMatchObject({ bold: true });
  });

  it("closes every department with a bold subtotal, and the sheet with the grand total", () => {
    expect(at(ws, "A10").value).toBe("ACCOUNTS - Total");
    expect(ws.model.merges).toContain("A10:C10");
    expect(at(ws, `${COL.net}10`).value).toBe(46004);
    expect(at(ws, `${COL.net}10`).numFmt).toBe("#,##0.00");
    expect(at(ws, `${COL.eSalary}10`).value).toBe(47808);
    expect(at(ws, `${COL.present}10`).value).toBe(46);
    expect(at(ws, `${COL.designation}10`).value).toBeNull();
    expect(at(ws, `${COL.remarks}10`).value).toBeNull();
    expect(at(ws, `${COL.net}10`).font).toMatchObject({ bold: true });
    expect(at(ws, `${COL.net}10`).fill).toEqual(solidFill("FFEEF2F9"));

    expect(at(ws, "A24").value).toBe("ADMIN - Total");
    expect(at(ws, `${COL.net}24`).value).toBe(683495);

    expect(at(ws, "A25").value).toBe("GRAND TOTAL");
    expect(ws.model.merges).toContain("A25:C25");
    expect(at(ws, `${COL.net}25`).value).toBe(729499);
    expect(at(ws, `${COL.total}25`).value).toBe(859500);
    expect(at(ws, `${COL.net}25`).font).toMatchObject({ bold: true, color: { argb: "FFFFFFFF" } });
    expect(at(ws, `${COL.net}25`).fill).toEqual(solidFill("FF3730A3")); // Staff Payroll's indigo
  });

  it("prints the notes under the table, then the counts and when it was generated", () => {
    expect(at(ws, "A27").value).toBe("Notes");
    expect(String(at(ws, "A28").value)).toMatch(/^Basic is the first salary-split portion/);
    expect(at(ws, "A34").value).toBe("TDS is not tracked by the HRMS and is always 0.");
    expect(String(at(ws, "A35").value)).toMatch(
      /^15 employees {2}- {2}2 departments {2}- {2}11 cleared {2}- {2}4 pending {2}- {2}Generated \d{2}-\d{2}-\d{4} \d{2}:\d{2}$/,
    );
    expect(ws.model.merges).toEqual(expect.arrayContaining(["A27:X27", "A28:X28", "A34:X34", "A35:X35"]));
    // a long note gets a taller row so the wrapped text shows
    expect(ws.getRow(28).height).toBeGreaterThanOrEqual(13);
    expect(at(ws, "A28").alignment).toMatchObject({ wrapText: true });
  });

  it("freezes the header and the SNO / ID NO / Name columns", () => {
    expect(ws.views).toHaveLength(1);
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 3, ySplit: 5 });
  });

  it("is set up to print on A4 landscape, one page wide, with the header repeated and 'Page x of y' in the footer", () => {
    expect(ws.pageSetup).toMatchObject({
      paperSize: 9,
      orientation: "landscape",
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:5",
    });
    expect(ws.headerFooter.oddFooter).toContain("Page &P of &N");
  });

  it("sizes the columns from their weight (names wide, ids and days narrow)", () => {
    const widths = Object.fromEntries(STAFF_COLUMNS.map((c, i) => [c.key, ws.getColumn(i + 1).width]));
    expect(widths.name).toBeGreaterThan(widths.designation!);
    expect(widths.designation).toBeGreaterThan(widths.net!);
    expect(widths.net).toBeGreaterThan(widths.present!);
    expect(widths.sno).toBeLessThan(widths.code!);
    expect(STAFF_COLUMNS.every((c, i) => ws.getColumn(i + 1).width === excelColumnWidth(c))).toBe(true);
  });
});

describe("the workbook: other statements", () => {
  it("a filtered statement exports the rows on screen with their recomputed totals", () => {
    const wb = buildStatementWorkbook(filterStatement(staffStatement(), { search: "kannan" }));
    const ws = sheet(wb);
    expect(at(ws, "A6").value).toBe("ACCOUNTS  (1 employee)");
    expect(at(ws, `${COL.name}7`).value).toBe("LOKESH KANNAN");
    expect(at(ws, `${COL.sno}7`).value).toBe(2); // serial numbers stay the server's
    expect(at(ws, `${COL.net}8`).value).toBe(14005); // ACCOUNTS subtotal
    expect(at(ws, `${COL.name}10`).value).toBe("KUNHIK KANNAN PV");
    expect(at(ws, `${COL.net}11`).value).toBe(118000); // ADMIN subtotal
    expect(at(ws, "A12").value).toBe("GRAND TOTAL");
    expect(at(ws, `${COL.net}12`).value).toBe(132005);
  });

  it("an empty statement is just the header and a zero grand total", () => {
    const ws = sheet(buildStatementWorkbook(filterStatement(staffStatement(), { search: "zzz" })));
    expect(at(ws, "A6").value).toBe("GRAND TOTAL");
    expect(at(ws, `${COL.net}6`).value).toBe(0);
    expect(ws.model.merges.some((m) => m.startsWith("A7:"))).toBe(false);
  });

  it("the production statement uses its own columns and Production Payroll's amber", () => {
    const wb = buildStatementWorkbook(productionStatement());
    const ws = sheet(wb);
    expect(ws.model.merges).toEqual(expect.arrayContaining(["A1:R1", "A2:R2", "A3:R3"]));
    expect(at(ws, "A2").value).toBe("Weaving unit");
    expect(at(ws, "A3").value).toBe("Production Salary Statement From 02-02-2026 To 08-02-2026");
    expect(at(ws, "E5").value).toBe("Rate / shift");
    expect(at(ws, "I5").value).toBe("Shifts");
    expect(at(ws, "A6").value).toBe("Weaving  (3 employees)");
    expect(at(ws, "Q7").value).toBe(3700); // RAMESH K net
    expect(at(ws, "E7").value).toBe(650);
    expect(at(ws, "H7").numFmt).toBe("0"); // "Late" is a count
    // the grand total: Weaving 3 + band + subtotal, Spinning 2, Packing 1 -> after 6 rows, 3 bands, 3 subtotals
    expect(at(ws, "A18").value).toBe("GRAND TOTAL");
    expect(at(ws, "Q18").value).toBe(3700 + 3475 + 3640 + 3300 + 2550 + 3216);
    expect(at(ws, "Q18").fill).toEqual(solidFill("FF92400E"));
    expect(ws.properties.tabColor).toEqual({ argb: "FFD97706" });
    expect(PRODUCTION_COLUMNS).toHaveLength(18);
  });

  it("pins a company logo when one is given, and ignores anything that is not an image", () => {
    expect(sheet(buildStatementWorkbook(staffStatement(), { logoDataUrl: PNG_DATA_URL })).getImages()).toHaveLength(1);
    expect(
      sheet(buildStatementWorkbook(staffStatement(), { logoDataUrl: "https://example.com/a.png" })).getImages(),
    ).toHaveLength(0);
    expect(sheet(buildStatementWorkbook(staffStatement())).getImages()).toHaveLength(0);
  });

  it("number formats and column widths", () => {
    expect(NUMBER_FORMAT).toEqual({ money: "#,##0.00", days: "0.00", int: "0", text: null });
    const narrow = { ...STAFF_COLUMNS[4], weight: 0.1 };
    expect(excelColumnWidth(narrow)).toBeGreaterThanOrEqual("salary".length + 2); // the header's longest word
    expect(excelColumnWidth({ ...STAFF_COLUMNS[2], weight: 99 })).toBe(44);
    expect(excelColumnWidth({ ...STAFF_COLUMNS[2], weight: Number.NaN })).toBeGreaterThanOrEqual(11);
  });
});

describe("the file", () => {
  let created: Blob[];
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    created = [];
    clicked = [];
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: (b: Blob) => {
          created.push(b);
          return "blob:statement";
        },
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("is named Salary_Statement_<period>.xlsx", () => {
    expect(statementXlsxFilename(staffStatement())).toBe("Salary_Statement_September_2026.xlsx");
    expect(statementXlsxFilename(productionStatement())).toBe("Salary_Statement_Production_2_Feb_8_Feb_2026.xlsx");
  });

  it("downloads a real .xlsx that reads back with the same numbers, merges, freeze panes and page setup", async () => {
    await downloadStatementXlsx(staffStatement());
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("Salary_Statement_September_2026.xlsx");
    expect(created[0].type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(created[0]);
    });
    const back = new ExcelJS.Workbook();
    await back.xlsx.load(bytes);
    const ws = back.getWorksheet("Salary Statement")!;
    expect(ws.getCell("A3").value).toBe("Salary Statement From 01-09-2026 To 30-09-2026");
    expect(ws.getCell("W25").value).toBe(729499);
    expect(ws.getCell("E7").numFmt).toBe("#,##0.00");
    expect(ws.getCell("E5").value).toBe("Basic salary");
    expect(ws.getCell("U5").value).toBe("Lop& PSAmt\ninformation");
    expect(ws.model.merges).toEqual(expect.arrayContaining(["A1:X1", "A4:D4", "A6:X6", "A25:C25"]));
    expect(ws.views[0]).toMatchObject({ state: "frozen", xSplit: 3, ySplit: 5 });
    expect(ws.pageSetup).toMatchObject({
      orientation: "landscape",
      fitToWidth: 1,
      fitToHeight: 0,
      printTitlesRow: "1:5",
    });
    expect(ws.headerFooter.oddFooter).toContain("Page &P of &N");
  });
});
