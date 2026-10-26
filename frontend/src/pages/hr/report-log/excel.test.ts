import { describe, expect, it } from "vitest";
import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";
import { buildSheetWorkbook, sheetFileName } from "./excel";
import { lateSpec, leaveSpec } from "./sheets";

let id = 1;
const row = (over: Partial<ReportLogDailyRow>): ReportLogDailyRow => ({
  employeeId: id++,
  employeeCode: "1",
  employeeName: "Someone",
  department: "QAD",
  designation: "QC",
  firstPunch: "09:06",
  branchId: 1,
  branchName: "Head Office",
  unitLabel: "HO",
  status: "absent",
  isLate: true,
  lateAfternoon: false,
  permissionAfternoon: false,
  isCompensationDay: false,
  isInformed: null,
  ...over,
});

const ctx = { company: "UK Textiles", branchLabel: "All Branches", logoDataUrl: null };

describe("the Excel file of a paper-style list", () => {
  it("draws the late list like the paper sheet: unit label in the gutter, a blank row between blocks, yellow late cells", () => {
    const spec = lateSpec("2026-10-16", [
      row({ employeeCode: "2896", employeeName: "LOKESH KANNAN", firstPunch: "09:06" }),
      row({ employeeCode: "2981", employeeName: "PANDIYAMMAL", firstPunch: "09:07" }),
      row({
        employeeCode: "2",
        employeeName: "BABU",
        firstPunch: "08:53",
        branchId: 2,
        branchName: "Unit One",
        unitLabel: "U-1",
      }),
    ]);
    const ws = buildSheetWorkbook(spec, ctx).getWorksheet("Report")!;
    expect(ws.getCell("A1").value).toBe("UK Textiles");
    expect(ws.getCell("A3").value).toBe("16.10.26 STAFF LATE REPORT");
    // header row 5: gutter column A stays empty, the columns start in B
    expect(["B", "C", "D", "E", "F"].map((c) => ws.getCell(`${c}5`).value)).toEqual([
      "S.No",
      "Ticket No",
      "Employee Name",
      "Designation",
      "Late Hours",
    ]);
    expect((ws.getCell("F5").font as { color?: { argb?: string } }).color?.argb).toBe("FFFF0000");
    // HO block: label on its first row only
    expect(ws.getCell("A6").value).toBe("HO");
    expect(ws.getCell("A7").value).toBeNull();
    expect(ws.getCell("C6").value).toBe("2896");
    expect(ws.getCell("F6").value).toBe("09:06 AM");
    expect((ws.getCell("F6").fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe("FFFFFF00");
    expect(ws.getCell("B7").value).toBe(2);
    // a blank row, then the next block restarts its numbers
    expect(ws.getCell("C8").value).toBeNull();
    expect(ws.getCell("A9").value).toBe("U-1");
    expect(ws.getCell("B9").value).toBe(1);
    expect(ws.getCell("F9").value).toBe("08:53 AM");
    expect(String(ws.getCell("A11").value)).toContain("Total 3 (HO 2 · U-1 1)");
  });

  it("draws the leave list with the Remarks colours", () => {
    const spec = leaveSpec("2026-10-03", [
      row({ employeeCode: "2503", isInformed: true }),
      row({ employeeCode: "2998", isInformed: false }),
      row({ employeeCode: "3000", isInformed: null }),
    ]);
    const ws = buildSheetWorkbook(spec, ctx).getWorksheet("Report")!;
    expect(ws.getCell("A3").value).toBe("03.10.2026 STAFF LEAVE LIST");
    expect(ws.getCell("G5").value).toBe("Remarks");
    const fill = (a: string) => (ws.getCell(a).fill as { fgColor?: { argb?: string } }).fgColor?.argb;
    expect([ws.getCell("G6").value, fill("G6")]).toEqual(["Informed", "FF9BBB59"]);
    expect([ws.getCell("G7").value, fill("G7")]).toEqual(["Not informed", "FFF79646"]);
    expect([ws.getCell("G8").value, fill("G8")]).toEqual(["Unset", "FFDDDDDD"]);
    expect(ws.getCell("E6").value).toBe("QAD");
  });

  it("names the file after the title", () => {
    expect(sheetFileName(lateSpec("2026-10-16", []))).toBe("16_10_26_STAFF_LATE_REPORT.xlsx");
  });
});
