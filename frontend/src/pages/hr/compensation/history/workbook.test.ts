import type ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyReport, reportOf } from "../fixtures";
import { TYPE_META } from "./history-logic";

// The History & Reports workbook, built for real (exceljs runs in Node) with only the download captured: a Summary sheet and
// a sheet for every type, with the real columns, real dates and numbers, and the redeemed balance under the claims.

const h = vi.hoisted(() => ({ download: vi.fn() }));

vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadWorkbook: h.download,
}));

import { buildReportWorkbook, exportReportWorkbook, sheetColumns } from "./workbook";

const qs = (query = "") => new URLSearchParams(query);
const COMPANY = "UK Textiles Ltd";

/** The values of a sheet's rows from `from` on, as plain arrays (cell 1 first). */
const rows = (ws: ExcelJS.Worksheet, from: number, width = ws.columnCount) => {
  const out: unknown[][] = [];
  for (let r = from; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    out.push(Array.from({ length: width }, (_, c) => row.getCell(c + 1).value));
  }
  return out;
};

/** The row number of the header (the row that says "Code" in its first cell). */
const headerOf = (ws: ExcelJS.Worksheet, label = "Code") => {
  for (let r = 1; r <= ws.rowCount; r += 1) if (ws.getCell(r, 1).value === label) return r;
  throw new Error(`no header row says "${label}"`);
};

beforeEach(() => h.download.mockReset());

