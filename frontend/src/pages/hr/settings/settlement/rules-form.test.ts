import { describe, expect, it } from "vitest";
import type { SalaryAdvanceRules, TermLoanRules } from "@/lib/api-client/custom-hooks/settlement-automation";
import {
  SA_FIELD,
  TL_FIELD,
  fieldOfServer,
  hasProblems,
  saChanges,
  saFormOf,
  saProblems,
  saRulesOf,
  tlChanges,
  tlFormOf,
  tlProblems,
  tlRulesOf,
  type Limits,
} from "./rules-form";

// Settings -> Loan & Advance -> Salary Advance Rules / Term Loan Rules (owner 2026-11-27): the checks the server makes
// (advance_rules.clean), what Save sends (only what changed) and the server's field mapped back to the form's.

/** advance_rules.LIMITS as GET /api/settlement-settings sends them (ruleLimits). */
const LIMITS: Limits = {
  sa_percent: { min: 1, max: 100 },
  sa_window_from: { min: 1, max: 28 },
  sa_window_to: { min: 1, max: 28 },
  sa_earned_through: { min: 1, max: 28 },
  sa_per_month: { min: 1, max: 5 },
  tl_limit_percent: { min: 1, max: 1000 },
  tl_max_months: { min: 1, max: 12 },
  tl_min_amount: { min: 0, max: 1000000 },
  tl_per_year: { min: 1, max: 12 },
  tl_min_service_months: { min: 0, max: 120 },
};

const SA: SalaryAdvanceRules = {
  percent: 50,
  windowFromDay: 21,
  windowToDay: 22,
  earnedThroughDay: 20,
  perMonth: 1,
  rejectedAllowsReapply: true,
  windowText: "the 21st and 22nd of each month",
};
const TL: TermLoanRules = {
  limitPercent: 100,
  effectivePercent: 100,
  allowAboveSalary: false,
  maxMonths: 6,
  absoluteMaxMonths: 12,
  minAmount: 1000,
  perYear: 1,
  minServiceMonths: 6,
  reapplyNextMonth: true,
  oneOpenAtATime: true,
  staffOnly: true,
};

describe("the Salary Advance rules form", () => {
  it("starts from the saved rules with nothing to save", () => {
    const f = saFormOf(SA);
    expect(f).toEqual({
      percent: "50",
      windowFromDay: "21",
      windowToDay: "22",
      earnedThroughDay: "20",
      perMonth: "1",
      rejectedAllowsReapply: true,
    });
    expect(hasProblems(saProblems(f, LIMITS))).toBe(false);
    expect(saChanges(SA, f)).toEqual({});
  });

  it("checks each number against the server's limits, whole numbers only", () => {
    const f = saFormOf(SA);
    expect(saProblems({ ...f, percent: "101" }, LIMITS).percent).toBe("Enter a whole number from 1 to 100.");
    expect(saProblems({ ...f, percent: "0" }, LIMITS).percent).toBe("Enter a whole number from 1 to 100.");
    expect(saProblems({ ...f, percent: "40.5" }, LIMITS).percent).toBe("Enter a whole number from 1 to 100.");
    expect(saProblems({ ...f, percent: "" }, LIMITS).percent).toBe("Enter a whole number from 1 to 100.");
    expect(saProblems({ ...f, perMonth: "6" }, LIMITS).perMonth).toBe("Enter a whole number from 1 to 5.");
    expect(saProblems({ ...f, windowToDay: "29" }, LIMITS).windowToDay).toBe("Enter a whole number from 1 to 28.");
  });

  it("the window starts on or before it ends, and the earned salary is counted to a day before it opens", () => {
    const f = saFormOf(SA);
    expect(saProblems({ ...f, windowFromDay: "23", earnedThroughDay: "20" }, LIMITS).windowToDay).toBe(
      "The window must start on or before the day it ends.",
    );
    expect(saProblems({ ...f, earnedThroughDay: "21" }, LIMITS).earnedThroughDay).toBe(
      "Count the earned salary up to a day BEFORE the window opens, so the figure is complete when employees apply.",
    );
    // a one-day window is fine
    expect(
      hasProblems(saProblems({ ...f, windowFromDay: "19", windowToDay: "19", earnedThroughDay: "18" }, LIMITS)),
    ).toBe(false);
  });

  it("sends only what changed, as numbers and switches", () => {
    const f = { ...saFormOf(SA), percent: "40", earnedThroughDay: "18", rejectedAllowsReapply: false };
    expect(saChanges(SA, f)).toEqual({ percent: 40, earnedThroughDay: 18, rejectedAllowsReapply: false });
    // a field not valid yet keeps the saved value in the preview
    expect(saRulesOf({ ...f, percent: "abc" }, SA).percent).toBe(50);
  });
});

