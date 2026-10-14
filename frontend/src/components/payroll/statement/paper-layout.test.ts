import { describe, expect, it } from "vitest";
import type { SalaryStatement, StatementColumn } from "@/lib/api-client/custom-hooks";
import { PRODUCTION_COLUMNS, generatedStaffStatement, productionStatement, staffStatement } from "./fixtures";
import { PAPER, PT_MM, layoutPaperColumns, notesReserveLines, textWidthEm, wrapsOnPaper } from "./paper-layout";
import { buildTotalRow, cellValue, formatCell } from "./statement-model";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("textWidthEm", () => {
  it("measures Helvetica: digits are 0.55 em, bold letters are wider than regular ones", () => {
    expect(textWidthEm("0")).toBeCloseTo(0.55, 5);
    expect(textWidthEm("1,67,462.00")).toBeCloseTo(8 * 0.55 + 3 * 0.28, 5);
    expect(textWidthEm("")).toBe(0);
    expect(textWidthEm("Deduction", true)).toBeGreaterThan(textWidthEm("Deduction", false));
    expect(textWidthEm("W")).toBeGreaterThan(textWidthEm("i"));
  });

  it("gives a generous width to a letter it has no table for", () => {
    expect(textWidthEm(String.fromCharCode(0x0b95))).toBeGreaterThan(0.6);
  });

  it("agrees with jsPDF's own measurement of the same text (within a percent: jsPDF kerns pairs like AV), regular and bold", async () => {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const samples = [
      "1,67,462.00",
      "SANDHYA KRISHNAN AGARWAL",
      "ADMINISTRATIVE OFFICER",
      "Lop& PSAmt",
      "Page 3 of 9",
      " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    ];
    for (const style of ["normal", "bold"] as const) {
      doc.setFont("helvetica", style);
      doc.setFontSize(10);
      for (const text of samples) {
        const mine = textWidthEm(text, style === "bold") * 10;
        const theirs = doc.getTextWidth(text);
        expect(Math.abs(mine - theirs) / theirs).toBeLessThan(0.01);
      }
    }
  });
});

describe("layoutPaperColumns", () => {
  const statement = staffStatement();

  it("fills the sheet's width exactly with a font between 5.5 and 7 pt", () => {
    const layout = layoutPaperColumns(statement);
    expect(layout.widthsMm).toHaveLength(statement.columns.length);
    expect(sum(layout.widthsMm)).toBeCloseTo(PAPER.contentWidthMm, 1);
    expect(layout.totalMm).toBe(PAPER.contentWidthMm);
    expect(layout.fontPt).toBeGreaterThanOrEqual(5.5);
    expect(layout.fontPt).toBeLessThanOrEqual(7);
    expect(layout.widthsMm.every((w) => w > 3)).toBe(true);
  });

  it("every figure fits its column at the chosen font (a cut figure is a wrong amount on paper)", () => {
    for (const s of [statement, productionStatement(), generatedStaffStatement(120, 8)]) {
      const layout = layoutPaperColumns(s);
      const rows = [
        ...s.groups.flatMap((g) => [...g.rows.map((row) => ({ row, bold: false })), { row: g.subtotal, bold: true }]),
        { row: s.total, bold: true },
      ];
      s.columns.forEach((col, i) => {
        if (col.format === "text") return;
        for (const { row, bold } of rows) {
          const text = formatCell(col, cellValue(row, col), { blankNull: true }).text;
          const needed = textWidthEm(text, bold) * layout.fontPt * PT_MM + 2 * layout.padMm;
          expect(layout.widthsMm[i]).toBeGreaterThanOrEqual(needed - 0.001);
        }
      });
    }
  });

  it("lets a name have its whole width when there is room, and a designation wrap onto two lines", () => {
    const layout = layoutPaperColumns(statement);
    const nameIndex = statement.columns.findIndex((c) => c.key === "name");
    const widest = textWidthEm("SANDHYA KRISHNAN AGARWAL") * layout.fontPt * PT_MM;
    expect(layout.widthsMm[nameIndex]).toBeGreaterThanOrEqual(widest);
    expect(wrapsOnPaper(statement.columns.find((c) => c.key === "designation")!)).toBe(true);
    expect(wrapsOnPaper(statement.columns[nameIndex])).toBe(false);
    const designationIndex = statement.columns.findIndex((c) => c.key === "designation");
    // narrower than the whole of "ADMINISTRATIVE OFFICER" on one line, wide enough for "ADMINISTRATIVE"
    const oneLine = textWidthEm("ADMINISTRATIVE OFFICER") * layout.fontPt * PT_MM;
    const longestWord = textWidthEm("ADMINISTRATIVE") * layout.fontPt * PT_MM;
    expect(layout.widthsMm[designationIndex]).toBeLessThan(oneLine);
    expect(layout.widthsMm[designationIndex]).toBeGreaterThanOrEqual(longestWord);
  });

  it("is deterministic and follows the statement it is given", () => {
    expect(layoutPaperColumns(statement)).toEqual(layoutPaperColumns(statement));
    // a bigger figure in a column widens it
    const rich: SalaryStatement = {
      ...statement,
      groups: statement.groups.map((g) => ({
        ...g,
        rows: g.rows.map((r) => ({ ...r, values: { ...r.values, net: 98765432.1 } })),
      })),
    };
    const i = statement.columns.findIndex((c) => c.key === "net");
    expect(layoutPaperColumns(rich).widthsMm[i]).toBeGreaterThan(layoutPaperColumns(statement).widthsMm[i] - 0.001);
  });

  it("shrinks the font for a very wide statement, and squeezes when even the smallest font will not do", () => {
    const wide = (n: number): SalaryStatement => {
      const columns: StatementColumn[] = Array.from({ length: n }, (_, i) => ({
        ...PRODUCTION_COLUMNS[9],
        key: `c${i}`,
        label: `Column ${i}`,
      }));
      const row = {
        payrollId: 1,
        employeeId: 1,
        sno: 1,
        status: "paid",
        values: Object.fromEntries(columns.map((c) => [c.key, 123456.78])),
      };
      return {
        ...staffStatement(),
        columns,
        groups: [{ key: "a", label: "A", rows: [row], subtotal: buildTotalRow(columns, [row]) }],
        total: buildTotalRow(columns, [row]),
      };
    };
    const thirty = layoutPaperColumns(wide(30));
    expect(thirty.fontPt).toBeLessThan(7);
    expect(sum(thirty.widthsMm)).toBeCloseTo(PAPER.contentWidthMm, 1);
    const sixty = layoutPaperColumns(wide(60));
    expect(sixty.fontPt).toBe(5.5);
    expect(sum(sixty.widthsMm)).toBeCloseTo(PAPER.contentWidthMm, 1);
    expect(layoutPaperColumns({ ...staffStatement(), columns: [] })).toMatchObject({ widthsMm: [], totalMm: 0 });
  });

  it("can lay out for another width", () => {
    const narrow = layoutPaperColumns(productionStatement(), { widthMm: 200 });
    expect(sum(narrow.widthsMm)).toBeCloseTo(200, 1);
  });
});

describe("notesReserveLines", () => {
  it("is nothing without notes, and grows with them", () => {
    expect(notesReserveLines([])).toBe(0);
    const few = notesReserveLines(["One short note."]);
    expect(few).toBeGreaterThanOrEqual(1);
    const many = notesReserveLines(
      Array.from({ length: 6 }, () => "A note that says a fair amount about how a column is worked out."),
    );
    expect(many).toBeGreaterThan(few);
    const long = notesReserveLines(["word ".repeat(400)]);
    expect(long).toBeGreaterThan(few);
  });
});
