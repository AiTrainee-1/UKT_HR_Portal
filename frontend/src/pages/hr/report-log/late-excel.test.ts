import type { Worksheet } from "exceljs";
import { describe, expect, it } from "vitest";
import { HEADER_ROW, buildLateWorkbook, lateExcelName } from "./late-excel";
import type { LateEntry } from "./late";

const entry = (id: number, name: string, over: Partial<LateEntry> = {}): LateEntry => ({
  employeeId: id,
  name,
  code: `E${id}`,
  department: "Admin",
  unit: "HO",
  shiftStart: "09:00",
  grace: 15,
  lateDeadline: "09:15",
  punchIn: "09:40",
  minutesLate: 25,
  minutesAfterStart: 40,
  ...over,
});

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

describe("the Daily Late Report Excel file", () => {
  const entries = [
    entry(1, "Babu", { minutesLate: 40, minutesAfterStart: 55, punchIn: "09:55" }),
    entry(2, "Chitra", { minutesLate: 12, punchIn: "09:27", minutesAfterStart: 27 }),
    entry(3, "Anand", { minutesLate: 5, punchIn: "09:20", minutesAfterStart: 20 }),
  ];
  const wb = buildLateWorkbook(input(entries));
  const ws = wb.getWorksheet("Daily Late Report")!;

  it("opens with the company, the report title, the date and the moment it was made", () => {
    expect(ws.getCell("A1").value).toBe("UK Textiles");
    expect(ws.getCell("A2").value).toBe("All Branches");
    expect(ws.getCell("A3").value).toBe("Daily Late Report");
    expect(String(ws.getCell("A4").value)).toContain("Mon, 3 Aug 2026");
    expect(String(ws.getCell("A4").value)).toContain("Generated: 26 Oct 2026, 11:45 AM");
  });

  it("has no summary line, no explanation line and no totals row", () => {
    const text = allText(ws);
    expect(text).not.toContain("Total late");
    expect(text).not.toContain("Average");
    expect(text).not.toContain("Longest");
    expect(text).not.toContain("Total Minutes Late =");
    expect(text).not.toContain("Total:");
    expect(text).not.toContain("SUM(");
    // the table is the last thing in the file: the header and one row per employee, nothing after them
    expect(ws.rowCount).toBe(HEADER_ROW + entries.length);
  });

  it("has the seven columns with the exact headers, a frozen header and filters", () => {
    expect(HEADER_ROW).toBe(6);
    expect([1, 2, 3, 4, 5, 6, 7].map((c) => ws.getCell(HEADER_ROW, c).value)).toEqual([
      "Employee Name",
      "Employee Code",
      "Department",
      "Shift Start Time",
      "Grace Period (minutes)",
      "Actual Punch-In Time",
      "Total Minutes Late",
    ]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: HEADER_ROW });
    expect(ws.autoFilter).toMatchObject({
      from: { row: HEADER_ROW, column: 1 },
      to: { row: HEADER_ROW + 3, column: 7 },
    });
  });

  it("writes real times and real numbers, in the order given", () => {
    const first = HEADER_ROW + 1;
    expect(ws.getCell(first, 1).value).toBe("Babu");
    expect(ws.getCell(first + 2, 1).value).toBe("Anand");
    expect(ws.getCell(first, 4).value).toBeCloseTo(9 / 24, 8); // 09:00 as an Excel time
    expect(ws.getCell(first, 4).numFmt).toBe("hh:mm AM/PM");
    expect(ws.getCell(first, 5).value).toBe(15);
    expect(ws.getCell(first, 6).value).toBeCloseTo((9 * 60 + 55) / 1440, 8);
    expect(ws.getCell(first, 7).value).toBe(40);
    expect(ws.getCell(first, 7).numFmt).toBe('0" min"');
  });

  it("tints the minutes by severity", () => {
    const fill = (row: number) => (ws.getCell(row, 7).fill as { fgColor?: { argb?: string } }).fgColor?.argb;
    expect(fill(HEADER_ROW + 1)).toBe("FFFECACA"); // 40 min
    expect(fill(HEADER_ROW + 2)).toBe("FFFED7AA"); // 12 min
    expect(fill(HEADER_ROW + 3)).toBe("FFFEF3C7"); // 5 min
  });

  it("says what narrows the list in one small line above the table, and only when something does", () => {
    expect(ws.getCell("A5").value).toBeNull(); // nothing narrows this list
    const narrowed = buildLateWorkbook(input(entries, "Department: Admin; Selected: 3 of 18")).getWorksheet(
      "Daily Late Report",
    )!;
    expect(narrowed.getCell("A5").value).toBe("Department: Admin; Selected: 3 of 18");
    expect(narrowed.getCell(HEADER_ROW, 1).value).toBe("Employee Name");
  });

  it("shows a dash where a value is missing and builds for nobody late", () => {
    const sparse = buildLateWorkbook(
      input([entry(4, "No Shift", { shiftStart: null, grace: null, minutesLate: null })]),
    );
    const w = sparse.getWorksheet("Daily Late Report")!;
    const row = HEADER_ROW + 1;
    expect([w.getCell(row, 4).value, w.getCell(row, 5).value, w.getCell(row, 7).value]).toEqual(["—", "—", "—"]);
    const empty = buildLateWorkbook(input([])).getWorksheet("Daily Late Report")!;
    expect(empty.rowCount).toBe(HEADER_ROW);
    expect(empty.autoFilter).toBeFalsy();
  });

  it("is named after the report and its date", () => {
    expect(lateExcelName("2026-08-03")).toBe("Daily_Late_Report_2026-08-03.xlsx");
  });
});