describe("the Term Loan rules form", () => {
  it("above 100% of the monthly salary only with 'Allow loan above monthly salary' on", () => {
    const f = tlFormOf(TL);
    expect(tlProblems({ ...f, limitPercent: "150" }, LIMITS).limitPercent).toBe(
      "Above 100% of the monthly salary needs 'Allow loan above monthly salary' switched on.",
    );
    expect(tlProblems({ ...f, limitPercent: "150", allowAboveSalary: true }, LIMITS).limitPercent).toBeUndefined();
    expect(tlProblems({ ...f, limitPercent: "1001", allowAboveSalary: true }, LIMITS).limitPercent).toBe(
      "Enter a whole number from 1 to 1000.",
    );
    // the % in force: capped at 100 while the switch is off
    expect(tlRulesOf({ ...f, limitPercent: "150" }, TL).effectivePercent).toBe(100);
    expect(tlRulesOf({ ...f, limitPercent: "150", allowAboveSalary: true }, TL).effectivePercent).toBe(150);
  });

  it("repayment months 1 to 12, the amount, the year's count and the service", () => {
    const f = tlFormOf(TL);
    expect(tlProblems({ ...f, maxMonths: "13" }, LIMITS).maxMonths).toBe("Enter a whole number from 1 to 12.");
    expect(tlProblems({ ...f, maxMonths: "0" }, LIMITS).maxMonths).toBe("Enter a whole number from 1 to 12.");
    expect(tlProblems({ ...f, minAmount: "-1" }, LIMITS).minAmount).toBe("Enter a whole number from 0 to 1000000.");
    expect(tlProblems({ ...f, perYear: "13" }, LIMITS).perYear).toBe("Enter a whole number from 1 to 12.");
    expect(tlProblems({ ...f, minServiceMonths: "121" }, LIMITS).minServiceMonths).toBe(
      "Enter a whole number from 0 to 120.",
    );
    expect(hasProblems(tlProblems(f, LIMITS))).toBe(false);
  });

  it("sends only what changed, switches included", () => {
    const f = {
      ...tlFormOf(TL),
      limitPercent: "150",
      allowAboveSalary: true,
      maxMonths: "9",
      oneOpenAtATime: false,
    };
    expect(tlChanges(TL, f)).toEqual({
      limitPercent: 150,
      allowAboveSalary: true,
      maxMonths: 9,
      oneOpenAtATime: false,
    });
    expect(tlChanges(TL, tlFormOf(TL))).toEqual({});
  });
});

describe("the server's refusal", () => {
  it("names the form field its model field is", () => {
    expect(fieldOfServer(SA_FIELD, "sa_window_to")).toBe("windowToDay");
    expect(fieldOfServer(SA_FIELD, "sa_earned_through")).toBe("earnedThroughDay");
    expect(fieldOfServer(TL_FIELD, "tl_limit_percent")).toBe("limitPercent");
    expect(fieldOfServer(TL_FIELD, "tl_one_open")).toBe("oneOpenAtATime");
    expect(fieldOfServer(TL_FIELD, "nonsense")).toBeNull();
    expect(fieldOfServer(TL_FIELD, null)).toBeNull();
  });
});
