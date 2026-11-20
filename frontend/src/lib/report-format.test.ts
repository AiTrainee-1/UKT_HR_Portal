import { describe, expect, it } from "vitest";
import {
  badgeTone,
  formatCell,
  formatDate,
  formatDateTime,
  formatDuration,
  indianNumber,
  rowMatches,
  sortRows,
  type ColumnType,
} from "./report-format";

describe("indianNumber", () => {
  it("groups in lakhs and crores", () => {
    expect(indianNumber(0)).toBe("0.00");
    expect(indianNumber(999.5)).toBe("999.50");
    expect(indianNumber(1234567.891)).toBe("12,34,567.89");
    expect(indianNumber(12345678)).toBe("1,23,45,678.00");
    expect(indianNumber(-100000)).toBe("-1,00,000.00");
    expect(indianNumber(1500, 0)).toBe("1,500");
  });
  it("returns an empty string for non-finite input", () => {
    expect(indianNumber(Number.NaN)).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats minutes as hours and minutes", () => {
    expect(formatDuration(125)).toBe("2h 05m");
    expect(formatDuration(45)).toBe("45m");
    expect(formatDuration(0)).toBe("0m");
    expect(formatDuration(-70)).toBe("-1h 10m");
    expect(formatDuration(59.6)).toBe("1h 00m");
  });
});

describe("dates", () => {
  it("formats ISO dates as DD-Mon-YYYY", () => {
    expect(formatDate("2026-09-05")).toBe("05-Sep-2026");
    expect(formatDate("2026-12-31")).toBe("31-Dec-2026");
  });
  it("leaves non-dates alone", () => {
    expect(formatDate("soon")).toBe("soon");
    expect(formatDate("2026-13-01")).toBe("2026-13-01");
  });
  it("formats date-times", () => {
    expect(formatDateTime("2026-09-05 14:30")).toBe("05-Sep-2026 14:30");
    expect(formatDateTime("2026-09-05T09:05:00")).toBe("05-Sep-2026 09:05");
    expect(formatDateTime("2026-09-05")).toBe("05-Sep-2026");
  });
});

describe("formatCell", () => {
  it("renders empty values as an em dash", () => {
    expect(formatCell(null, "text")).toBe("—");
    expect(formatCell(undefined, "currency")).toBe("—");
    expect(formatCell("", "date")).toBe("—");
  });
  it("formats every column type", () => {
    expect(formatCell(1234.5, "currency")).toBe("₹1,234.50");
    expect(formatCell(1234.5, "number")).toBe("1,234.50");
    expect(formatCell(1234, "integer")).toBe("1,234");
    expect(formatCell(85.5, "percent")).toBe("85.5%");
    expect(formatCell(7.5, "hours")).toBe("7.50");
    expect(formatCell(90, "minutes")).toBe("90");
    expect(formatCell(90, "duration")).toBe("1h 30m");
    expect(formatCell("2026-09-05", "date")).toBe("05-Sep-2026");
    expect(formatCell("09:05:33", "time")).toBe("09:05");
    expect(formatCell("Approved", "badge")).toBe("Approved");
  });
  it("keeps a stray label in a numeric column visible", () => {
    expect(formatCell("N/A", "currency")).toBe("N/A");
  });
  it("shows zero, not a dash", () => {
    expect(formatCell(0, "integer")).toBe("0");
    expect(formatCell(0, "currency")).toBe("₹0.00");
  });
});

describe("badgeTone", () => {
  it("maps common status words", () => {
    expect(badgeTone("Approved")).toBe("success");
    expect(badgeTone("PENDING")).toBe("warning");
    expect(badgeTone("Rejected")).toBe("danger");
    expect(badgeTone("On Duty")).toBe("info");
    expect(badgeTone("Something else")).toBe("neutral");
  });
});

describe("sortRows", () => {
  const rows = [
    { code: "E10", amount: 5, _kind: undefined },
    { code: "E2", amount: null },
    { code: "E1", amount: 30 },
    { code: "Subtotal", amount: 35, _kind: "subtotal" as const },
    { code: "E4", amount: 1 },
  ];
  it("sorts numbers ascending with nulls last", () => {
    const out = sortRows(rows, "amount", "asc", "currency");
    expect(out.map((r) => r.code)).toEqual(["E10", "E1", "E2", "Subtotal", "E4"]);
  });
  it("sorts numbers descending with nulls still last", () => {
    const out = sortRows(rows, "amount", "desc", "currency");
    expect(out.map((r) => r.code)).toEqual(["E1", "E10", "E2", "Subtotal", "E4"]);
  });
  it("sorts text naturally (E2 before E10) and keeps subtotals in place", () => {
    const out = sortRows(rows, "code", "asc", "text");
    expect(out.map((r) => r.code)).toEqual(["E1", "E2", "E10", "Subtotal", "E4"]);
  });
});

describe("rowMatches", () => {
  const row = { code: "UKT001", name: "Priya Kumar", dept: null };
  const col = (key: string, type: ColumnType = "text") => ({ key, type });
  const TEXT_COLS = [col("code"), col("name")];
  it("matches case-insensitively across the given columns", () => {
    expect(rowMatches(row, TEXT_COLS, "priya")).toBe(true);
    expect(rowMatches(row, TEXT_COLS, "  UKT ")).toBe(true);
    expect(rowMatches(row, TEXT_COLS, "nope")).toBe(false);
    expect(rowMatches(row, [col("dept")], "x")).toBe(false);
  });
  it("matches everything for an empty needle", () => {
    expect(rowMatches(row, [col("code")], "")).toBe(true);
    expect(rowMatches(row, [col("code")], "   ")).toBe(true);
  });
  it("finds a value as the table shows it, and as the server sent it", () => {
    const r = { day: "2026-09-05", net: 1234567.891, late: 125, joined: "2026-09-05 14:30", empty: "" };
    // dates: the cell reads 05-Sep-2026
    expect(rowMatches(r, [col("day", "date")], "05-sep")).toBe(true);
    expect(rowMatches(r, [col("day", "date")], "sep-2026")).toBe(true);
    expect(rowMatches(r, [col("day", "date")], "2026-09-05")).toBe(true);
    // money: ₹12,34,567.89 on screen, 1234567.891 in the data
    expect(rowMatches(r, [col("net", "currency")], "12,34,567")).toBe(true);
    expect(rowMatches(r, [col("net", "currency")], "₹12")).toBe(true);
    expect(rowMatches(r, [col("net", "currency")], "1234567")).toBe(true);
    // durations: 2h 05m
    expect(rowMatches(r, [col("late", "duration")], "2h 05")).toBe(true);
    expect(rowMatches(r, [col("joined", "datetime")], "05-sep-2026 14:30")).toBe(true);
    // number columns are searched too (they used to be skipped), but an empty cell never matches its em dash
    expect(rowMatches(r, [col("empty", "text")], "—")).toBe(false);
    expect(rowMatches(r, [col("net", "currency")], "99,99")).toBe(false);
  });
});
