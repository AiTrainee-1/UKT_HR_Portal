import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addMergedTextRow,
  addTitleBlock,
  allBorders,
  downloadBlob,
  downloadWorkbook,
  fileSafe,
  newWorkbook,
  solidFill,
  styleHeaderCell,
  todayStamp,
} from "./exportUtils";

// 1x1 transparent PNG
const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("filename helpers", () => {
  it("fileSafe collapses runs of unsafe characters to a single underscore", () => {
    expect(fileSafe("Monthly Attendance Sheet - Sep 2026")).toBe("Monthly_Attendance_Sheet_Sep_2026");
    expect(fileSafe("23.09.2026 STAFF LEAVE LIST")).toBe("23_09_2026_STAFF_LEAVE_LIST");
  });

  it("todayStamp is an ISO date", () => {
    expect(todayStamp()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("cell styling", () => {
  it("styleHeaderCell applies fill, bold font, centred wrapped alignment and border", () => {
    const ws = newWorkbook().addWorksheet("t");
    const cell = ws.getCell("A1");
    styleHeaderCell(cell, { fill: "FF1B4B6E", size: 11, border: allBorders("thin") });

    expect(cell.fill).toEqual(solidFill("FF1B4B6E"));
    expect(cell.font).toMatchObject({ bold: true, size: 11, color: { argb: "FFFFFFFF" } });
    expect(cell.alignment).toMatchObject({ horizontal: "center", vertical: "middle", wrapText: true });
    expect(cell.border?.top?.style).toBe("thin");
  });

  it("styleHeaderCell can turn wrapping off and change the font colour", () => {
    const cell = newWorkbook().addWorksheet("t").getCell("A1");
    styleHeaderCell(cell, { fill: "FFF1F5F9", color: "FF000000", wrapText: false });
    expect(cell.alignment?.wrapText).toBe(false);
    expect(cell.font?.color?.argb).toBe("FF000000");
  });

  it("newWorkbook stamps the creator", () => {
    expect(newWorkbook().creator).toBe("UKTextiles HRMS");
  });
});

describe("title block", () => {
  it("addMergedTextRow merges across the requested columns and sets the row height", () => {
    const ws = newWorkbook().addWorksheet("t");
    addMergedTextRow(ws, 2, 6, "Hello", { size: 10, bold: false, color: "FF555555", height: 18 });

    expect(ws.getCell("A2").value).toBe("Hello");
    expect(ws.model.merges).toContain("A2:F2");
    expect(ws.getRow(2).height).toBe(18);
    expect(ws.getCell("A2").font).toMatchObject({ bold: false, size: 10, color: { argb: "FF555555" } });
  });

  it("addTitleBlock writes company, branch and title into rows 1-3 and returns 3", () => {
    const wb = newWorkbook();
    const ws = wb.addWorksheet("t");
    const last = addTitleBlock(wb, ws, {
      totalCols: 8,
      company: "UKTextiles",
      branchLabel: "Head Office Branch",
      title: "Sheet - Sep 2026",
    });

    expect(last).toBe(3);
    expect(ws.getCell("A1").value).toBe("UKTextiles");
    expect(ws.getCell("A2").value).toBe("Head Office Branch");
    expect(ws.getCell("A3").value).toBe("Sheet - Sep 2026");
    expect(ws.getCell("A3").fill).toEqual(solidFill("FFE8A9A3"));
    expect(ws.model.merges).toEqual(expect.arrayContaining(["A1:H1", "A2:H2", "A3:H3"]));
  });

  it("embeds a valid data-URL logo and silently ignores anything else", () => {
    const wb1 = newWorkbook();
    const ws1 = wb1.addWorksheet("t");
    addTitleBlock(wb1, ws1, { totalCols: 4, company: "c", branchLabel: "b", title: "t", logoDataUrl: PNG_DATA_URL });
    expect(ws1.getImages()).toHaveLength(1);

    for (const bad of [null, undefined, "", "https://example.com/logo.png", "data:image/gif;base64,AAAA"]) {
      const wb = newWorkbook();
      const ws = wb.addWorksheet("t");
      addTitleBlock(wb, ws, { totalCols: 4, company: "c", branchLabel: "b", title: "t", logoDataUrl: bad });
      expect(ws.getImages()).toHaveLength(0);
    }
  });
});

describe("downloads", () => {
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
          return "blob:test";
        },
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      // The anchor must be attached to the DOM when clicked (Firefox ignores detached clicks).
      expect(document.body.contains(this)).toBe(true);
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("downloadBlob names the file, clicks once, and cleans up the anchor", () => {
    downloadBlob(new Blob(["x"]), "report.xlsx");

    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("report.xlsx");
    expect(clicked[0].href).toBe("blob:test");
    expect(document.body.querySelector("a")).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });

  it("downloadWorkbook produces a real .xlsx that reads back with the same cells", async () => {
    const wb = newWorkbook();
    const ws = wb.addWorksheet("Report");
    ws.getCell("A1").value = "Code";
    ws.getCell("B2").value = 42;

    await downloadWorkbook(wb, "out.xlsx");

    expect(clicked[0].download).toBe("out.xlsx");
    const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(created[0]);
    });
    const reread = new ExcelJS.Workbook();
    await reread.xlsx.load(bytes);
    const rws = reread.getWorksheet("Report")!;
    expect(rws.getCell("A1").value).toBe("Code");
    expect(rws.getCell("B2").value).toBe(42);
    expect(created[0].type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
