import { describe, expect, it } from "vitest";
import type { SalaryStatement, StatementColumn, StatementRow } from "@/lib/api-client/custom-hooks";
import {
  PRODUCTION_COLUMNS,
  STAFF_COLUMNS,
  generatedStaffStatement,
  productionStatement,
  staffStatement,
} from "./fixtures";
import {
  ALL,
  DEFAULT_ROWS_PER_PAGE,
  buildTotalRow,
  cellValue,
  columnBands,
  columnWidthPx,
  columnWidthsPx,
  countStatement,
  fitWidths,
  departmentOptions,
  filterStatement,
  formatCell,
  formatStamp,
  isFiltering,
  leadingIdentityCount,
  paginateStatement,
  remarkChips,
  statementFileStem,
  statementHeadline,
  statementRowCount,
  statementTitle,
  stickyCount,
  stickyOffsets,
  subtotalLabel,
  toNumber,
  type StatementLine,
} from "./statement-model";

const col = (key: string): StatementColumn => {
  const c = STAFF_COLUMNS.find((x) => x.key === key);
  if (!c) throw new Error(`no column ${key}`);
  return c;
};

const rowsOf = (s: SalaryStatement): StatementRow[] => s.groups.flatMap((g) => g.rows);
const names = (s: SalaryStatement): string[] => rowsOf(s).map((r) => String(r.values.name));
const val = (row: StatementRow, key: string): number => Number(row.values[key]);

