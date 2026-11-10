import { describe, expect, it, vi } from "vitest";
import type ExcelJS from "exceljs";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";

const saved: { wb?: ExcelJS.Workbook; name?: string } = {};
vi.mock("@/lib/exportUtils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/exportUtils")>("@/lib/exportUtils");
  return {
    ...actual,
    downloadWorkbook: async (wb: ExcelJS.Workbook, name: string) => {
      saved.wb = wb;
      saved.name = name;
    },
  };
});

const { exportPayrollToExcel } = await import("./payrollExcelExport");

const run = (over: Partial<PayrollRunItem>): PayrollRunItem =>
  ({
    employeeCode: "0123",
    employeeName: "Abirami T",
    bankAccount: "38083488840",
    bankIfsc: "sbin0007921",
    bankName: "State Bank of India",
    finalSalary: 13481.48,
    ...over,
  }) as PayrollRunItem;

describe("bank file (Export bank file)", () => {
  it("has an Employee Code column right after Beneficiary Code (owner 2026-11-06)", async () => {
    await exportPayrollToExcel(
      [run({}), run({ employeeCode: "2671", employeeName: "Karan" })],
      "Staff",
      "October 2026",
    );
    const ws = saved.wb!.worksheets[0];
    const header = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v).split("\n")[0]);
    expect(header).toEqual([
      "TXN TYPE",
      "BENEFICIARY CODE",
      "EMPLOYEE CODE",
      "BENE A/C NO",
      "AMOUNT",
      "BENEFICIARY NAME",
      "IFSC CODE",
      "BENE BANK NAME",
      "BENE BANK BRANCH NAME",
      "BENE EMAIL ID",
    ]);
    const first = (ws.getRow(3).values as unknown[]).slice(1);
    expect(first.slice(0, 8)).toEqual([
      "",
      "",
      "0123",
      "38083488840",
      // a stored NET of 13,481.48 is paid as the Salary Statement prints it: up to the next whole rupee (owner 2026-11-10)
      13482,
      "ABIRAMI T",
      "SBIN0007921",
      "STATE BANK OF INDIA",
    ]);
    expect(ws.getRow(4).getCell(3).value).toBe("2671");
    // the amount keeps its money format and the red header, in its new place
    expect(ws.getColumn(5).numFmt).toBe("#,##0.00");
    expect(ws.getRow(1).getCell(5).font?.color?.argb).toBe("FFFF0000");
    expect(ws.getRow(1).getCell(3).font?.color?.argb).toBe("FFFFFFFF");
    expect(saved.name).toBe("Payroll_Staff_October_2026.xlsx");
  });
});
