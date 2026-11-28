import { describe, expect, it, vi } from "vitest";
import type ExcelJS from "exceljs";
import type { PayrollRunItem } from "@/lib/api-client/custom-hooks";
import golden from "./bankFile.golden.json";

// The bank file has one writer (bankFile.ts) shared by the Payroll pages and the Settlement page (2026-11-26). The
// payroll's file must stay EXACTLY as it was: the golden file holds every value, style, width and height the payroll bank
// file had before the writer was shared (taken from the code as it was), and the file must still match it.

const saved: { wb?: ExcelJS.Workbook; name?: string }[] = [];
vi.mock("@/lib/exportUtils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/exportUtils")>("@/lib/exportUtils");
  return {
    ...actual,
    downloadWorkbook: async (wb: ExcelJS.Workbook, name: string) => {
      saved.push({ wb, name });
    },
  };
});

const { exportPayrollToExcel } = await import("./payrollExcelExport");
const { buildBankFileWorkbook, downloadBankFile } = await import("./bankFile");

/** Everything a bank reads from the file, and everything that makes it look the way it does. */
export function dumpWorkbook(wb: ExcelJS.Workbook, name: string) {
  const ws = wb.worksheets[0];
  const rows: unknown[] = [];
  for (let r = 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const cells: unknown[] = [];
    for (let c = 1; c <= 10; c += 1) {
      const cell = row.getCell(c);
      cells.push({
        value: cell.value ?? null,
        numFmt: cell.numFmt ?? null,
        font: cell.font ?? null,
        fill: cell.fill ?? null,
        alignment: cell.alignment ?? null,
        border: cell.border ?? null,
      });
    }
    rows.push({ height: row.height ?? null, cells });
  }
  const columns = Array.from({ length: 10 }, (_, i) => {
    const col = ws.getColumn(i + 1);
    return { key: col.key ?? null, width: col.width ?? null, numFmt: col.numFmt ?? null };
  });
  return JSON.parse(
    JSON.stringify({ name, sheet: ws.name, sheets: wb.worksheets.length, creator: wb.creator, columns, rows }),
  );
}

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

const RUNS = [
  run({}),
  run({ employeeCode: "", employeeName: "karan s", bankAccount: "", bankIfsc: "", bankName: "", finalSalary: 20000 }),
  run({ employeeCode: "2671", employeeName: "Held One", onHold: true, finalSalary: 9000.01 }),
  run({ employeeCode: "3001", employeeName: "New Joiner", newJoinerParked: true, paymentStatus: "paid" }),
  run({ employeeCode: "3002", employeeName: "Missed", source: "missed_payroll", finalSalary: 500 }),
  run({ employeeCode: "3003", employeeName: "Parked", newJoinerParked: true, finalSalary: 7777.5 }),
];

describe("the payroll bank file is unchanged by the shared writer", () => {
  it("the month's file matches the golden file cell for cell", async () => {
    saved.length = 0;
    await exportPayrollToExcel(RUNS, "Staff", "October 2026");
    expect(dumpWorkbook(saved[0].wb!, saved[0].name!)).toEqual(golden.payroll);
  });

  it("the Skipped Employees' file matches the golden file cell for cell", async () => {
    saved.length = 0;
    await exportPayrollToExcel(RUNS, "Production Weekly", "1-7 Nov 2026", "skipped");
    expect(dumpWorkbook(saved[0].wb!, saved[0].name!)).toEqual(golden.skipped);
  });
});

describe("the shared bank file writer", () => {
  it("writes the lines it is given with the payroll's headers, M/O row, colours and widths", async () => {
    const wb = await buildBankFileWorkbook(
      [
        {
          employeeCode: "0123",
          employeeName: "Abirami T",
          bankAccount: "38083488840",
          bankIfsc: "sbin0007921",
          bankName: "State Bank of India",
          amount: 13481.48,
        },
      ],
      "Term Loan Nov 2026",
    );
    const dump = dumpWorkbook(wb, "x");
    // the same header block and columns as the payroll's file
    expect(dump.columns).toEqual(golden.payroll.columns);
    expect(dump.rows.slice(0, 2)).toEqual(golden.payroll.rows.slice(0, 2));
    expect(dump.sheet).toBe("Term Loan Nov 2026");
    // the amount in whole rupees (owner 2026-11-28: General format, no commas or decimals): a paisa rounds UP, as every
    // caller pays; the account number and the code are Text cells
    const first = (wb.worksheets[0].getRow(3).values as unknown[]).slice(1);
    expect(wb.worksheets[0].getRow(3).getCell(4).numFmt).toBe("@");
    expect(wb.worksheets[0].getRow(3).getCell(5).numFmt).toBe("General");
    expect(first).toEqual([
      "",
      "",
      "0123",
      "38083488840",
      13482,
      "ABIRAMI T",
      "SBIN0007921",
      "STATE BANK OF INDIA",
      "",
      "",
    ]);
  });

  it("downloads under the name it is given", async () => {
    saved.length = 0;
    await downloadBankFile([], "Overview All months", "Settlement_Bank_File_Overview_All_months.xlsx");
    expect(saved[0].name).toBe("Settlement_Bank_File_Overview_All_months.xlsx");
    expect(saved[0].wb!.worksheets[0].rowCount).toBe(2); // headers and the M/O row only
  });
});
