import { describe, expect, it } from "vitest";
import type { SalaryAdvanceRules, TermLoanRules } from "@/lib/api-client/custom-hooks/settlement-automation";
import {
  earnedRange,
  ordinal,
  salaryAdvanceRuleLines,
  salaryAdvanceSummary,
  termLoanRuleLines,
  termLoanSummary,
  termPercent,
  windowText,
} from "./rules";

// The Salary Advance and Term Loan rules in words (owner 2026-11-27: every rule is HR's setting in Settings -> Loan &
// Advance): the sentences follow the numbers they are given, and no screen keeps a rule's number of its own.

const SA: SalaryAdvanceRules = {
  percent: 50,
  windowFromDay: 21,
  windowToDay: 22,
  earnedThroughDay: 20,
  perMonth: 1,
  rejectedAllowsReapply: true,
};
const TL: TermLoanRules = {
  limitPercent: 100,
  allowAboveSalary: false,
  maxMonths: 6,
  minAmount: 1000,
  perYear: 1,
  minServiceMonths: 6,
  reapplyNextMonth: true,
  oneOpenAtATime: true,
};

describe("the rules in words", () => {
  it("days as the employee app says them", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 20, 21, 22, 23, 28].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "20th",
      "21st",
      "22nd",
      "23rd",
      "28th",
    ]);
    expect(earnedRange(18)).toBe("1st–18th");
    expect(windowText(SA)).toBe("the 21st and 22nd of each month");
    expect(windowText({ ...SA, windowFromDay: 19, windowToDay: 19 })).toBe("the 19th of each month");
    expect(windowText({ ...SA, windowFromDay: 20, windowToDay: 25 })).toBe("the 20th to the 25th of each month");
    // the server's own words win
    expect(windowText({ ...SA, windowText: "the 21st and 22nd" })).toBe("the 21st and 22nd");
  });

  it("the Salary Advance follows Settings' %, days and count", () => {
    expect(salaryAdvanceRuleLines(SA)).toEqual([
      "Salary Advance: apply on the 21st and 22nd of each month; up to 50% of the salary earned from the 1st to the 20th, deducted in full from that month's salary.",
      "One Salary Advance a month (a rejected request does not count).",
    ]);
    const other = { ...SA, percent: 40, earnedThroughDay: 15, windowFromDay: 16, windowToDay: 18, perMonth: 2 };
    expect(salaryAdvanceRuleLines({ ...other, rejectedAllowsReapply: false })).toEqual([
      "Salary Advance: apply on the 16th to the 18th of each month; up to 40% of the salary earned from the 1st to the 15th, deducted in full from that month's salary.",
      "Up to 2 Salary Advances a month (a rejected request counts too).",
    ]);
    expect(salaryAdvanceSummary(other)).toBe(
      "up to 40% of the salary earned from the 1st to the 15th; employees apply on the 16th to the 18th of each month",
    );
    expect(salaryAdvanceSummary(null)).not.toMatch(/\d/);
  });

  it("the Term Loan follows Settings' %, months, amount, count and service; above 100% only when allowed", () => {
    expect(termLoanRuleLines(TL)).toEqual([
      "Term Loan: staff employees only, after 6 months of service; apply on any day of the month.",
      "Up to 100% of the fixed monthly salary, from ₹1,000, repaid in 1 to 6 monthly EMIs from the next month's salary.",
      "One Term Loan approved per calendar year.",
      "One waiting or active Term Loan at a time.",
      "After a rejection, apply again from the 1st of the next month.",
    ]);
    expect(termPercent({ ...TL, limitPercent: 150 })).toBe(100);
    expect(termPercent({ ...TL, limitPercent: 150, allowAboveSalary: true })).toBe(150);
    const other = { ...TL, maxMonths: 9, minAmount: 5000, perYear: 2, minServiceMonths: 1, oneOpenAtATime: false };
    expect(termLoanRuleLines({ ...other, reapplyNextMonth: false })).toEqual([
      "Term Loan: staff employees only, after 1 month of service; apply on any day of the month.",
      "Up to 100% of the fixed monthly salary, from ₹5,000, repaid in 1 to 9 monthly EMIs from the next month's salary.",
      "Up to 2 Term Loans approved per calendar year.",
    ]);
    expect(termLoanSummary(other)).toBe(
      "up to 100% of the fixed monthly salary, repaid in 1 to 9 monthly EMIs from ₹5,000, after 1 month of service; staff only",
    );
    expect(termLoanSummary(undefined)).not.toMatch(/\d/);
  });
});

// ─── no rule number of its own on any screen (owner 2026-11-27) ─────────────────────────────────────────────────

const SOURCES = {
  ...import.meta.glob(["./**/*.{ts,tsx}", "!./**/*.test.{ts,tsx}", "!./**/test-fixtures.ts"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob(
    ["../../auditor-review/*.{ts,tsx}", "!../../auditor-review/*.test.{ts,tsx}", "!../../auditor-review/fixtures.ts"],
    { query: "?raw", import: "default", eager: true },
  ),
  ...import.meta.glob(["../settings/settlement/*.{ts,tsx}", "!../settings/settlement/*.test.{ts,tsx}"], {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../settings/SettlementTab*.{ts,tsx}", { query: "?raw", import: "default", eager: true }),
} as Record<string, string>;

/** The code without its comments (a comment may explain a default; the screens may not show one). */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");

/** What the rules used to be written as on the screens before Settings had them. */
const HARD_CODED: [string, RegExp][] = [
  ["the earned days", /1st\s*(-|–|to the)\s*20th/],
  ["the window", /\b21st\b|\b22nd\b/],
  ["the Salary Advance %", /\b50\s?%/],
  ["the Term Loan months", /\b1 to 12\b|\b6 months\b|\?\?\s*6\b/],
  ["the smallest Term Loan", /1,000\b|\?\?\s*1000\b/],
  ["the counted day", /[<>]=?\s*20\b/],
];

describe("no hard-coded rule numbers", () => {
  it("reads the Loan & Advance, Auditor Review and Settings sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);
    expect(Object.keys(SOURCES).some((p) => p.endsWith("NormalSettlement.tsx"))).toBe(true);
    expect(Object.keys(SOURCES).some((p) => p.endsWith("AttendanceSection.tsx"))).toBe(true);
    expect(Object.keys(SOURCES).some((p) => p.endsWith("RulesForms.tsx"))).toBe(true);
  });

  it.each(HARD_CODED)("%s comes from the server, not the screen", (_what, pattern) => {
    const found = Object.entries(SOURCES)
      .filter(([, source]) => pattern.test(code(source)))
      .map(([path]) => path);
    expect(found).toEqual([]);
  });
});