describe("the fixture (the printed page) adds up", () => {
  const s = staffStatement();

  it("has ACCOUNTS (3) and ADMIN (12), serial numbers running across them", () => {
    expect(s.groups.map((g) => [g.label, g.rows.length])).toEqual([
      ["ACCOUNTS", 3],
      ["ADMIN", 12],
    ]);
    expect(rowsOf(s).map((r) => r.sno)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(s.counts).toEqual({ employees: 15, departments: 2, paid: 11, pending: 4 });
  });

  it("every row satisfies E salary - Total Deduction = NET, and Total - E salary = Lop & PSAmt", () => {
    for (const r of rowsOf(s)) {
      expect(val(r, "eSalary") - val(r, "totalDeduction")).toBe(val(r, "net"));
      expect(val(r, "total") - val(r, "eSalary")).toBe(val(r, "lopAmount"));
    }
  });

  it("the stored subtotals and grand total are the sums of the rows (hand-checked)", () => {
    const [accounts, admin] = s.groups;
    expect(val(accounts.subtotal, "net")).toBe(46004);
    expect(val(admin.subtotal, "net")).toBe(683495);
    expect(val(s.total, "net")).toBe(729499);
    expect(val(s.total, "total")).toBe(859500);
    expect(val(s.total, "basic")).toBe(425150);
    expect(val(accounts.subtotal, "present")).toBe(46);
    // ... and the same numbers come out of buildTotalRow
    expect(buildTotalRow(s.columns, rowsOf(s))).toEqual(s.total);
  });
});

describe("filterStatement", () => {
  const s = staffStatement();

  it("with no filter hands back the statement itself, server totals and all", () => {
    expect(filterStatement(s, {})).toBe(s);
    expect(filterStatement(s, { search: "  ", department: ALL, status: ALL })).toBe(s);
    expect(isFiltering({ search: " ", department: ALL, status: "" })).toBe(false);
    expect(isFiltering({ status: "paid" })).toBe(true);
  });

  it("a department filter keeps that department's rows and the server's serial numbers", () => {
    const admin = filterStatement(s, { department: "admin" });
    expect(admin.groups.map((g) => g.label)).toEqual(["ADMIN"]);
    expect(rowsOf(admin).map((r) => r.sno)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(val(admin.total, "net")).toBe(683495);
    expect(admin.counts).toEqual({ employees: 12, departments: 1, paid: 9, pending: 3 });
  });

  it("the search matches a name, any case, anywhere in it - and recomputes every total from what is left", () => {
    const r = filterStatement(s, { search: "KaNnAn" });
    expect(names(r)).toEqual(["LOKESH KANNAN", "KUNHIK KANNAN PV"]);
    expect(r.groups.map((g) => [g.label, g.rows.length])).toEqual([
      ["ACCOUNTS", 1],
      ["ADMIN", 1],
    ]);
    expect(val(r.groups[0].subtotal, "net")).toBe(14005);
    expect(val(r.groups[1].subtotal, "net")).toBe(118000);
    expect(val(r.total, "net")).toBe(132005);
    expect(val(r.total, "total")).toBe(17500 + 123000);
    expect(val(r.total, "present")).toBe(21 + 26);
    expect(r.counts).toEqual({ employees: 2, departments: 2, paid: 2, pending: 0 });
  });

  it("the search also matches the ID no, and a department left with nothing is dropped", () => {
    const r = filterStatement(s, { search: "30071" });
    expect(names(r)).toEqual(["SRIRAM DORAISWAMY"]);
    expect(r.groups.map((g) => g.label)).toEqual(["ACCOUNTS"]);
    expect(r.groups[0].rows[0].sno).toBe(3);
    expect(val(r.total, "net")).toBe(5769);
    expect(r.counts.departments).toBe(1);
  });

  it("the status filter keeps paid or pending rows", () => {
    const pending = filterStatement(s, { status: "pending" });
    expect(rowsOf(pending).map((r) => r.sno)).toEqual([3, 6, 8, 11]);
    expect(val(pending.groups[0].subtotal, "net")).toBe(5769);
    expect(val(pending.groups[1].subtotal, "net")).toBe(99200 + 21069 + 17661);
    expect(val(pending.total, "net")).toBe(5769 + 137930);
    expect(val(pending.groups[1].subtotal, "present")).toBe(73.5);
    expect(pending.counts).toEqual({ employees: 4, departments: 2, paid: 0, pending: 4 });
    const paid = filterStatement(s, { status: "paid" });
    expect(paid.counts.employees).toBe(11);
    expect(val(paid.total, "net")).toBe(729499 - 143699);
  });

  it("the filters combine", () => {
    const r = filterStatement(s, { department: "admin", status: "pending", search: "m" });
    // the pending ADMIN rows are MURUGESAN.K (6), NARAYANAN KUPPAYI (8) and MOHANA LAKSHMI P (11): only two have an "m"
    expect(names(r)).toEqual(["MURUGESAN.K", "MOHANA LAKSHMI P"]);
    expect(val(r.total, "net")).toBe(99200 + 17661);
  });

  it("nothing matching leaves an empty statement with zero totals", () => {
    const r = filterStatement(s, { search: "zzz" });
    expect(r.groups).toEqual([]);
    expect(r.counts).toEqual({ employees: 0, departments: 0, paid: 0, pending: 0 });
    expect(val(r.total, "net")).toBe(0);
    expect(statementRowCount(r)).toBe(0);
  });

  it("does not touch the statement it was given", () => {
    const before = JSON.stringify(s);
    filterStatement(s, { search: "kannan", status: "paid" });
    expect(JSON.stringify(s)).toBe(before);
  });

  it("sums money and days exactly (0.1 + 0.2 is 0.3) and understands decimals that arrive as strings", () => {
    const columns = [col("name"), col("basic"), col("present"), col("cl")];
    const mk = (n: string, basic: number | string, present: number): StatementRow => ({
      payrollId: 1,
      employeeId: 1,
      sno: 1,
      status: "paid",
      values: { name: n, basic, present, cl: null },
    });
    const total = buildTotalRow(columns, [mk("a", 0.1, 0.1), mk("b", 0.2, 0.2), mk("c", "14750.10", 1.15)]);
    expect(total.values.basic).toBe(14750.4);
    expect(total.values.present).toBe(1.45);
    expect(total.values.cl).toBe(0);
    expect(total.values.name).toBeNull(); // not a column that adds up
  });

  it("works on the production statement too", () => {
    const p = productionStatement();
    const r = filterStatement(p, { department: "spinning" });
    expect(r.groups.map((g) => g.label)).toEqual(["Spinning"]);
    expect(val(r.total, "net")).toBe(3300 + 2550);
    expect(val(r.total, "late")).toBe(3);
    expect(r.total.values.rate).toBeNull();
  });

  it("countStatement and departmentOptions read the groups", () => {
    expect(countStatement(s.groups)).toEqual(s.counts);
    expect(departmentOptions(s)).toEqual([
      { key: "accounts", label: "ACCOUNTS", count: 3 },
      { key: "admin", label: "ADMIN", count: 12 },
    ]);
  });
});

describe("formatCell", () => {
  it("money has Indian grouping and two decimals; zero is flagged so it can be muted", () => {
    expect(formatCell(col("net"), 167462)).toEqual({ text: "1,67,462.00", zero: false, empty: false });
    expect(formatCell(col("net"), 26230.5).text).toBe("26,230.50");
    expect(formatCell(col("net"), 0)).toEqual({ text: "0.00", zero: true, empty: false });
  });

  it("days have two decimals, ints none, text is shown as it is", () => {
    expect(formatCell(col("present"), 24.5).text).toBe("24.50");
    expect(formatCell(col("sno"), 12).text).toBe("12");
    expect(
      formatCell(
        PRODUCTION_COLUMNS.find((c) => c.key === "late")!,
        1234,
      ).text,
    ).toBe("1,234");
    expect(formatCell(col("name"), "MEENATCHI.T").text).toBe("MEENATCHI.T");
    expect(formatCell(col("code"), 2316).text).toBe("2316");
  });

  it("nothing at all is a dash, or blank on a subtotal line and in the Remarks column", () => {
    expect(formatCell(col("net"), null)).toEqual({ text: "—", zero: false, empty: true });
    expect(formatCell(col("name"), "").text).toBe("—");
    expect(formatCell(col("net"), undefined, { blankNull: true })).toEqual({ text: "", zero: false, empty: true });
    expect(formatCell(col("remarks"), null)).toEqual({ text: "", zero: false, empty: true });
    expect(formatCell(col("remarks"), "LEFT").text).toBe("LEFT");
    expect(formatCell(col("remarks"), null, { blankNull: false }).text).toBe("—");
  });

  it("reads decimal strings, shows words in a number column untouched, never prints -0.00", () => {
    expect(formatCell(col("basic"), "14750.00").text).toBe("14,750.00");
    expect(formatCell(col("basic"), "on hold").text).toBe("on hold");
    expect(formatCell(col("basic"), -0).text).toBe("0.00");
    expect(formatCell(col("basic"), -0.001)).toMatchObject({ text: "0.00", zero: true });
    expect(formatCell(col("basic"), -250.5).text).toBe("-250.50");
    expect(formatCell(col("basic"), Number.NaN).empty).toBe(true);
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber("x")).toBeNull();
    expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("reads the serial number from the row itself, falling back to the values", () => {
    const row: StatementRow = { payrollId: 1, employeeId: 1, sno: 7, status: null, values: { sno: 99 } };
    expect(cellValue(row, col("sno"))).toBe(7);
    expect(cellValue({ ...row, sno: null }, col("sno"))).toBe(99);
    expect(cellValue({ ...row, sno: null, values: {} }, col("sno"))).toBeNull();
    expect(cellValue(row, col("net"))).toBeNull();
  });
});

describe("remark chips", () => {
  it("splits the remarks and gives each its tone", () => {
    expect(remarkChips("LEFT")).toEqual([{ label: "LEFT", tone: "danger" }]);
    expect(remarkChips("JOINED 12-09-2026; ON HOLD")).toEqual([
      { label: "JOINED 12-09-2026", tone: "info" },
      { label: "ON HOLD", tone: "warning" },
    ]);
    expect(remarkChips("see HR")).toEqual([{ label: "see HR", tone: "neutral" }]);
    expect(remarkChips(null)).toEqual([]);
    expect(remarkChips("  ")).toEqual([]);
  });
});

describe("columns", () => {
  it("groups neighbouring columns of one group into the bands of the header", () => {
    const bands = columnBands(STAFF_COLUMNS);
    expect(bands.map((b) => [b.group, b.span])).toEqual([
      ["identity", 4],
      ["earnings", 2],
      ["attendance", 5],
      ["earnings", 3],
      ["deductions", 8],
      ["result", 2],
    ]);
    expect(bands.map((b) => b.start)).toEqual([0, 4, 6, 11, 14, 22]);
    expect(bands[0].label).toBe("Employee");
    expect(bands.every((b) => !b.continued)).toBe(true);
  });

  it("can cut a band where the sticky columns end", () => {
    const bands = columnBands(STAFF_COLUMNS, 3);
    expect(bands.slice(0, 2).map((b) => [b.group, b.start, b.span, b.continued])).toEqual([
      ["identity", 0, 3, false],
      ["identity", 3, 1, true],
    ]);
    expect(bands.reduce((n, b) => n + b.span, 0)).toBe(STAFF_COLUMNS.length);
  });

  it("widths follow the weight but never go below what a figure of that kind needs", () => {
    expect(columnWidthPx(col("name"))).toBe(252); // 3 x 84
    expect(columnWidthPx(col("net"))).toBe(Math.round(1.3 * 84)); // 109
    expect(columnWidthPx(col("sno"))).toBe(52); // 0.6 x 84 = 50, but SNO needs 52
    expect(columnWidthPx(col("basic"))).toBe(109);
    expect(columnWidthPx(col("present"))).toBe(84); // a days column, weight 1
    expect(columnWidthPx({ ...col("net"), weight: 0.3 })).toBe(96); // a money column is never narrower than 96
    expect(columnWidthPx({ ...col("net"), weight: Number.NaN })).toBe(96);
    expect(columnWidthsPx(STAFF_COLUMNS)).toHaveLength(STAFF_COLUMNS.length);
    expect(columnWidthPx(col("net"), 100)).toBe(130);
  });

  it("a table narrower than its room is stretched by one factor, adding up exactly; a wider one keeps its widths", () => {
    const widths = [52, 76, 218];
    expect(fitWidths(widths, 300)).toBe(widths); // 300 < 346: it scrolls, nothing changes
    expect(fitWidths(widths, 346)).toBe(widths);
    expect(fitWidths([100, 100, 100], 600)).toEqual([200, 200, 200]);
    const stretched = fitWidths(widths, 693);
    expect(stretched).toEqual([104, 152, 437]);
    expect(stretched.reduce((a, b) => a + b, 0)).toBe(693);
    // fractions of a pixel of room are not used (a half pixel would make the table wider than the room)
    expect(fitWidths([100, 100], 300.9).reduce((a, b) => a + b, 0)).toBe(300);
    // nothing to measure yet (0 before the first layout, NaN): the natural widths
    expect(fitWidths(widths, 0)).toBe(widths);
    expect(fitWidths(widths, Number.NaN)).toBe(widths);
    expect(fitWidths([], 500)).toEqual([]);
  });

  it("SNO, ID NO and Name are the sticky columns, offset by the widths before them", () => {
    expect(stickyCount(STAFF_COLUMNS)).toBe(3);
    expect(stickyCount(PRODUCTION_COLUMNS)).toBe(3);
    expect(stickyCount([col("name"), col("sno")])).toBe(2);
    expect(stickyCount([col("designation"), col("sno")])).toBe(0);
    const widths = columnWidthsPx(STAFF_COLUMNS);
    expect(stickyOffsets(widths, 3)).toEqual([0, 52, 52 + 92]);
    expect(leadingIdentityCount(STAFF_COLUMNS)).toBe(4);
  });
});

describe("titles and stamps", () => {
  const s = staffStatement();

  it("the headline is the company and its branch, like the printed page", () => {
    expect(statementHeadline(s)).toBe("U.K TEXTILES - H.O");
    expect(statementHeadline({ ...s, company: { name: "UKTextiles", branchLabel: null } })).toBe("UKTextiles");
  });

  it("the title is 'Salary Statement From dd-mm-yyyy To dd-mm-yyyy'", () => {
    expect(statementTitle(s)).toBe("Salary Statement From 01-09-2026 To 30-09-2026");
    // a server title that already says it is not repeated
    expect(statementTitle({ ...s, title: "Salary Statement From 01-09-2026 To 30-09-2026" })).toBe(
      "Salary Statement From 01-09-2026 To 30-09-2026",
    );
    // missing labels fall back to the period's own dates
    expect(statementTitle({ ...s, title: "", period: { ...s.period, fromLabel: "", toLabel: "" } })).toBe(
      "Salary Statement From 01-09-2026 To 30-09-2026",
    );
  });

  it("file names are safe and say staff or production", () => {
    expect(statementFileStem(s)).toBe("Salary_Statement_September_2026");
    expect(statementFileStem(productionStatement())).toBe("Salary_Statement_Production_2_Feb_8_Feb_2026");
  });

  it("labels of the subtotal lines", () => {
    expect(subtotalLabel("ACCOUNTS")).toBe("ACCOUNTS - Total");
  });

  it("formats a stamp as dd-mm-yyyy hh:mm and survives a bad date", () => {
    expect(formatStamp("2026-10-01T09:05:00")).toBe("01-10-2026 09:05");
    const fallback = new Date(2026, 9, 13, 8, 7);
    expect(formatStamp("not a date", fallback)).toBe("13-10-2026 08:07");
    expect(formatStamp(null, fallback)).toBe("13-10-2026 08:07");
  });
});

// ── Pages ────────────────────────────────────────────────────────────────────

const kinds = (lines: StatementLine[]): string[] =>
  lines.map((l) => (l.kind === "band" ? (l.continued ? "band-contd" : "band") : l.kind));

/** Every row of the statement exactly once, in order, whatever the page size. */
const dataRows = (pages: ReturnType<typeof paginateStatement>): StatementRow[] =>
  pages.flatMap((p) => p.lines.flatMap((l) => (l.kind === "row" ? [l.row] : [])));

describe("paginateStatement", () => {
  const s = staffStatement();

  it("the printed fifteen rows make two pages at the default size: the second opens with ADMIN (contd.)", () => {
    expect(DEFAULT_ROWS_PER_PAGE).toBe(18);
    const pages = paginateStatement(s);
    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.number)).toEqual([1, 2]);
    expect(pages.map((p) => p.last)).toEqual([false, true]);
    expect(pages[0].lines).toHaveLength(17);
    expect(kinds(pages[0].lines).slice(0, 7)).toEqual(["band", "row", "row", "row", "subtotal", "band", "row"]);
    expect(kinds(pages[1].lines)).toEqual(["band-contd", "row", "subtotal", "total"]);
    const contd = pages[1].lines[0];
    expect(contd.kind === "band" && [contd.label, contd.count]).toEqual(["ADMIN", 12]);
    expect(dataRows(pages)).toEqual(rowsOf(s));
  });

  it("the grand total is only on the last page, and each subtotal follows the last row of its department", () => {
    const pages = paginateStatement(generatedStaffStatement(40, 4), 12);
    const totals = pages.flatMap((p, i) => p.lines.filter((l) => l.kind === "total").map(() => i + 1));
    expect(totals).toEqual([pages.length]);
    expect(pages[pages.length - 1].lines.at(-1)?.kind).toBe("total");
    const subtotals = pages.flatMap((p) => p.lines.filter((l) => l.kind === "subtotal"));
    expect(subtotals).toHaveLength(4);
  });

  it("never exceeds the page size, never ends a page on a band, always keeps a subtotal with a row", () => {
    for (const employees of [1, 2, 7, 15, 40, 120]) {
      const statement = generatedStaffStatement(employees, 5);
      for (const cap of [5, 6, 8, 12, 18, 25, 40]) {
        const pages = paginateStatement(statement, cap);
        for (const page of pages) {
          expect(page.lines.length).toBeLessThanOrEqual(cap);
          expect(page.lines.at(-1)?.kind).not.toBe("band");
          page.lines.forEach((line, i) => {
            if (line.kind === "subtotal") expect(page.lines[i - 1]?.kind).toBe("row");
            if (i > 0 && line.kind === "total") expect(page.lines[i - 1].kind).toBe("subtotal");
          });
          // a page that opens with a row gets the (contd.) band of its department
          const first = page.lines[0];
          expect(first.kind === "band" || first.kind === "total").toBe(true);
        }
        expect(dataRows(pages)).toEqual(rowsOf(statement));
        expect(pages.filter((p) => p.last)).toHaveLength(1);
      }
    }
  });

  it("page counts for 15, 40 and 120 employees", () => {
    expect(paginateStatement(generatedStaffStatement(15, 2))).toHaveLength(2);
    expect(paginateStatement(generatedStaffStatement(40, 4))).toHaveLength(3);
    expect(paginateStatement(generatedStaffStatement(120, 8))).toHaveLength(8);
    // about a hundred and thirty employees fill nine pages, like the printed "Page 1 of 9"
    expect(paginateStatement(generatedStaffStatement(130, 8))).toHaveLength(9);
  });

  it("a small page size cuts a department into several (contd.) pages", () => {
    const one = generatedStaffStatement(9, 1);
    const pages = paginateStatement(one, 5);
    expect(pages.map((p) => kinds(p.lines))).toEqual([
      ["band", "row", "row", "row", "row"],
      ["band-contd", "row", "row", "row", "row"],
      ["band-contd", "row", "subtotal", "total"],
    ]);
  });

  it("keeps the last department's last row with its subtotal and the grand total", () => {
    const three = generatedStaffStatement(3, 1);
    const pages = paginateStatement(three, 5);
    expect(pages.map((p) => kinds(p.lines))).toEqual([
      ["band", "row", "row"],
      ["band-contd", "row", "subtotal", "total"],
    ]);
  });

  it("can keep room free on the last page for the notes", () => {
    const base = paginateStatement(s);
    const reserved = paginateStatement(s, 18, { reserveLastPage: 16 });
    expect(reserved.length).toBeGreaterThanOrEqual(base.length);
    expect(reserved.at(-1)!.lines.length).toBeLessThanOrEqual(18 - 13); // reserve is capped so a page can still hold a block
    expect(dataRows(reserved)).toEqual(rowsOf(s));
  });

  it("an empty statement is one page with only the total; a tiny size is raised to the minimum", () => {
    const empty = filterStatement(s, { search: "zzz" });
    const pages = paginateStatement(empty);
    expect(pages).toHaveLength(1);
    expect(kinds(pages[0].lines)).toEqual(["total"]);
    expect(paginateStatement(s, 1).every((p) => p.lines.length <= 5)).toBe(true);
    expect(paginateStatement(s, Number.NaN)).toHaveLength(2);
  });

  it("a department with no rows is left out", () => {
    const withEmpty: SalaryStatement = {
      ...s,
      groups: [{ key: "hr", label: "HR", rows: [], subtotal: s.total }, ...s.groups],
    };
    const pages = paginateStatement(withEmpty);
    expect(pages.flatMap((p) => p.lines).some((l) => l.kind === "band" && l.label === "HR")).toBe(false);
  });
});