describe("the report workbook", () => {
  it("is a Summary sheet and one sheet per type, in the order of the report", () => {
    const wb = buildReportWorkbook(reportOf(qs("period=week")), COMPANY);
    expect(wb.worksheets.map((s) => s.name)).toEqual([
      "Summary",
      "OT allowance",
      "OT relaxation",
      "OT payment",
      "Late-in window",
      "Early-out window",
      "Holiday work",
      "Birthday",
    ]);
  });

  it("has only the sheets of the types asked for", () => {
    const wb = buildReportWorkbook(reportOf(qs("period=today&type=birthday,ot_allowance")), COMPANY);
    expect(wb.worksheets.map((s) => s.name)).toEqual(["Summary", "OT allowance", "Birthday"]);
  });

  it("opens every sheet with the company, the period and what the sheet is", () => {
    const wb = buildReportWorkbook(reportOf(qs("period=week")), COMPANY);
    for (const ws of wb.worksheets) {
      expect(ws.getCell(1, 1).value).toBe(COMPANY);
      expect(ws.getCell(2, 1).value).toBe("Compensation · 12 Oct - 18 Oct 2026");
    }
    expect(wb.getWorksheet("Birthday")!.getCell(3, 1).value).toBe(TYPE_META.birthday.label);
  });

  describe("the Summary sheet", () => {
    it("says the period, the filters and the totals", () => {
      const wb = buildReportWorkbook(reportOf(qs("period=week")), COMPANY, { department: "Cutting", branch: null });
      const ws = wb.getWorksheet("Summary")!;
      const facts = new Map(
        rows(ws, 4, 2)
          .filter((r) => typeof r[0] === "string" && r[1] !== null)
          .map((r) => [r[0] as string, r[1]]),
      );
      expect(facts.get("Period")).toBe("Week");
      expect(facts.get("From")).toBe("Mon, 12 Oct 2026");
      expect(facts.get("To")).toBe("Sun, 18 Oct 2026");
      expect(facts.get("Department")).toBe("Cutting");
      expect(facts.get("Branch")).toBe("All branches");
      expect(facts.get("Records")).toBe("7");
      expect(facts.get("Employees who benefited")).toBe("6");
    });

    it("has a row per type: who benefits, how many employees and records, and its totals", () => {
      const wb = buildReportWorkbook(reportOf(qs("period=today")), COMPANY);
      const ws = wb.getWorksheet("Summary")!;
      const header = headerOf(ws, "Type");
      const table = rows(ws, header + 1, 5);
      expect(table).toHaveLength(7);
      const [allowance] = table;
      expect(allowance[0]).toBe("OT: next-day late-in allowance");
      expect(allowance[1]).toBe(TYPE_META.ot_allowance.who);
      expect(allowance[2]).toBe(2);
      expect(allowance[3]).toBe(2);
      expect(String(allowance[4])).toContain("Used it: 1 (18 min used)");
      expect(table.at(-1)![0]).toBe("Birthday leave");
    });

    it("says which types are switched off in Settings", () => {
      const wb = buildReportWorkbook(reportOf(qs("period=today"), ["ot_shift_pay"]), COMPANY);
      const ws = wb.getWorksheet("Summary")!;
      const names = rows(ws, headerOf(ws, "Type") + 1, 1).map((r) => String(r[0]));
      expect(names).toContain("OT: shift compensation as pay (switched off in Settings)");
      expect(names).toContain("OT: shift compensation as relaxation");
    });
  });

  describe("a type's sheet", () => {
    it("has who, then the type's own columns, with a frozen header", () => {
      const report = reportOf(qs("period=today"));
      const wb = buildReportWorkbook(report, COMPANY);
      const ws = wb.getWorksheet("OT allowance")!;
      const header = headerOf(ws);
      const labels = rows(ws, header, ws.columnCount)[0];
      expect(labels).toEqual(sheetColumns("ot_allowance").map((c) => c.label));
      expect(labels.slice(0, 5)).toEqual(["Code", "Name", "Department", "Designation", "Branch"]);
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: header });
    });

    it("writes dates as real dates and numbers as numbers", () => {
      const wb = buildReportWorkbook(reportOf(qs("period=today")), COMPANY);
      const ws = wb.getWorksheet("OT payment")!;
      const header = headerOf(ws);
      const labels = rows(ws, header, ws.columnCount)[0] as string[];
      const [first] = rows(ws, header + 1, ws.columnCount);
      const cell = (label: string) => first[labels.indexOf(label)];
      expect(cell("Code")).toBe("E13");
      expect(cell("OT date")).toEqual(new Date(Date.UTC(2026, 9, 5)));
      expect(cell("Granted date")).toEqual(new Date(Date.UTC(2026, 9, 14)));
      expect(cell("Shifts")).toBe(0.5);
      expect(cell("Amount (₹)")).toBe(450);
      expect(cell("Amount is an estimate")).toBe("Estimate");
      expect(ws.getCell(header + 1, labels.indexOf("Amount (₹)") + 1).numFmt).toBe("#,##0.00");
    });

    it("says nobody benefited on a type with no rows", () => {
      const wb = buildReportWorkbook(reportOf(qs("period=today")), COMPANY);
      const ws = wb.getWorksheet("Early-out window")!;
      expect(ws.getCell(headerOf(ws) + 1, 1).value).toBe("Nobody in this period.");
    });

    it("lists the balance redeemed under the claims, with its own header", () => {
      const wb = buildReportWorkbook(reportOf(qs("period=today")), COMPANY);
      const ws = wb.getWorksheet("Holiday work")!;
      const header = headerOf(ws);
      expect(rows(ws, header + 1, 1)[0][0]).toBe("E24");
      let heading = 0;
      for (let r = header + 1; r <= ws.rowCount; r += 1) {
        if (ws.getCell(r, 1).value === "Balance redeemed as days off in this period") heading = r;
      }
      expect(heading).toBeGreaterThan(header + 1);
      const redemptionHeader = rows(ws, heading + 1, 10)[0];
      expect(redemptionHeader.slice(0, 7)).toEqual([
        "Code",
        "Name",
        "Department",
        "Designation",
        "Branch",
        "Redeemed on",
        "Shifts",
      ]);
      const [redeemed] = rows(ws, heading + 2, 10);
      expect(redeemed[0]).toBe("E21");
      expect(redeemed[5]).toEqual(new Date(Date.UTC(2026, 9, 12)));
      expect(redeemed[6]).toBe(0.5);
    });

    it("does not add the redeemed block when nothing was redeemed", () => {
      const wb = buildReportWorkbook(emptyReport(qs("period=today")), COMPANY);
      const ws = wb.getWorksheet("Holiday work")!;
      for (let r = 1; r <= ws.rowCount; r += 1) {
        expect(ws.getCell(r, 1).value).not.toBe("Balance redeemed as days off in this period");
      }
    });
  });

  it("is downloaded under a name that carries the period", async () => {
    await exportReportWorkbook(reportOf(qs("period=week")), COMPANY, {});
    expect(h.download).toHaveBeenCalledTimes(1);
    const [wb, filename] = h.download.mock.calls[0] as [ExcelJS.Workbook, string];
    expect(filename).toBe("Compensation_Report_2026-10-12_to_2026-10-18.xlsx");
    expect(wb.worksheets.length).toBe(8);
  });
});
