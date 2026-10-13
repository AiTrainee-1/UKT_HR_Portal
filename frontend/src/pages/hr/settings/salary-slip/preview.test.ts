import { describe, expect, it } from "vitest";
import { minWageCases, parseMinWage, pdfRupee } from "./preview";

describe("salary slip amounts", () => {
  it("prints money the way the PDF does (Python {:,.2f})", () => {
    expect(pdfRupee(700)).toBe("₹700.00");
    expect(pdfRupee(19675)).toBe("₹19,675.00");
    expect(pdfRupee(1234567.5)).toBe("₹1,234,567.50");
    expect(pdfRupee(Number.NaN)).toBe("₹0.00");
  });
});

describe("minimum wage compliance examples (payroll_statutory_controls._run_min_wage)", () => {
  it("compares per paid day by default: 18,000 over 26 days is 692.31, 200.00 short of 700", () => {
    const [day, month, shift] = minWageCases(700);
    expect(day).toMatchObject({ wage: 692.31, result: "Below minimum", shortfall: 200 });
    // The same figure read per month: 18,000 a month is far above 700.
    expect(month).toMatchObject({ wage: 18000, result: "OK", shortfall: 0 });
    // Production: 9,000 for 15 shifts = 600 a shift, (700 - 600) x 15 = 1,500 short.
    expect(shift).toMatchObject({ wage: 600, result: "Below minimum", shortfall: 1500 });
  });

  it("says OK when the rate is met, and has no examples while the rate is not set", () => {
    expect(minWageCases(500).map((c) => c.result)).toEqual(["OK", "OK", "OK"]);
    expect(minWageCases(0)).toEqual([]);
  });

  it("parses the typed rate, refusing what the column cannot hold", () => {
    expect(parseMinWage("")).toEqual({ value: 0, problem: null });
    expect(parseMinWage(" 700.55 ")).toEqual({ value: 700.55, problem: null });
    expect(parseMinWage("700.555").problem).toMatch(/two decimals/);
    expect(parseMinWage("-5").problem).toMatch(/negative/);
    expect(parseMinWage("abc").problem).toMatch(/number/);
    expect(parseMinWage("100000000").problem).toMatch(/more than/);
  });
});
