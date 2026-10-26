import { describe, expect, it } from "vitest";
import type { ReportLogDailyRow } from "@/lib/api-client/custom-hooks";
import { buildSheetWorkbook, sheetFileName } from "./excel";
import { leaveSpec } from "./sheets";

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

describe("the Excel file of the paper STAFF LEAVE LIST", () => {
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

  it("puts the unit label in the gutter of its block and leaves a blank row between blocks", () => {
    const spec = leaveSpec("2026-10-03", [
      row({ employeeCode: "1", employeeName: "A" }),
      row({ employeeCode: "2", employeeName: "B" }),
      row({ employeeCode: "3", employeeName: "C", branchId: 2, branchName: "Unit One", unitLabel: "U-1" }),
    ]);
    const ws = buildSheetWorkbook(spec, ctx).getWorksheet("Report")!;
    expect([ws.getCell("A6").value, ws.getCell("A7").value]).toEqual(["HO", null]);
    expect(ws.getCell("C8").value).toBeNull();
    expect([ws.getCell("A9").value, ws.getCell("B9").value]).toEqual(["U-1", 1]);
    expect(String(ws.getCell("A11").value)).toContain("Total 3 (HO 2 · U-1 1)");
  });

  it("names the file after the title", () => {
    expect(sheetFileName(leaveSpec("2026-10-03", []))).toBe("03_10_2026_STAFF_LEAVE_LIST.xlsx");
  });
});
