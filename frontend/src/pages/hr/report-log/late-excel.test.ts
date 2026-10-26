import type { Worksheet } from "exceljs";
import { describe, expect, it } from "vitest";
import { EXCEL_UNIT_COLUMN, HEADER_ROW, buildLateWorkbook, lateExcelName } from "./late-excel";
import type { LateEntry } from "./late";

const entry = (id: number, name: string, over: Partial<LateEntry> = {}): LateEntry => ({
  employeeId: id,
  name,
  code: `E${id}`,
  department: "Admin",
  unit: "HO",
  unitKey: "1",
  branchName: "Head Office",
  shiftStart: "09:00",
  grace: 15,
  lateDeadline: "09:15",
  punchIn: "09:40",
  minutesLate: 25,
  minutesAfterStart: 40,
  ...over,
});
const u1 = (id: number, name: string, over: Partial<LateEntry> = {}) =>
  entry(id, name, { unit: "U-1", unitKey: "2", branchName: "Unit One", ...over });
const other = (id: number, name: string, over: Partial<LateEntry> = {}) =>
  entry(id, name, { unit: "Other", unitKey: "none", branchName: null, ...over });

const NOW = new Date(2026, 9, 26, 11, 45);
const input = (entries: LateEntry[], filter = "") => ({
  date: "2026-08-03",
  entries,
  company: "UK Textiles",
  branchLabel: "All Branches",
  logoDataUrl: null,
  filter,
  now: NOW,
});

/** Every non-empty cell of a sheet as text, so a test can say what is NOT in the file. */
function allText(ws: Worksheet): string {
  const out: string[] = [];
  ws.eachRow((row) =>
    row.eachCell((cell) => out.push(typeof cell.value === "object" ? JSON.stringify(cell.value) : String(cell.value))),
  );
  return out.join(" | ");
}

const first = HEADER_ROW + 1;

describe("the Daily Late Report Excel file, unit by unit", () => {
  // given in a jumble: the file puts the units in order and each unit's longest delay first
  const entries = [
    u1(1, "Kumar", { minutesLate: 5, punchIn: "09:20" }),
    entry(2, "Anand", { minutesLate: 12, punchIn: "09:27" }),
    other(3, "Loose", { minutesLate: 99, punchIn: "10:54" }),
    entry(4, "Babu", { minutesLate: 40, punchIn: "09:55" }),
    u1(5, "Mani", { minutesLate: 31, punchIn: "09:46" }),
  ];
  const wb = buildLateWorkbook(input(entries));
  const ws = wb.getWorksheet("Daily Late Report")!;
  // HO band, Babu, Anand | U-1 band, Mani, Kumar | Other band, Loose
  const rows = {
    hoBand: first,
    babu: first + 1,
    anand: first + 2,
    u1Band: first + 3,
    mani: first + 4,
    kumar: first + 5,
    otherBand: first + 6,
    loose: first + 7,
  };

  it("opens with the company, the report title, the date and the moment it was made", () => {
    expect(ws.getCell("A1").value).toBe("UK Textiles");
    expect(ws.getCell("A2").value).toBe("All Branches");
    expect(ws.getCell("A3").value).toBe("Daily Late Report");
    expect(String(ws.getCell("A4").value)).toContain("Mon, 3 Aug 2026");
    expect(String(ws.getCell("A4").value)).toContain("Generated: 26 Oct 2026, 11:45 AM");
  });

  it("puts a band before each unit with its label and how many were late: HO first, Other last", () => {
    expect(ws.getCell(rows.hoBand, 1).value).toBe("HO   2 late");
    expect(ws.getCell(rows.u1Band, 1).value).toBe("U-1   2 late");
    expect(ws.getCell(rows.otherBand, 1).value).toBe("Other   1 late");
    // one merged cell across the whole table, in its own colour
    for (const r of [rows.hoBand, rows.u1Band, rows.otherBand]) {
      expect(ws.getCell(r, EXCEL_UNIT_COLUMN).isMerged).toBe(true);
      expect((ws.getCell(r, 1).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe("FFE0E7FF");
    }
  });

  it("orders the rows inside a unit by minutes late, longest first", () => {
    expect([rows.babu, rows.anand].map((r) => ws.getCell(r, 1).value)).toEqual(["Babu", "Anand"]);
    expect([rows.mani, rows.kumar].map((r) => ws.getCell(r, 1).value)).toEqual(["Mani", "Kumar"]);
    expect(ws.getCell(rows.loose, 1).value).toBe("Loose");
  });

  it("has the seven columns and a narrow Unit column, a frozen header, and filters over every row", () => {
    expect(HEADER_ROW).toBe(6);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((c) => ws.getCell(HEADER_ROW, c).value)).toEqual([
      "Employee Name",
      "Employee Code",
      "Department",
      "Shift Start Time",
      "Grace Period (minutes)",
      "Actual Punch-In Time",
      "Total Minutes Late",
      "Unit",
    ]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: HEADER_ROW });
    expect(ws.autoFilter).toMatchObject({
      from: { row: HEADER_ROW, column: 1 },
      to: { row: rows.loose, column: 8 },
    });
    // the Unit column of a row says its unit, so a filter on it keeps a clean list (a band has no value there)
    expect([rows.babu, rows.mani, rows.loose].map((r) => ws.getCell(r, EXCEL_UNIT_COLUMN).value)).toEqual([
      "HO",
      "U-1",
      "Other",
    ]);
  });

  it("writes real times and real numbers, and tints the minutes by severity", () => {
    expect(ws.getCell(rows.babu, 4).value).toBeCloseTo(9 / 24, 8); // 09:00 as an Excel time
    expect(ws.getCell(rows.babu, 4).numFmt).toBe("hh:mm AM/PM");
    expect(ws.getCell(rows.babu, 5).value).toBe(15);
    expect(ws.getCell(rows.babu, 6).value).toBeCloseTo((9 * 60 + 55) / 1440, 8);
    expect(ws.getCell(rows.babu, 7).value).toBe(40);
    expect(ws.getCell(rows.babu, 7).numFmt).toBe('0" min"');
    const fill = (row: number) => (ws.getCell(row, 7).fill as { fgColor?: { argb?: string } }).fgColor?.argb;
    expect(fill(rows.babu)).toBe("FFFECACA"); // 40 min
    expect(fill(rows.anand)).toBe("FFFED7AA"); // 12 min
    expect(fill(rows.kumar)).toBe("FFFEF3C7"); // 5 min
  });

  it("has no summary line, no explanation line and no totals row", () => {
    const text = allText(ws);
    expect(text).not.toContain("Total late");
    expect(text).not.toContain("Average");
    expect(text).not.toContain("Longest");
    expect(text).not.toContain("Total Minutes Late =");
    expect(text).not.toContain("Total:");
    expect(text).not.toContain("SUM(");
    // the table is the last thing in the file
    expect(ws.rowCount).toBe(rows.loose);
  });
});

