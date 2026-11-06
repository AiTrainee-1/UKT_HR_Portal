import type { jsPDF } from "jspdf";
import { describe, expect, it } from "vitest";
import type { MonthlyAttendanceRow } from "@/lib/api-client/custom-hooks";
import { DAY, NIGHT, ON_DUTY, PRESENT, STAFF_DAY } from "./fixtures";
import {
  DAY_HEADERS,
  DAY_PDF_COLUMNS,
  buildDayPdf,
  buildDayWorkbook,
  buildMonthPdf,
  buildMonthWorkbook,
  dayCells,
  dayFileStem,
  monthCells,
  monthFileStem,
  monthHeaders,
  monthPdfColumns,
  monthTotals,
  type DayExportInput,
  type MonthExportInput,
} from "./export";

const company = { company: "UK Textiles", branchLabel: "All Branches", logoDataUrl: null };

const dayInput = (over: Partial<DayExportInput> = {}): DayExportInput => ({
  ...company,
  date: DAY,
  view: "staff",
  rows: [...STAFF_DAY],
  scope: "",
  totalRows: STAFF_DAY.length,
  now: new Date(2026, 10, 6, 10, 30),
  ...over,
});

const month = (code: string, over: Partial<MonthlyAttendanceRow> = {}): MonthlyAttendanceRow => ({
  employeeId: Number(code),
  employeeCode: code,
  employeeName: `Person ${code}`,
  department: "Cutting",
  designation: null,
  employmentType: "staff",
  workingDays: 5,
  present: 3,
  halfDay: 1,
  absent: 1,
  onLeave: 0,
  cl: 0.5,
  onDuty: 1,
  late: 2,
  earlyOut: 0,
  holidays: 1,
  effectiveDays: 3.5,
  totalShifts: 3.5,
  ...over,
});

const monthInput = (over: Partial<MonthExportInput> = {}): MonthExportInput => ({
  ...company,
  year: 2026,
  month: 11,
  view: "staff",
  asOf: "2026-11-06",
  rows: [month("101"), month("102", { present: 5, halfDay: 0, absent: 0, cl: 1, onDuty: 0, late: 0 })],
  now: new Date(2026, 10, 6, 10, 30),
  ...over,
});

/** Every string the document draws, in drawing order. */
function drawn(doc: jsPDF): string[] {
  const out = doc.output();
  const found: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\)\s*Tj/g;
  for (let m = re.exec(out); m; m = re.exec(out)) found.push(m[1].replace(/\\([()\\])/g, "$1"));
  return found;
}

describe("the day export", () => {
  it("has one line per person with every punch and its source", () => {
    const cells = dayCells(PRESENT, 0, DAY);
    expect(cells).toHaveLength(DAY_HEADERS.length);
    expect(cells.slice(0, 10)).toEqual([
      1,
      "101",
      "Asha Kumar",
      "Cutting",
      "Operator",
      "Present",
      "",
      "08:31",
      "18:05",
      4,
    ]);
    expect(String(cells[10]).split("\n")).toEqual([
      "IN 08:31 (Biometric)",
      "OUT 13:00 (Geo Punch)",
      "IN 13:40 (HR Entry)",
      "OUT 18:05 (Missing Punch)",
    ]);
    const night = dayCells(NIGHT, 1, DAY);
    expect(night[8]).toBe("05:30 (+1)");
    expect(night[9]).toBe(2); // the counted punches only
    expect(String(night[10])).toContain("OUT 05:30 5 Nov (Biometric)");
    expect(String(night[10])).toContain("IN 05:30 (Biometric, previous night)");
    expect(night[11]).toBe("Late");
    expect(night[12]).toBe("1.50");
    const od = dayCells(ON_DUTY, 2, DAY);
    expect(od[5]).toBe("On Duty");
    expect(od[6]).toBe("On-Duty: On-Duty approved; punches await HR (Erode)");
  });

  it("builds the workbook: title, scope line, headers, a row per person", async () => {
    const wb = await buildDayWorkbook(
      dayInput({ scope: "Status: Present", rows: STAFF_DAY.slice(0, 2), totalRows: 7 }),
    );
    const ws = wb.worksheets[0];
    expect(ws.name).toBe(`Attendance ${DAY}`);
    expect(String(ws.getCell(3, 1).value)).toBe("Staff attendance - 4 Nov 2026");
    expect(String(ws.getCell(4, 1).value)).toContain("2 of 7 employees - Status: Present.");
    expect(ws.getRow(5).values).toEqual([undefined, ...DAY_HEADERS]);
    expect(ws.getCell(6, 3).value).toBe("Asha Kumar");
    expect(ws.getCell(7, 6).value).toBe("Present (by hand)");
    expect(dayFileStem("production", DAY)).toBe("Production_Attendance_2026_11_04");
  });

  it("builds an A4 landscape PDF that carries the punches", async () => {
    expect(DAY_PDF_COLUMNS.reduce((a, c) => a + c.mm, 0)).toBe(277);
    const doc = await buildDayPdf(dayInput());
    const text = drawn(doc).join(" | ");
    expect(text).toContain("Staff attendance - 4 Nov 2026");
    expect(text).toContain("Asha Kumar");
    expect(text).toMatch(/IN 08:31 \(Biometric\); OUT 13:00/);
    expect(text).toContain("Page 1 of 1");
    expect(doc.internal.pageSize.getWidth()).toBeCloseTo(297, 0);
  });

  it("cuts a long list into pages, each with its heads", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...PRESENT, employeeId: i, employeeCode: String(1000 + i) }));
    const doc = await buildDayPdf(dayInput({ rows: many, totalRows: 60 }));
    const pages = doc.getNumberOfPages();
    expect(pages).toBeGreaterThan(1);
    const text = drawn(doc);
    expect(text.filter((t) => t === "Every punch (time, source)")).toHaveLength(pages);
    expect(text).toContain(`Page ${pages} of ${pages}`);
  });
});

describe("the monthly report", () => {
  it("has a line per person and a totals line", () => {
    expect(monthHeaders("staff")).toContain("Effective days");
    expect(monthHeaders("production")).toContain("Shifts");
    expect(monthCells(month("101"), 0, "staff")).toEqual([
      1,
      "101",
      "Person 101",
      "Cutting",
      5,
      3,
      1,
      1,
      0,
      0.5,
      1,
      2,
      0,
      3.5,
    ]);
    const totals = monthTotals(monthInput().rows, "staff");
    expect(totals.slice(2)).toEqual(["Total (2)", "", 10, 8, 1, 1, 0, 1.5, 1, 2, 0, 7]);
    expect(monthPdfColumns("staff").reduce((a, c) => a + c.mm, 0)).toBe(277);
    expect(monthFileStem("staff", 2026, 3)).toBe("Staff_Monthly_Attendance_2026_03");
  });

  it("builds the workbook and the PDF", async () => {
    const wb = await buildMonthWorkbook(monthInput());
    const ws = wb.worksheets[0];
    expect(ws.name).toBe("Nov 2026");
    expect(String(ws.getCell(3, 1).value)).toBe("Staff monthly attendance - November 2026");
    expect(ws.getRow(5).values).toEqual([undefined, ...monthHeaders("staff")]);
    expect(ws.getCell(8, 3).value).toBe("Total (2)");
    expect(String(ws.getCell(10, 1).value)).toContain("attendance engine");
    const doc = await buildMonthPdf(monthInput({ view: "production" }));
    const text = drawn(doc).join(" | ");
    expect(text).toContain("Production monthly attendance - November 2026");
    expect(text).toContain("Total (2)");
    expect(text).toContain("Shifts");
  });
});
