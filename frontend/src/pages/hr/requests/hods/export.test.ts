import type { jsPDF } from "jspdf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CATEGORIES, KUMAR, MEENA, RAVI } from "../fixtures";
import {
  BOARD_TITLE,
  DETAIL_COLUMNS,
  PDF,
  boardColumns,
  boardLines,
  buildHodPdf,
  buildHodWorkbook,
  canShareFile,
  copyText,
  detailLines,
  hodFileName,
  pageCapacity,
  planPages,
  shareOrDownload,
  type HodReportInput,
  type PdfLine,
} from "./export";

const dl = vi.hoisted(() => ({ downloadBlob: vi.fn() }));
vi.mock("@/lib/exportUtils", async (original) => ({
  ...(await original<typeof import("@/lib/exportUtils")>()),
  downloadBlob: dl.downloadBlob,
}));

afterEach(() => vi.clearAllMocks());

const input = (over: Partial<HodReportInput> = {}): HodReportInput => ({
  rows: [KUMAR, MEENA, RAVI],
  categories: CATEGORIES,
  company: "UK Textiles",
  branchLabel: "All Branches",
  logoDataUrl: null,
  scope: "",
  now: new Date(2026, 10, 4, 10, 30),
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

const row = (group: number | null, n: number): PdfLine => ({ kind: "row", group, zebra: false, cells: [String(n)] });
const band = (group: number): PdfLine => ({ kind: "band", group, text: `Head ${group}` });

describe("the PDF pages", () => {
  it("keep a band with its first row, and open a continued head with its (contd.) band", () => {
    const lines = [band(0), row(0, 1), row(0, 2), row(0, 3), band(1), row(1, 4)];
    const pages = planPages(lines, 4, 4);
    expect(pages.map((p) => p.map((l) => (l.kind === "band" ? `B${l.group}${l.contd ? "+" : ""}` : "r")))).toEqual([
      ["B0", "r", "r", "r"],
      ["B1", "r"],
    ]);
    const tight = planPages([band(0), row(0, 1), row(0, 2), row(0, 3), row(0, 4)], 3, 3);
    expect(tight[1][0]).toMatchObject({ kind: "band", group: 0, contd: true });
    // a band that would be the last line of a page moves on
    const late = planPages([row(null, 1), row(null, 2), band(0), row(0, 3)], 3, 3);
    expect(late.map((p) => p.length)).toEqual([2, 2]);
    expect(planPages([], 3, 3)).toEqual([[]]);
  });

  it("fit the board's columns to the A4 width whatever the number of categories", () => {
    const width = PDF.width - 2 * PDF.margin;
    for (const n of [1, 5, 9]) {
      const sum = boardColumns(CATEGORIES.slice(0, n)).reduce((a, c) => a + c.mm, 0);
      expect(sum).toBeCloseTo(width, 5);
    }
    expect(DETAIL_COLUMNS.reduce((a, c) => a + c.mm, 0)).toBeCloseTo(width, 5);
    expect(pageCapacity(PDF.firstTop)).toBeGreaterThan(15);
  });

  it("lays out the board (most pending first, then the totals) and the detail (a band per head with something)", () => {
    const board = boardLines([KUMAR, MEENA, RAVI], CATEGORIES);
    expect(board.map((l) => (l.kind === "row" ? l.cells[1] : ""))).toEqual([
      "Ravi Shankar",
      "Meena Rani",
      "Kumar Vel",
      "Total",
    ]);
    const total = board[3];
    expect(total.kind === "row" && total.total).toBe(true);
    // Ravi may not approve casual leave: a dash, not a zero
    const ravi = board[0];
    expect(ravi.kind === "row" && ravi.cells[3 + CATEGORIES.findIndex((c) => c.key === "casual_leave")]).toBe("—");
    const detail = detailLines([KUMAR, MEENA, RAVI], CATEGORIES);
    expect(detail.filter((l) => l.kind === "band")).toHaveLength(2);
    expect(detail.filter((l) => l.kind === "row")).toHaveLength(5);
  });

  it("draws the title, the date, every head, the totals and each pending request", async () => {
    const doc = await buildHodPdf(input({ scope: "Only HoDs with pending" }));
    const text = drawn(doc).join(" | ");
    for (const want of [
      BOARD_TITLE,
      "04 Nov 2026",
      "Ravi Shankar",
      "Meena Rani",
      "Kumar Vel",
      "Total",
      "Only HoDs with pending",
    ])
      expect(text, want).toContain(want);
    for (const want of [
      "Asha Kumar (E101)",
      "Chitra Devi (E103)",
      "Divya S (E201)",
      "Casual Leave · First half",
      "Resignation",
    ])
      expect(text, want).toContain(want);
    expect(text).toContain("Page 1 of 2");
    expect(text).toContain("Page 2 of 2");
  });

  it("is one page when nothing is pending", async () => {
    const doc = await buildHodPdf(input({ rows: [KUMAR] }));
    expect(doc.getNumberOfPages()).toBe(1);
  });
});

describe("the workbook", () => {
  it("has the board with the totals and the detail, a dash where a head may not decide", async () => {
    const wb = await buildHodWorkbook(input());
    expect(wb.worksheets.map((w) => w.name)).toEqual(["HoD board", "Pending requests"]);
    const board = wb.getWorksheet("HoD board")!;
    const values = (r: number) => (board.getRow(r).values as unknown[]).slice(1);
    // rows 1-3: the title block; 4: the header
    expect(values(3)[0]).toBe(`${BOARD_TITLE} - 04 Nov 2026`);
    expect(values(4).slice(0, 7)).toEqual(["#", "HoD", "Code", "Designation", "Departments", "Branch", "Leave"]);
    expect(values(5).slice(0, 2)).toEqual([1, "Ravi Shankar"]);
    expect(values(5)[6 + CATEGORIES.findIndex((c) => c.key === "casual_leave")]).toBe("—");
    expect(values(8)[1]).toBe("Total");
    const detail = wb.getWorksheet("Pending requests")!;
    expect(detail.rowCount).toBe(4 + 5);
  });

  it("names the files by the day", () => {
    expect(hodFileName(new Date(2026, 10, 4), "png")).toBe("hod-pending-approvals-2026-11-04.png");
  });
});

describe("sharing", () => {
  const blob = new Blob(["x"], { type: "image/png" });
  const meta = { title: "HoDs", text: "summary" };

  it("hands the file to the share sheet when the browser can", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const nav = { share, canShare: vi.fn().mockReturnValue(true) };
    await expect(shareOrDownload(blob, "board.png", meta, nav)).resolves.toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    const arg = share.mock.calls[0][0] as ShareData;
    expect(arg.files?.[0].name).toBe("board.png");
    expect(arg.text).toBe("summary");
    expect(dl.downloadBlob).not.toHaveBeenCalled();
  });

  it("downloads when it cannot, or when the share sheet fails; a cancel is just a cancel", async () => {
    await expect(shareOrDownload(blob, "board.png", meta, { canShare: () => false, share: vi.fn() })).resolves.toBe(
      "downloaded",
    );
    await expect(shareOrDownload(blob, "board.png", meta, {})).resolves.toBe("downloaded");
    const broken = { canShare: () => true, share: vi.fn().mockRejectedValue(new Error("nope")) };
    await expect(shareOrDownload(blob, "board.png", meta, broken)).resolves.toBe("downloaded");
    expect(dl.downloadBlob).toHaveBeenCalledTimes(3);
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const cancelled = { canShare: () => true, share: vi.fn().mockRejectedValue(abort) };
    await expect(shareOrDownload(blob, "board.png", meta, cancelled)).resolves.toBe("cancelled");
    expect(dl.downloadBlob).toHaveBeenCalledTimes(3);
    expect(
      canShareFile(new File(["x"], "a.png"), {
        canShare: () => {
          throw new Error("x");
        },
        share: vi.fn(),
      }),
    ).toBe(false);
  });

  it("copies the summary with the clipboard API, or the old way without it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await expect(copyText("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: typeof exec }).execCommand = exec;
    await expect(copyText("again")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });
});