describe("what the Excel file holds when only some rows are exported", () => {
  it("has a band only for a unit that has a row, with the count of the rows exported", () => {
    const ticked = [u1(7, "Only U1 A", { minutesLate: 9 }), u1(8, "Only U1 B", { minutesLate: 30 })];
    const ws = buildLateWorkbook(input(ticked)).getWorksheet("Daily Late Report")!;
    expect(ws.getCell(first, 1).value).toBe("U-1   2 late");
    expect([first + 1, first + 2].map((r) => ws.getCell(r, 1).value)).toEqual(["Only U1 B", "Only U1 A"]);
    expect(ws.rowCount).toBe(first + 2);
    expect(allText(ws)).not.toContain("HO ");
  });

  it("says what narrows the list in one small line above the table, and only when something does", () => {
    const rows = [entry(1, "A")];
    expect(buildLateWorkbook(input(rows)).getWorksheet("Daily Late Report")!.getCell("A5").value).toBeNull();
    const narrowed = buildLateWorkbook(input(rows, "Department: Admin; Selected: 1 of 18")).getWorksheet(
      "Daily Late Report",
    )!;
    expect(narrowed.getCell("A5").value).toBe("Department: Admin; Selected: 1 of 18");
    expect(narrowed.getCell(HEADER_ROW, 1).value).toBe("Employee Name");
  });

  it("shows a dash where a value is missing and builds for nobody late", () => {
    const sparse = buildLateWorkbook(
      input([entry(4, "No Shift", { shiftStart: null, grace: null, minutesLate: null })]),
    );
    const w = sparse.getWorksheet("Daily Late Report")!;
    const row = first + 1; // under the HO band
    expect([w.getCell(row, 4).value, w.getCell(row, 5).value, w.getCell(row, 7).value]).toEqual(["—", "—", "—"]);
    const empty = buildLateWorkbook(input([])).getWorksheet("Daily Late Report")!;
    expect(empty.rowCount).toBe(HEADER_ROW);
    expect(empty.autoFilter).toBeFalsy();
  });

  it("is named after the report and its date", () => {
    expect(lateExcelName("2026-08-03")).toBe("Daily_Late_Report_2026-08-03.xlsx");
  });
});
